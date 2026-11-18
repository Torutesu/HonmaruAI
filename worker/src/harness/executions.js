import { mayUseApp } from './resourceAccess.js';
import { allowed } from '../permissions.js';
import { mayViewWorkflow } from './workflows.js';
import { mayUseConversation } from './conversationAccess.js';
import {settleWorkflowProgram} from './workflowCodeJobs.js';
import { mayRunAgent } from './agents.js';
import { getMode } from './mode.js';
import { workspaceBudgetAdmission } from '../workspaceAIBudget.js';
export const jobView = row => row && ({ id: row.id, gatewayId: row.gateway_id, status: row.status, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, result: row.result ? JSON.parse(row.result) : null });
const id = () => crypto.randomUUID();
const now = () => Date.now();
const error = (message, status = 400) => ({ error: message, status });
const success = (value, status = 200) => ({ ...value, statusCode: status });
export async function listExecutionNodes(db, orgId, me) {
  if (!(await allowed(db, orgId, me, 'harness.build'))) return error('Execution is not allowed.', 403);
  const { results } = await db.prepare('SELECT id, name, last_seen_at AS lastSeenAt FROM hx_gateways WHERE org_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC').bind(orgId).all();
  return { gateways: results || [] };
}
export async function readExecution(db, orgId, me, jobId) {
  if (!(await allowed(db, orgId, me, 'harness.build'))) return error('Execution is not allowed.', 403);
  const row = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id = ?1 AND id = ?2 AND created_by = ?3').bind(orgId, String(jobId || ''), String(me)).first();
  if (row) {
    try {
      const payload=JSON.parse(row.payload);
      if (payload.nativeBrowserAction===true && !await nativeBrowserActionAllowed(db,row,payload)) return error('No such execution.',404);
    } catch { return error('No such execution.',404); }
  }
  const scope = row && await db.prepare('SELECT app_id FROM hx_app_action_jobs WHERE job_id=?1 AND org_id=?2').bind(row.id,orgId).first();
  if(scope && !(await mayUseApp(db,orgId,scope.app_id,me))) return error('No such execution.',404);
  const activation = row && await db.prepare(`SELECT d.definition FROM hx_workflow_activations a
    LEFT JOIN hx_workflow_run_definitions d ON d.org_id=a.org_id AND d.run_id=a.run_id
    WHERE a.org_id=?1 AND a.job_id=?2`).bind(orgId,row.id).first();
  if (row && JSON.parse(row.payload).workflowProgram === true && !activation) return error('No such execution.',404);
  if (activation) {
    // Retained output must respect both today's resource permissions and the
    // source room captured when this particular program was admitted.
    let definition, context;
    try { definition=JSON.parse(activation.definition); context=JSON.parse(row.payload).context; }
    catch { return error('No such execution.',404); }
    if (!definition || !(await mayViewWorkflow(db,orgId,definition,me)) ||
        (context?.roomId && !(await mayUseConversation(db,orgId,me,context.roomId)))) return error('No such execution.',404);
  }
  return row ? { job: jobView(row) } : error('No such execution.', 404);
}
export async function cancelExecution(db, orgId, me, jobId) {
  const found = await readExecution(db, orgId, me, jobId);
  if (found.error) return found;
  await db.prepare("UPDATE hx_gateway_jobs SET status = 'cancelled', lease_hash = NULL, finished_at = ?2 WHERE id = ?1 AND status IN ('queued', 'running')").bind(jobId, now()).run();
  await settleWorkflowProgram(db,jobId);
  return readExecution(db, orgId, me, jobId);
}
const MAX_FILE_COUNT = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_BYTES = 1024 * 1024;
const MAX_JOB_BYTES = 1600000;
export async function browserConversationAllowed(db, orgId, userId, browserContext) {
  if (!browserContext || typeof browserContext !== 'object' || Array.isArray(browserContext) ||
      typeof browserContext.channel !== 'string' || browserContext.channel.length > 200 ||
      typeof browserContext.threadId !== 'string' || browserContext.threadId.length > 200 ||
      typeof browserContext.sourceMessageId !== 'string' || browserContext.sourceMessageId.length > 80 ||
      typeof browserContext.requesterLogin !== 'string' || browserContext.requesterLogin.length > 100) return false;
  const identity = await db.prepare('SELECT login FROM users WHERE github_id=?1').bind(String(userId)).first();
  if (!identity?.login || identity.login !== browserContext.requesterLogin) return false;
  const message = await db.prepare(`SELECT id,channel,parent_id,author_login,deleted_at FROM channel_messages
    WHERE org_id=?1 AND id=?2`).bind(orgId,browserContext.sourceMessageId).first();
  if (!message || message.deleted_at || message.channel !== browserContext.channel || message.author_login !== identity.login ||
      (message.parent_id || message.id) !== browserContext.threadId) return false;
  if (message.parent_id && !await db.prepare(`SELECT 1 FROM channel_messages
      WHERE org_id=?1 AND id=?2 AND channel=?3 AND parent_id IS NULL AND deleted_at IS NULL`)
      .bind(orgId,message.parent_id,browserContext.channel).first()) return false;
  return Boolean(await mayUseConversation(db,orgId,userId,browserContext.channel));
}

function validNativeBrowserAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  const exact=(...keys)=>Object.keys(action).sort().join(',')===['type',...keys].sort().join(',');
  switch (action.type) {
    case 'navigate': {
      if(!exact('url'))return false;
      if (typeof action.url !== 'string' || action.url.length > 2048) return false;
      try { const url=new URL(action.url); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    }
    case 'click': return exact('x','y')&&[action.x,action.y].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=4096);
    case 'type': return exact('text')&&typeof action.text==='string'&&action.text.length<=2000;
    case 'press': return exact('key')&&['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageUp','PageDown'].includes(action.key);
    case 'scroll': return exact('x','y','deltaX','deltaY')&&[action.x,action.y,action.deltaX,action.deltaY].every(Number.isSafeInteger)&&action.x>=0&&action.y>=0&&action.x<=4096&&action.y<=4096&&Math.abs(action.deltaX)<=2000&&Math.abs(action.deltaY)<=2000;
    case 'screenshot': case 'visible_text': return exact();
    default: return false;
  }
}

/** Recheck every fence for a native Harness Agent browser action. This is
 * intentionally separate from ACP authorization: ACP settings never grant
 * a native Agent access to a Gateway browser. */
export async function nativeBrowserActionAllowed(db, row, payload) {
  if (payload?.nativeBrowserAction !== true || payload?.workspaceId !== row.org_id ||
      payload?.browserIdentity !== payload?.agentId || typeof payload.agentId !== 'string' ||
      !validNativeBrowserAction(payload.browserAction) || await getMode(db,row.org_id)!=='harness' ||
      !(await allowed(db,row.org_id,row.created_by,'harness.build')) ||
      !(await browserConversationAllowed(db,row.org_id,row.created_by,payload.browserContext))) return false;
  const setting=await db.prepare(`SELECT p.native_browser_enabled,p.native_browser_gateway_id,a.provider,a.id,a.scope,a.owner_login
    FROM hx_agent_profiles p JOIN custom_agents a ON a.org_id=p.org_id AND a.id=p.agent_id
    WHERE p.org_id=?1 AND p.agent_id=?2 AND a.deleted_at IS NULL`).bind(row.org_id,payload.agentId).first();
  const gateway=await db.prepare('SELECT id FROM hx_gateways WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL AND last_seen_at>?3')
    .bind(row.org_id,row.gateway_id,now()-90000).first();
  return Boolean(gateway && setting?.native_browser_enabled===1 && setting.native_browser_gateway_id===row.gateway_id && !setting.provider &&
    await mayRunAgent(db,row.org_id,setting,row.created_by));
}

export async function enqueueNativeBrowserAction(db, orgId, me, input) {
  me=String(me);
  if (!(await allowed(db,orgId,me,'harness.build')) || await getMode(db,orgId)!=='harness') return error('Native browser access is not allowed.',403);
  if (typeof input?.agentId!=='string' || !validNativeBrowserAction(input.browserAction)) return error('Invalid browser action.');
  const agent=await db.prepare(`SELECT p.native_browser_enabled,p.native_browser_gateway_id,a.id,a.scope,a.owner_login,a.provider
    FROM hx_agent_profiles p JOIN custom_agents a ON a.org_id=p.org_id AND a.id=p.agent_id
    WHERE p.org_id=?1 AND p.agent_id=?2 AND a.deleted_at IS NULL`).bind(orgId,input.agentId).first();
  if (!agent || agent.provider || agent.native_browser_enabled!==1 || !agent.native_browser_gateway_id ||
      !(await mayRunAgent(db,orgId,agent,me))) return error('This Agent has not enabled native browser access.',403);
  const gateway=await db.prepare('SELECT id FROM hx_gateways WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL AND last_seen_at>?3').bind(orgId,agent.native_browser_gateway_id,now()-90000).first();
  if (!gateway) return error('The selected execution node is offline.',409);
  if (!(await browserConversationAllowed(db,orgId,me,input.browserContext))) return error('The source conversation is no longer authorized.',403);
  const payload=JSON.stringify({nativeBrowserAction:true,workspaceId:orgId,agentId:input.agentId,browserIdentity:input.agentId,browserContext:input.browserContext,browserAction:input.browserAction});
  const requestId=typeof input.requestId==='string'&&/^[\w-]{1,80}$/.test(input.requestId)?input.requestId:id();
  const jobId=id();
  const inserted=await db.prepare(`INSERT OR IGNORE INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,'queued',?7 WHERE (SELECT COUNT(*) FROM hx_gateway_jobs WHERE org_id=?2 AND status IN ('queued','running'))<100
    AND EXISTS(SELECT 1 FROM hx_gateways WHERE id=?3 AND org_id=?2 AND revoked_at IS NULL)`).bind(jobId,orgId,gateway.id,me,requestId,payload,now()).run();
  if (!inserted.meta?.changes) return error('Queue is full or the browser action was already submitted.',409);
  return success({job:jobView(await db.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id=?1 AND id=?2').bind(orgId,jobId).first())},201);
}

function validateExecutionFiles(files) {
  if (files === undefined) return undefined;
  if (!Array.isArray(files) || files.length > MAX_FILE_COUNT) throw new Error('Invalid execution files.');
  const seen = new Set(), kinds = new Map();
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).sort().join(',') !== 'base64,path' ||
        typeof file.path !== 'string' || typeof file.base64 !== 'string') throw new Error('Invalid execution file.');
    const path = file.path;
    if (!path || path.length > 240 || path.startsWith('/') || path.includes('\\') || path.includes(':') ||
        /[\u0000-\u001f\u007f]/.test(path) || path.endsWith('/')) throw new Error('Invalid execution file path.');
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('Invalid execution file path.');
    if (seen.has(path)) throw new Error('Duplicate execution file path.');
    seen.add(path);
    for (let i=1;i<parts.length;i++) {
      const parent=parts.slice(0,i).join('/');
      if (seen.has(parent)) throw new Error('Conflicting execution file paths.');
      kinds.set(parent,'directory');
    }
    if (kinds.get(path)==='directory') throw new Error('Conflicting execution file paths.');
    kinds.set(path,'file');
    if (file.base64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3) || file.base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('Invalid execution file encoding.');
    const decoded = atob(file.base64);
    if (btoa(decoded) !== file.base64) throw new Error('Invalid execution file encoding.');
    const size = decoded.length;
    if (size > MAX_FILE_BYTES) throw new Error('Execution file is too large or invalid.');
    total += size;
    if (total > MAX_FILES_BYTES) throw new Error('Execution files are too large.');
  }
  return files;
}

export async function enqueueExecution(db, orgId, me, input, appAction = null) {
  me = String(me);
    if (!(await allowed(db, orgId, me, 'harness.build'))) return error('Execution is not allowed.', 403);
    const gateway = await db.prepare('SELECT id FROM hx_gateways WHERE org_id = ?1 AND id = ?2 AND revoked_at IS NULL').bind(orgId, String(input.gatewayId || '')).first();
    if (!gateway) return error('No such execution node.', 404);
    if (typeof input.code !== 'string' || !input.code.trim()) return error('JavaScript code is required.');
    if(input.language!==undefined&&!['javascript','typescript'].includes(input.language))return error('Unsupported execution language.');
    let files;
    try { files = validateExecutionFiles(input.files); } catch (e) { return error(e.message, 400); }
    const payload = JSON.stringify({ code: input.code, input: input.input ?? null, ...(input.language==='typescript'?{language:'typescript'}:{}), ...(files?.length?{files}:{}) });
    const baseBytes = new TextEncoder().encode(JSON.stringify({ code: input.code, input: input.input ?? null, ...(input.language==='typescript'?{language:'typescript'}:{}) })).length;
    if (baseBytes > 65536 || new TextEncoder().encode(payload).length > MAX_JOB_BYTES) return error('Execution input is too large.', 413);
    const requestId = input.requestId || id();
    if (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId)) return error('Invalid request ID.');
    const previous = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id = ?1 AND created_by = ?2 AND request_id = ?3').bind(orgId, me, requestId).first();
    if (previous) {
      if(previous.payload !== payload || previous.gateway_id !== gateway.id) return error('Request ID was already used for different input.',409);
      const current=await readExecution(db,orgId,me,previous.id);
      return current.error?current:success(current);
    }
    if (await getMode(db, orgId) === 'harness') {
      const budget = await workspaceBudgetAdmission(db, orgId);
      if (!budget.allowed) return error(budget.message, budget.status);
    }
    const jobIdNew = id();
    const insert = db.prepare(`INSERT OR IGNORE INTO hx_gateway_jobs (id, org_id, gateway_id, created_by, request_id, payload, status, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7 WHERE (SELECT COUNT(*) FROM hx_gateway_jobs WHERE org_id = ?2 AND status IN ('queued', 'running')) < 100
      AND EXISTS (SELECT 1 FROM hx_gateways WHERE id = ?3 AND org_id = ?2 AND revoked_at IS NULL)`)
      .bind(jobIdNew, orgId, gateway.id, me, requestId, payload, now());
    const r = appAction ? (await db.batch([insert, db.prepare('INSERT INTO hx_app_action_jobs (org_id,app_id,job_id,action_name,action_version,created_by) SELECT ?1,?2,?3,?4,?5,?6 WHERE changes()=1').bind(orgId,appAction.appId,jobIdNew,appAction.name,appAction.version,me)]))[0] : await insert.run();
    if (!r.meta?.changes) return error('Queue is full or the request was already submitted. Reload before retrying.', 409);
    return success({ job: jobView(await db.prepare('SELECT * FROM hx_gateway_jobs WHERE id = ?1').bind(jobIdNew).first()) }, 201);
}

/** Queue one ACP v1 prompt for a node that has opted into the ACP capability.
 * The payload carries an allowlist key only; executable, cwd, args, env, MCP
 * servers and client capabilities are resolved and fixed on the local node.
 */
export async function enqueueAcpExecution(db, orgId, me, input) {
  me = String(me);
  if (!(await allowed(db, orgId, me, 'harness.build'))) return error('Execution is not allowed.', 403);
  const gatewayId = String(input?.gatewayId || '');
  const agentKey = String(input?.agentKey || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(agentKey)) return error('Invalid local ACP agent key.');
  // A configured local Agent may accept work while its node is asleep. The
  // last advertised ACP key is durable; the claim path still checks that the
  // same key is present when the node reconnects.
  const gateway = await db.prepare(`SELECT g.id,g.name,g.last_seen_at AS lastSeenAt FROM hx_gateways g JOIN hx_gateway_acp_agents a ON a.org_id=g.org_id AND a.gateway_id=g.id AND a.agent_key=?3
    WHERE g.org_id=?1 AND g.id=?2 AND g.revoked_at IS NULL`).bind(orgId, gatewayId, agentKey).first();
  if (!gateway) return error('The execution node is revoked or does not advertise this ACP agent.', 409);
  if (typeof input?.prompt !== 'string' || !input.prompt.trim()) return error('ACP prompt is required.');
  // Keep the Simple experience usable even if an administrator enabled this
  // teammate's Harness-only tools earlier. No Workspace data is offered here.
  const harnessMode = await getMode(db, orgId) === 'harness';
  const workspaceTools = input.workspaceTools === true && harnessMode;
  const browserContext = input.browserContext && typeof input.browserContext === 'object' && !Array.isArray(input.browserContext)
    ? input.browserContext : null;
  const conversationContext = input.conversationContext && typeof input.conversationContext === 'object' && !Array.isArray(input.conversationContext)
    ? input.conversationContext : null;
  if (conversationContext && !(await browserConversationAllowed(db, orgId, me, conversationContext)))
    return error('The source conversation is no longer authorized.', 403);
  let browserTools = input.browserTools === true && harnessMode && input.conversationTask === true &&
    await browserConversationAllowed(db,orgId,me,browserContext);
  if (workspaceTools) {
    const budget = await workspaceBudgetAdmission(db, orgId);
    if (!budget.allowed) return error(budget.message, budget.status);
  }
  let acpAgentId = '';
  if (workspaceTools) {
    acpAgentId = String(input.agentId || '');
    const acpAgent = await db.prepare(`SELECT id,scope,owner_login FROM custom_agents
      WHERE org_id=?1 AND id=?2 AND provider='acp' AND deleted_at IS NULL`).bind(orgId, acpAgentId).first();
    if (!acpAgent || !(await mayRunAgent(db, orgId, acpAgent, me))) return error('This person may not use Workspace MCP tools through this ACP agent.', 403);
  }
  const context = Array.isArray(input.context) ? input.context.slice(-30).map(line => String(line || '').slice(0, 4000)) : [];
  const requestedBrowserIdentity=typeof input.agentId==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(input.agentId)?input.agentId:null;
  const browserIdentity=workspaceTools?acpAgentId:requestedBrowserIdentity||`local-${agentKey}`;
  const payload = JSON.stringify({ acp: true, agentKey, prompt: input.prompt.slice(0, 48000), ...(typeof input.sessionId === 'string' && input.sessionId.length <= 200 ? { sessionId: input.sessionId } : {}), ...(context.length ? { context } : {}), ...(conversationContext ? { conversationContext } : {}), ...(workspaceTools ? { workspaceTools: true, agentId: acpAgentId } : {}), ...(browserTools ? { browserTools: true, browserIdentity, workspaceId: orgId, browserContext } : {}) });
  if (new TextEncoder().encode(payload).length > 65536) return error('ACP prompt is too large.', 413);
  const jobId = id();
  const requestId = id();
  const result = await db.prepare(`INSERT OR IGNORE INTO hx_gateway_jobs (id, org_id, gateway_id, created_by, request_id, payload, status, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7 WHERE (SELECT COUNT(*) FROM hx_gateway_jobs WHERE org_id = ?2 AND status IN ('queued', 'running')) < 100
      AND EXISTS (SELECT 1 FROM hx_gateways WHERE id = ?3 AND org_id = ?2 AND revoked_at IS NULL)`)
    .bind(jobId, orgId, gateway.id, me, requestId, payload, now()).run();
  if (!result.meta?.changes) return error('Queue is full or the node was disconnected.', 409);
  const row = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE id = ?1').bind(jobId).first();
  const online = gateway.lastSeenAt !== null && now() - Number(gateway.lastSeenAt) <= 90_000;
  const nodeName = String(gateway.name || 'Execution node').slice(0, 60);
  const progress = { kind: 'thinking', title: online ? `Waiting for ${nodeName} to pick up this task` : `Waiting for ${nodeName} to reconnect`, status: 'pending' };
  await db.prepare('UPDATE hx_gateway_jobs SET acp_progress=?3,acp_progress_at=?4 WHERE org_id=?1 AND id=?2 AND status=\'queued\'')
    .bind(orgId, jobId, JSON.stringify(progress), now()).run();
  return success({ job: jobView(row) }, 201);
}

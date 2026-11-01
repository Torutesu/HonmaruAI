import { mayUseApp } from './resourceAccess.js';
import { allowed } from '../permissions.js';
import { mayViewWorkflow } from './workflows.js';
import { mayUseConversation } from './conversationAccess.js';
import {settleWorkflowProgram} from './workflowCodeJobs.js';
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
export async function enqueueExecution(db, orgId, me, input, appAction = null) {
  me = String(me);
    if (!(await allowed(db, orgId, me, 'harness.build'))) return error('Execution is not allowed.', 403);
    const gateway = await db.prepare('SELECT id FROM hx_gateways WHERE org_id = ?1 AND id = ?2 AND revoked_at IS NULL').bind(orgId, String(input.gatewayId || '')).first();
    if (!gateway) return error('No such execution node.', 404);
    if (typeof input.code !== 'string' || !input.code.trim()) return error('JavaScript code is required.');
    if(input.language!==undefined&&!['javascript','typescript'].includes(input.language))return error('Unsupported execution language.');
    const payload = JSON.stringify({ code: input.code, input: input.input ?? null, ...(input.language==='typescript'?{language:'typescript'}:{}) });
    if (new TextEncoder().encode(payload).length > 65536) return error('Execution input is too large.', 413);
    const requestId = input.requestId || id();
    if (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId)) return error('Invalid request ID.');
    const previous = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id = ?1 AND created_by = ?2 AND request_id = ?3').bind(orgId, me, requestId).first();
    if (previous) {
      if(previous.payload !== payload || previous.gateway_id !== gateway.id) return error('Request ID was already used for different input.',409);
      const current=await readExecution(db,orgId,me,previous.id);
      return current.error?current:success(current);
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
  const gateway = await db.prepare(`SELECT g.id FROM hx_gateways g JOIN hx_gateway_acp_agents a ON a.org_id=g.org_id AND a.gateway_id=g.id AND a.agent_key=?3
    WHERE g.org_id=?1 AND g.id=?2 AND g.revoked_at IS NULL AND g.last_seen_at>?4`).bind(orgId, gatewayId, agentKey, now()-90000).first();
  if (!gateway) return error('The execution node is offline or does not advertise this ACP agent.', 409);
  if (typeof input?.prompt !== 'string' || !input.prompt.trim()) return error('ACP prompt is required.');
  const context = Array.isArray(input.context) ? input.context.slice(-30).map(line => String(line || '').slice(0, 4000)) : [];
  const payload = JSON.stringify({ acp: true, agentKey, prompt: input.prompt.slice(0, 48000), ...(typeof input.sessionId === 'string' && input.sessionId.length <= 200 ? { sessionId: input.sessionId } : {}), ...(context.length ? { context } : {}) });
  if (new TextEncoder().encode(payload).length > 65536) return error('ACP prompt is too large.', 413);
  const jobId = id();
  const requestId = id();
  const result = await db.prepare(`INSERT OR IGNORE INTO hx_gateway_jobs (id, org_id, gateway_id, created_by, request_id, payload, status, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7 WHERE (SELECT COUNT(*) FROM hx_gateway_jobs WHERE org_id = ?2 AND status IN ('queued', 'running')) < 100
      AND EXISTS (SELECT 1 FROM hx_gateways WHERE id = ?3 AND org_id = ?2 AND revoked_at IS NULL)`)
    .bind(jobId, orgId, gateway.id, me, requestId, payload, now()).run();
  if (!result.meta?.changes) return error('Queue is full or the node was disconnected.', 409);
  const row = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE id = ?1').bind(jobId).first();
  return success({ job: jobView(row) }, 201);
}

import {workflowActivationState} from './workflowActivationState.js';
import {settleWorkflowProgram,workflowProgramJobAccess,workflowProgramAccessCTE} from './workflowCodeJobs.js';
import {WorkflowStateInputError} from './workflowState.js';
import { enqueueExecution, jobView, readExecution } from './executions.js';
import { HARNESS_TOOLS, callHarnessTool } from './mcpTools.js';
import { mayRunAgent } from './agents.js';
import { getMode } from './mode.js';
// Outbound-only execution nodes. A node token grants access to one workspace's
// assigned jobs, never to workspace files, agent memories or integration keys.
import { member, json } from './routes.js';
import { enforceSubject } from '../ratelimit.js';
import { allowed } from '../permissions.js';
const now = () => Date.now();
const id = () => crypto.randomUUID();
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
const failure = (message, status = 400) => json({ message }, status);
const activeMember = `(EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = hx_gateway_jobs.org_id AND m.user_github_id = hx_gateway_jobs.created_by AND m.role != 'guest') AND NOT EXISTS (SELECT 1 FROM hx_app_action_jobs j WHERE j.job_id=hx_gateway_jobs.id AND NOT EXISTS (SELECT 1 FROM hx_apps a LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id WHERE a.org_id=j.org_id AND a.id=j.app_id AND (COALESCE(p.visibility,'workspace')='workspace' OR a.created_by=hx_gateway_jobs.created_by))))`;


export const isGatewayNodeRoute = pathname => /^\/gateways\/(?:claim|jobs\/[^/]+\/(?:heartbeat|finish|state|mcp))\/?$/.test(pathname);

const ACP_READ_ONLY_TOOLS = new Set(['list_apps','read_app','list_tables','query_rows','list_workflows','list_followups']);
const acpReadTools = () => HARNESS_TOOLS.filter(tool => ACP_READ_ONLY_TOOLS.has(tool.name))
  .map(({name,title,description,inputSchema}) => ({name,title,description,inputSchema}));

async function acpWorkspacePrincipal(db, row, payload) {
  if (await getMode(db, row.org_id) !== 'harness' || !(await allowed(db,row.org_id,row.created_by,'harness.build'))) return null;
  const agent = await db.prepare(`SELECT id,scope,owner_login FROM custom_agents
    WHERE org_id=?1 AND id=?2 AND provider='acp' AND deleted_at IS NULL`).bind(row.org_id,payload.agentId).first();
  if (!agent || !(await mayRunAgent(db,row.org_id,agent,row.created_by))) return null;
  const person = await db.prepare('SELECT login FROM users WHERE github_id=?1').bind(String(row.created_by)).first();
  return person?.login ? {orgId:row.org_id,githubId:String(row.created_by),login:person.login} : null;
}

export async function expireGatewayJobs(db, at = now()) {
  const result=await db.prepare(`${workflowProgramAccessCTE('?1')} UPDATE hx_gateway_jobs SET status = 'failed', finished_at = ?1, lease_hash = NULL,
    result = '{"error":"Execution lease or requester access expired."}'
    WHERE (status = 'running' AND (lease_until <= ?1 OR deadline <= ?1 OR NOT ${activeMember} OR NOT ${workflowProgramJobAccess}))
       OR (status = 'queued' AND (created_at < ?1 - 3600000 OR NOT ${activeMember} OR NOT ${workflowProgramJobAccess}
        OR (json_extract(payload,'$.workflowProgram')=1 AND created_at < ?1 - 180000)))`).bind(at).run();
  // Also recover a committed node result whose HTTP response/settlement was
  // interrupted. Bound the cron/claim work; later ticks drain the remainder.
  const pending=await db.prepare(`SELECT a.job_id FROM hx_workflow_activations a
   JOIN hx_gateway_jobs j ON j.id=a.job_id AND j.org_id=a.org_id
   JOIN hx_workflow_runs r ON r.id=a.run_id AND r.org_id=a.org_id
   JOIN hx_workflow_run_definitions d ON d.run_id=r.id AND d.org_id=r.org_id
   JOIN hx_workflow_node_checkpoints c ON c.org_id=a.org_id AND c.run_id=a.run_id AND c.node_id=a.node_id AND c.owner=a.node_owner AND c.attempt=a.node_attempt
   WHERE r.status='running' AND j.status IN ('succeeded','failed','timed_out','cancelled')
    AND c.status IN ('running','unknown') AND a.node_id='program'
   ORDER BY j.finished_at,a.job_id LIMIT 25`).all();
  for(const row of pending.results||[])await settleWorkflowProgram(db,row.job_id);
  return result;
}

export async function handleGateways(request, env, url, input) {
  const parts = url.pathname.split('/').filter(Boolean);
  const db = env.DB;
  const nodeRoute = isGatewayNodeRoute(url.pathname);
  if (nodeRoute) {
    if (request.method !== 'POST') return failure('Method not allowed.', 405);
    const token = request.headers.get('authorization')?.match(/^Bearer (hgw_[A-Za-z0-9-]{64,100})$/)?.[1];
    if (!token) return failure('Node authentication required.', 401);
    const g = await db.prepare('SELECT * FROM hx_gateways WHERE token_hash = ?1 AND revoked_at IS NULL').bind(await digest(token)).first();
    if (!g) return failure('Node authentication required.', 401);
    const limited = await enforceSubject(env, 'gateway/node', `gateway:${g.id}`);
    if (limited) return limited;
    // Removing the registering administrator disables the node as well.
    if (!(await allowed(db, g.org_id, g.created_by, 'workspace.mode'))) return failure('Node owner access was revoked.', 403);
    const at = now();
    await db.prepare('UPDATE hx_gateways SET last_seen_at = ?2 WHERE id = ?1').bind(g.id, at).run();
    await db.prepare('UPDATE hx_gateway_acp_agents SET last_seen_at=?2 WHERE gateway_id=?1').bind(g.id,at).run();
    if (parts[1] === 'claim') {
      if (input?.acpAgents !== undefined) {
        if (!Array.isArray(input.acpAgents) || input.acpAgents.length > 20 || input.acpAgents.some(key => typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key))) return failure('Invalid local ACP agent registration.');
        const agentKeys=[...new Set(input.acpAgents)].sort();
        const registered=await db.prepare('SELECT agent_key FROM hx_gateway_acp_agents WHERE gateway_id=?1 ORDER BY agent_key').bind(g.id).all();
        const before=(registered.results||[]).map(row=>row.agent_key);
        if(JSON.stringify(before)!==JSON.stringify(agentKeys)) {
          const statements=[db.prepare('DELETE FROM hx_gateway_acp_agents WHERE gateway_id=?1').bind(g.id),...agentKeys.map(key=>db.prepare('INSERT INTO hx_gateway_acp_agents(org_id,gateway_id,agent_key,last_seen_at) VALUES(?1,?2,?3,?4)').bind(g.org_id,g.id,key,at))];
          await db.batch(statements);
        }
      }
      await expireGatewayJobs(db, at);
      const lease = secret();
      const programCapable=Array.isArray(input?.capabilities)&&input.capabilities.includes('workflow-program-v1');
      const acpCapable=Array.isArray(input?.capabilities)&&input.capabilities.includes('acp-v1');
      const row = await db.prepare(`${workflowProgramAccessCTE('?2')} UPDATE hx_gateway_jobs SET status = 'running', lease_hash = ?3, lease_until = ?2 + 90000, deadline = ?2 + 120000, started_at = ?2
        WHERE id = (SELECT id FROM hx_gateway_jobs WHERE gateway_id = ?1 AND status = 'queued'
          AND (?4=1 OR (COALESCE(json_extract(payload,'$.workflowProgram'),0)!=1 AND NOT EXISTS(SELECT 1 FROM hx_workflow_activations a WHERE a.job_id=hx_gateway_jobs.id)))
          AND (?5=1 OR COALESCE(json_extract(payload,'$.acp'),0)!=1)
          AND (COALESCE(json_extract(payload,'$.acp'),0)!=1 OR EXISTS(SELECT 1 FROM hx_gateway_acp_agents c WHERE c.org_id=hx_gateway_jobs.org_id AND c.gateway_id=hx_gateway_jobs.gateway_id AND c.agent_key=json_extract(hx_gateway_jobs.payload,'$.agentKey')))
          ORDER BY created_at, id LIMIT 1)
        AND status = 'queued' AND ${activeMember} AND ${workflowProgramJobAccess}
        AND NOT EXISTS (SELECT 1 FROM hx_gateway_jobs busy WHERE busy.gateway_id = ?1 AND busy.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM hx_document_jobs busy WHERE busy.gateway_id = ?1 AND busy.status = 'running') RETURNING *`)
        .bind(g.id, at, await digest(lease),programCapable?1:0,acpCapable?1:0).first();
      const workflow=row&&await db.prepare('SELECT 1 FROM hx_workflow_activations WHERE org_id=?1 AND job_id=?2').bind(row.org_id,row.id).first();
      const payload=row?JSON.parse(row.payload):null;
      return json({ job: row ? { ...jobView(row), workflow:Boolean(workflow), payload, lease, timeoutMs: payload?.acp===true?110000:60000 } : null });
    }
    if (typeof input?.lease !== 'string' || input.lease.length > 150) return failure('Execution lease required.', 409);
    const leaseHash = await digest(input.lease);
    const guard = `id = ?1 AND gateway_id = ?2 AND status = 'running' AND lease_hash = ?3 AND lease_until > ?4 AND deadline > ?4 AND ${activeMember} AND ${workflowProgramJobAccess}`;
    if (parts[3] === 'mcp') {
      const readJob = () => db.prepare(`${workflowProgramAccessCTE('?4')} SELECT payload,org_id,created_by FROM hx_gateway_jobs WHERE ${guard}`)
        .bind(parts[2],g.id,leaseHash,now()).first();
      const job = await readJob();
      if (!job) return failure('Execution is no longer authorized.',409);
      let payload;
      try { payload=JSON.parse(job.payload); } catch { return failure('Workspace MCP request is invalid.',400); }
      if (payload.acp !== true || payload.workspaceTools !== true || !payload.agentId) return failure('Workspace MCP tools were not enabled for this ACP task.',403);
      const principal=await acpWorkspacePrincipal(db,job,payload);
      if (!principal) return failure('Workspace or Agent access changed.',403);
      let result;
      if (input.method === 'tools/list') result={tools:acpReadTools()};
      else if (input.method === 'tools/call') {
        const name=typeof input.params?.name==='string'?input.params.name:'';
        if (!ACP_READ_ONLY_TOOLS.has(name)) return failure('This ACP Workspace tool is unavailable.',403);
        const args=input.params?.arguments&&typeof input.params.arguments==='object'&&!Array.isArray(input.params.arguments)?{...input.params.arguments}:{};
        if(name==='query_rows') {
          const limit=Number(args.limit),offset=Number(args.offset);
          args.limit=Number.isInteger(limit)&&limit>0?Math.min(limit,100):100;
          args.offset=Number.isInteger(offset)&&offset>=0?Math.min(offset,1000):0;
        }
        result=await callHarnessTool(env,principal,name,args);
        if (!result) return failure('This ACP Workspace tool is unavailable.',404);
        const fresh=await readJob();
        if (!fresh) return failure('Execution is no longer authorized.',409);
        let freshPayload;
        try { freshPayload=JSON.parse(fresh.payload); } catch { return failure('Workspace MCP request is invalid.',400); }
        if (freshPayload.agentId!==payload.agentId || freshPayload.workspaceTools!==true || !(await acpWorkspacePrincipal(db,fresh,freshPayload))) return failure('Workspace or Agent access changed.',403);
      } else return failure('Unsupported Workspace MCP method.',400);
      if (new TextEncoder().encode(JSON.stringify(result)).length>200000) return failure('Workspace MCP result is too large.',413);
      return json({result});
    }
    if (parts[3] === 'state') {
      if(new TextEncoder().encode(JSON.stringify(input)).length>165000)return failure('State request is too large.',413);
      try {
        const result=await workflowActivationState(db,{jobId:parts[2],gatewayId:g.id,leaseHash},input.operation,input.params,at);
        if(result.error)return failure(result.error,result.status);
        if(result.available===false||result.saved===false)return failure('State revision or activation is no longer current.',409);
        return json(result);
      } catch(error) {
        return error instanceof WorkflowStateInputError?failure(error.message,400):failure('State storage is temporarily unavailable.',503);
      }
    }
    if (parts[3] === 'heartbeat') {
      const r = await db.prepare(`${workflowProgramAccessCTE('?4')} UPDATE hx_gateway_jobs SET lease_until = MIN(?4 + 90000, deadline) WHERE ${guard}`).bind(parts[2], g.id, leaseHash, at).run();
      return r.meta?.changes ? json({ ok: true }) : failure('Execution is no longer authorized.', 409);
    }
    if (!['succeeded', 'failed', 'timed_out'].includes(input.status)) return failure('Invalid execution status.');
    const result = { stdout: String(input.stdout || ''), stderr: String(input.stderr || ''), exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 70000) return failure('Result is too large.', 413);
    // The lease's hash stays on a finished job, so the same node sending the
    // same result again (its first reply was lost) is told it is already
    // in rather than that it was refused. Nothing about the job changes.
    const r = await db.prepare(`${workflowProgramAccessCTE('?4')} UPDATE hx_gateway_jobs SET status = ?5, result = ?6, finished_at = ?4 WHERE ${guard}`)
      .bind(parts[2], g.id, leaseHash, at, input.status, JSON.stringify(result)).run();
    if (r.meta?.changes) { await settleWorkflowProgram(db,parts[2]); return json({ ok: true }); }
    const done = await db.prepare('SELECT 1 FROM hx_gateway_jobs WHERE id = ?1 AND gateway_id = ?2 AND lease_hash = ?3 AND status = ?4 AND result = ?5')
      .bind(parts[2], g.id, leaseHash, input.status, JSON.stringify(result)).first();
    if(done)await settleWorkflowProgram(db,parts[2]);
    return done ? json({ message: 'This execution already has this result.', code: 'already_finished' }, 409) : failure('Execution is no longer authorized.', 409);
  }

  const orgId = input?.orgId || url.searchParams.get('orgId');
  const who = await member(env, request, orgId);
  if (who.denied) return who.denied;
  const me = String(who.session.github_id);
  const admin = await allowed(db, orgId, me, 'workspace.mode');
  if (parts.length === 1) {
    if (request.method === 'GET') {
      const { results } = await db.prepare('SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM hx_gateways WHERE org_id = ?1 ORDER BY created_at DESC').bind(orgId).all();
      const gateways=[];
      for(const row of results||[]) {
        const agents=await db.prepare('SELECT agent_key FROM hx_gateway_acp_agents WHERE org_id=?1 AND gateway_id=?2 ORDER BY agent_key').bind(orgId,row.id).all();
        gateways.push({...row,acpAgents:(agents.results||[]).map(agent=>agent.agent_key)});
      }
      return json({ gateways, canManage: admin });
    }
    if (request.method !== 'POST') return failure('Method not allowed.', 405);
    if (!admin) return failure('Only an administrator can register an execution node.', 403);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) return failure('A node name of 1–80 characters is required.');
    const token = `hgw_${secret()}`, gatewayId = id();
    const r = await db.prepare(`INSERT INTO hx_gateways (id, org_id, name, token_hash, created_by, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT COUNT(*) FROM hx_gateways WHERE org_id = ?2 AND revoked_at IS NULL) < 5`)
      .bind(gatewayId, orgId, name, await digest(token), me, now()).run();
    if (!r.meta?.changes) return failure('This workspace already has five execution nodes.', 409);
    return json({ gateway: { id: gatewayId, name }, token }, 201);
  }
  if (parts[1] === 'jobs') {
    const jobId = parts[2];
    if (jobId) {
      const job = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id = ?1 AND id = ?2 AND created_by = ?3').bind(orgId, jobId, me).first();
      if (!job) return failure('No such execution.', 404);
      if (request.method === 'GET') { const r=await readExecution(db,orgId,me,jobId); return r.error?failure(r.error,r.status):json(r); }
      if (parts[3] === 'cancel' && request.method === 'POST') {
        const access=await readExecution(db,orgId,me,jobId);
        if(access.error)return failure(access.error,access.status);
        await db.prepare("UPDATE hx_gateway_jobs SET status = 'cancelled', lease_hash = NULL, finished_at = ?2 WHERE id = ?1 AND status IN ('queued', 'running')").bind(jobId, now()).run();
        await settleWorkflowProgram(db,jobId);
        return json({ cancelled: true });
      }
      return failure('Method not allowed.', 405);
    }
    if (request.method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id = ?1 AND created_by = ?2 ORDER BY created_at DESC LIMIT 100').bind(orgId, me).all();
      const jobs=[]; for(const row of results||[]) {const r=await readExecution(db,orgId,me,row.id);if(!r.error)jobs.push(r.job);} return json({jobs});
    }
    if (request.method !== 'POST') return failure('Method not allowed.', 405);
    const result = await enqueueExecution(db, orgId, me, input);
    if (result.error) return failure(result.error, result.status);
    return json({ job: result.job }, result.statusCode);
  }
  if (parts[2] === 'revoke' && request.method === 'POST') {
    if (!admin) return failure('Only an administrator can revoke an execution node.', 403);
    const at = now();
    const r = await db.batch([
      db.prepare('UPDATE hx_gateways SET revoked_at = ?3 WHERE org_id = ?1 AND id = ?2 AND revoked_at IS NULL').bind(orgId, parts[1], at),
      db.prepare("UPDATE hx_gateway_jobs SET status = 'cancelled', lease_hash = NULL, finished_at = ?3 WHERE org_id = ?1 AND gateway_id = ?2 AND status IN ('queued', 'running')").bind(orgId, parts[1], at),
    ]);
    return r[0].meta?.changes ? json({ revoked: true }) : failure('No such execution node.', 404);
  }
  return failure('No such endpoint.', 404);
}

import {workflowActivationState} from './workflowActivationState.js';
import {settleWorkflowProgram,workflowProgramJobAccess,workflowProgramAccessCTE} from './workflowCodeJobs.js';
import {WorkflowStateInputError} from './workflowState.js';
import { enqueueExecution, jobView, readExecution } from './executions.js';
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


export const isGatewayNodeRoute = pathname => /^\/gateways\/(?:claim|jobs\/[^/]+\/(?:heartbeat|finish|state))\/?$/.test(pathname);

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
    if (parts[1] === 'claim') {
      await expireGatewayJobs(db, at);
      const lease = secret();
      const programCapable=Array.isArray(input?.capabilities)&&input.capabilities.includes('workflow-program-v1');
      const row = await db.prepare(`${workflowProgramAccessCTE('?2')} UPDATE hx_gateway_jobs SET status = 'running', lease_hash = ?3, lease_until = ?2 + 90000, deadline = ?2 + 120000, started_at = ?2
        WHERE id = (SELECT id FROM hx_gateway_jobs WHERE gateway_id = ?1 AND status = 'queued'
          AND (?4=1 OR (COALESCE(json_extract(payload,'$.workflowProgram'),0)!=1 AND NOT EXISTS(SELECT 1 FROM hx_workflow_activations a WHERE a.job_id=hx_gateway_jobs.id)))
          ORDER BY created_at, id LIMIT 1)
        AND status = 'queued' AND ${activeMember} AND ${workflowProgramJobAccess}
        AND NOT EXISTS (SELECT 1 FROM hx_gateway_jobs busy WHERE busy.gateway_id = ?1 AND busy.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM hx_document_jobs busy WHERE busy.gateway_id = ?1 AND busy.status = 'running') RETURNING *`)
        .bind(g.id, at, await digest(lease),programCapable?1:0).first();
      const workflow=row&&await db.prepare('SELECT 1 FROM hx_workflow_activations WHERE org_id=?1 AND job_id=?2').bind(row.org_id,row.id).first();
      return json({ job: row ? { ...jobView(row), workflow:Boolean(workflow), payload: JSON.parse(row.payload), lease, timeoutMs: 60000 } : null });
    }
    if (typeof input?.lease !== 'string' || input.lease.length > 150) return failure('Execution lease required.', 409);
    const leaseHash = await digest(input.lease);
    const guard = `id = ?1 AND gateway_id = ?2 AND status = 'running' AND lease_hash = ?3 AND lease_until > ?4 AND deadline > ?4 AND ${activeMember} AND ${workflowProgramJobAccess}`;
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
      return json({ gateways: results || [], canManage: admin });
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

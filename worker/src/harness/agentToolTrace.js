export const MAX_AGENT_TOOL_STEPS_PER_GENERATION = 16;
export const AGENT_TOOL_TRACE_RETENTION_DAYS = 90;
const MAX_GENERATION = 8;
const TOOL_STATUSES = new Set(['running', 'completed', 'failed', 'interrupted', 'handed_off']);
const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 100;

export function cleanAgentToolName(value) {
  return String(value || '').normalize('NFKC').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'unknown_tool';
}

export function validAgentToolTraceScope(input) {
  return typeof input?.orgId === 'string' && input.orgId.length > 0 && input.orgId.length <= 200 && ID(input?.assignmentId) && ID(input?.sourceMessageId)
    && Number.isSafeInteger(input?.generation) && input.generation >= 0 && input.generation <= MAX_GENERATION;
}

export async function startAgentToolTrace(db, {orgId, assignmentId, generation, agentId, stepIndex, toolName, startedAt}) {
  if (typeof orgId !== 'string' || orgId.length === 0 || orgId.length > 200 || !ID(assignmentId) || !ID(agentId) || !Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION
    || !Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= MAX_AGENT_TOOL_STEPS_PER_GENERATION
    || typeof startedAt !== 'string' || startedAt.length > 64 || !Number.isFinite(Date.parse(startedAt))) return false;
  const result = await db.prepare(`INSERT INTO hx_agent_tool_steps
      (org_id,assignment_id,generation,agent_id,step_index,tool_name,status,started_at)
    SELECT ?1,?2,?3,?4,?5,?6,'running',?7
    WHERE EXISTS(SELECT 1 FROM hx_agent_assignments a WHERE a.org_id=?1 AND a.id=?2 AND a.generation=?3 AND a.current_agent_id=?4 AND a.status='running')
      AND (SELECT COUNT(*) FROM hx_agent_tool_steps s WHERE s.org_id=?1 AND s.assignment_id=?2 AND s.generation=?3) < ?8
    ON CONFLICT(org_id,assignment_id,generation,step_index) DO NOTHING`)
    .bind(orgId, assignmentId, generation, agentId, stepIndex, cleanAgentToolName(toolName), startedAt, MAX_AGENT_TOOL_STEPS_PER_GENERATION).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function finishAgentToolTrace(db, {orgId, assignmentId, generation, stepIndex, status, finishedAt, durationMs}) {
  if (typeof orgId !== 'string' || orgId.length === 0 || orgId.length > 200 || !ID(assignmentId) || !Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION
    || !Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= MAX_AGENT_TOOL_STEPS_PER_GENERATION
    || !TOOL_STATUSES.has(status) || status === 'running' || typeof finishedAt !== 'string' || finishedAt.length > 64 || !Number.isFinite(Date.parse(finishedAt))
    || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 600_000) return false;
  const result = await db.prepare(`UPDATE hx_agent_tool_steps SET status=?5,finished_at=?6,duration_ms=?7
    WHERE org_id=?1 AND assignment_id=?2 AND generation=?3 AND step_index=?4 AND status='running'`)
    .bind(orgId, assignmentId, generation, stepIndex, status, finishedAt, durationMs).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function readAgentToolTrace(db, {orgId, assignmentId, generation}) {
  if (typeof orgId !== 'string' || orgId.length === 0 || orgId.length > 200 || !ID(assignmentId) || !Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) return [];
  const {results} = await db.prepare(`SELECT s.generation,s.agent_id,s.step_index,s.tool_name,s.status,s.started_at,s.finished_at,s.duration_ms,
      c.name AS agent_name,c.handle AS agent_handle,c.emoji AS agent_emoji,c.avatar_url AS agent_avatar_url
    FROM hx_agent_tool_steps s JOIN custom_agents c ON c.org_id=s.org_id AND c.id=s.agent_id
    WHERE s.org_id=?1 AND s.assignment_id=?2 AND s.generation<=?3
    ORDER BY s.generation,s.step_index LIMIT 144`).bind(orgId, assignmentId, generation).all();
  return (results || []).map(row => ({
    generation: row.generation, stepIndex: row.step_index,
    agent: {id: row.agent_id, name: row.agent_name || '', handle: row.agent_handle || '', emoji: row.agent_emoji || null, avatarUrl: row.agent_avatar_url || null},
    toolName: cleanAgentToolName(row.tool_name), status: TOOL_STATUSES.has(row.status) ? row.status : 'interrupted',
    startedAt: row.started_at, ...(row.finished_at ? {finishedAt: row.finished_at} : {}),
    ...(Number.isSafeInteger(row.duration_ms) ? {durationMs: row.duration_ms} : {}),
  }));
}

export async function closeOpenAgentToolTraces(db, {orgId, assignmentId, generation, at = new Date().toISOString()}) {
  if (typeof orgId !== 'string' || orgId.length === 0 || orgId.length > 200 || !ID(assignmentId) || !Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION || !Number.isFinite(Date.parse(at))) return 0;
  const result = await db.prepare(`UPDATE hx_agent_tool_steps SET status='interrupted',finished_at=?4,
      duration_ms=MIN(600000,MAX(0,CAST((julianday(?4)-julianday(started_at))*86400000 AS INTEGER)))
    WHERE org_id=?1 AND assignment_id=?2 AND generation=?3 AND status='running'`)
    .bind(orgId, assignmentId, generation, at).run();
  return Number(result?.meta?.changes || 0);
}

export async function pruneAgentToolTraces(db, {now = Date.now()} = {}) {
  const stamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(stamp)) return {interrupted: 0, deleted: 0};
  const current = new Date(stamp).toISOString();
  const staleBefore = new Date(stamp - 10 * 60_000).toISOString();
  const expiredBefore = new Date(stamp - AGENT_TOOL_TRACE_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const interrupted = await db.prepare(`UPDATE hx_agent_tool_steps SET status='interrupted',finished_at=?1,
      duration_ms=MIN(600000,MAX(0,CAST((julianday(?1)-julianday(started_at))*86400000 AS INTEGER)))
    WHERE status='running' AND started_at<?2 AND started_at>=?3`).bind(current, staleBefore, expiredBefore).run();
  const deleted = await db.prepare('DELETE FROM hx_agent_tool_steps WHERE started_at<?1').bind(expiredBefore).run();
  return {interrupted: Number(interrupted?.meta?.changes || 0), deleted: Number(deleted?.meta?.changes || 0)};
}

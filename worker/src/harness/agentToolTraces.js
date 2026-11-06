const MAX_STEPS = 16;
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;

const safeTime = value => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

/** Keep only the small, non-sensitive execution summary shown in a reply. */
export function normalizeAgentToolTrace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.steps)) return null;
  const startedAt = safeTime(value.startedAt);
  const finishedAt = safeTime(value.finishedAt);
  if (!startedAt || !finishedAt) return null;
  const steps = value.steps.slice(0, MAX_STEPS).flatMap(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const name = String(step.name || '').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64);
    const status = ['completed', 'failed', 'interrupted'].includes(step.status) ? step.status : null;
    const elapsedMs = Number(step.elapsedMs);
    if (!name || !status || !Number.isFinite(elapsedMs)) return [];
    return [{ name, status, elapsedMs: Math.max(0, Math.min(MAX_ELAPSED_MS, Math.round(elapsedMs))) }];
  });
  if (!steps.length) return null;
  const elapsed = Number(value.elapsedMs);
  return {
    startedAt,
    finishedAt,
    elapsedMs: Number.isFinite(elapsed)
      ? Math.max(0, Math.min(MAX_ELAPSED_MS, Math.round(elapsed)))
      : Math.max(0, Math.min(MAX_ELAPSED_MS, Date.parse(finishedAt) - Date.parse(startedAt))),
    steps,
  };
}

export async function storeAgentToolTrace(db, { orgId, messageId, channel, agentId, runBy, trace }) {
  const safe = normalizeAgentToolTrace(trace);
  if (!safe) return false;
  const createdAt = new Date().toISOString();
  const result = await db.prepare(`
    INSERT INTO hx_agent_tool_traces
      (org_id, message_id, agent_id, channel, run_by, started_at, finished_at, elapsed_ms, steps_json, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE EXISTS (
       SELECT 1 FROM channel_messages m
        WHERE m.org_id = ?1 AND m.id = ?2 AND m.channel = ?4
          AND m.kind = 'agent' AND m.author_login = 'agent:' || ?3 AND m.deleted_at IS NULL
     )
    ON CONFLICT (org_id, message_id) DO UPDATE SET
      agent_id = excluded.agent_id, channel = excluded.channel, run_by = excluded.run_by,
      started_at = excluded.started_at, finished_at = excluded.finished_at,
      elapsed_ms = excluded.elapsed_ms, steps_json = excluded.steps_json, created_at = excluded.created_at
  `).bind(orgId, messageId, agentId, channel, String(runBy), safe.startedAt, safe.finishedAt,
    safe.elapsedMs, JSON.stringify(safe.steps), createdAt).run();
  return Boolean(result.meta?.changes);
}

export function traceFromRow(row) {
  if (!row) return null;
  try {
    return normalizeAgentToolTrace({
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      elapsedMs: row.elapsed_ms,
      steps: JSON.parse(row.steps_json),
    });
  } catch {
    return null;
  }
}

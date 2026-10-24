// Authenticated webhook input retained while paused. A resume is not a replay.
export const HELD_LIMIT = 1000;
export const HELD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function readHeldWorkflowEvent(db, orgId, workflowId, eventId) {
  const row = await db.prepare(`SELECT id,input,received_at AS receivedAt,expires_at AS expiresAt
    FROM hx_workflow_held_events WHERE org_id=?1 AND workflow_id=?2 AND id=?3 AND run_id IS NULL AND expires_at>?4`)
    .bind(orgId, workflowId, eventId, new Date().toISOString()).first();
  return row ? { ...row, input: JSON.parse(row.input) } : null;
}

export async function heldWorkflowSummary(db, orgId, workflowId) {
  const at = new Date().toISOString();
  const { results } = await db.prepare(`SELECT id,received_at AS receivedAt,expires_at AS expiresAt
    FROM hx_workflow_held_events WHERE org_id=?1 AND workflow_id=?2 AND run_id IS NULL AND expires_at>?3 ORDER BY received_at,id LIMIT 1000`)
    .bind(orgId, workflowId, at).all();
  // One read keeps the count, review batch and discard snapshot consistent.
  return { count: results.length, oldestExpiry: results[0]?.expiresAt || null, events: results.slice(0, 25), discardEventIds: results.map(event => event.id) };
}

export async function discardWorkflowEvents(db, orgId, workflowId, eventIds) {
  if (!Array.isArray(eventIds) || !eventIds.length || eventIds.length > HELD_LIMIT ||
    eventIds.some(id => typeof id !== 'string' || id.length > 100) || new Set(eventIds).size !== eventIds.length) {
    return { error: 'Select between 1 and 1000 distinct held events.', status: 400 };
  }
  const result = await db.prepare(`DELETE FROM hx_workflow_held_events WHERE org_id=?1 AND workflow_id=?2 AND run_id IS NULL
    AND id IN (SELECT value FROM json_each(?3))`).bind(orgId, workflowId, JSON.stringify(eventIds)).run();
  return { discarded: Number(result.meta?.changes || 0) };
}

export async function holdWorkflowEvent(db, workflow, secret, input) {
  const at = new Date().toISOString();
  const expires = new Date(Date.now() + HELD_TTL_MS).toISOString();
  const id = `held_${crypto.randomUUID().replace(/-/g, '')}`;
  // Purge expired bodies before accepting another delivery. The cap and live
  // credential/state check are in the insert, not a separate read-then-write.
  const results = await db.batch([
    db.prepare('DELETE FROM hx_workflow_held_events WHERE org_id=?1 AND workflow_id=?2 AND expires_at<=?3')
      .bind(workflow.orgId, workflow.id, at),
    db.prepare(`INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at)
      SELECT ?1,org_id,id,?2,?3,?4 FROM hx_workflows
      WHERE org_id=?5 AND id=?6 AND (enabled=0 OR EXISTS(SELECT 1 FROM hx_workflow_safety s WHERE s.org_id=hx_workflows.org_id AND s.workflow_id=hx_workflows.id AND s.paused_at IS NOT NULL)) AND hook_secret=?7 AND json_extract(trigger,'$.type')='webhook'
      AND (SELECT COUNT(*) FROM hx_workflow_held_events WHERE org_id=?5 AND workflow_id=?6 AND run_id IS NULL AND expires_at>?3) < ?8`)
      .bind(id, JSON.stringify(input), at, expires, workflow.orgId, workflow.id, secret, HELD_LIMIT),
  ]);
  if (results[1].meta?.changes) return { id, expiresAt: expires };
  const current = await db.prepare(`SELECT enabled,hook_secret,trigger FROM hx_workflows WHERE org_id=?1 AND id=?2`)
    .bind(workflow.orgId, workflow.id).first();
  if (!current || current.hook_secret !== secret || JSON.parse(current.trigger).type !== 'webhook') return { error: 'No such hook.', status: 404 };
  if (current.enabled) return { error: 'The workflow changed. Retry this delivery.', status: 409 };
  return { error: 'The paused webhook queue is full.', status: 429 };
}

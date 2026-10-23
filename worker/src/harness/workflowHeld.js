// Authenticated webhook input retained while paused. A resume is not a replay.
export const HELD_LIMIT = 1000;
export const HELD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function heldWorkflowSummary(db, orgId, workflowId) {
  const at = new Date().toISOString();
  const row = await db.prepare(`SELECT COUNT(*) AS count, MIN(expires_at) AS oldestExpiry
    FROM hx_workflow_held_events WHERE org_id=?1 AND workflow_id=?2 AND run_id IS NULL AND expires_at>?3`)
    .bind(orgId, workflowId, at).first();
  const { results } = await db.prepare(`SELECT id,received_at AS receivedAt,expires_at AS expiresAt
    FROM hx_workflow_held_events WHERE org_id=?1 AND workflow_id=?2 AND run_id IS NULL AND expires_at>?3 ORDER BY received_at,id LIMIT 25`)
    .bind(orgId, workflowId, at).all();
  return { count: Number(row?.count || 0), oldestExpiry: row?.oldestExpiry || null, events: results };
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
      WHERE org_id=?5 AND id=?6 AND enabled=0 AND hook_secret=?7 AND json_extract(trigger,'$.type')='webhook'
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

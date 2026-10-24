// Operational safety is independent of the published workflow definition.
// These helpers are internal: routes must authorize workflow access first.
export async function ensureWorkflowSafety(db, orgId, workflowId) {
  await db.prepare(`INSERT OR IGNORE INTO hx_workflow_safety(org_id,workflow_id,generation)
    SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?1 AND id=?2)`)
    .bind(orgId,workflowId,crypto.randomUUID()).run();
  return readWorkflowSafety(db,orgId,workflowId);
}
export async function readWorkflowSafety(db,orgId,workflowId) {
  return db.prepare('SELECT generation,failure_streak,paused_at,pause_reason FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
}
export async function resumeWorkflowSafety(db,orgId,workflowId,generation) {
  const result=await db.prepare(`UPDATE hx_workflow_safety SET generation=?1,failure_streak=0,paused_at=NULL,pause_reason=NULL
    WHERE org_id=?2 AND workflow_id=?3 AND generation=?4 AND EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?2 AND id=?3)`)
    .bind(crypto.randomUUID(),orgId,workflowId,generation).run();
  return !!result.meta?.changes;
}
// Append to the transaction which marks a run terminal. The persisted
// definition freezes generation at admission; callers cannot supply outcomes.
export function workflowSettlementStatements(db,orgId,runId) {
  const claim=crypto.randomUUID(),at=new Date().toISOString();
  return [
    db.prepare(`INSERT OR IGNORE INTO hx_workflow_outcomes(org_id,run_id,workflow_id,generation,status,claim_id)
      SELECT r.org_id,r.id,r.workflow_id,s.generation,r.status,?3 FROM hx_workflow_runs r
      JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
      JOIN hx_workflow_safety s ON s.org_id=r.org_id AND s.workflow_id=r.workflow_id
      WHERE r.org_id=?1 AND r.id=?2 AND r.status IN ('done','failed','declined','cancelled')
      AND s.generation=json_extract(d.definition,'$.safetyGeneration') AND s.paused_at IS NULL`)
      .bind(orgId,runId,claim),
    db.prepare(`UPDATE hx_workflow_safety SET
      failure_streak=CASE WHEN (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN failure_streak+1 ELSE 0 END,
      paused_at=CASE WHEN failure_streak>=2 AND (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN ?4 ELSE NULL END,
      pause_reason=CASE WHEN failure_streak>=2 AND (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN 'consecutive_failures' ELSE NULL END
      WHERE org_id=?1 AND EXISTS(SELECT 1 FROM hx_workflow_outcomes o WHERE o.org_id=?1 AND o.run_id=?2 AND o.claim_id=?3 AND o.workflow_id=hx_workflow_safety.workflow_id AND o.generation=hx_workflow_safety.generation)`)
      .bind(orgId,runId,claim,at),
    db.prepare(`INSERT OR IGNORE INTO hx_workflow_safety_notices(org_id,workflow_id,generation,run_id,recipient_id,created_at)
      SELECT s.org_id,s.workflow_id,s.generation,?2,w.created_by,?4 FROM hx_workflow_safety s
      JOIN hx_workflows w ON w.org_id=s.org_id AND w.id=s.workflow_id
      JOIN hx_workflow_outcomes o ON o.org_id=s.org_id AND o.workflow_id=s.workflow_id AND o.generation=s.generation
      WHERE s.org_id=?1 AND o.run_id=?2 AND o.claim_id=?3 AND s.paused_at IS NOT NULL`)
      .bind(orgId,runId,claim,at),
  ];
}

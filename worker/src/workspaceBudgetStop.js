import { workflowSettlementStatements } from "./harness/workflowSafety.js";

// Cancel deployment-pinned active workflows, even before the first AI call.
// For legacy runs without an admission-time pin, infer deployment source only
// from exclusively deployment-key usage; ambiguous history fails open.
export async function cancelDeploymentBudgetWorkflowRuns(db, orgId, at = new Date().toISOString()) {
  if (!db || typeof orgId !== "string" || !orgId) return 0;
  const { results = [] } = await db.prepare(`
    UPDATE hx_workflow_runs SET
      status='cancelled',
      log=CASE WHEN json_valid(log)
        THEN json_insert(log,'$[#]',json_object('status','cancelled','reason','workspace_budget_exceeded','at',?2))
        ELSE '[]' END,
      finished_at=?2
    WHERE org_id=?1 AND status='running'
      AND (credential_source='deployment' OR (
        credential_source='unknown'
        AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.run_id=hx_workflow_runs.id AND u.byok=0)
      ))
      AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.run_id=hx_workflow_runs.id AND u.byok=1)
    RETURNING id
  `).bind(orgId, at).all();
  if (!results.length) return 0;

  // Persist terminal workflow outcomes so safety counters and run history stay
  // in sync. Cancellation itself is already committed if settlement fails.
  for (let offset = 0; offset < results.length; offset += 30) {
    const statements = results.slice(offset, offset + 30).flatMap(({ id }) => [
      db.prepare(`UPDATE hx_gateway_jobs SET status='cancelled',lease_hash=NULL,finished_at=?3
        WHERE org_id=?1 AND status IN ('queued','running')
          AND EXISTS(SELECT 1 FROM hx_workflow_activations a WHERE a.org_id=?1 AND a.run_id=?2 AND a.job_id=hx_gateway_jobs.id)`)
        .bind(orgId, id, Date.parse(at)),
      ...workflowSettlementStatements(db, orgId, id),
    ]);
    await db.batch(statements);
  }
  return results.length;
}

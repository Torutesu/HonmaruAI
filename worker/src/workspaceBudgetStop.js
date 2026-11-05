// Stop already-queued or running execution-node work when the shared
// deployment-key budget is exhausted. The gateway's next heartbeat sees the
// cleared lease and aborts its isolated process; queued jobs never get claimed.
export async function cancelWorkspaceGatewayJobs(db, orgId, at = Date.now()) {
  if (!db || typeof orgId !== "string" || !orgId) return 0;
  const { results = [] } = await db.prepare(
    "SELECT id FROM hx_gateway_jobs WHERE org_id=?1 AND status IN ('queued','running') ORDER BY id"
  ).bind(orgId).all();
  if (!results.length) return 0;

  const update = await db.prepare(
    "UPDATE hx_gateway_jobs SET status='cancelled',lease_hash=NULL,finished_at=?2 WHERE org_id=?1 AND status IN ('queued','running')"
  ).bind(orgId, at).run();
  const cancelled = Number(update.meta?.changes) || 0;
  if (!cancelled) return 0;

  // Workflow-program jobs need their durable workflow run settled as cancelled.
  // Keep budget denial fail-closed even if this best-effort history update fails.
  try {
    const { settleWorkflowProgram } = await import('./harness/workflowCodeJobs.js');
    await Promise.allSettled(results.map(row => settleWorkflowProgram(db, row.id)));
  } catch (error) {
    console.error('workspace budget workflow settlement failed', error?.message || error);
  }
  return cancelled;
}

// SQL expressions are supplied only by internal callers (bound parameter
// names), never by a request. Standalone workflows keep their old behavior.
export function managedAutomationGuard(org='?1',workflow='?2',release='?3') {
  return `(NOT EXISTS(SELECT 1 FROM hx_app_automation_bindings b WHERE b.org_id=${org} AND b.workflow_id=${workflow})
    OR EXISTS(SELECT 1 FROM hx_app_automation_bindings b
      JOIN hx_app_automation_state s ON s.org_id=b.org_id AND s.app_id=b.app_id
      JOIN hx_apps a ON a.org_id=b.org_id AND a.id=b.app_id
      JOIN hx_workflows w ON w.org_id=b.org_id AND w.id=b.workflow_id
      WHERE b.org_id=${org} AND b.workflow_id=${workflow} AND b.release_id=${release} AND s.release_id=b.release_id
        AND s.published IS NOT NULL AND w.enabled=1
        AND (json_type(a.definition,'$.custom') IS NULL OR length(json_extract(a.definition,'$.custom.published'))>0)
        AND EXISTS(SELECT 1 FROM json_each(s.published,'$.items') item
          WHERE json_extract(item.value,'$.key')=b.declaration_key AND json_extract(item.value,'$.enabled')=1)))`;
}
export async function managedAutomationRelease(db,orgId,workflowId) {
  return (await db.prepare('SELECT release_id FROM hx_app_automation_bindings WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first())?.release_id || null;
}
export async function managedAutomationMayRun(db,orgId,workflowId,releaseId) {
  const row=await db.prepare(`SELECT CASE WHEN ${managedAutomationGuard()} THEN 1 ELSE 0 END AS permitted`).bind(orgId,workflowId,releaseId || null).first();
  return row?.permitted===1;
}

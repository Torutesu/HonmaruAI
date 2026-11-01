// Authorize every schema that may enter a model prompt at the same instant.
// Captured app entities must still have the same keys and table identities;
// extra workspace tables are also checked because automation prompts list them.
export async function mayGenerateFromSchema(db, orgId, appId, userId, entities, extraTables = []) {
  if (!userId || !Array.isArray(entities) || !entities.length || entities.some(e => !e?.key || !e.table?.id)) return false;
  const references = entities.map(e => ({key:e.key, id:e.table.id}));
  const tableIds = [...new Set([...references.map(e=>e.id), ...extraTables])];
  if (tableIds.some(id => typeof id !== 'string' || !id)) return false;
  const row = await db.prepare(`SELECT 1 AS allowed FROM memberships m
    JOIN hx_apps target ON target.org_id=m.org_id AND target.id=?2
    LEFT JOIN hx_app_access policy ON policy.org_id=target.org_id AND policy.app_id=target.id
    WHERE m.org_id=?1 AND m.user_github_id=?3 AND lower(coalesce(m.role,'guest'))!='guest'
      AND (target.created_by=?3 OR lower(m.role) IN ('admin','owner'))
      AND (coalesce(policy.visibility,'workspace')='workspace' OR target.created_by=?3)
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)
      AND (SELECT count(*)+1 FROM hx_app_entities WHERE org_id=?1 AND app_id=?2)=json_array_length(?4)
      AND NOT EXISTS(SELECT 1 FROM json_each(?4) e WHERE NOT (
        (json_extract(e.value,'$.key')='primary' AND target.table_id=json_extract(e.value,'$.id')) OR
        EXISTS(SELECT 1 FROM hx_app_entities current WHERE current.org_id=?1 AND current.app_id=?2
          AND current.entity_key=json_extract(e.value,'$.key') AND current.table_id=json_extract(e.value,'$.id'))))
      AND NOT EXISTS(SELECT 1 FROM json_each(?5) scope WHERE
        NOT EXISTS(SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=scope.value)
        OR EXISTS(SELECT 1 FROM (
          SELECT a.id FROM hx_apps a WHERE a.org_id=?1 AND a.table_id=scope.value
          UNION SELECT e.app_id AS id FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=scope.value
        ) refs LEFT JOIN hx_apps linked ON linked.org_id=?1 AND linked.id=refs.id
          LEFT JOIN hx_app_access p ON p.org_id=linked.org_id AND p.app_id=linked.id
          WHERE linked.id IS NULL OR (coalesce(p.visibility,'workspace')!='workspace' AND linked.created_by IS NOT ?3)))`)
    .bind(orgId,appId,String(userId),JSON.stringify(references),JSON.stringify(tableIds)).first();
  return Boolean(row);
}

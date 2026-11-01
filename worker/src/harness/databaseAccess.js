// A database operation needs access to every current table and every table
// retained in an older snapshot, including every app linked to those tables.
// Parameter expressions are supplied by the caller, never by the request.
export function databaseAuthority(org, app, user, extraTables = "'[]'", manage = false) {
  return `EXISTS(SELECT 1 FROM memberships m JOIN hx_apps target ON target.org_id=m.org_id AND target.id=${app}
    LEFT JOIN hx_app_access target_policy ON target_policy.org_id=target.org_id AND target_policy.app_id=target.id
    WHERE m.org_id=${org} AND m.user_github_id=${user} AND lower(coalesce(m.role,'member'))!='guest'
      AND (coalesce(target_policy.visibility,'workspace')='workspace' OR target.created_by=${user})
      ${manage ? `AND (target.created_by=${user} OR lower(coalesce(m.role,'member')) IN ('admin','owner'))` : ''}
      AND NOT EXISTS (SELECT 1 FROM (
        SELECT target.table_id AS id UNION SELECT table_id FROM hx_app_entities WHERE org_id=${org} AND app_id=${app}
        UNION SELECT value AS id FROM json_each(${extraTables})
      ) scope WHERE NOT EXISTS (SELECT 1 FROM hx_tables t WHERE t.org_id=${org} AND t.id=scope.id)
        OR EXISTS(SELECT 1 FROM (
          SELECT id FROM hx_apps WHERE org_id=${org} AND table_id=scope.id
          UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id=${org} AND table_id=scope.id
        ) linked LEFT JOIN hx_apps a ON a.org_id=${org} AND a.id=linked.id
          LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id
          WHERE a.id IS NULL OR (coalesce(p.visibility,'workspace')!='workspace' AND a.created_by IS NOT ${user}))))`;
}

export async function mayUseDatabase(db, orgId, appId, userId, tableIds = [], manage = false) {
  const check = databaseAuthority('?1','?2','?3','?4',manage);
  return Boolean(await db.prepare(`SELECT 1 AS ok WHERE ${check}`).bind(orgId,appId,String(userId),JSON.stringify(tableIds)).first());
}

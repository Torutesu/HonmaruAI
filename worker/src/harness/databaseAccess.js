function roomAccess(policy, org, user) {
  const room = policy + '.room_channel';
  return `(
    NOT EXISTS(SELECT 1 FROM hx_room_access tombstone WHERE tombstone.org_id=${org} AND tombstone.channel=${room} AND tombstone.deleted_at IS NOT NULL)
    AND (EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=${org} AND 'b:'||b.slug=${room}
        AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login
          WHERE cm.org_id=${org} AND cm.channel=${room} AND roomUser.github_id=${user})))
      OR EXISTS(SELECT 1 FROM conversation_members cm JOIN users roomUser ON roomUser.login=cm.login
        WHERE cm.org_id=${org} AND cm.channel=${room} AND length(${room})=18 AND substr(${room},1,2)='g:' AND substr(${room},3) NOT GLOB '*[^0-9a-f]*' AND roomUser.github_id=${user})
      OR EXISTS(SELECT 1 FROM users dmUser WHERE dmUser.github_id=${user} AND ${room} LIKE 'dm:%'
        AND instr('|'||substr(${room},4)||'|','|'||dmUser.login||'|')>0))
  )`;
}

// `mayUseApp` permits the owner, an explicit person grant, a workspace
// audience, or membership in the selected Room. Schema and preview writes
// use the corresponding edit decision and are also fenced in their SQL writes.
function appPermission(app, policy, person, membership, org, user, required) {
  if (required === 'edit') {
    return `(${app}.created_by=${user}
      OR COALESCE(${person}.permission='edit',0)
      OR (${person}.user_github_id IS NULL AND COALESCE(${policy}.visibility,'workspace')='workspace'
        AND LOWER(TRIM(COALESCE(${membership}.role,'guest'))) IN ('owner','admin')))`;
  }
  return `(${app}.created_by=${user}
    OR COALESCE(${person}.permission IN ('view','edit'),0)
    OR (${person}.user_github_id IS NULL AND (COALESCE(${policy}.visibility,'workspace')='workspace'
      OR (${policy}.room_channel IS NOT NULL AND ${roomAccess(policy,org,user)}))))`;
}

// A database operation needs access to every current table and every table
// retained in an older snapshot, including every app linked to those tables.
// Parameter expressions are supplied by the caller, never by the request.
export function databaseAuthority(org, app, user, extraTables = "'[]'", manage = false) {
  const permission = manage ? 'edit' : 'view';
  const linkedPermission = appPermission('linkedApp','linkedPolicy','linkedPerson','m',org,user,permission);
  const targetPermission = appPermission('target','targetPolicy','targetPerson','m',org,user,permission);
  const scopeTables = `SELECT target.table_id AS id UNION SELECT table_id FROM hx_app_entities WHERE org_id=${org} AND app_id=${app}
    UNION SELECT value AS id FROM json_each(${extraTables})`;
  const linkedApps = `SELECT id FROM hx_apps WHERE org_id=${org} AND table_id IN (SELECT id FROM (${scopeTables}))
    UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id=${org} AND table_id IN (SELECT id FROM (${scopeTables}))`;
  return `EXISTS(SELECT 1 FROM memberships m JOIN hx_apps target ON target.org_id=m.org_id AND target.id=${app}
    LEFT JOIN hx_app_access targetPolicy ON targetPolicy.org_id=target.org_id AND targetPolicy.app_id=target.id
    LEFT JOIN hx_app_person_access targetPerson ON targetPerson.org_id=target.org_id AND targetPerson.app_id=target.id AND targetPerson.user_github_id=${user}
    WHERE m.org_id=${org} AND m.user_github_id=${user} AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
      AND target.deleted_at IS NULL AND ${targetPermission}
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=m.org_id AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=m.org_id)
      AND NOT EXISTS (SELECT 1 FROM (${scopeTables}) scope WHERE NOT EXISTS (SELECT 1 FROM hx_tables t WHERE t.org_id=${org} AND t.id=scope.id))
      AND NOT EXISTS(SELECT 1 FROM (${linkedApps}) linked LEFT JOIN hx_apps linkedApp ON linkedApp.org_id=${org} AND linkedApp.id=linked.id
          LEFT JOIN hx_app_access linkedPolicy ON linkedPolicy.org_id=linkedApp.org_id AND linkedPolicy.app_id=linkedApp.id
          LEFT JOIN hx_app_person_access linkedPerson ON linkedPerson.org_id=linkedApp.org_id AND linkedPerson.app_id=linkedApp.id AND linkedPerson.user_github_id=${user}
          WHERE linkedApp.id IS NULL OR linkedApp.deleted_at IS NOT NULL OR NOT ${linkedPermission}))`;
}

export async function mayUseDatabase(db, orgId, appId, userId, tableIds = [], manage = false) {
  if (!userId) return false;
  const check = databaseAuthority('?1','?2','?3','?4',manage);
  return Boolean(await db.prepare(`SELECT 1 AS ok WHERE ${check}`).bind(orgId,appId,String(userId),JSON.stringify(tableIds)).first());
}

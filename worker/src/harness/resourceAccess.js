import { readableConversation, mayUseConversation } from './conversationAccess.js';

// Explicit app visibility. Absence means the legacy workspace-wide policy.
// Room links are navigation only; they never grant access to a private app.
export async function appAccess(db, orgId, appId) {
  const row = await db.prepare(`SELECT a.created_by, p.visibility, p.version, p.room_channel FROM hx_apps a
    LEFT JOIN hx_app_access p ON p.org_id = a.org_id AND p.app_id = a.id
    WHERE a.org_id = ?1 AND a.id = ?2`).bind(orgId, appId).first();
  return row ? { ownerId: row.created_by, visibility: row.room_channel ? 'room' : (row.visibility || 'workspace'), roomChannel: row.room_channel || null, version: row.version || 0 } : null;
}

export async function mayUseApp(db, orgId, appId, userId) {
  if (!userId) return false;
  return (await appPermission(db, orgId, appId, userId)) !== 'none';
}

export async function mayEditApp(db, orgId, appId, userId) {
  if (!userId) return false;
  return (await appPermission(db, orgId, appId, userId)) === 'edit';
}

export async function hasExplicitAppPermission(db, orgId, appId, userId) {
  if (!userId) return false;
  return Boolean(await db.prepare('SELECT 1 FROM hx_app_person_access WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3')
    .bind(orgId,appId,String(userId)).first());
}

async function appPermission(db, orgId, appId, userId) {
  const row = await db.prepare(`SELECT app.created_by AS ownerId, COALESCE(a.visibility,'workspace') AS visibility, a.room_channel,
      m.role, p.permission
    FROM hx_apps app
    JOIN memberships m ON m.org_id=app.org_id AND m.user_github_id=?3
    LEFT JOIN hx_app_access a ON a.org_id=app.org_id AND a.app_id=app.id
    LEFT JOIN hx_app_person_access p ON p.org_id=app.org_id AND p.app_id=app.id AND p.user_github_id=?3
    WHERE app.org_id=?1 AND app.id=?2 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'`)
    .bind(orgId, appId, String(userId)).first();
  if (!row) return 'none';
  if (row.ownerId === String(userId)) return 'edit';
  if (row.permission) return row.permission;
  if (row.room_channel) return await mayUseConversation(db, orgId, userId, row.room_channel) ? 'view' : 'none';
  return row.visibility === 'workspace' ? (['owner','admin'].includes(String(row.role).trim().toLowerCase()) ? 'edit' : 'view') : 'none';
}

export async function appPeopleAccess(db, orgId, appId) {
  const access = await appAccess(db, orgId, appId);
  if (!access) return [];
  const { results = [] } = await db.prepare(`SELECT u.github_id AS userId,u.login,u.name,m.role,p.permission,app.created_by AS ownerId,
      CASE WHEN p.user_github_id IS NULL THEN 0 ELSE 1 END AS explicit
    FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    JOIN hx_apps app ON app.org_id=m.org_id AND app.id=?2
    LEFT JOIN hx_app_person_access p ON p.org_id=m.org_id AND p.app_id=?2 AND p.user_github_id=m.user_github_id
    WHERE m.org_id=?1 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    ORDER BY CASE WHEN p.user_github_id IS NULL THEN 1 ELSE 0 END,u.login`).bind(orgId, appId).all();
  return Promise.all(results.map(async row => {
    const role = String(row.role).trim().toLowerCase();
    const inherited = String(row.ownerId) === String(row.userId) ? 'edit'
      : access.visibility === 'workspace' ? (['owner','admin'].includes(role) ? 'edit' : 'view') : 'none';
    const roomMember = access.visibility === 'room' ? await mayUseConversation(db, orgId, row.userId, access.roomChannel) : false;
    const defaultPermission = access.visibility === 'workspace' ? inherited : roomMember ? 'view' : 'none';
    return { userId: String(row.userId), login: row.login, name: row.name || row.login,
      role, canOverride: !['owner','admin'].includes(role) && String(row.ownerId)!==String(row.userId),
      permission: row.permission || defaultPermission, explicit: Boolean(row.explicit) };
  }));
}

export async function mayUseTable(db, orgId, tableId, userId) {
  if (!userId) return false;
  const member = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2 AND LOWER(TRIM(COALESCE(role,'guest'))) != 'guest'").bind(orgId, String(userId)).first();
  if (!member) return false;
  const table = await db.prepare('SELECT id FROM hx_tables WHERE org_id = ?1 AND id = ?2').bind(orgId, tableId).first();
  if (!table) return false;
  const { results } = await db.prepare('SELECT id FROM hx_apps WHERE org_id = ?1 AND table_id = ?2 UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id = ?1 AND table_id = ?2').bind(orgId, tableId).all();
  for (const app of results || []) if (!(await mayUseApp(db, orgId, app.id, userId))) return false;
  return true;
}

// A named view grant is read-only. Tables without a person-specific app
// policy retain the legacy workspace behavior for existing Honmaru users.
export async function mayEditTable(db, orgId, tableId, userId) {
  if (!(await mayUseTable(db,orgId,tableId,userId))) return false;
  const { results = [] } = await db.prepare('SELECT id FROM hx_apps WHERE org_id=?1 AND table_id=?2 UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id=?1 AND table_id=?2').bind(orgId,tableId).all();
  // A workspace/Room default grant is usually view-only for ordinary members.
  // Requiring edit on every App that exposes a shared table prevents the table
  // route, MCP, or a workflow from turning visibility into an implicit write grant.
  for (const app of results) if (!(await mayEditApp(db,orgId,app.id,userId))) return false;
  return true;
}

// Recheck a rendered app and its primary table together after reading rows.
// Every app linked to the table must remain visible, as with mayUseTable; a
// single SQL statement prevents an ACL change between individual checks.
export async function mayReadAppRows(db, orgId, appId, tableId, userId) {
  if (!userId || !tableId) return false;
  const roomAllowed = policy => `EXISTS(SELECT 1 FROM businesses rb WHERE rb.org_id=?1 AND 'b:'||rb.slug=${policy}.room_channel AND (rb.private=0 OR EXISTS(SELECT 1 FROM conversation_members cm JOIN users cu ON cu.login=cm.login WHERE cm.org_id=?1 AND cm.channel=${policy}.room_channel AND cu.github_id=?4)))`;
  const row = await db.prepare(`SELECT 1 AS allowed FROM hx_apps target
    JOIN hx_tables t ON t.org_id=target.org_id AND t.id=target.table_id
    JOIN memberships m ON m.org_id=target.org_id AND m.user_github_id=?4
    LEFT JOIN hx_app_access policy ON policy.org_id=target.org_id AND policy.app_id=target.id
    LEFT JOIN hx_app_person_access personal ON personal.org_id=target.org_id AND personal.app_id=target.id AND personal.user_github_id=?4
    WHERE target.org_id=?1 AND target.id=?2 AND target.table_id=?3
      AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)
      AND (target.created_by=?4 OR personal.permission IN ('view','edit')
        OR (personal.permission IS NULL AND (COALESCE(policy.visibility,'workspace')='workspace' OR (policy.room_channel IS NOT NULL AND ${roomAllowed('policy')}))))
      AND NOT EXISTS(SELECT 1 FROM hx_apps linked
        LEFT JOIN hx_app_access p ON p.org_id=linked.org_id AND p.app_id=linked.id
        WHERE linked.org_id=?1 AND (linked.table_id=?3 OR EXISTS(
          SELECT 1 FROM hx_app_entities e WHERE e.org_id=linked.org_id AND e.app_id=linked.id AND e.table_id=?3))
        AND (EXISTS(SELECT 1 FROM hx_app_person_access denied WHERE denied.org_id=linked.org_id AND denied.app_id=linked.id AND denied.user_github_id=?4 AND denied.permission='none')
          OR (COALESCE(p.visibility,'workspace')!='workspace' AND (p.room_channel IS NULL OR NOT ${roomAllowed('p')}) AND linked.created_by IS NOT ?4
            AND NOT EXISTS(SELECT 1 FROM hx_app_person_access granted WHERE granted.org_id=linked.org_id AND granted.app_id=linked.id AND granted.user_github_id=?4 AND granted.permission IN ('view','edit'))))
        )
      AND NOT EXISTS(SELECT 1 FROM hx_app_person_access denied WHERE denied.org_id=target.org_id AND denied.app_id=target.id AND denied.user_github_id=?4 AND denied.permission='none'
        AND target.created_by IS NOT ?4)
      AND NOT EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=?3
        AND NOT EXISTS(SELECT 1 FROM hx_apps linked WHERE linked.org_id=e.org_id AND linked.id=e.app_id))`)
    .bind(orgId, appId, tableId, String(userId)).first();
  return Boolean(row);
}

export async function setAppAccess(db, orgId, appId, userId, input) {
  const current = await appAccess(db, orgId, appId);
  if (!current || !(await mayUseApp(db, orgId, appId, userId))) return { error: 'No such app.', status: 404 };
  if (current.ownerId !== String(userId)) return { error: 'Only the app owner can change sharing.', status: 403 };
  if (!['workspace', 'private', 'room'].includes(input.visibility)) return { error: 'Invalid visibility.' };
  const roomChannel = input.visibility === 'room' ? String(input.channel || '') : null;
  if (input.visibility === 'room' && (!roomChannel || roomChannel.length > 200 || !(await mayUseConversation(db, orgId, userId, roomChannel)))) return { error: 'Choose a room you can access.', status: 400 };
  if (!Number.isSafeInteger(input.version) || input.version < 0) return { error: 'A current access version is required.' };
  const hasPeopleUpdate = Array.isArray(input.people);
  if (input.people !== undefined && !hasPeopleUpdate) return { error: 'People access must be a list.' };
  const people = hasPeopleUpdate ? input.people : [];
  const seen = new Set();
  for (const person of people) {
    const id = typeof person?.userId === 'string' ? person.userId.trim() : '';
    if (!id || id.length > 100 || seen.has(id) || !['none','view','edit'].includes(person.permission)) return { error: 'A person or permission is invalid.' };
    seen.add(id);
    if (id === current.ownerId) return { error: 'The app owner always keeps access.' };
    const member = await db.prepare('SELECT role FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId,id).first();
    if (!member || ['guest','owner','admin'].includes(String(member.role).trim().toLowerCase())) return { error: 'Choose an active workspace member who can receive a personal app permission.' };
  }
  const at = new Date().toISOString(), token = crypto.randomUUID();
  const storedVisibility = input.visibility === 'room' ? 'private' : input.visibility;
  const stmts = [];
  const peopleJson = hasPeopleUpdate ? JSON.stringify(people.map(({ userId, permission }) => ({ userId: String(userId).trim(), permission }))) : null;
  const validPeople = param => hasPeopleUpdate ? `AND NOT EXISTS(
    SELECT 1 FROM json_each(${param}) selected
    LEFT JOIN memberships selectedMember ON selectedMember.org_id=?1
      AND selectedMember.user_github_id=json_extract(selected.value,'$.userId')
    WHERE selectedMember.user_github_id IS NULL
      OR LOWER(TRIM(COALESCE(selectedMember.role,'guest'))) IN ('guest','owner','admin')
  )` : '';
  if (input.version === 0) stmts.push(db.prepare(`INSERT OR IGNORE INTO hx_app_access(org_id,app_id,visibility,version,change_token)
    SELECT ?1,?2,'workspace',0,NULL WHERE EXISTS(SELECT 1 FROM hx_apps a JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?3 AND LOWER(TRIM(m.role))!='guest' WHERE a.org_id=?1 AND a.id=?2 AND a.created_by=?3)
      ${validPeople('?4')}`)
    .bind(...(hasPeopleUpdate ? [orgId, appId, String(userId), peopleJson] : [orgId, appId, String(userId)])));
  stmts.push(db.prepare(`UPDATE hx_app_access SET visibility=?3,room_channel=?7,version=version+1,change_token=?5
    WHERE org_id=?1 AND app_id=?2 AND version=?4
      AND EXISTS(SELECT 1 FROM hx_apps a JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?6 AND LOWER(TRIM(m.role))!='guest' WHERE a.org_id=?1 AND a.id=?2 AND a.created_by=?6)
      ${validPeople('?8')}`)
    .bind(...(hasPeopleUpdate ? [orgId,appId,storedVisibility,input.version,token,String(userId),roomChannel,peopleJson] : [orgId,appId,storedVisibility,input.version,token,String(userId),roomChannel])));
  if (hasPeopleUpdate) {
    stmts.push(db.prepare('DELETE FROM hx_app_person_access WHERE org_id=?1 AND app_id=?2 AND EXISTS(SELECT 1 FROM hx_app_access WHERE org_id=?1 AND app_id=?2 AND change_token=?3)').bind(orgId,appId,token));
    stmts.push(db.prepare(`INSERT INTO hx_app_person_access(org_id,app_id,user_github_id,permission,updated_at)
      SELECT ?1,?2,json_extract(selected.value,'$.userId'),json_extract(selected.value,'$.permission'),?3
      FROM json_each(?4) selected
      WHERE EXISTS(SELECT 1 FROM hx_app_access WHERE org_id=?1 AND app_id=?2 AND change_token=?5)
        AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=json_extract(selected.value,'$.userId') AND LOWER(TRIM(COALESCE(role,'guest'))) NOT IN ('guest','owner','admin'))`)
      .bind(orgId,appId,at,peopleJson,token));
  }
  stmts.push(db.prepare('UPDATE hx_app_access SET change_token=NULL WHERE org_id=?1 AND app_id=?2 AND change_token=?3').bind(orgId,appId,token));
  const result = await db.batch(stmts);
  const changed = result[input.version === 0 ? 1 : 0];
  if (!changed?.meta?.changes) return { error: 'Sharing changed. Reload before saving.', status: 409 };
  if (hasPeopleUpdate) {
    const insertIndex = (input.version === 0 ? 1 : 0) + 2;
    if ((result[insertIndex]?.meta?.changes || 0) !== people.length) {
      return { error: 'A selected person changed workspace access. Reload sharing and try again.', status: 409 };
    }
  }
  return { access: await appAccess(db, orgId, appId), people: await appPeopleAccess(db, orgId, appId) };
}

export async function visibleResources(items, mayUse) {
  const visible = [];
  for (const item of items) if (await mayUse(item)) visible.push(item);
  return visible;
}

// App responses contain channel keys; do not expose a private room name to a
// member who cannot open that room.
export async function visibleAppLinks(db, orgId, apps, viewer) {
  const githubId = viewer?.github_id ?? viewer?.githubId;
  if (!githubId || !viewer?.login) return (apps || []).map(app => ({ ...app, channels: [] }));
  const visible = [];
  const roomAccess = new Map();
  for (const app of apps || []) {
    const channels = [];
    for (const channel of app.channels || []) {
      if (!roomAccess.has(channel)) roomAccess.set(channel, readableConversation(db, orgId, githubId, channel));
      const room = await roomAccess.get(channel);
      if (room?.key === channel) channels.push(channel);
    }
    visible.push({ ...app, channels });
  }
  return visible;
}

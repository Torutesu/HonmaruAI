import { mayUseConversation } from './conversationAccess.js';
import { readableConversation } from './conversationAccess.js';

// Explicit app visibility. Absence means the legacy workspace-wide policy.
// Room links are navigation only; room visibility uses current room membership.
export async function appAccess(db, orgId, appId) {
  const row = await db.prepare(`SELECT a.created_by, p.visibility, p.version, p.room_channel FROM hx_apps a
    LEFT JOIN hx_app_access p ON p.org_id = a.org_id AND p.app_id = a.id
    WHERE a.org_id = ?1 AND a.id = ?2`).bind(orgId, appId).first();
  return row ? { ownerId: row.created_by, visibility: row.room_channel ? 'room' : (row.visibility || 'workspace'), roomChannel: row.room_channel || null, version: row.version || 0 } : null;
}

async function appPermission(db, orgId, appId, userId) {
  if (!userId) return 'none';
  const member = await db.prepare("SELECT created_at FROM memberships WHERE org_id = ?1 AND user_github_id = ?2 AND LOWER(COALESCE(role,'guest')) != 'guest'").bind(orgId, String(userId)).first();
  if (!member) return 'none';
  const access = await appAccess(db, orgId, appId);
  if (!access) return 'none';
  if (access.ownerId === String(userId)) return 'edit';
  const grant = await db.prepare(`SELECT permission FROM hx_app_member_permissions
    WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3 AND membership_since=?4`)
    .bind(orgId, appId, String(userId), String(member.created_at || '')).first();
  if (grant && ['none','view','edit'].includes(grant.permission)) return grant.permission;
  if (access.visibility === 'workspace') return 'edit';
  if (access.visibility === 'room') return (await mayUseConversation(db, orgId, userId, access.roomChannel)) ? 'edit' : 'none';
  return 'none';
}
export async function appMemberPermissionSnapshot(db,orgId,appId,userId) {
  if(!userId)return null;
  const member=await db.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'").bind(orgId,String(userId)).first();
  if(!member)return {hasMembership:false,membershipSince:null,permission:null};
  const membershipSince=String(member.created_at||'');
  const grant=await db.prepare("SELECT permission FROM hx_app_member_permissions WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3 AND membership_since=?4").bind(orgId,appId,String(userId),membershipSince).first();
  return {hasMembership:true,membershipSince,permission:grant?.permission||null};
}
export async function appShareMemberStillAllowed(db,orgId,appId,userId,snapshot) {
  if(!userId)return true;
  const current=await appMemberPermissionSnapshot(db,orgId,appId,userId);
  if(snapshot?.hasMembership && (!current?.hasMembership || current.membershipSince!==snapshot.membershipSince))return false;
  return !current?.hasMembership || current.permission!=='none';
}
export async function mayUseApp(db, orgId, appId, userId) {
  return (await appPermission(db, orgId, appId, userId)) !== 'none';
}
export async function mayEditApp(db, orgId, appId, userId) {
  return (await appPermission(db, orgId, appId, userId)) === 'edit';
}
export async function listAppMemberPermissions(db, orgId, appId) {
  const { results = [] } = await db.prepare(`SELECT u.github_id AS userId, COALESCE(u.name,u.login,u.github_id) AS name,
    u.login, m.role, m.created_at AS membershipSince, p.permission, p.version
    FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    LEFT JOIN hx_app_member_permissions p ON p.org_id=m.org_id AND p.app_id=?2 AND p.user_github_id=m.user_github_id AND p.membership_since=m.created_at
    WHERE m.org_id=?1 AND LOWER(COALESCE(m.role,'guest'))!='guest' ORDER BY COALESCE(u.name,u.login,u.github_id)`)
    .bind(orgId, appId).all();
  return Promise.all(results.map(async row => ({ ...row, effectivePermission: await appPermission(db,orgId,appId,row.userId) })));
}
export async function setAppMemberPermission(db, orgId, appId, actorId, input, adminOverride = false) {
  const app = await appAccess(db, orgId, appId);
  if (!app) return { error: 'No such app.', status: 404 };
  if (app.ownerId !== String(actorId) && !adminOverride) return { error: 'Only the app owner or a workspace admin can change member access.', status: 403 };
  const userId = String(input.userId || '');
  const permission = String(input.permission || '');
  if (!userId || userId.length > 120 || !['none','view','edit'].includes(permission)) return { error: 'Choose a workspace member and a valid permission.', status: 400 };
  if (userId === String(app.ownerId)) return { error: 'The app owner always has edit access.', status: 400 };
  const member = await db.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'").bind(orgId,userId).first();
  if (!member) return { error: 'This person is no longer a workspace member.', status: 409 };
  const current = await db.prepare('SELECT version FROM hx_app_member_permissions WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3 AND membership_since=?4').bind(orgId,appId,userId,String(member.created_at||'')).first();
  const version = Number(input.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0 || version !== Number(current?.version || 0)) return { error: 'Member access changed. Reload before saving.', status: 409 };
  const result = await db.prepare(`INSERT INTO hx_app_member_permissions (org_id,app_id,user_github_id,membership_since,permission,version,updated_by,updated_at)
    VALUES (?1,?2,?3,?4,?5,1,?6,datetime('now'))
    ON CONFLICT(org_id,app_id,user_github_id) DO UPDATE SET membership_since=excluded.membership_since,permission=excluded.permission,version=hx_app_member_permissions.version+1,updated_by=excluded.updated_by,updated_at=datetime('now')
    WHERE hx_app_member_permissions.version=?7 OR hx_app_member_permissions.membership_since!=excluded.membership_since`)
    .bind(orgId,appId,userId,String(member.created_at||''),permission,String(actorId),version).run();
  if (!result.meta?.changes) return { error: 'Member access changed. Reload before saving.', status: 409 };
  return { permissions: await listAppMemberPermissions(db,orgId,appId) };
}
export async function clearAppMemberPermission(db, orgId, appId, actorId, input, adminOverride = false) {
  const app = await appAccess(db,orgId,appId);
  if (!app) return { error:'No such app.',status:404 };
  if (app.ownerId !== String(actorId) && !adminOverride) return { error:'Only the app owner or a workspace admin can change member access.',status:403 };
  const userId=String(input.userId||'');
  const member=await db.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'").bind(orgId,userId).first();
  if(!member)return {error:'This person is no longer a workspace member.',status:409};
  const result=await db.prepare('DELETE FROM hx_app_member_permissions WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3 AND membership_since=?4 AND version=?5')
    .bind(orgId,appId,userId,String(member.created_at||''),Number(input.version)).run();
  if(!result.meta?.changes)return {error:'Member access changed. Reload before saving.',status:409};
  return {permissions:await listAppMemberPermissions(db,orgId,appId)};
}

async function mayAccessTable(db, orgId, tableId, userId, edit) {
  if (!userId) return false;
  const member = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2 AND role != 'guest'").bind(orgId, String(userId)).first();
  if (!member) return false;
  const table = await db.prepare('SELECT id FROM hx_tables WHERE org_id = ?1 AND id = ?2').bind(orgId, tableId).first();
  if (!table) return false;
  const { results } = await db.prepare('SELECT id FROM hx_apps WHERE org_id = ?1 AND table_id = ?2 UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id = ?1 AND table_id = ?2').bind(orgId, tableId).all();
  for (const app of results || []) if (!((edit ? await mayEditApp(db, orgId, app.id, userId) : await mayUseApp(db, orgId, app.id, userId)))) return false;
  return true;
}
export async function mayUseTable(db, orgId, tableId, userId) { return mayAccessTable(db,orgId,tableId,userId,false); }
export async function mayEditTable(db, orgId, tableId, userId) { return mayAccessTable(db,orgId,tableId,userId,true); }

// Recheck a rendered app and its primary table together after reading rows.
// Every app linked to the table must remain visible, as with mayUseTable; a
// single SQL statement prevents an ACL change between individual checks.
export async function mayReadAppRows(db, orgId, appId, tableId, userId) {
  if (!userId || !tableId) return false;
  const target = await db.prepare(`SELECT target.id FROM hx_apps target
    JOIN hx_tables t ON t.org_id=target.org_id AND t.id=target.table_id
    JOIN memberships m ON m.org_id=target.org_id AND m.user_github_id=?4
    WHERE target.org_id=?1 AND target.id=?2 AND target.table_id=?3
      AND LOWER(COALESCE(m.role,'guest'))!='guest'
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)`)
    .bind(orgId, appId, tableId, String(userId)).first();
  if (!target || !(await mayUseApp(db, orgId, appId, userId))) return false;
  const { results = [] } = await db.prepare(`SELECT id FROM hx_apps WHERE org_id=?1 AND table_id=?2
    UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id=?1 AND table_id=?2`).bind(orgId, tableId).all();
  // Preserve the existing shared-table fence: every app that exposes these
  // rows must be visible to the caller, now including current room authority.
  for (const linked of results) if (!(await mayUseApp(db, orgId, linked.id, userId))) return false;
  const missing = await db.prepare(`SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=?2
    AND NOT EXISTS(SELECT 1 FROM hx_apps linked WHERE linked.org_id=e.org_id AND linked.id=e.app_id) LIMIT 1`)
    .bind(orgId, tableId).first();
  return !missing;
}

export async function setAppAccess(db, orgId, appId, userId, input) {
  const current = await appAccess(db, orgId, appId);
  if (!current || !(await mayUseApp(db, orgId, appId, userId))) return { error: 'No such app.', status: 404 };
  if (current.ownerId !== String(userId)) return { error: 'Only the app owner can change sharing.', status: 403 };
  if (!['workspace', 'private', 'room'].includes(input.visibility)) return { error: 'Invalid visibility.' };
  if (!Number.isSafeInteger(input.version) || input.version < 0) return { error: 'A current access version is required.' };
  const roomChannel = input.visibility === 'room' ? String(input.channel || '') : null;
  if (input.visibility === 'room' && (!roomChannel || roomChannel.length > 200 || !(await mayUseConversation(db, orgId, userId, roomChannel)))) {
    return { error: 'Choose a room you can access.', status: 400 };
  }
  const storedVisibility = input.visibility === 'room' ? 'private' : input.visibility;
  const result = input.version === 0
    ? await db.prepare('INSERT OR IGNORE INTO hx_app_access (org_id, app_id, visibility, version, room_channel) VALUES (?1, ?2, ?3, 1, ?4)').bind(orgId, appId, storedVisibility, roomChannel).run()
    : await db.prepare('UPDATE hx_app_access SET visibility = ?3, version = version + 1, room_channel = ?5 WHERE org_id = ?1 AND app_id = ?2 AND version = ?4').bind(orgId, appId, storedVisibility, input.version, roomChannel).run();
  if (!result.meta?.changes) return { error: 'Sharing changed. Reload before saving.', status: 409 };
  return { access: await appAccess(db, orgId, appId) };
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

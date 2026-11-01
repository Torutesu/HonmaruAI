import { readableConversation } from './conversationAccess.js';

// Explicit app visibility. Absence means the legacy workspace-wide policy.
// Room links are navigation only; they never grant access to a private app.
export async function appAccess(db, orgId, appId) {
  const row = await db.prepare(`SELECT a.created_by, p.visibility, p.version FROM hx_apps a
    LEFT JOIN hx_app_access p ON p.org_id = a.org_id AND p.app_id = a.id
    WHERE a.org_id = ?1 AND a.id = ?2`).bind(orgId, appId).first();
  return row ? { ownerId: row.created_by, visibility: row.visibility || 'workspace', version: row.version || 0 } : null;
}

export async function mayUseApp(db, orgId, appId, userId) {
  if (!userId) return false;
  const member = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2 AND role != 'guest'").bind(orgId, String(userId)).first();
  if (!member) return false;
  const access = await appAccess(db, orgId, appId);
  return Boolean(access && (access.visibility === 'workspace' || access.ownerId === String(userId)));
}

export async function mayUseTable(db, orgId, tableId, userId) {
  if (!userId) return false;
  const member = await db.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2 AND role != 'guest'").bind(orgId, String(userId)).first();
  if (!member) return false;
  const table = await db.prepare('SELECT id FROM hx_tables WHERE org_id = ?1 AND id = ?2').bind(orgId, tableId).first();
  if (!table) return false;
  const { results } = await db.prepare('SELECT id FROM hx_apps WHERE org_id = ?1 AND table_id = ?2 UNION SELECT app_id AS id FROM hx_app_entities WHERE org_id = ?1 AND table_id = ?2').bind(orgId, tableId).all();
  for (const app of results || []) if (!(await mayUseApp(db, orgId, app.id, userId))) return false;
  return true;
}

export async function setAppAccess(db, orgId, appId, userId, input) {
  const current = await appAccess(db, orgId, appId);
  if (!current || !(await mayUseApp(db, orgId, appId, userId))) return { error: 'No such app.', status: 404 };
  if (current.ownerId !== String(userId)) return { error: 'Only the app owner can change sharing.', status: 403 };
  if (!['workspace', 'private'].includes(input.visibility)) return { error: 'Invalid visibility.' };
  if (!Number.isSafeInteger(input.version) || input.version < 0) return { error: 'A current access version is required.' };
  const result = input.version === 0
    ? await db.prepare('INSERT OR IGNORE INTO hx_app_access (org_id, app_id, visibility, version) VALUES (?1, ?2, ?3, 1)').bind(orgId, appId, input.visibility).run()
    : await db.prepare('UPDATE hx_app_access SET visibility = ?3, version = version + 1 WHERE org_id = ?1 AND app_id = ?2 AND version = ?4').bind(orgId, appId, input.visibility, input.version).run();
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

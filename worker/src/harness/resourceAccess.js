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

// Recheck a rendered app and its primary table together after reading rows.
// Every app linked to the table must remain visible, as with mayUseTable; a
// single SQL statement prevents an ACL change between individual checks.
export async function mayReadAppRows(db, orgId, appId, tableId, userId) {
  if (!userId || !tableId) return false;
  const row = await db.prepare(`SELECT 1 AS allowed FROM hx_apps target
    JOIN hx_tables t ON t.org_id=target.org_id AND t.id=target.table_id
    JOIN memberships m ON m.org_id=target.org_id AND m.user_github_id=?4
    LEFT JOIN hx_app_access policy ON policy.org_id=target.org_id AND policy.app_id=target.id
    WHERE target.org_id=?1 AND target.id=?2 AND target.table_id=?3
      AND LOWER(COALESCE(m.role,'guest'))!='guest'
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)
      AND (COALESCE(policy.visibility,'workspace')='workspace' OR target.created_by=?4)
      AND NOT EXISTS(SELECT 1 FROM hx_apps linked
        LEFT JOIN hx_app_access p ON p.org_id=linked.org_id AND p.app_id=linked.id
        WHERE linked.org_id=?1 AND (linked.table_id=?3 OR EXISTS(
          SELECT 1 FROM hx_app_entities e WHERE e.org_id=linked.org_id AND e.app_id=linked.id AND e.table_id=?3))
        AND COALESCE(p.visibility,'workspace')!='workspace' AND linked.created_by IS NOT ?4)
      AND NOT EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=?3
        AND NOT EXISTS(SELECT 1 FROM hx_apps linked WHERE linked.org_id=e.org_id AND linked.id=e.app_id))`)
    .bind(orgId, appId, tableId, String(userId)).first();
  return Boolean(row);
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

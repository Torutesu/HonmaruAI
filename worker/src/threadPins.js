import { accessFor } from "./access.js";
import { getMessage, viewOf } from "./channels.js";
import { listMembers } from "./team.js";

export async function threadPins(db, orgId, user) {
  const members = await listMembers(db, orgId, user.github_id);
  const access = await accessFor(db, orgId, user.login);
  const { results } = await db.prepare(`
    SELECT m.id, m.channel, m.body, d.title, p.created_at
    FROM channel_thread_pins p
    JOIN channel_messages m ON m.id = p.message_id AND m.org_id = p.org_id
    LEFT JOIN channel_thread_details d ON d.org_id = m.org_id AND d.message_id = m.id
    WHERE p.org_id = ?1 AND p.user_id = ?2 AND m.deleted_at IS NULL AND m.parent_id IS NULL
    ORDER BY p.created_at, p.message_id LIMIT 50
  `).bind(orgId, String(user.github_id)).all();
  return { pins: (results || []).flatMap(row => {
    const view = viewOf(row.channel, user.login, members, access);
    return view ? [{ id: row.id, view, title: row.title || row.body.slice(0, 160), createdAt: row.created_at }] : [];
  }) };
}

export async function setThreadPin(db, orgId, user, id, pinned) {
  if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id) || typeof pinned !== "boolean")
    return { error: "Invalid thread pin.", status: 400 };
  // Removing one's saved pointer is allowed even after access was revoked.
  if (!pinned) {
    await db.prepare("DELETE FROM channel_thread_pins WHERE org_id=?1 AND user_id=?2 AND message_id=?3")
      .bind(orgId, String(user.github_id), id).run();
    return threadPins(db, orgId, user);
  }
  const row = await getMessage(db, orgId, id);
  const members = await listMembers(db, orgId, user.github_id);
  const access = await accessFor(db, orgId, user.login);
  if (!row || row.deleted_at || row.parent_id || !viewOf(row.channel, user.login, members, access))
    return { error: "No such thread.", status: 404 };
  await db.prepare(`INSERT OR IGNORE INTO channel_thread_pins (org_id,user_id,message_id,created_at)
    SELECT ?1,?2,?3,?4 WHERE
    (SELECT COUNT(*) FROM channel_thread_pins WHERE org_id=?1 AND user_id=?2) < 50
    AND EXISTS (SELECT 1 FROM channel_messages WHERE org_id=?1 AND id=?3 AND deleted_at IS NULL AND parent_id IS NULL)`)
    .bind(orgId, String(user.github_id), id, new Date().toISOString()).run();
  const saved = await db.prepare("SELECT 1 FROM channel_thread_pins WHERE org_id=?1 AND user_id=?2 AND message_id=?3")
    .bind(orgId, String(user.github_id), id).first();
  if (!saved) return { error: "You can pin up to 50 threads.", status: 409 };
  return threadPins(db, orgId, user);
}

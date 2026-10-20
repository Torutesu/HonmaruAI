// Personal notification preferences never change room membership or history.
export async function threadMuted(db, orgId, login, messageId) {
  if (!messageId) return false;
  return Boolean(await db.prepare("SELECT 1 FROM channel_thread_mutes WHERE org_id=?1 AND login=?2 AND message_id=?3")
    .bind(orgId, login, messageId).first());
}

export async function threadNotificationPreference(db, orgId, channel, login, messageId, muted) {
  if (typeof messageId !== "string" || !/^[\w-]{1,80}$/.test(messageId) ||
      (muted !== undefined && typeof muted !== "boolean")) return { error: "Invalid thread preference.", status: 400 };
  const root = await db.prepare("SELECT id FROM channel_messages WHERE org_id=?1 AND channel=?2 AND id=?3 AND parent_id IS NULL AND deleted_at IS NULL")
    .bind(orgId, channel, messageId).first();
  if (!root) return { error: "No such thread.", status: 404 };
  if (muted === true) {
    await db.prepare(`INSERT OR IGNORE INTO channel_thread_mutes (org_id,login,message_id)
      SELECT ?1,?2,?3 FROM channel_messages WHERE org_id=?1 AND id=?3 AND channel=?4 AND parent_id IS NULL AND deleted_at IS NULL`)
      .bind(orgId, login, messageId, channel).run();
  } else if (muted === false) {
    await db.prepare("DELETE FROM channel_thread_mutes WHERE org_id=?1 AND login=?2 AND message_id=?3")
      .bind(orgId, login, messageId).run();
  }
  return { muted: await threadMuted(db, orgId, login, messageId) };
}

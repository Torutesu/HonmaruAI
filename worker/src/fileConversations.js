// One ordinary channel thread per sent file, independent of the other files
// attached to its source message. Channel reply/AI/notification rules stay in
// the existing message routes; merely looking up a thread never creates one.
export async function sentFile(db, orgId, fileId) {
  if (typeof fileId !== "string" || !/^f_[0-9a-f]{24}$/.test(fileId)) return null;
  return db.prepare(`SELECT f.id,f.channel,f.name FROM message_files f
    JOIN channel_messages m ON m.org_id=f.org_id AND m.id=f.message_id AND m.channel=f.channel
    WHERE f.org_id=? AND f.id=? AND m.deleted_at IS NULL`).bind(orgId,fileId).first();
}

// Call only after the caller has passed the source channel's access check.
export async function fileConversation(db, { orgId, file, login, create = false }) {
  const id = `file-thread-${file.id}`;
  if (create) {
    // The deterministic ID makes concurrent first opens converge. Recheck
    // the live source in the insert itself, so deleting it cannot create
    // an orphan conversation between the earlier lookup and this write.
    await db.prepare(`INSERT OR IGNORE INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at)
      SELECT ?,f.org_id,f.channel,?,'message',?,?
      FROM message_files f JOIN channel_messages m
        ON m.org_id=f.org_id AND m.id=f.message_id AND m.channel=f.channel
      WHERE f.org_id=? AND f.id=? AND f.channel=? AND m.deleted_at IS NULL`)
      .bind(id,login,`ファイル: ${file.name}`,new Date().toISOString(),orgId,file.id,file.channel).run();
  }
  const row = await db.prepare("SELECT * FROM channel_messages WHERE org_id=? AND id=? AND channel=?")
    .bind(orgId,id,file.channel).first();
  if (row?.deleted_at) return { error: "This file conversation was deleted.", status: 410 };
  if (create && !row) return { error: "No such file.", status: 404 };
  return { row, threadId: row?.id || null };
}

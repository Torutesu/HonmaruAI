import { present } from './channels.js';

// The caller resolves the exact room before entering here. Search visible
// conversation messages, including replies explicitly also sent to the room.
export async function searchRoom(db, orgId, key, login, view, members, query, before) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200)
    return { error: 'Enter a search phrase of up to 200 characters.', status: 400 };
  if (before !== null && (!/^\d{1,15}$/.test(before) || !Number.isSafeInteger(Number(before))))
    return { error: 'Invalid search cursor.', status: 400 };
  const pattern = `%${query.trim().replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const { results = [] } = await db.prepare(`SELECT m.*, m.rowid AS position,
      COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id=m.org_id AND 'agent:' || ca.id=m.author_login)) AS author_name
    FROM channel_messages m LEFT JOIN users u ON u.login=m.author_login
    WHERE m.org_id=?1 AND m.channel=?2 AND (m.parent_id IS NULL OR m.also_channel=1)
      AND m.deleted_at IS NULL AND m.body LIKE ?3 ESCAPE '\\'
      AND (?4 IS NULL OR m.rowid<?4)
    ORDER BY m.rowid DESC LIMIT 31`).bind(orgId, key, pattern, before === null ? null : Number(before)).all();
  const rows = results.slice(0, 30);
  return { messages: await present(db, orgId, rows, login, view, members),
    nextCursor: results.length > 30 ? String(rows.at(-1).position) : null };
}

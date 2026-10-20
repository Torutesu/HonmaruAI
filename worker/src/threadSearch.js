import { getMessage, present } from "./channels.js";

export async function searchThread(db, orgId, key, id, login, view, members, query, before) {
  if (typeof query !== "string" || !query.trim() || query.length > 200)
    return { error: "Enter a search phrase of up to 200 characters.", status: 400 };
  if (before !== null && (!/^\d{1,15}$/.test(before) || !Number.isSafeInteger(Number(before))))
    return { error: "Invalid search cursor.", status: 400 };
  const root = await getMessage(db, orgId, id);
  if (!root || root.deleted_at || root.parent_id || root.channel !== key)
    return { error: "No such thread.", status: 404 };
  const pattern = `%${query.trim().replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const { results = [] } = await db.prepare(`SELECT m.*, m.rowid AS position, u.name AS author_name
    FROM channel_messages m LEFT JOIN users u ON u.login=m.author_login
    WHERE m.org_id=?1 AND m.channel=?2 AND (m.id=?3 OR m.parent_id=?3)
      AND m.deleted_at IS NULL AND m.body LIKE ?4 ESCAPE '\\'
      AND (?5 IS NULL OR m.rowid<?5)
    ORDER BY m.rowid DESC LIMIT 31`)
    .bind(orgId, key, id, pattern, before === null ? null : Number(before)).all();
  const rows = results.slice(0, 30);
  return { messages: await present(db, orgId, rows, login, view, members),
    nextCursor: results.length > 30 ? String(rows.at(-1).position) : null };
}

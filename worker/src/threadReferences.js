import { getMessage } from "./channels.js";
import { filesFor, toFile } from "./files.js";

// Only canonical internal app links in this workspace are references.
export function referencedAppIds(text, orgId) {
  const ids = new Set();
  for (const match of text.matchAll(/\[(?:\\.|[^\]\\\n]){1,240}\]\(#\/apps\/([\w%-]{1,240})\/([\w%.-]{1,600})\)/g)) {
    try {
      const id = decodeURIComponent(match[1]), org = decodeURIComponent(match[2]);
      if (/^[\w-]{1,80}$/.test(id) && org === orgId) ids.add(id);
    } catch { /* Malformed links are plain message text. */ }
  }
  return [...ids];
}

// Scan messages in bounded pages, including the root and older replies that
// the conversation UI has not loaded. An empty reference page can have a cursor.
export async function threadReferences(db, orgId, key, id, userId, after = null) {
  if (after !== null && (!/^\d{1,15}$/.test(after) || !Number.isSafeInteger(Number(after))))
    return { error: "Invalid reference cursor.", status: 400 };
  const root = await getMessage(db, orgId, id);
  if (!root || root.deleted_at || root.parent_id || root.channel !== key)
    return { error: "No such thread.", status: 404 };
  const { results = [] } = await db.prepare(`SELECT rowid AS position, id, body FROM channel_messages
    WHERE org_id=?1 AND channel=?2 AND (id=?3 OR parent_id=?3)
      AND deleted_at IS NULL AND rowid>?4 ORDER BY rowid LIMIT 21`)
    .bind(orgId, key, id, Number(after || 0)).all();
  const messages = results.slice(0, 20);
  const wanted = [...new Set(messages.flatMap(m => referencedAppIds(m.body, orgId)))];
  const apps = [];
  for (let i = 0; i < wanted.length; i += 80) {
    const chunk = wanted.slice(i, i + 80);
    const { results: rows = [] } = await db.prepare(`SELECT a.id, a.name FROM hx_apps a
      LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id
      WHERE a.org_id=?1 AND a.id IN (${chunk.map((_, j) => `?${j + 3}`).join(",")})
      AND (COALESCE(p.visibility,'workspace')='workspace' OR a.created_by=?2)
      AND EXISTS (SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND role!='guest')`)
      .bind(orgId, String(userId), ...chunk).all();
    apps.push(...rows);
  }
  const attachments = await filesFor(db, orgId, messages.map(m => m.id));
  const files = [];
  for (const message of messages) {
    for (const row of attachments.get(message.id) || []) {
      if (row.channel === key) files.push({ ...await toFile(db, row), messageId: message.id });
    }
  }
  return {
    apps: wanted.flatMap(id => apps.filter(app => app.id === id)),
    files,
    nextCursor: results.length > 20 ? String(messages.at(-1).position) : null,
  };
}

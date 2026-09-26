// Bookmarks: links kept at the top of a conversation, as in Slack — the
// shared doc, the dashboard, the message everyone keeps looking for. They
// belong to the conversation: anyone who can read it sees them and may add
// one; whoever added one, or an admin, may take it away.

const MAX_PER_CHANNEL = 50;

/// A link a bookmark may hold: http(s), no credentials in it.
export function cleanBookmarkUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  return url.toString().slice(0, 1000);
}

function titleFor(title, url) {
  const t = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (t) return t;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, 80); }
}

export async function listBookmarks(db, orgId, key) {
  const { results } = await db.prepare(
    "SELECT id, title, url, created_by, created_at, position FROM channel_bookmarks WHERE org_id = ?1 AND channel = ?2 ORDER BY position, created_at"
  ).bind(orgId, key).all().catch(() => ({ results: [] }));
  return results || [];
}

/// A bookmark as a client sees it: who added it by name, never by login.
export function toClientBookmark(row, members, viewerLogin) {
  const by = members.find((m) => m.login === row.created_by);
  return { id: row.id, title: row.title, url: row.url, addedBy: by?.name || null, mine: row.created_by === viewerLogin, createdAt: row.created_at };
}

export async function addBookmark(db, { orgId, key, title, url, login }) {
  const link = cleanBookmarkUrl(url);
  if (!link) return { error: "Use an http:// or https:// link.", status: 400 };
  const count = await db.prepare("SELECT COUNT(*) AS n, MAX(position) AS last FROM channel_bookmarks WHERE org_id = ?1 AND channel = ?2").bind(orgId, key).first();
  if ((count?.n || 0) >= MAX_PER_CHANNEL) return { error: `A conversation keeps at most ${MAX_PER_CHANNEL} bookmarks.`, status: 400 };
  const row = {
    id: `bm_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    title: titleFor(title, link), url: link, created_by: login, created_at: new Date().toISOString(),
    position: (count?.last ?? -1) + 1,
  };
  await db.prepare(
    "INSERT INTO channel_bookmarks (id, org_id, channel, title, url, created_by, created_at, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
  ).bind(row.id, orgId, key, row.title, row.url, row.created_by, row.created_at, row.position).run();
  return { bookmark: row };
}

export async function editBookmark(db, { orgId, key, id, title, url }) {
  const row = await db.prepare("SELECT * FROM channel_bookmarks WHERE id = ?1 AND org_id = ?2 AND channel = ?3").bind(id, orgId, key).first();
  if (!row) return { error: "No such bookmark.", status: 404 };
  const link = url === undefined ? row.url : cleanBookmarkUrl(url);
  if (!link) return { error: "Use an http:// or https:// link.", status: 400 };
  await db.prepare("UPDATE channel_bookmarks SET title = ?2, url = ?3 WHERE id = ?1").bind(id, titleFor(title === undefined ? row.title : title, link), link).run();
  return { ok: true };
}

export async function removeBookmark(db, { orgId, key, id, login, isAdmin }) {
  const row = await db.prepare("SELECT created_by FROM channel_bookmarks WHERE id = ?1 AND org_id = ?2 AND channel = ?3").bind(id, orgId, key).first();
  if (!row) return { error: "No such bookmark.", status: 404 };
  if (row.created_by !== login && !isAdmin) return { error: "Only whoever added it, or an admin, can remove it.", status: 403 };
  await db.prepare("DELETE FROM channel_bookmarks WHERE id = ?1").bind(id).run();
  return { ok: true };
}

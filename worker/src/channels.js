import { listMembers } from "./team.js";
import { businessSlug } from "./db.js";

// Channels you can talk in.
//
// The list was laid out like a chat client and could not be talked in: a
// channel held decisions and nothing else, so the conversation that leads
// to a decision — the numbers someone pasted, the "what about Friday?", the
// link to the quote — happened somewhere else and never reached the AI.
// Now a channel carries messages, the AI reads them, and a message becomes
// a decision on request: "@AI" in it, or one click on it. Whatever was said
// around it goes in as the context the card is written from.
//
// Two kinds of channel. A business's (`b:<slug>`): the whole workspace
// reads it. A direct conversation (`dm:<a>|<b>`, logins sorted): only the
// two people in it, and a browser names it by the other person's member
// handle — `dm:<ref>` — never by a login, which is an email address for
// most people.

export const MAX_MESSAGE_CHARS = 4000;
const PAGE = 150;

/// "@AI" anywhere a mention can start, in either width of @, any case —
/// and "@AIに…", where Japanese runs straight on from the name.
export function asksTheAI(text) {
  return /(^|[\s(（「])[@＠]ai(?![A-Za-z0-9_])/iu.test(String(text || ""));
}

/// The instruction in a message, without the "@AI" that summoned it.
export function withoutAI(text) {
  // "@AIに…" is addressed to the AI; the particle goes with the name.
  return String(text || "").replace(/(^|[\s(（「])[@＠]ai(?![A-Za-z0-9_])(?:[にへ]|[,、:：])?\s*/giu, "$1").trim();
}

/// A channel as a client named it, to its stored key — or null when it
/// names nothing this person may read. `members` is the workspace's list,
/// passed in when the caller has it.
export async function resolveChannel(db, orgId, viewer, channel, members) {
  if (typeof channel !== "string") return null;
  if (channel.startsWith("b:")) {
    const slug = channel.slice(2);
    if (!slug || businessSlug(slug) !== slug) return null;
    return { key: channel, kind: "business", slug };
  }
  if (channel.startsWith("dm:")) {
    const ref = channel.slice(3).replace(/^member:/, "");
    const list = members || await listMembers(db, orgId, viewer.github_id);
    const other = list.find((m) => m.ref === ref);
    if (!other || other.login === viewer.login) return null;
    return { key: `dm:${[viewer.login, other.login].sort().join("|")}`, kind: "dm", other, logins: [viewer.login, other.login] };
  }
  return null;
}

/// A stored key as one viewer names it, or null when it is not theirs to see.
export function viewOf(key, viewerLogin, members) {
  if (key.startsWith("b:")) return key;
  if (!key.startsWith("dm:")) return null;
  const [a, b] = key.slice(3).split("|");
  if (viewerLogin !== a && viewerLogin !== b) return null;
  const otherLogin = viewerLogin === a ? b : a;
  const other = members.find((m) => m.login === otherLogin);
  return other ? `dm:${other.ref}` : null;
}

/// A stored message as a browser sees it: the author by name and member
/// handle, never by login.
export function toMessage(row, viewerLogin, view, members) {
  const author = row.kind === "ai" ? null : members.find((m) => m.login === row.author_login);
  return {
    id: row.id,
    channel: view,
    kind: row.kind,
    body: row.body,
    authorName: row.kind === "ai" ? null : (author?.name || row.author_name || null),
    authorRef: author ? author.ref : null,
    mine: Boolean(viewerLogin) && row.author_login === viewerLogin,
    cardId: row.card_id || null,
    createdAt: row.created_at,
  };
}

export async function listMessages(db, orgId, resolved, viewerLogin, view, members, { before } = {}) {
  const { results } = await db
    .prepare(
      `SELECT m.*, u.name AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.channel = ?2 ${before ? "AND m.created_at < ?4" : ""}
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?3`
    )
    .bind(...[orgId, resolved.key, PAGE, ...(before ? [before] : [])])
    .all();
  return (results || []).reverse().map((r) => toMessage(r, viewerLogin, view, members));
}

export async function getMessage(db, orgId, id) {
  return db
    .prepare("SELECT m.*, u.name AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login WHERE m.org_id = ?1 AND m.id = ?2")
    .bind(orgId, id)
    .first();
}

export async function postMessage(db, { orgId, key, authorLogin, body, kind = "message", cardId = null }) {
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { error: "Write something first." };
  if (text.length > MAX_MESSAGE_CHARS) return { error: `That is longer than ${MAX_MESSAGE_CHARS} characters.` };
  const id = crypto.randomUUID();
  // Strictly after the channel's last message, so two sent in the same
  // millisecond still read in the order they were sent.
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, card_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(id, orgId, key, authorLogin, kind, text, cardId, now)
    .run();
  return { row: await getMessage(db, orgId, id) };
}

export async function linkCard(db, orgId, messageId, cardId) {
  await db.prepare("UPDATE channel_messages SET card_id = ?3 WHERE org_id = ?1 AND id = ?2 AND card_id IS NULL")
    .bind(orgId, messageId, cardId).run();
}

/// The conversation before (and including) a message, as the AI reads it:
/// one line per message, names not logins, oldest first.
export async function transcriptUpTo(db, orgId, key, createdAt, { limit = 24 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT m.kind, m.body, m.created_at, u.name AS author_name, m.author_login FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.channel = ?2 AND m.created_at <= ?3
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?4`
    )
    .bind(orgId, key, createdAt, limit)
    .all();
  return (results || []).reverse().map((r) => {
    const who = r.kind === "ai" ? "AI" : (r.author_name || "someone");
    return `${String(r.created_at).slice(5, 16).replace("T", " ")} ${who}: ${String(r.body).replace(/\s+/g, " ").slice(0, 500)}`;
  });
}

/// What a business's channel has said lately, for anything that writes
/// about that business: "Ask anything" on its cards, routines about it.
export async function recentBusinessTalk(db, orgId, slugs, { since, limit = 30 } = {}) {
  const keys = [...new Set((slugs || []).filter(Boolean))].slice(0, 20).map((s) => `b:${s}`);
  const where = keys.length ? `AND m.channel IN (${keys.map((_, i) => `?${i + 3}`).join(", ")})` : "AND m.channel LIKE 'b:%'";
  const { results } = await db
    .prepare(
      `SELECT m.channel, m.kind, m.body, m.created_at, u.name AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.created_at >= ?2 ${where}
        ORDER BY m.created_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`
    )
    .bind(orgId, since || "1970-01-01", ...keys)
    .all();
  return (results || []).reverse().map((r) => ({
    channel: `#${r.channel.slice(2)}`,
    who: r.kind === "ai" ? "AI" : (r.author_name || "someone"),
    text: String(r.body).replace(/\s+/g, " ").slice(0, 400),
    when: r.created_at,
  }));
}

/// Every conversation this person can see, with its latest message — the
/// sidebar's activity. Business channels, and direct ones they are in.
export async function channelActivity(db, orgId, viewerLogin, members) {
  const { results } = await db
    .prepare(
      `SELECT m.channel, m.body, m.kind, m.created_at, m.author_login, u.name AS author_name
         FROM channel_messages m
         JOIN (SELECT channel, MAX(created_at) AS at FROM channel_messages WHERE org_id = ?1 GROUP BY channel) latest
           ON latest.channel = m.channel AND latest.at = m.created_at
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1`
    )
    .bind(orgId)
    .all();
  const out = [];
  for (const r of results || []) {
    const view = viewOf(r.channel, viewerLogin, members);
    if (!view) continue;
    out.push({
      channel: view,
      lastAt: r.created_at,
      preview: String(r.body).replace(/\s+/g, " ").slice(0, 120),
      lastBy: r.kind === "ai" ? null : (r.author_login === viewerLogin ? "me" : (r.author_name || null)),
    });
  }
  return out;
}

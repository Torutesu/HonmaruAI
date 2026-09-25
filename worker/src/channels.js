import { listMembers } from "./team.js";
import { businessSlug } from "./db.js";
import { resolveMentions } from "./threads.js";

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
/// handle, never by login. `extra` carries what hydrate() gathered: the
/// thread under it and the reactions on it.
export function toMessage(row, viewerLogin, view, members, extra = {}) {
  const author = row.kind === "ai" ? null : members.find((m) => m.login === row.author_login);
  const deleted = Boolean(row.deleted_at);
  const refOf = (login) => members.find((m) => m.login === login)?.ref || null;
  const reactions = [];
  for (const r of extra.reactions || []) {
    let slot = reactions.find((x) => x.emoji === r.emoji);
    if (!slot) { slot = { emoji: r.emoji, count: 0, refs: [], mine: false }; reactions.push(slot); }
    slot.count += 1;
    const ref = refOf(r.login);
    if (ref) slot.refs.push(ref);
    if (viewerLogin && r.login === viewerLogin) slot.mine = true;
  }
  return {
    id: row.id,
    channel: view,
    kind: row.kind,
    // A deleted message keeps its place (its thread hangs off it) and
    // loses its words.
    body: deleted ? "" : row.body,
    authorName: row.kind === "ai" ? null : (author?.name || row.author_name || null),
    authorRef: author ? author.ref : null,
    authorAvatar: author?.avatarUrl || null,
    mine: Boolean(viewerLogin) && row.author_login === viewerLogin,
    cardId: deleted ? null : (row.card_id || null),
    createdAt: row.created_at,
    editedAt: deleted ? null : (row.edited_at || null),
    deleted,
    parentId: row.parent_id || null,
    replyCount: extra.replyCount || 0,
    lastReplyAt: extra.lastReplyAt || null,
    replyRefs: extra.replyRefs || [],
    pinned: !deleted && Boolean(row.pinned_at),
    reactions: deleted ? [] : reactions,
  };
}

/// The threads and reactions for a page of messages, in as few queries as
/// D1's bound-parameter limit allows.
export async function hydrate(db, orgId, rows) {
  const out = new Map();
  const ids = rows.map((r) => r.id);
  for (const id of ids) out.set(id, { replyCount: 0, lastReplyAt: null, replyLogins: [], reactions: [] });
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map((_, j) => `?${j + 2}`).join(", ");
    const [replies, reactions] = await Promise.all([
      db.prepare(`SELECT parent_id, author_login, created_at FROM channel_messages
                   WHERE org_id = ?1 AND deleted_at IS NULL AND parent_id IN (${marks}) ORDER BY created_at`)
        .bind(orgId, ...chunk).all(),
      db.prepare(`SELECT message_id, emoji, login FROM message_reactions
                   WHERE org_id = ?1 AND message_id IN (${marks}) ORDER BY created_at`)
        .bind(orgId, ...chunk).all(),
    ]);
    for (const r of replies.results || []) {
      const slot = out.get(r.parent_id);
      if (!slot) continue;
      slot.replyCount += 1;
      slot.lastReplyAt = r.created_at;
      if (r.author_login && !slot.replyLogins.includes(r.author_login)) slot.replyLogins.push(r.author_login);
    }
    for (const r of reactions.results || []) out.get(r.message_id)?.reactions.push({ emoji: r.emoji, login: r.login });
  }
  return out;
}

/// Rows to messages, with their threads and reactions.
export async function present(db, orgId, rows, viewerLogin, view, members) {
  const extras = await hydrate(db, orgId, rows);
  return rows.map((r) => {
    const x = extras.get(r.id) || {};
    const replyRefs = (x.replyLogins || []).map((l) => members.find((m) => m.login === l)?.ref).filter(Boolean).slice(0, 5);
    return toMessage(r, viewerLogin, view, members, { ...x, replyRefs });
  });
}

export async function listMessages(db, orgId, resolved, viewerLogin, view, members, { before } = {}) {
  const { results } = await db
    .prepare(
      `SELECT m.*, u.name AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.channel = ?2 AND m.parent_id IS NULL ${before ? "AND m.created_at < ?4" : ""}
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?3`
    )
    .bind(...[orgId, resolved.key, PAGE, ...(before ? [before] : [])])
    .all();
  const rows = (results || []).reverse();
  const shown = await present(db, orgId, rows, viewerLogin, view, members);
  // A deleted message with nothing under it is simply gone, as in Slack.
  return shown.filter((m) => !m.deleted || m.replyCount > 0);
}

/// A thread: the message it hangs off, and every reply under it, oldest first.
export async function listThread(db, orgId, key, parentId, viewerLogin, view, members) {
  const parent = await getMessage(db, orgId, parentId);
  if (!parent || parent.channel !== key || parent.parent_id) return null;
  const { results } = await db
    .prepare(
      `SELECT m.*, u.name AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.parent_id = ?2 AND m.deleted_at IS NULL
        ORDER BY m.created_at, m.rowid`
    )
    .bind(orgId, parentId)
    .all();
  const [head, ...replies] = await present(db, orgId, [parent, ...(results || [])], viewerLogin, view, members);
  return { parent: head, replies };
}

/// Pinned messages in a channel, newest pin first.
export async function listPins(db, orgId, key, viewerLogin, view, members) {
  const { results } = await db
    .prepare(
      `SELECT m.*, u.name AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.channel = ?2 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
        ORDER BY m.pinned_at DESC LIMIT 50`
    )
    .bind(orgId, key)
    .all();
  return present(db, orgId, results || [], viewerLogin, view, members);
}

/// Only the author changes their words, and not the AI's, and not after
/// they are gone.
export async function editMessage(db, { orgId, id, authorLogin, body }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  if (row.kind !== "message" || row.author_login !== authorLogin) return { error: "Only the person who wrote it can edit it.", status: 403 };
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { error: "Write something first.", status: 400 };
  if (text.length > MAX_MESSAGE_CHARS) return { error: `That is longer than ${MAX_MESSAGE_CHARS} characters.`, status: 400 };
  if (text === row.body) return { row };
  await db.prepare("UPDATE channel_messages SET body = ?3, edited_at = ?4 WHERE org_id = ?1 AND id = ?2")
    .bind(orgId, id, text, new Date().toISOString()).run();
  return { row: await getMessage(db, orgId, id) };
}

/// Unsend. The words go at once; the row stays as a tombstone so a thread
/// under it still has somewhere to hang, and its reactions and pin go too.
export async function deleteMessage(db, { orgId, id, authorLogin }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  if (row.kind !== "message" || row.author_login !== authorLogin) return { error: "Only the person who wrote it can delete it.", status: 403 };
  await db.batch([
    db.prepare("UPDATE channel_messages SET body = '', deleted_at = ?3, pinned_at = NULL, pinned_by = NULL WHERE org_id = ?1 AND id = ?2")
      .bind(orgId, id, new Date().toISOString()),
    db.prepare("DELETE FROM message_reactions WHERE org_id = ?1 AND message_id = ?2").bind(orgId, id),
  ]);
  return { row: await getMessage(db, orgId, id) };
}

/// The emoji a reaction may be: one grapheme of pictograph, or a short
/// :name:. Anything longer is somebody writing a message in a reaction.
export function cleanEmoji(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 16) return null;
  if (/^:[a-z0-9_+-]{1,30}:$/.test(text)) return text;
  if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u.test(text) && /\p{Extended_Pictographic}/u.test(text)) return text;
  return null;
}

/// On if it was off, off if it was on — the way a reaction pill works.
export async function toggleReaction(db, { orgId, id, login, emoji }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  const clean = cleanEmoji(emoji);
  if (!clean) return { error: "That is not an emoji.", status: 400 };
  const had = await db.prepare("SELECT 1 FROM message_reactions WHERE message_id = ?1 AND emoji = ?2 AND login = ?3").bind(id, clean, login).first();
  if (had) {
    await db.prepare("DELETE FROM message_reactions WHERE message_id = ?1 AND emoji = ?2 AND login = ?3").bind(id, clean, login).run();
  } else {
    const count = await db.prepare("SELECT COUNT(DISTINCT emoji) AS n FROM message_reactions WHERE message_id = ?1").bind(id).first();
    if ((count?.n || 0) >= 20) return { error: "That message has all the reactions it can hold.", status: 400 };
    await db.prepare("INSERT INTO message_reactions (org_id, message_id, emoji, login, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(orgId, id, clean, login, new Date().toISOString()).run();
  }
  return { row };
}

export async function setPinned(db, { orgId, id, login, pinned }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  if (row.parent_id) return { error: "Pin the message a thread hangs off, not a reply.", status: 400 };
  await db.prepare("UPDATE channel_messages SET pinned_at = ?3, pinned_by = ?4 WHERE org_id = ?1 AND id = ?2")
    .bind(orgId, id, pinned ? new Date().toISOString() : null, pinned ? login : null).run();
  return { row: await getMessage(db, orgId, id) };
}

export async function getMessage(db, orgId, id) {
  return db
    .prepare("SELECT m.*, u.name AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login WHERE m.org_id = ?1 AND m.id = ?2")
    .bind(orgId, id)
    .first();
}

export async function postMessage(db, { orgId, key, authorLogin, body, kind = "message", cardId = null, parentId = null }) {
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { error: "Write something first." };
  if (text.length > MAX_MESSAGE_CHARS) return { error: `That is longer than ${MAX_MESSAGE_CHARS} characters.` };
  if (parentId) {
    // A reply goes under a message in this same conversation, one level deep.
    const parent = await getMessage(db, orgId, parentId);
    if (!parent || parent.channel !== key || parent.parent_id) return { error: "That thread is not here any more." };
  }
  const id = crypto.randomUUID();
  // Strictly after the channel's last message, so two sent in the same
  // millisecond still read in the order they were sent.
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, card_id, created_at, parent_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(id, orgId, key, authorLogin, kind, text, cardId, now, parentId)
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
        WHERE m.org_id = ?1 AND m.channel = ?2 AND m.created_at <= ?3 AND m.deleted_at IS NULL
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
        WHERE m.org_id = ?1 AND m.created_at >= ?2 AND m.deleted_at IS NULL ${where}
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
         JOIN (SELECT channel, MAX(created_at) AS at FROM channel_messages
                WHERE org_id = ?1 AND deleted_at IS NULL AND parent_id IS NULL GROUP BY channel) latest
           ON latest.channel = m.channel AND latest.at = m.created_at
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.deleted_at IS NULL AND m.parent_id IS NULL`
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


// ---- Reading: where each person is up to, what is new for them ----

/// Read up to `at` (now, if not given). Never moves backwards.
export async function markRead(db, orgId, login, key, at) {
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  await db.prepare(
    `INSERT INTO channel_reads (org_id, login, channel, last_read_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (org_id, login, channel) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`
  ).bind(orgId, login, key, when).run();
  return when;
}

/// Every read position this person has, as they name the conversations.
export async function readsFor(db, orgId, login, members) {
  const { results } = await db.prepare("SELECT channel, last_read_at FROM channel_reads WHERE org_id = ?1 AND login = ?2")
    .bind(orgId, login).all();
  const out = {};
  for (const r of results || []) {
    const view = r.channel === "activity" ? "activity" : viewOf(r.channel, login, members);
    if (view) out[view] = r.last_read_at;
  }
  return out;
}

/// Where this person can read: every business channel, and their own DMs.
const VISIBLE = "(m.channel LIKE 'b:%' OR m.channel LIKE 'dm:' || ?2 || '|%' OR m.channel LIKE 'dm:%|' || ?2)";

/// The Activity inbox: messages that name you, and replies in threads you
/// started or answered in — the last 30 days, newest first.
export async function activityFeed(db, orgId, login, members, { days = 30, limit = 60 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [recent, mine, read] = await Promise.all([
    db.prepare(
      `SELECT m.*, u.name AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND ${VISIBLE} AND m.deleted_at IS NULL AND m.created_at >= ?3
          AND (m.author_login IS NULL OR m.author_login != ?2)
        ORDER BY m.created_at DESC LIMIT 500`
    ).bind(orgId, login, since).all(),
    db.prepare(
      `SELECT DISTINCT COALESCE(parent_id, id) AS thread FROM channel_messages
        WHERE org_id = ?1 AND author_login = ?2 AND deleted_at IS NULL AND created_at >= ?3`
    ).bind(orgId, login, new Date(Date.now() - 90 * 86400000).toISOString()).all(),
    db.prepare("SELECT last_read_at FROM channel_reads WHERE org_id = ?1 AND login = ?2 AND channel = 'activity'").bind(orgId, login).first(),
  ]);
  const threads = new Set((mine.results || []).map((r) => r.thread));
  const picked = [];
  for (const r of recent.results || []) {
    const mention = r.body && resolveMentions(r.body, members).some((m) => m.login === login);
    const reply = r.parent_id && threads.has(r.parent_id);
    if (!mention && !reply) continue;
    picked.push({ row: r, type: mention ? "mention" : "reply" });
    if (picked.length >= limit) break;
  }
  const lastRead = read?.last_read_at || "";
  const out = [];
  for (const { row, type } of picked) {
    const view = viewOf(row.channel, login, members);
    if (!view) continue;
    const [message] = await present(db, orgId, [row], login, view, members);
    out.push({ type, message, unread: row.created_at > lastRead, at: row.created_at });
  }
  // What others said with a reaction to what you wrote: one entry each, as
  // a notification — who, which, on what.
  const { results: reacted } = await db.prepare(
    `SELECT r.emoji AS r_emoji, r.created_at AS r_at, ru.name AS r_name, ru.avatar_url AS r_avatar, m.*, au.name AS author_name
       FROM message_reactions r
       JOIN channel_messages m ON m.id = r.message_id AND m.org_id = r.org_id
       LEFT JOIN users ru ON ru.login = r.login
       LEFT JOIN users au ON au.login = m.author_login
      WHERE r.org_id = ?1 AND m.author_login = ?2 AND r.login != ?2
        AND m.deleted_at IS NULL AND r.created_at >= ?3
      ORDER BY r.created_at DESC LIMIT ?4`
  ).bind(orgId, login, since, limit).all().catch(() => ({ results: [] }));
  for (const r of reacted || []) {
    const view = viewOf(r.channel, login, members);
    if (!view) continue;
    const { r_emoji: emoji, r_at: at, r_name: by, r_avatar: byAvatar, ...row } = r;
    const [message] = await present(db, orgId, [row], login, view, members);
    out.push({ type: "reaction", message, unread: at > lastRead, at, emoji, by: by || null, byAvatar: byAvatar || null });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { items: out.slice(0, limit), lastRead };
}

/// Search what was said. `q` may carry Slack's filters: from:@name,
/// in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD, has:thread, is:pinned.
export function parseQuery(raw) {
  const out = { text: [], from: null, in: null, before: null, after: null, has: null, is: null };
  for (const token of String(raw || "").trim().split(/\s+/).filter(Boolean)) {
    const m = /^(from|in|before|after|has|is):(.+)$/i.exec(token);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/^[@#]/, "");
    else out.text.push(token);
  }
  out.text = out.text.join(" ").slice(0, 200);
  return out;
}

export async function searchMessages(db, orgId, login, members, raw, { limit = 30 } = {}) {
  const q = parseQuery(raw);
  const where = [`m.org_id = ?1`, VISIBLE, `m.deleted_at IS NULL`, `m.body != ''`];
  const binds = [orgId, login];
  const add = (sql, value) => { binds.push(value); where.push(sql.replace("?", `?${binds.length}`)); };
  if (q.text) add("m.body LIKE ? ESCAPE '\\'", `%${q.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (q.from) {
    const who = resolveMentions(`@${q.from}`, members)[0];
    if (!who) return { messages: [], query: q };
    add("m.author_login = ?", who.login);
  }
  if (q.in) add("m.channel = ?", `b:${businessSlug(q.in)}`);
  if (q.before && !Number.isNaN(Date.parse(q.before))) add("m.created_at < ?", new Date(q.before).toISOString());
  if (q.after && !Number.isNaN(Date.parse(q.after))) add("m.created_at >= ?", new Date(q.after).toISOString());
  if (q.is === "pinned") where.push("m.pinned_at IS NOT NULL");
  if (q.has === "thread") where.push("EXISTS (SELECT 1 FROM channel_messages r WHERE r.org_id = m.org_id AND r.parent_id = m.id AND r.deleted_at IS NULL)");
  if (!q.text && !q.from && !q.in && !q.is && !q.has) return { messages: [], query: q };
  const { results } = await db.prepare(
    `SELECT m.*, u.name AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
      WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT ${Math.max(1, Math.min(50, limit))}`
  ).bind(...binds).all();
  const rows = results || [];
  const out = [];
  for (const r of rows) {
    const view = viewOf(r.channel, login, members);
    if (!view) continue;
    const [message] = await present(db, orgId, [r], login, view, members);
    out.push(message);
  }
  return { messages: out, query: q };
}

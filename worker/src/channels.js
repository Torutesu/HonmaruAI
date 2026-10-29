import {workflowNoticeGuard} from './harness/workflowNoticeGuard.js';
import {agentRequestStatement} from './agentRequestDispatch.js';
import { roomHookReplyGuard } from './harness/roomHookExecutionGrant.js';
import { listMembers } from "./team.js";
import { businessSlug } from "./db.js";
import { resolveMentions, MENTION_BEFORE } from "./threads.js";

const NOBODY = new Set();
import { filesFor, toFile, claimFiles } from "./files.js";
import { accessFor, mayRead, membersOf, isGroupKey, hasGuests, publicAudience } from "./access.js";
import { parseKeywords, keywordHit } from "./quiet.js";
import { messageLanguage } from "./translate.js";
import { mirrorIds } from "./store/mirror.js";
import { mayAccessAgent } from "./harness/agents.js";

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
// Three kinds of channel. A business's (`b:<slug>`): the whole workspace
// reads it — unless it is private, when only its members do. A direct
// conversation (`dm:<a>|<b>`, logins sorted): only the two people in it,
// and a browser names it by the other person's member handle — `dm:<ref>`
// — never by a login, which is an email address for most people. A group
// DM (`g:<id>`): the three to nine people listed for it. Who may read which
// is access.js's to say.

export const MAX_MESSAGE_CHARS = 4000;
const PAGE = 150;

/// "@AI" anywhere a mention can start, in either width of @, any case —
/// and "@AIに…", where Japanese runs straight on from the name.
/// Where a mention may start is the same rule as every other "@name"
/// (threads.js): "確認して@AI" asks it; "x@ai.com" does not.
const AI_CALL = new RegExp(`${MENTION_BEFORE}[@＠]ai(?![A-Za-z0-9_])`, "iu");
const AI_CALL_ALL = new RegExp(`${MENTION_BEFORE}[@＠]ai(?![A-Za-z0-9_])(?:[にへ]|[,、:：])?\\s*`, "giu");
export function asksTheAI(text) {
  return AI_CALL.test(String(text || ""));
}

/// "@AI" asked for a decision, in so many words: a card, an approval, a
/// sign-off. Anything else said to the AI — a question, "summarise this",
/// "what do you think" — is answered in the thread, never made a card.
export function asksForDecision(text) {
  const t = String(text || "");
  return /(カード|意思決定|決裁|稟議|承認|決定を|判断を仰|OKをもら|approv|sign[- ]?off|decision|\bcard\b|aprob|décision|valid(ate|er)|genehmig|entscheid)/iu.test(t);
}

/// The instruction in a message, without the "@AI" that summoned it.
export function withoutAI(text) {
  // "@AIに…" is addressed to the AI; the particle goes with the name.
  return String(text || "").replace(AI_CALL_ALL, "$1").trim();
}

/// A channel as a client named it, to its stored key — or null when it
/// names nothing this person may read. `members` is the workspace's list,
/// passed in when the caller has it.
export async function resolveChannel(db, orgId, viewer, channel, members) {
  if (typeof channel !== "string") return null;
  if (channel.startsWith("b:")) {
    const slug = channel.slice(2);
    if (!slug || businessSlug(slug) !== slug) return null;
    // A lookup that fails says nothing about whether the channel is private,
    // so it lets nobody in: treating it as public handed a private channel
    // (and everything broadcast in it) to the whole workspace whenever one
    // read failed.
    let row;
    try {
      row = await db.prepare("SELECT private FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug).first();
    } catch {
      return null;
    }
    if (!row?.private) {
      // With guests in the workspace, a public channel has a list of who
      // reads it too — and a guest who is not on it is not told it exists.
      if (!(await hasGuests(db, orgId))) return { key: channel, kind: "business", slug };
      const logins = await publicAudience(db, orgId, channel);
      if (!logins.includes(viewer.login)) return null;
      return { key: channel, kind: "business", slug, logins };
    }
    // A private channel: its members, and for anybody else nothing — not
    // even that it is there.
    const logins = await membersOf(db, orgId, channel);
    if (!logins.includes(viewer.login)) return null;
    return { key: channel, kind: "business", slug, private: true, logins };
  }
  if (isGroupKey(channel)) {
    const logins = await membersOf(db, orgId, channel);
    if (!logins.includes(viewer.login)) return null;
    const list = members || await listMembers(db, orgId, viewer.github_id);
    return { key: channel, kind: "group", logins, others: list.filter((m) => logins.includes(m.login) && m.login !== viewer.login) };
  }
  // A direct conversation with an agent: `ag:<id>` as the person names it,
  // `ag:<id>|<login>` as stored — theirs alone, one per agent.
  if (channel.startsWith("ag:")) {
    const id = channel.slice(3);
    if (!/^[\w-]{1,80}$/.test(id)) return null;
    const agent = await db.prepare(
      `SELECT id, handle, name, emoji, avatar_url, description, instructions, scope, owner_login FROM custom_agents
        WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL AND (scope = 'team' OR owner_login = ?3)`
    ).bind(orgId, id, viewer.login).first().catch(() => null);
    if (!agent) return null;
    if (!(await mayAccessAgent(db, orgId, { ...agent, ownerLogin: agent.owner_login }, viewer.login))) return null;
    return { key: `ag:${id}|${viewer.login}`, kind: "agent", agent, logins: [viewer.login] };
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
/// `access` (access.js's accessFor, for this viewer) is what decides a
/// private channel or a group; without it the caller vouches that the
/// viewer is one of the conversation's people — a broadcast to its members.
export function viewOf(key, viewerLogin, members, access = null) {
  if (key.startsWith("b:") || key.startsWith("g:")) return !access || mayRead(key, access) ? key : null;
  if (key.startsWith("ag:")) {
    const [view, login] = key.split("|");
    return login === viewerLogin ? view : null;
  }
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
  const author = row.kind === "ai" || row.kind === "agent" ? null : members.find((m) => m.login === row.author_login);
  // An agent the team wrote speaks as itself: its name and face.
  const agent = row.kind === "agent" ? (extra.agent || null) : null;
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
    // A deleted message loses its words. A page of history leaves it out;
    // it comes only as the head of a thread opened by its link (listThread
    // fetches it by id), and in what the unsend sends out to take it off
    // the screens it is on.
    body: deleted ? "" : row.body,
    threadTitle: deleted ? null : (row.thread_title || null),
    threadTitleVersion: deleted ? 0 : (row.thread_version || 0),
    // The language it is written in, for a reader in another to ask for it
    // translated (translate.js). Null when there is nothing to translate.
    lang: deleted ? null : messageLanguage(row.body),
    authorName: row.kind === "ai" ? null : (agent?.name || author?.name || row.author_name || null),
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
    pinVersion: Number(row.pin_version || 0),
    ...(row.previews_hidden ? { previewsHidden: true } : {}),
    reactions: deleted ? [] : reactions,
    files: deleted ? [] : (extra.files || []),
    // An inline reply carries the message it answers, as that is now.
    ...(!deleted && row.reply_to_id ? { replyTo: quoteOf(row, extra.original || null, members) } : {}),
    // A thread reply sent to the conversation too: it says so, and what the
    // thread it answers starts with.
    ...(row.parent_id && row.also_channel ? { alsoChannel: true, ...(!deleted ? { threadParent: quoteOf({ ...row, reply_to_id: row.parent_id }, extra.threadParent || null, members) } : {}) } : {}),
    // An agent answering for a person who was mentioned: whose it is.
    ...(row.on_behalf_of ? { onBehalfOf: (() => { const p = members.find((m) => m.login === row.on_behalf_of); return { name: p?.name || null, ref: p?.ref || null }; })() } : {}),
    ...(agent ? { agent: { id: agent.id, handle: agent.handle, name: agent.name, emoji: agent.emoji || null, avatarUrl: agent.avatar_url || agent.avatarUrl || null } } : {}),
  };
}

/// What a spoiler hides in a quote: one bar, the same whatever it said, so
/// not even its length shows.
export const SPOILER_MASK = "████";
const QUOTE_CHARS = 120;

/// What the message renderer reads on a line before it reads a spoiler, in
/// its own order (the web's MessageParts inline()): `code`, a link, an
/// :emoji:, an @name — each kept whole — and then ||a spoiler||, which
/// never crosses a line and holds no bar. One pass, left to right, as the
/// renderer makes: a spoiler here is exactly a spoiler there.
const QUOTE_TOKENS = /(`[^`\n]+`|https?:\/\/[^\s<>"）」|]+|:[a-z0-9_+-]{1,30}:|[@＠][^\s@＠,，。、!?！？:;|]+)|\|\|[^|\n]+\|\|/g;

/// The first words of a message, as a reply quotes them: each ||spoiler||
/// hidden before anything is cut (so half of one never shows), then put on
/// one line. What is a spoiler is decided as the renderer decides it, on
/// the message's own lines: a ```block``` is code across lines (an unclosed
/// one to the end), `code` only within a line — two stray backticks on
/// different lines protect nothing between them — and bars inside either
/// open no spoiler. A file is named when there are no words. At most `max`
/// characters, with an ellipsis when cut.
export function replyExcerpt(body, fileName = null, max = QUOTE_CHARS) {
  const masked = String(body || "").split("```")
    .map((piece, i) => (i % 2 ? piece : piece.replace(QUOTE_TOKENS, (all, kept) => kept || SPOILER_MASK)))
    .join("```");
  const text = masked.replace(/\s+/g, " ").trim() || (fileName ? `📎 ${fileName}` : "");
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/// What a reply shows of the message it answers: who said it and how it
/// starts, or only that it is gone. `original` is that message as it is
/// now, null when there is none; one from another conversation is never
/// shown, whatever the id says.
export function quoteOf(row, original, members) {
  const id = row.reply_to_id;
  if (!original || original.deleted_at || original.channel !== row.channel) {
    return { id, kind: null, authorName: null, authorRef: null, excerpt: "", deleted: true };
  }
  const author = original.kind === "ai" ? null : members.find((m) => m.login === original.author_login);
  return {
    id,
    kind: original.kind,
    authorName: original.kind === "ai" ? null : (author?.name || original.author_name || null),
    authorRef: author?.ref || null,
    excerpt: replyExcerpt(original.body, original.file_name),
    deleted: false,
  };
}

/// The messages these rows reply to, as they are now, by id: one query for
/// a page (in chunks D1's bound-parameter limit allows), none when nothing
/// in it is a reply. The thread a reply sent to the conversation too hangs
/// off is looked up with them.
async function originalsOf(db, orgId, rows) {
  const ids = [...new Set(rows.flatMap((r) => [r.reply_to_id, r.also_channel ? r.parent_id : null]).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT m.id, m.channel, m.parent_id, m.created_at, m.kind, m.body, m.author_login, m.deleted_at,
              COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name,
              (SELECT f.name FROM message_files f WHERE f.org_id = m.org_id AND f.message_id = m.id ORDER BY f.created_at LIMIT 1) AS file_name
         FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.id IN (${chunk.map((_, j) => `?${j + 2}`).join(", ")})`
    ).bind(orgId, ...chunk).all();
    for (const r of results || []) out.set(r.id, r);
  }
  return out;
}

/// The agents that wrote any of these rows, by id — the deleted too, so
/// what one said keeps its name.
async function agentsOf(db, orgId, rows) {
  const ids = [...new Set(rows.filter((r) => r.kind === "agent" && String(r.author_login || "").startsWith("agent:")).map((r) => r.author_login.slice(6)))];
  const out = new Map();
  if (!ids.length) return out;
  const { results } = await db.prepare(
    `SELECT id, handle, name, emoji, avatar_url FROM custom_agents WHERE org_id = ?1 AND id IN (${ids.slice(0, 90).map((_, i) => `?${i + 2}`).join(", ")})`
  ).bind(orgId, ...ids.slice(0, 90)).all().catch(() => ({ results: [] }));
  for (const r of results || []) out.set(`agent:${r.id}`, r);
  return out;
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
      db.prepare(`SELECT parent_id, author_login, kind, created_at FROM channel_messages
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
      // Who answered, for the faces beside "3 replies": a person by login,
      // the AI as "ai", an agent as "agent:<id>".
      const who = r.kind === "ai" ? "ai" : r.author_login;
      if (who && !slot.replyLogins.includes(who)) slot.replyLogins.push(who);
    }
    for (const r of reactions.results || []) out.get(r.message_id)?.reactions.push({ emoji: r.emoji, login: r.login });
  }
  return out;
}

/// Rows to messages, with their threads, reactions and files — each file
/// with an address signed for whoever is being shown it.
export async function present(db, orgId, rows, viewerLogin, view, members) {
  const [extras, files, agents, originals] = await Promise.all([hydrate(db, orgId, rows), filesFor(db, orgId, rows.map((r) => r.id)), agentsOf(db, orgId, rows), originalsOf(db, orgId, rows)]);
  const now = Date.now();
  return Promise.all(rows.map(async (r) => {
    const x = extras.get(r.id) || {};
    const replyRefs = (x.replyLogins || []).map((l) => (l === "ai" || String(l).startsWith("agent:") ? l : members.find((m) => m.login === l)?.ref)).filter(Boolean).slice(0, 5);
    const own = await Promise.all((files.get(r.id) || []).map((f) => toFile(db, f, now)));
    return toMessage(r, viewerLogin, view, members, { ...x, replyRefs, files: own, agent: agents.get(r.author_login) || null, original: originals.get(r.reply_to_id) || null, threadParent: r.also_channel ? originals.get(r.parent_id) || null : null });
  }));
}

/// A page of a conversation: up to `PAGE` messages before `before`, oldest
/// first, and `more` — whether there are older ones still.
///
/// A deleted message is simply gone. (Before its thread went with it, one
/// could be left with replies under it; those are not shown either.) It is
/// left out by the query, not after it: filtered from a page already cut to
/// `PAGE`, one unsent message made the page short, and a short page read as
/// the start of the conversation — the history above it could not be
/// reached. One row past the page says outright whether there is more.
///
/// `beforeId`, the oldest message the reader holds, makes `before` exact:
/// two messages can share a millisecond, and a page cut between them left
/// the older one out of every page, since `created_at < before` skipped it.
/// With the id, messages at that same moment that come before it in the
/// page order are read too. Without it (or with an id not in this
/// conversation) `before` alone is the cursor, as it always was.
export async function listMessages(db, orgId, resolved, viewerLogin, view, members, { before, beforeId } = {}) {
  const exact = before && typeof beforeId === "string" && beforeId ? beforeId : null;
  const older = !before ? ""
    : exact ? "AND (m.created_at < ?4 OR (m.created_at = ?4 AND m.rowid < (SELECT b.rowid FROM channel_messages b WHERE b.org_id = ?1 AND b.channel = ?2 AND b.id = ?5)))"
      : "AND m.created_at < ?4";
  const { results } = await db
    .prepare(
      `SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.channel = ?2 AND (m.parent_id IS NULL OR m.also_channel = 1) AND m.deleted_at IS NULL ${older}
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?3`
    )
    .bind(...[orgId, resolved.key, PAGE + 1, ...(before ? [before] : []), ...(exact ? [exact] : [])])
    .all();
  const more = (results || []).length > PAGE;
  const rows = (results || []).slice(0, PAGE).reverse();
  return { messages: await present(db, orgId, rows, viewerLogin, view, members), more };
}

/// Legacy callers keep complete history until they opt into bounded pages.
export function threadPageRequest(params) {
  if (!params.has("limit")) {
    if (params.has("before")) throw new Error("A thread cursor requires a page limit.");
    return null;
  }
  const limit = Number(params.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Thread page limit must be between 1 and 50.");
  const before = params.get("before");
  if (!before) return { limit, before: null };
  try {
    if (before.length > 256 || !/^[A-Za-z0-9_-]+$/.test(before)) throw new Error();
    const cursor = JSON.parse(atob(before.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor[0]) || !Number.isSafeInteger(cursor[1]) || cursor[1] < 1) throw new Error();
    return { limit, before: cursor };
  } catch { throw new Error("Invalid thread cursor."); }
}

/// A thread: parent plus replies, oldest first. Paged readers start at the
/// newest replies and retain an opaque timestamp/rowid boundary for older ones.
export async function listThread(db, orgId, key, parentId, viewerLogin, view, members, page = null) {
  const parent = await getMessage(db, orgId, parentId);
  if (!parent || parent.channel !== key || parent.parent_id || (page && parent.deleted_at)) return null;
  const select = (older, limit = page?.limit + 1, boundary = []) => db
    .prepare(
      `SELECT m.*, m.rowid AS thread_rowid, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.parent_id = ?2 AND m.deleted_at IS NULL ${older}
        ORDER BY m.created_at ${page ? "DESC" : "ASC"}, m.rowid ${page ? "DESC" : "ASC"} ${page ? "LIMIT ?3" : ""}`
    )
    .bind(orgId, parentId, ...(page ? [limit, ...boundary] : []))
    .all();
  // Equality on created_at lets SQLite seek its implicit rowid tie-breaker.
  // A tuple comparison alone scans the whole timestamp tie before rowid.
  const first = page?.before
    ? await select("AND m.created_at = ?4 AND m.rowid < ?5", page.limit + 1, page.before)
    : await select("");
  const results = first.results || [];
  if (page?.before && results.length <= page.limit) {
    const earlier = await select("AND m.created_at < ?4", page.limit + 1 - results.length, [page.before[0]]);
    results.push(...(earlier.results || []));
  }
  const more = Boolean(page && results?.length > page.limit);
  const rows = page ? (results || []).slice(0, page.limit).reverse() : results || [];
  const oldest = rows[0];
  const nextCursor = more && oldest ? btoa(JSON.stringify([oldest.created_at, oldest.thread_rowid])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
  const [head, ...replies] = await present(db, orgId, [parent, ...rows], viewerLogin, view, members);
  return { parent: head, replies, ...(page ? { more, nextCursor } : {}) };
}

/// Pinned messages in a channel, newest pin first.
export async function listPins(db, orgId, key, viewerLogin, view, members) {
  const { results } = await db
    .prepare(
      `SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m
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
  // Under a legal hold, the words as they were are kept for the export.
  const { keepIfHeld } = await import("./governance.js");
  await keepIfHeld(db, orgId, row, "edit");
  await db.prepare("UPDATE channel_messages SET body = ?3, edited_at = ?4 WHERE org_id = ?1 AND id = ?2")
    .bind(orgId, id, text, new Date().toISOString()).run();
  await mirrorIds(db, orgId, [id]);
  return { row: await getMessage(db, orgId, id) };
}

/// Unsend. The message is gone — no "this message was deleted" left in
/// its place — and a thread under it goes with it: the replies, their
/// reactions and pins. The rows stay only as tombstones nobody is shown.
/// `replies` are the ids taken with it, for their files to go too.
export async function deleteMessage(db, { orgId, id, authorLogin, withThread = false }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  if (row.kind !== "message" || row.author_login !== authorLogin) return { error: "Only the person who wrote it can delete it.", status: 403 };
  const { keepIfHeld } = await import("./governance.js");
  await keepIfHeld(db, orgId, row, "delete");
  const { results: under } = row.parent_id ? { results: [] } : await db.prepare(
    "SELECT * FROM channel_messages WHERE org_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL"
  ).bind(orgId, id).all();
  // Other people's words go with it only when that was said outright.
  const others = (under || []).filter((r) => r.author_login !== authorLogin).length;
  if (others && !withThread) return { error: "Others replied in this thread. Delete it with their replies?", status: 409, code: "thread_has_replies", others };
  for (const r of under || []) await keepIfHeld(db, orgId, r, "delete");
  const now = new Date().toISOString();
  const tombstone = (mids) => db.batch(mids.flatMap((mid) => [
    db.prepare("UPDATE channel_messages SET body = '', deleted_at = ?3, pinned_at = NULL, pinned_by = NULL WHERE org_id = ?1 AND id = ?2")
      .bind(orgId, mid, now),
    db.prepare("DELETE FROM message_reactions WHERE org_id = ?1 AND message_id = ?2").bind(orgId, mid),
    // A snapshot may contain this reply. Deleting source content also removes
    // its public copies, in the same transaction as the tombstone.
    db.prepare("UPDATE channel_thread_shares SET revoked_at=COALESCE(revoked_at,?3),snapshot='{}' WHERE org_id=?1 AND message_id=?2")
      .bind(orgId, row.parent_id || id, now),
    ...(mid === id && !row.parent_id ? [
      db.prepare("DELETE FROM channel_thread_details WHERE org_id = ?1 AND message_id = ?2").bind(orgId, mid),
      db.prepare("DELETE FROM channel_thread_pins WHERE org_id = ?1 AND message_id = ?2").bind(orgId, mid),
    ] : []),
  ]));
  const gone = [id, ...(under || []).map((r) => r.id)];
  await tombstone(gone);
  // A reply that landed between the read above and the parent going is
  // taken too: once the parent is a tombstone no further reply can land
  // (postMessage), so this second look is the last.
  if (!row.parent_id) {
    const { results: late } = await db.prepare(
      "SELECT * FROM channel_messages WHERE org_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL"
    ).bind(orgId, id).all();
    if (late?.length) {
      for (const r of late) await keepIfHeld(db, orgId, r, "delete");
      await tombstone(late.map((r) => r.id));
      gone.push(...late.map((r) => r.id));
    }
  }
  await mirrorIds(db, orgId, gone);
  return { row: await getMessage(db, orgId, id), replies: gone.slice(1) };
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
export async function toggleReaction(db, { orgId, id, login, emoji, row: known = null }) {
  // The caller that has just read the message hands it over: one read fewer.
  const row = known && known.id === id ? known : await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  const clean = cleanEmoji(emoji);
  if (!clean) return { error: "That is not an emoji.", status: 400 };
  const had = await db.prepare("SELECT 1 FROM message_reactions WHERE message_id = ?1 AND emoji = ?2 AND login = ?3").bind(id, clean, login).first();
  if (had) {
    await db.prepare("DELETE FROM message_reactions WHERE message_id = ?1 AND emoji = ?2 AND login = ?3").bind(id, clean, login).run();
  } else {
    // The cap is on kinds of emoji, not on people: joining an emoji already
    // there is always allowed, and only a 21st kind is refused. One statement
    // checks and inserts, so two people adding different new kinds at once
    // cannot take a message past twenty between them.
    const added = await db.prepare(
      `INSERT INTO message_reactions (org_id, message_id, emoji, login, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM message_reactions WHERE message_id = ?2 AND emoji = ?3)
          OR (SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id = ?2) < 20
       ON CONFLICT DO NOTHING`
    ).bind(orgId, id, clean, login, new Date().toISOString()).run();
    if (!added.meta?.changes) {
      // Nothing inserted because this person's reaction landed a moment ago
      // (a double tap) is not the cap.
      const now = await db.prepare("SELECT 1 FROM message_reactions WHERE message_id = ?1 AND emoji = ?2 AND login = ?3").bind(id, clean, login).first();
      if (!now) return { error: "That message has all the reactions it can hold.", status: 400 };
    }
  }
  return { row };
}

/// The author takes a message's link cards off, or puts them back.
export async function setPreviewsHidden(db, { orgId, id, login, hidden }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  if (row.author_login !== login) return { error: "Only the person who wrote it can change its previews.", status: 403 };
  await db.prepare("UPDATE channel_messages SET previews_hidden = ?3 WHERE org_id = ?1 AND id = ?2").bind(orgId, id, hidden ? 1 : 0).run();
  return { row: await getMessage(db, orgId, id) };
}

export async function setPinned(db, { orgId, id, login, pinned }) {
  const row = await getMessage(db, orgId, id);
  if (!row || row.deleted_at) return { error: "No such message.", status: 404 };
  if (row.parent_id) return { error: "Pin the message a thread hangs off, not a reply.", status: 400 };
  const result = await db.prepare("UPDATE channel_messages SET pinned_at = ?3, pinned_by = ?4, pin_version = pin_version + 1 WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL AND parent_id IS NULL")
    .bind(orgId, id, pinned ? new Date().toISOString() : null, pinned ? login : null).run();
  if (!result.meta?.changes) return { error: "No such message.", status: 404 };
  return { row: await getMessage(db, orgId, id) };
}

export async function getMessage(db, orgId, id) {
  return db
    .prepare("SELECT m.*, td.title AS thread_title, td.version AS thread_version, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login LEFT JOIN channel_thread_details td ON td.org_id = m.org_id AND td.message_id = m.id WHERE m.org_id = ?1 AND m.id = ?2")
    .bind(orgId, id)
    .first();
}

/// The browser's id for a send (`tmp-…`). Anything else is not a retry key.
const CLIENT_ID = /^tmp-[0-9a-z-]{1,76}$/;
export const clientIdOk = (id) => typeof id === "string" && CLIENT_ID.test(id);

const THREAD_GONE = "That thread is not here any more.";

async function messageByClientId(db, orgId, authorLogin, clientId) {
  const hit = await db
    .prepare("SELECT id FROM channel_messages WHERE org_id = ?1 AND author_login = ?2 AND client_id = ?3")
    .bind(orgId, authorLogin, clientId)
    .first();
  return hit ? getMessage(db, orgId, hit.id) : null;
}

/// A send naming an upload that is not there any more: swept unsent, or
/// gone with its message. Said, so the file can be attached again, rather
/// than sent without it.
const FILES_GONE = "A file in this message is no longer there. Attach it again.";

export async function postMessage(db, { orgId, key, authorLogin, body, kind = "message", cardId = null, parentId = null, replyTo = null, withFiles = false, files = null, clientId = null, alsoChannel = false, onBehalfOf = null, roomHookSource = false, agentRequest = null, assignmentFence = null, workflowNotice = null }) {
  if(workflowNotice && (kind!=='ai'||authorLogin!=='__workflow'||!parentId||files||withFiles||assignmentFence||agentRequest||roomHookSource||typeof workflowNotice.workflowId!=='string'||typeof workflowNotice.generation!=='string'||typeof workflowNotice.recipientId!=='string'))return {error:'Invalid workflow notice.',status:403};
  if (roomHookSource && (!parentId || kind !== 'agent' || !authorLogin?.startsWith('agent:'))) return {error:'Invalid webhook reply.',status:403};
  if(assignmentFence && (kind!=='agent' || !parentId || files?.ids?.length || withFiles || typeof assignmentFence.assignmentId!=='string' || !Number.isSafeInteger(assignmentFence.generation) || typeof assignmentFence.sourceId!=='string' || typeof assignmentFence.sourceBody!=='string' || typeof assignmentFence.sourceAuthor!=='string'))return {error:'Invalid execution reply.',status:403};
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  const remembered = clientIdOk(clientId) ? clientId : null;
  // A picture on its own is something said. A retry of one has had its
  // files claimed already, and is answered below with what it made.
  if (!text && !withFiles && !files?.gone && !remembered) return { error: "Write something first." };
  if (text.length > MAX_MESSAGE_CHARS) return { error: `That is longer than ${MAX_MESSAGE_CHARS} characters.` };
  if (clientId != null && clientId !== "" && !clientIdOk(clientId)) return { error: "That send cannot be tried again.", status: 400 };
  if (parentId) {
    // A reply goes under a message in this same conversation, one level deep.
    // A deleted one is a tombstone, not a thread: nothing new goes under it.
    const parent = await getMessage(db, orgId, parentId);
    if (!parent || parent.deleted_at || parent.channel !== key || parent.parent_id) return { error: THREAD_GONE, code: "thread_gone" };
  }
  // A retry of a send that already landed gets that message back, before
  // anything about it is checked again: it was fine when it was written.
  if (remembered && authorLogin) {
    const prior = await messageByClientId(db, orgId, authorLogin, remembered);
    if (prior) return { row: prior, replay: true };
  }
  if (files?.gone) return { error: FILES_GONE, code: "files_gone", status: 409 };
  if (!text && !withFiles) return { error: "Write something first." };
  if (replyTo) {
    // An inline reply answers a message where it is read: the conversation
    // for a message, the same thread for a reply in one. Gone, unsent or
    // somewhere else are refused alike, so the refusal says nothing of
    // what another conversation holds. Only something somebody said — not
    // a "joined" line or another notice — can be answered.
    const original = await getMessage(db, orgId, replyTo);
    const here = original && original.channel === key && !original.deleted_at
      && ["message", "ai", "agent"].includes(original.kind)
      && (parentId ? original.id === parentId || original.parent_id === parentId : !original.parent_id);
    if (!here) return { error: "The message you are replying to is not here any more.", code: "reply_gone" };
  }
  const id = crypto.randomUUID();
  // Strictly after the channel's last message, so two sent in the same
  // millisecond still read in the order they were sent.
  const now = new Date().toISOString();
  const columns = "id, org_id, channel, author_login, kind, body, card_id, created_at, parent_id, reply_to_id, client_id, also_channel, on_behalf_of";
  const values = [id, orgId, key, authorLogin, kind, text, cardId, now, parentId, replyTo || null, remembered, parentId && alsoChannel ? 1 : 0, kind === "agent" && onBehalfOf ? onBehalfOf : null];
  const marks = values.map((_, i) => `?${i + 1}`).join(", ");
  const dispatch = agentRequest ? await agentRequestStatement(db,{orgId,row:{id,channel:key,author_login:authorLogin,kind,body:text,parent_id:parentId},...agentRequest}) : null;
  try {
    // A reply is written only while its parent is still there, in the same
    // statement: a thread deleted after the check above takes no reply.
    const parentLive = "(?9 IS NULL OR EXISTS (SELECT 1 FROM channel_messages WHERE org_id = ?2 AND id = ?9 AND deleted_at IS NULL))" + (roomHookSource ? ` AND ${roomHookReplyGuard}` : "");
    const executionLive = assignmentFence ? ` AND EXISTS (SELECT 1 FROM hx_agent_assignments a JOIN channel_messages s ON s.org_id=a.org_id AND s.id=a.source_message_id
      WHERE a.org_id=?2 AND a.id=?14 AND a.generation=?15 AND a.status='running' AND 'agent:'||a.current_agent_id=?4 AND a.channel=?3 AND a.thread_id=?9
      AND s.channel=a.channel AND s.kind='message' AND COALESCE(s.parent_id,s.id)=a.thread_id AND s.id=?16 AND s.body=?17 AND s.author_login=?18 AND COALESCE(s.parent_id,'')=?19 AND s.deleted_at IS NULL)` : '';
    const noticeLive=workflowNotice?` AND ${workflowNoticeGuard}`:'';
    const noticeValues=workflowNotice?[workflowNotice.workflowId,workflowNotice.generation||'',workflowNotice.recipientId,workflowNotice.budgetNoticeId||'']:[];
    const fenceValues=assignmentFence?[assignmentFence.assignmentId,assignmentFence.generation,assignmentFence.sourceId,assignmentFence.sourceBody,assignmentFence.sourceAuthor,assignmentFence.sourceParent || '']:[];

    if (files?.ids?.length) {
      // The message and its files in one step, all or none: its uploads are
      // claimed, the message is written only if every one of them still
      // could be (the sweep of unsent ones may have taken one since they
      // were looked at), and a claim whose message was not written is let
      // go. A send that fails part way leaves no message missing its files,
      // and a retry of it is a send like the first.
      const done = await db.batch([
        claimFiles(db, { orgId, key, login: files.login, messageId: id, ids: files.ids }),
        db.prepare(`INSERT INTO channel_messages (${columns}) SELECT ${marks}
                    WHERE ${parentLive} AND (SELECT COUNT(*) FROM message_files WHERE org_id = ?2 AND message_id = ?1) = ?${values.length + 1}`)
          .bind(...values, files.ids.length),
        db.prepare("UPDATE message_files SET message_id = NULL WHERE org_id = ?1 AND message_id = ?2 AND NOT EXISTS (SELECT 1 FROM channel_messages WHERE org_id = ?1 AND id = ?2)")
          .bind(orgId, id),
        ...(dispatch ? [dispatch] : []),
      ]);
      if (!done[1].meta?.changes) {
        if (parentId && !(await db.prepare("SELECT 1 FROM channel_messages WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL").bind(orgId, parentId).first())) {
          return { error: THREAD_GONE, code: "thread_gone" };
        }
        return { error: FILES_GONE, code: "files_gone", status: 409 };
      }
    } else {
      const insert = db.prepare(`INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, card_id, created_at, parent_id, reply_to_id, client_id, also_channel, on_behalf_of) SELECT ${marks} WHERE ${parentLive}${executionLive}${noticeLive}`).bind(...values,...fenceValues,...noticeValues);
      const put = dispatch ? (await db.batch([insert,dispatch]))[0] : await insert.run();
      if(workflowNotice && !put.meta?.changes)return {error:'Workflow notice access changed.',code:'notice_changed',status:409};
      if (assignmentFence && !put.meta?.changes)return {error:'Execution access changed.',code:'execution_changed',status:409};
      if (parentId && !put.meta?.changes) return roomHookSource ? {error:"Webhook access changed.",code:"webhook_revoked",status:403} : { error: THREAD_GONE, code: "thread_gone" };
    }
  } catch (err) {
    if (remembered && authorLogin) {
      const prior = await messageByClientId(db, orgId, authorLogin, remembered);
      if (prior) return { row: prior, replay: true };
    }
    throw err;
  }
  await mirrorIds(db, orgId, [id]);
  return { row: await getMessage(db, orgId, id) };
}

export async function linkCard(db, orgId, messageId, cardId) {
  await db.prepare("UPDATE channel_messages SET card_id = ?3 WHERE org_id = ?1 AND id = ?2 AND card_id IS NULL")
    .bind(orgId, messageId, cardId).run();
}

/// The conversation before (and including) a message, as the AI reads it:
/// one line per message, names not logins, oldest first. An inline reply
/// says what it answers, as its reader sees over it — so the AI knows which
/// message "this" is, and is shown one too old to be among these lines.
export async function transcriptUpTo(db, orgId, key, createdAt, { limit = 24, skip = null, threadId = null, throughId = null } = {}) {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.parent_id, m.kind, m.body, m.created_at, m.reply_to_id, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name, m.author_login,
              (SELECT ca.handle FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login) AS agent_handle,
              (SELECT group_concat(f.name, ', ') FROM message_files f WHERE f.org_id = m.org_id AND f.message_id = m.id) AS file_names
         FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.channel = ?2 AND m.created_at <= ?3 AND m.deleted_at IS NULL AND m.kind != 'joined'
          AND (?5 IS NULL OR m.id = ?5 OR m.parent_id = ?5)
          AND (?6 IS NULL OR m.created_at < ?3 OR m.rowid <= (SELECT rowid FROM channel_messages WHERE org_id = ?1 AND channel = ?2 AND id = ?6))
        ORDER BY CASE WHEN m.id = ?5 THEN 0 ELSE 1 END, m.created_at DESC, m.rowid DESC LIMIT ?4`
    )
    .bind(orgId, key, createdAt, skip ? limit * 3 : limit, threadId, throughId)
    .all();
  // `skip`: rows left out — talk with the agents, for a decision.
  const kept = skip ? (results || []).filter((r) => !skip({ ...r, channel: key })).slice(0, limit) : (results || []);
  const originals = await originalsOf(db, orgId, kept);
  const answers = (r, max) => {
    const o = r.reply_to_id ? originals.get(r.reply_to_id) : null;
    // Never one from another conversation, one unsent, or one `skip`
    // leaves out of these lines.
    if (!o || o.deleted_at || o.channel !== key || (skip && skip(o))) return "";
    if (threadId && o.id !== threadId && o.parent_id !== threadId) return "";
    if (o.created_at > createdAt || (throughId && o.created_at === createdAt && !kept.some((r) => r.id === o.id))) return "";
    const said = String(o.body || "").replace(/\s+/g, " ").trim() || (o.file_name ? `[attached: ${o.file_name}]` : "");
    return ` (replying to ${o.kind === "ai" ? "AI" : (o.author_name || "someone")}: "${said.length > max ? `${said.slice(0, max)}…` : said}")`;
  };
  return kept.reverse().sort((a, b) => a.id === threadId ? -1 : b.id === threadId ? 1 : 0).map((r, i, all) => {
    // An agent says so, with its handle: an agent reading the thread tells
    // its own earlier answers from another agent's, and both from people.
    const who = r.kind === "ai" ? "AI" : r.agent_handle ? `${r.author_name || r.agent_handle} (agent @${r.agent_handle})` : (r.author_name || "someone");
    const attached = r.file_names ? ` [attached: ${String(r.file_names).slice(0, 200)}]` : "";
    // The newest line is the one that asks: what it answers comes as long
    // as a line of its own would. The rest carry the short quote people see.
    const answered = answers(r, i === all.length - 1 ? 500 : QUOTE_CHARS);
    return `${String(r.created_at).slice(5, 16).replace("T", " ")} ${who}${answered}: ${String(r.body).replace(/\s+/g, " ").slice(0, 500)}${attached}`;
  });
}

/// What a business's channel has said lately, for anything that writes
/// about that business: "Ask anything" on its cards, routines about it.
export async function recentBusinessTalk(db, orgId, slugs, { since, limit = 30 } = {}) {
  const keys = [...new Set((slugs || []).filter(Boolean))].slice(0, 20).map((s) => `b:${s}`);
  const where = (keys.length ? `AND m.channel IN (${keys.map((_, i) => `?${i + 3}`).join(", ")})` : "AND m.channel LIKE 'b:%'")
    // What a private channel said stays in it: this feeds the AI's answers
    // on cards and routines anyone in the workspace may read.
    + " AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.org_id = ?1 AND 'b:' || b.slug = m.channel AND b.private = 1)";
  const { results } = await db
    .prepare(
      `SELECT m.channel, m.kind, m.body, m.created_at, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.kind != 'agent' AND m.org_id = ?1 AND m.created_at >= ?2 AND m.deleted_at IS NULL ${where}
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
      `SELECT m.id, m.channel, m.body, m.kind, m.created_at, m.author_login, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name,
              (SELECT f.name FROM message_files f WHERE f.org_id = m.org_id AND f.message_id = m.id ORDER BY f.created_at LIMIT 1) AS file_name
         FROM channel_messages m
         JOIN (SELECT channel, MAX(created_at) AS at FROM channel_messages
                WHERE org_id = ?1 AND deleted_at IS NULL AND (parent_id IS NULL OR also_channel = 1) AND kind != 'joined' GROUP BY channel) latest
           ON latest.channel = m.channel AND latest.at = m.created_at
         LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND m.deleted_at IS NULL AND (m.parent_id IS NULL OR m.also_channel = 1) AND m.kind != 'joined'`
    )
    .bind(orgId)
    .all();
  const access = await accessFor(db, orgId, viewerLogin);
  const out = [];
  for (const r of results || []) {
    const view = viewOf(r.channel, viewerLogin, members, access);
    if (!view) continue;
    out.push({
      // For the caller to put the preview in the reader's language; not sent.
      _row: { id: r.id, body: r.body },
      channel: view,
      lastAt: r.created_at,
      preview: (String(r.body).replace(/\s+/g, " ").trim() || (r.file_name ? `📎 ${r.file_name}` : "")).slice(0, 120),
      lastBy: r.kind === "ai" ? null : (r.author_login === viewerLogin ? "me" : (r.author_name || null)),
    });
  }
  return out;
}


// ---- Reading: where each person is up to, what is new for them ----

/// Read up to `at` (now, if not given). Never moves backwards.
export async function markRead(db, orgId, login, key, at, versioned = false) {
  const parsed = at ? Date.parse(at) : NaN;
  // A clock ahead of the server must not mark a message read that has not
  // been written yet. A clock behind keeps the earlier moment the person saw.
  const when = Number.isNaN(parsed) ? new Date().toISOString() : new Date(Math.min(parsed, Date.now())).toISOString();
  const state = await db.prepare(
    `INSERT INTO channel_reads (org_id, login, channel, last_read_at, read_version) VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (org_id, login, channel) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at), read_version = read_version + 1
     RETURNING last_read_at AS lastReadAt, read_version AS readVersion`
  ).bind(orgId, login, key, when).first();
  return versioned ? state : state.lastReadAt;
}

/// An Activity item's name, the same on every device: `m:<message>` for a
/// mention, reply or keyword, `r:<message>:<hash>` for one reaction.
function reactionKey(messageId, byLogin, emoji) {
  let h = 0;
  for (const ch of `${byLogin}|${emoji}`) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `r:${messageId}:${h.toString(36)}`;
}

/// Activity items looked at, wherever: kept so every other device stops
/// calling them new. Only names that look like one are kept.
export async function markActivitySeen(db, orgId, login, keys) {
  const valid = [...new Set((Array.isArray(keys) ? keys : []).map(String))]
    .filter((k) => /^(m:[A-Za-z0-9_-]{1,64}|r:[A-Za-z0-9_-]{1,64}:[a-z0-9]{1,8})$/.test(k))
    .slice(0, 100);
  if (!valid.length) return [];
  const at = new Date().toISOString();
  await db.batch(valid.map((k) => db.prepare(
    "INSERT INTO activity_reads (org_id, login, item, read_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (org_id, login, item) DO NOTHING"
  ).bind(orgId, login, k, at)));
  return valid;
}

/// A reply looked at in Activity is read in its thread too, up to it: Threads
/// stops calling it new, as Activity does for a thread read. Later replies
/// stay new. Returns each thread moved, and how far it is read now.
export async function readThreadsSeenInActivity(db, orgId, login, keys) {
  const ids = [...new Set(keys.filter((k) => k.startsWith("m:")).map((k) => k.slice(2)))];
  if (!ids.length) return [];
  // Only replies this person can read: a name sent here moves nothing else.
  const marks = ids.map((_, i) => `?${i + 3}`).join(", ");
  const { results } = await db.prepare(
    `SELECT m.parent_id AS parent_id, MAX(m.created_at) AS at FROM channel_messages m
      WHERE m.org_id = ?1 AND ${VISIBLE} AND m.id IN (${marks}) AND m.parent_id IS NOT NULL AND m.deleted_at IS NULL GROUP BY m.parent_id`
  ).bind(orgId, login, ...ids).all();
  const out = [];
  for (const r of results || []) {
    const state = await markRead(db, orgId, login, `t:${r.parent_id}`, r.at, true);
    out.push({ thread: r.parent_id, ...state });
  }
  return out;
}

/// "Mark unread from here": read only up to just before this message,
/// even if that is further back than before.
export async function markUnreadFrom(db, orgId, login, key, createdAt, versioned = false) {
  const when = new Date(Date.parse(createdAt) - 1).toISOString();
  const state = await db.prepare(
    `INSERT INTO channel_reads (org_id, login, channel, last_read_at, read_version) VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (org_id, login, channel) DO UPDATE SET last_read_at = excluded.last_read_at, read_version = read_version + 1
     RETURNING last_read_at AS lastReadAt, read_version AS readVersion`
  ).bind(orgId, login, key, when).first();
  return versioned ? state : state.lastReadAt;
}

/// Every read position this person has, as they name the conversations.
export async function readsFor(db, orgId, login, members, versioned = false) {
  const { results } = await db.prepare("SELECT channel, last_read_at, read_version FROM channel_reads WHERE org_id = ?1 AND login = ?2")
    .bind(orgId, login).all();
  const access = await accessFor(db, orgId, login);
  const out = {};
  for (const r of results || []) {
    const view = r.channel === "activity" || /^app:[a-z0-9_-]{1,32}$/.test(r.channel) ? r.channel : viewOf(r.channel, login, members, access);
    if (view) out[view] = versioned ? {lastReadAt:r.last_read_at,readVersion:r.read_version} : r.last_read_at;
  }
  return out;
}

/// Where this person can read: every public channel and the private ones
/// they are in — for a guest, only the channels they were let into — their
/// own DMs, and their group DMs. (`?1` the workspace, `?2` the login.)
/// viewOf with their access checks each row again, but the rule is whole
/// here, as mayRead has it, so it holds before a LIMIT: a guest's search
/// was cut to its newest 30 matches first, and matches in public channels
/// they cannot read could fill them and hide every one they can.
const VISIBLE = `(
  (m.channel LIKE 'b:%' AND (
     EXISTS (SELECT 1 FROM conversation_members c WHERE c.org_id = ?1 AND c.channel = m.channel AND c.login = ?2)
     OR (NOT EXISTS (SELECT 1 FROM businesses b WHERE b.org_id = ?1 AND 'b:' || b.slug = m.channel AND b.private = 1)
         AND NOT EXISTS (SELECT 1 FROM memberships ms JOIN users gu ON gu.github_id = ms.user_github_id
                          WHERE ms.org_id = ?1 AND gu.login = ?2 AND LOWER(ms.role) = 'guest'))))
  OR m.channel LIKE 'dm:' || ?2 || '|%' OR m.channel LIKE 'dm:%|' || ?2
  OR (m.channel LIKE 'g:%' AND EXISTS (SELECT 1 FROM conversation_members c WHERE c.org_id = ?1 AND c.channel = m.channel AND c.login = ?2)))`;

/// The Activity inbox: messages that name you, replies in threads you
/// started or answered in or inline to what you wrote, and your keywords
/// said anywhere you can read — the last 30 days, newest first.
export async function activityFeed(db, orgId, login, members, { days = 30, limit = 60 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [recent, mine, read, kw] = await Promise.all([
    db.prepare(
      `SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name,
              (SELECT o.author_login FROM channel_messages o WHERE o.org_id = m.org_id AND o.id = m.reply_to_id AND o.channel = m.channel AND o.deleted_at IS NULL) AS reply_to_login
         FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND ${VISIBLE} AND m.deleted_at IS NULL AND m.created_at >= ?3
          AND (m.author_login IS NULL OR m.author_login != ?2)
        ORDER BY m.created_at DESC LIMIT 500`
    ).bind(orgId, login, since).all(),
    db.prepare(
      `SELECT DISTINCT COALESCE(parent_id, id) AS thread FROM channel_messages
        WHERE org_id = ?1 AND author_login = ?2 AND deleted_at IS NULL AND created_at >= ?3`
    ).bind(orgId, login, new Date(Date.now() - 90 * 86400000).toISOString()).all(),
    db.prepare("SELECT last_read_at FROM channel_reads WHERE org_id = ?1 AND login = ?2 AND channel = 'activity'").bind(orgId, login).first(),
    db.prepare("SELECT notify_keywords FROM users WHERE login = ?1").bind(login).first().catch(() => null),
  ]);
  const threads = new Set((mine.results || []).map((r) => r.thread));
  const keywords = parseKeywords(kw?.notify_keywords);
  // "@here" was for whoever was at the app then — a push, not a later
  // entry in Activity; "@channel" is for everyone.
  const names = new Map((recent.results || []).map((r) => [r.id, Boolean(r.body) && resolveMentions(r.body, members, { online: NOBODY }).some((m) => m.login === login)]));
  // Named in a thread — in its first message or in a reply — is being in
  // it, as Threads has it: the replies after that are yours here too. Left
  // out, Threads kept such a thread new after its mention was seen here,
  // and both had to be opened.
  const namedAt = new Map();
  for (const r of recent.results || []) {
    if (!names.get(r.id)) continue;
    const thread = r.parent_id || r.id;
    if (!namedAt.has(thread) || r.created_at < namedAt.get(thread)) namedAt.set(thread, r.created_at);
  }
  const picked = [];
  for (const r of recent.results || []) {
    const mention = names.get(r.id);
    // A reply: in a thread you are in, or inline to what you wrote.
    const inThread = r.parent_id && (threads.has(r.parent_id) || (namedAt.has(r.parent_id) && r.created_at > namedAt.get(r.parent_id)));
    const reply = inThread || r.reply_to_login === login;
    const keyword = !mention && !reply ? keywordHit(r.body, keywords) : null;
    if (!mention && !reply && !keyword) continue;
    picked.push({ row: r, type: mention ? "mention" : reply ? "reply" : "keyword", keyword });
    if (picked.length >= limit) break;
  }
  const lastRead = read?.last_read_at || "";
  const access = await accessFor(db, orgId, login);
  // Each one looked at, on any device, is no longer new anywhere.
  const { results: lookedAt } = await db.prepare("SELECT item FROM activity_reads WHERE org_id = ?1 AND login = ?2 AND read_at >= ?3")
    .bind(orgId, login, since).all().catch(() => ({ results: [] }));
  const looked = new Set((lookedAt || []).map((r) => r.item));
  // Seen where it was said: read up to it in its conversation, or — a
  // reply — in its thread. Such an item is no longer new in Activity
  // either; nobody should have to tick it off twice.
  const { results: readRows } = await db.prepare("SELECT channel, last_read_at, read_version FROM channel_reads WHERE org_id = ?1 AND login = ?2")
    .bind(orgId, login).all().catch(() => ({ results: [] }));
  const readAt = new Map((readRows || []).map((r) => [r.channel, r.last_read_at || ""]));
  const seen = (row, at) => {
    const inConversation = readAt.get(row.channel) || "";
    const inThread = row.parent_id ? (readAt.get(`t:${row.parent_id}`) || "") : "";
    return row.parent_id ? inThread >= at : inConversation >= at;
  };
  const out = [];
  for (const { row, type, keyword } of picked) {
    const view = viewOf(row.channel, login, members, access);
    if (!view) continue;
    const [message] = await present(db, orgId, [row], login, view, members);
    const key = `m:${row.id}`;
    out.push({ key, type, message, unread: row.created_at > lastRead && !seen(row, row.created_at) && !looked.has(key), at: row.created_at, ...(keyword ? { keyword } : {}) });
  }
  // What others said with a reaction to what you wrote: one entry each, as
  // a notification — who, which, on what.
  const { results: reacted } = await db.prepare(
    `SELECT r.emoji AS r_emoji, r.created_at AS r_at, r.login AS r_login, ru.name AS r_name, ru.avatar_url AS r_avatar, m.*, au.name AS author_name
       FROM message_reactions r
       JOIN channel_messages m ON m.id = r.message_id AND m.org_id = r.org_id
       LEFT JOIN users ru ON ru.login = r.login
       LEFT JOIN users au ON au.login = m.author_login
      WHERE r.org_id = ?1 AND m.author_login = ?2 AND r.login != ?2
        AND m.deleted_at IS NULL AND r.created_at >= ?3
      ORDER BY r.created_at DESC LIMIT ?4`
  ).bind(orgId, login, since, limit).all().catch(() => ({ results: [] }));
  for (const r of reacted || []) {
    const view = viewOf(r.channel, login, members, access);
    if (!view) continue;
    const { r_emoji: emoji, r_at: at, r_login: byLogin, r_name: by, r_avatar: byAvatar, ...row } = r;
    const [message] = await present(db, orgId, [row], login, view, members);
    const key = reactionKey(row.id, byLogin, emoji);
    out.push({ key, type: "reaction", message, unread: at > lastRead && !seen(row, at) && !looked.has(key), at, emoji, by: by || null, byAvatar: byAvatar || null });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { items: out.slice(0, limit), lastRead };
}

export async function roomThreads(db, orgId, key, login, view, members, { limit = 20, before, beforeId } = {}) {
  // Unlike the personal Threads inbox, a room directory includes roots with
  // no replies and threads the reader has not participated in. The route
  // resolves membership before passing the room's internal key here.
  const { results = [] } = await db.prepare(`
    WITH summaries AS (
      SELECT m.id, COUNT(r.id) AS reply_count,
        MAX(m.created_at, COALESCE(MAX(r.created_at), m.created_at)) AS activity_at,
        MAX(CASE WHEN m.author_login = ?3 THEN m.created_at ELSE '' END,
            COALESCE(MAX(CASE WHEN r.author_login = ?3 THEN r.created_at END), '')) AS mine_at,
        MAX(CASE WHEN m.author_login != ?3 THEN m.created_at ELSE '' END,
            COALESCE(MAX(CASE WHEN r.author_login != ?3 THEN r.created_at END), '')) AS others_at
      FROM channel_messages m
      LEFT JOIN channel_messages r ON r.org_id = m.org_id AND r.channel = m.channel
        AND r.parent_id = m.id AND r.deleted_at IS NULL
      WHERE m.org_id = ?1 AND m.channel = ?2 AND m.parent_id IS NULL AND m.deleted_at IS NULL
      GROUP BY m.id
    )
    SELECT m.*, td.title AS thread_title, td.version AS thread_version, u.name AS author_name, s.reply_count, s.activity_at, s.mine_at, s.others_at,
      COALESCE(cr.last_read_at, '') AS thread_read_at
    FROM summaries s JOIN channel_messages m ON m.id = s.id AND m.org_id = ?1
    LEFT JOIN channel_thread_details td ON td.org_id = m.org_id AND td.message_id = m.id
    LEFT JOIN users u ON u.login = m.author_login
    LEFT JOIN channel_reads cr ON cr.org_id = ?1 AND cr.login = ?3 AND cr.channel = 't:' || m.id
    WHERE (?4 IS NULL OR s.activity_at < ?4 OR (s.activity_at = ?4 AND m.id < ?5))
    ORDER BY s.activity_at DESC, m.id DESC LIMIT ?6
  `).bind(orgId, key, login, before || null, beforeId || '', limit + 1).all();
  const rows = results.slice(0, limit);
  if (!rows.length) return { threads: [], nextCursor: null };
  const placeholders = rows.map(() => '?').join(',');
  const { results: replies = [] } = await db.prepare(`
    SELECT ranked.*, u.name AS author_name FROM (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY created_at DESC, rowid DESC) AS position
      FROM channel_messages m WHERE org_id = ? AND channel = ? AND deleted_at IS NULL
        AND parent_id IN (${placeholders})
    ) ranked LEFT JOIN users u ON u.login = ranked.author_login WHERE position <= 2
    ORDER BY created_at ASC, position DESC
  `).bind(orgId, key, ...rows.map(r => r.id)).all();
  const shown = await present(db, orgId, [...rows, ...replies], login, view, members);
  const byId = new Map(shown.map(m => [m.id, m]));
  const threads = rows.map(r => ({
    parent: byId.get(r.id), replies: replies.filter(m => m.parent_id === r.id).map(m => byId.get(m.id)),
    replyCount: r.reply_count, lastReplyAt: r.activity_at,
    unread: r.others_at > [r.thread_read_at, r.mine_at].sort().pop(),
  }));
  const last = rows[rows.length - 1];
  return { threads, nextCursor: results.length > limit ? { before: last.activity_at, beforeId: last.id } : null };
}

/// Threads: every thread this person is in — started, answered, or named
/// in — with a reply in the last 30 days, the newest reply first. Each is
/// its first message, the last two replies, how many there are, and
/// whether one came after they last read it (`t:<parent id>` in
/// channel_reads, or their own last word in it).
export async function threadsFor(db, orgId, login, members, { days = 30, limit = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [recent, mine] = await Promise.all([
    db.prepare(
      `SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
        WHERE m.org_id = ?1 AND ${VISIBLE} AND m.parent_id IS NOT NULL AND m.deleted_at IS NULL AND m.created_at >= ?3
        ORDER BY m.created_at DESC LIMIT 1000`
    ).bind(orgId, login, since).all(),
    db.prepare(
      `SELECT DISTINCT COALESCE(parent_id, id) AS thread FROM channel_messages
        WHERE org_id = ?1 AND author_login = ?2 AND deleted_at IS NULL AND created_at >= ?3`
    ).bind(orgId, login, new Date(Date.now() - 90 * 86400000).toISOString()).all(),
  ]);
  const inThread = new Set((mine.results || []).map((r) => r.thread));
  const named = (row) => Boolean(row.body) && resolveMentions(row.body, members, { online: NOBODY }).some((m) => m.login === login);
  // Replies by thread, newest first, in the order their newest reply came.
  const byParent = new Map();
  for (const r of recent.results || []) {
    if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
    byParent.get(r.parent_id).push(r);
  }
  const access = await accessFor(db, orgId, login);
  const out = [];
  for (const [parentId, replies] of byParent) {
    if (out.length >= limit) break;
    const parentRow = await db.prepare(
      "SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login WHERE m.org_id = ?1 AND m.id = ?2"
    ).bind(orgId, parentId).first();
    if (!parentRow || parentRow.deleted_at) continue;
    if (!inThread.has(parentId) && !named(parentRow) && !replies.some(named)) continue;
    const view = viewOf(parentRow.channel, login, members, access);
    if (!view) continue;
    const [count, read] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id = ?1 AND parent_id = ?2 AND deleted_at IS NULL").bind(orgId, parentId).first(),
      db.prepare("SELECT last_read_at FROM channel_reads WHERE org_id = ?1 AND login = ?2 AND channel = ?3").bind(orgId, login, `t:${parentId}`).first(),
    ]);
    const lastMine = replies.find((r) => r.author_login === login)?.created_at || (parentRow.author_login === login ? parentRow.created_at : "");
    const seen = [read?.last_read_at || "", lastMine].sort().pop();
    const newest = replies[0];
    const unread = replies.some((r) => r.author_login !== login && r.created_at > seen);
    const shown = replies.slice(0, 2).reverse();
    const [parent, ...last] = await present(db, orgId, [parentRow, ...shown], login, view, members);
    out.push({ parent, replies: last, replyCount: count?.n || replies.length, lastReplyAt: newest.created_at, unread });
  }
  return out;
}

/// Search what was said. `q` may carry Slack's filters:
///   from:@name  from:me        who wrote it
///   in:#channel in:@name       where: a channel, or your DM with someone
///   to:@name                   a DM or group they are in
///   before: after: on: during: a date (YYYY-MM-DD), or a month for during:
///   has:file has:link has:reaction has:thread has:pin
///   is:thread (a reply) is:pinned is:saved is:dm
///   "exact words"   -word (without it)
/// `has` and `is` may repeat; each narrows further.
export function parseQuery(raw) {
  const out = { text: [], phrases: [], not: [], from: null, in: null, to: null, before: null, after: null, on: null, during: null, has: null, is: null, hasList: [], isList: [] };
  const tokens = String(raw || "").trim().match(/-?"[^"]*"|\S+/g) || [];
  for (const token of tokens) {
    const quoted = /^(-?)"([^"]*)"$/.exec(token);
    if (quoted) {
      if (quoted[2].trim()) (quoted[1] ? out.not : out.phrases).push(quoted[2].trim());
      continue;
    }
    const m = /^(from|in|to|before|after|on|during|has|is):(.+)$/i.exec(token);
    if (m) {
      const key = m[1].toLowerCase();
      const value = m[2].replace(/^[@#]/, "");
      if (key === "has" || key === "is") {
        const v = value.toLowerCase();
        out[`${key}List`].push(v);
        if (!out[key]) out[key] = v;
      } else {
        out[key] = value;
        if (key === "in" && m[2].startsWith("@")) out.inPerson = true;
      }
    } else if (/^-\S{2,}$/.test(token)) out.not.push(token.slice(1));
    else out.text.push(token);
  }
  out.text = out.text.join(" ").slice(0, 200);
  return out;
}

const likeOf = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/// A day or a month as [start, end) ISO strings, or null.
function span(value, unit) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  const month = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (day) {
    const start = new Date(Date.UTC(+day[1], +day[2] - 1, +day[3]));
    return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
  }
  if (month && unit === "during") {
    return [new Date(Date.UTC(+month[1], +month[2] - 1, 1)).toISOString(), new Date(Date.UTC(+month[1], +month[2], 1)).toISOString()];
  }
  return null;
}

export async function searchMessages(db, orgId, login, members, raw, { limit = 30 } = {}) {
  const q = parseQuery(raw);
  const where = [`m.org_id = ?1`, VISIBLE, `m.deleted_at IS NULL`, `m.kind != 'joined'`];
  const binds = [orgId, login];
  const add = (sql, value) => { binds.push(value); where.push(sql.replace("?", `?${binds.length}`)); };
  const person = (name) => name === "me" ? members.find((m) => m.login === login) : resolveMentions(`@${name}`, members, { here: false })[0];
  if (q.text) add("m.body LIKE ? ESCAPE '\\'", likeOf(q.text));
  for (const phrase of q.phrases) add("m.body LIKE ? ESCAPE '\\'", likeOf(phrase));
  for (const word of q.not) add("m.body NOT LIKE ? ESCAPE '\\'", likeOf(word));
  if (q.from) {
    const who = person(q.from);
    if (!who) return { messages: [], query: q };
    add("m.author_login = ?", who.login);
  }
  if (q.in && q.inPerson) {
    const who = person(q.in);
    if (!who) return { messages: [], query: q };
    add("m.channel = ?", `dm:${[login, who.login].sort().join("|")}`);
  } else if (q.in) add("m.channel = ?", `b:${businessSlug(q.in)}`);
  if (q.to) {
    const who = person(q.to);
    if (!who) return { messages: [], query: q };
    add("(m.channel LIKE 'dm:%' AND ('|' || substr(m.channel, 4) || '|') LIKE ?)", `%|${who.login}|%`);
  }
  if (q.before && !Number.isNaN(Date.parse(q.before))) add("m.created_at < ?", new Date(q.before).toISOString());
  if (q.after && !Number.isNaN(Date.parse(q.after))) add("m.created_at >= ?", new Date(q.after).toISOString());
  for (const [value, unit] of [[q.on, "on"], [q.during, "during"]]) {
    const range = value ? span(value, unit) : null;
    if (range) { add("m.created_at >= ?", range[0]); add("m.created_at < ?", range[1]); }
  }
  for (const has of q.hasList) {
    if (has === "thread") where.push("EXISTS (SELECT 1 FROM channel_messages r WHERE r.org_id = m.org_id AND r.parent_id = m.id AND r.deleted_at IS NULL)");
    else if (has === "file" || has === "files") where.push("EXISTS (SELECT 1 FROM message_files f WHERE f.org_id = m.org_id AND f.message_id = m.id)");
    else if (has === "link" || has === "links") where.push("(m.body LIKE '%http://%' OR m.body LIKE '%https://%')");
    else if (has === "reaction" || has === "reactions") where.push("EXISTS (SELECT 1 FROM message_reactions x WHERE x.org_id = m.org_id AND x.message_id = m.id)");
    else if (has === "pin" || has === "pins") where.push("m.pinned_at IS NOT NULL");
  }
  for (const is of q.isList) {
    if (is === "pinned") where.push("m.pinned_at IS NOT NULL");
    else if (is === "thread") where.push("m.parent_id IS NOT NULL");
    else if (is === "dm") where.push("(m.channel LIKE 'dm:%' OR m.channel LIKE 'g:%')");
    else if (is === "saved") add("EXISTS (SELECT 1 FROM saved_items s WHERE s.org_id = m.org_id AND s.message_id = m.id AND s.login = ?)", login);
  }
  // A message that is only a file has no words; `has:file` may still find it.
  if (!q.hasList.some((h) => h.startsWith("file"))) where.push("m.body != ''");
  const narrowed = q.text || q.phrases.length || q.from || q.in || q.to || q.on || q.during || q.before || q.after || q.hasList.length || q.isList.length;
  if (!narrowed) return { messages: [], query: q };
  const { results } = await db.prepare(
    `SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login), (SELECT 'Webhook · ' || h.name FROM hx_room_hooks h WHERE h.org_id = m.org_id AND h.channel = m.channel AND 'webhook:' || h.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
      WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT ${Math.max(1, Math.min(50, limit))}`
  ).bind(...binds).all();
  const rows = results || [];
  const access = await accessFor(db, orgId, login);
  const out = [];
  for (const r of rows) {
    const view = viewOf(r.channel, login, members, access);
    if (!view) continue;
    const [message] = await present(db, orgId, [r], login, view, members);
    out.push(message);
  }
  return { messages: out, query: q };
}

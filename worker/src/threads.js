// Threads, mentions and reactions: the conversation around a decision.
//
// A card is the decision; the thread under it is what people said about it —
// a question before deciding, the reason after, a "done" from whoever acted.
// A mention (`@Kenji`) names a teammate and reaches them; a reaction is one
// emoji from one person, a toggle rather than a message. All of it is scoped
// to one workspace and one card, and readable only by that workspace's
// members — the routes that call this check membership first.

import { listMembers } from "./team.js";
import { getCard, saveCard } from "./db.js";
import { appendCardEvent } from "./events.js";

export const MAX_COMMENT_CHARS = 2000;
export const REACTIONS = ["👍", "✅", "👀", "🙏", "🎉", "❓"];

/// `@name` tokens in a text, as written: "@Kenji", "@kenji.t", "@美香".
/// A mention runs to the next space or punctuation that is not part of a
/// handle; the resolver decides which of these name anyone.
export function mentionTokens(text) {
  const out = [];
  const re = /(^|[\s(（「])@([^\s@,，。、!?！？:;)）」]+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[2]);
  return out;
}

const fold = (s) => String(s || "").normalize("NFKC").toLowerCase();
const handleOf = (login) => fold(login).replace(/^(u:|email:)/, "").split("@")[0];

/// Which members a text names. Matched by name (whole, or its first word),
/// by handle (the part of the login before the @), by ref, or by alias when
/// the member list carries them — case-folded, so "@kenji" finds "Kenji
/// Tanaka". Unmatched tokens are left alone: "@everyone" is just a word.
export function resolveMentions(text, members) {
  const tokens = mentionTokens(text);
  if (!tokens.length) return [];
  const found = new Map();
  for (const token of tokens) {
    const want = fold(token);
    for (const m of members) {
      const names = [m.name, ...(m.name ? String(m.name).split(/\s+/) : []), handleOf(m.login), m.login, m.ref, ...(m.aliases || [])]
        .filter(Boolean)
        .map(fold);
      if (names.includes(want)) { found.set(m.login, m); break; }
    }
  }
  return [...found.values()];
}

function toComment(row) {
  let mentions = [];
  try { mentions = JSON.parse(row.mentions || "[]"); } catch { mentions = []; }
  return {
    id: row.id,
    cardId: row.card_id,
    author: row.author_login,
    authorName: row.author_name || null,
    body: row.body,
    mentions,
    createdAt: row.created_at,
  };
}

export async function listComments(db, orgId, cardId) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.card_id, c.author_login, c.body, c.mentions, c.created_at,
              u.name AS author_name
         FROM card_comments c
         LEFT JOIN users u ON u.login = c.author_login
        WHERE c.org_id = ?1 AND c.card_id = ?2
        ORDER BY c.created_at ASC, c.rowid ASC`
    )
    .bind(orgId, cardId)
    .all();
  return (results || []).map(toComment);
}

/// The reactions on a card, folded per emoji: how many, who, and whether
/// the reader is among them.
export async function listReactions(db, orgId, cardId, viewerLogin) {
  const { results } = await db
    .prepare(
      `SELECT r.emoji, r.user_login, COALESCE(u.name, r.user_login) AS name
         FROM card_reactions r
         LEFT JOIN users u ON u.login = r.user_login
        WHERE r.org_id = ?1 AND r.card_id = ?2
        ORDER BY r.created_at ASC`
    )
    .bind(orgId, cardId)
    .all();
  const byEmoji = new Map();
  for (const r of results || []) {
    const entry = byEmoji.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false, names: [] };
    entry.count += 1;
    entry.names.push(r.name);
    if (r.user_login === viewerLogin) entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.values()];
}

/// The card's own summary of its thread, kept on the card so every list —
/// the feed, the inbox, the classic list, the phone — shows "3 replies"
/// without a second query. Written back through saveCard, so the relay's
/// next snapshot carries it.
async function refreshThreadSummary(db, orgId, cardId) {
  const card = await getCard(db, orgId, cardId);
  if (!card) return null;
  const counts = await db
    .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM card_comments WHERE org_id = ?1 AND card_id = ?2")
    .bind(orgId, cardId)
    .first();
  const { results } = await db
    .prepare("SELECT emoji, COUNT(*) AS n FROM card_reactions WHERE org_id = ?1 AND card_id = ?2 GROUP BY emoji")
    .bind(orgId, cardId)
    .all();
  const reactions = {};
  for (const r of results || []) reactions[r.emoji] = Number(r.n);
  const updated = {
    ...card,
    commentCount: Number(counts?.n || 0),
    lastCommentAt: counts?.last || null,
    reactions,
  };
  await saveCard(db, orgId, updated);
  return updated;
}

/// Say something under a card. Returns the comment and the card it now
/// hangs off, with its counts refreshed.
export async function addComment(db, { orgId, cardId, authorLogin, body }) {
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { error: "Say something." };
  if (text.length > MAX_COMMENT_CHARS) return { error: `A comment is at most ${MAX_COMMENT_CHARS} characters.` };
  const card = await getCard(db, orgId, cardId);
  if (!card) return { error: "no such card", status: 404 };
  const members = await listMembers(db, orgId, null);
  const mentioned = resolveMentions(text, members).map((m) => m.login).filter((l) => l !== authorLogin);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO card_comments (id, org_id, card_id, author_login, body, mentions, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(id, orgId, cardId, authorLogin, text, JSON.stringify(mentioned), createdAt)
    .run();
  await appendCardEvent(db, orgId, {
    cardId, type: "commented", actorUserId: authorLogin,
    note: text.length > 140 ? `${text.slice(0, 139)}…` : text, snapshot: card,
  });
  const updated = await refreshThreadSummary(db, orgId, cardId);
  const author = members.find((m) => m.login === authorLogin);
  return {
    comment: { id, cardId, author: authorLogin, authorName: author?.name || null, body: text, mentions: mentioned, createdAt },
    card: updated,
    mentioned,
  };
}

/// One emoji on, or off again. Returns the card with its reactions
/// refreshed and whether the reaction is now present.
export async function toggleReaction(db, { orgId, cardId, login, emoji }) {
  if (!REACTIONS.includes(emoji)) return { error: "That is not one of the reactions." };
  const card = await getCard(db, orgId, cardId);
  if (!card) return { error: "no such card", status: 404 };
  const { meta } = await db
    .prepare("DELETE FROM card_reactions WHERE org_id = ?1 AND card_id = ?2 AND user_login = ?3 AND emoji = ?4")
    .bind(orgId, cardId, login, emoji)
    .run();
  let on = false;
  if (!meta?.changes) {
    await db
      .prepare("INSERT INTO card_reactions (org_id, card_id, user_login, emoji, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(orgId, cardId, login, emoji, new Date().toISOString())
      .run();
    on = true;
  }
  const updated = await refreshThreadSummary(db, orgId, cardId);
  return { on, card: updated, reactions: await listReactions(db, orgId, cardId, login) };
}

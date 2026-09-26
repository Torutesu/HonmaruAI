import { accessFor, mayRead } from "./access.js";
import { sendDuePushes } from "./pushes.js";
import { getMessage, postMessage } from "./channels.js";
import { saveCard } from "./db.js";
import { appendCardEvent } from "./events.js";
import { announceCards } from "./announce.js";
import { localizeForRecipient } from "./localize.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";

// Time, in a conversation: messages written now and sent later, messages
// saved to come back to, and the reminder that brings one back as a card.

const MAX_AHEAD_DAYS = 120;

function when(raw) {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

export async function scheduleMessage(db, { orgId, key, authorLogin, body, parentId, sendAt }) {
  const at = when(sendAt);
  if (!Number.isFinite(at)) return { error: "That time is not a time." };
  if (at < Date.now() + 30000) return { error: "Pick a time at least a minute from now." };
  if (at > Date.now() + MAX_AHEAD_DAYS * 86400000) return { error: `Pick a time within ${MAX_AHEAD_DAYS} days.` };
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { error: "Write something first." };
  if (text.length > 4000) return { error: "That is longer than 4000 characters." };
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO scheduled_messages (id, org_id, channel, author_login, body, parent_id, send_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id, orgId, key, authorLogin, text, parentId || null, new Date(at).toISOString(), new Date().toISOString()).run();
  return { scheduled: { id, body: text, sendAt: new Date(at).toISOString(), parentId: parentId || null } };
}

export async function listScheduled(db, orgId, login, key) {
  const { results } = await db.prepare(
    `SELECT id, channel, body, parent_id, send_at FROM scheduled_messages
      WHERE org_id = ?1 AND author_login = ?2 AND sent_at IS NULL ${key ? "AND channel = ?3" : ""} ORDER BY send_at`
  ).bind(...[orgId, login, ...(key ? [key] : [])]).all();
  return (results || []).map((r) => ({ id: r.id, key: r.channel, body: r.body, parentId: r.parent_id, sendAt: r.send_at }));
}

export async function cancelScheduled(db, orgId, login, id) {
  const res = await db.prepare("DELETE FROM scheduled_messages WHERE id = ?1 AND org_id = ?2 AND author_login = ?3 AND sent_at IS NULL")
    .bind(id, orgId, login).run();
  return (res.meta?.changes || 0) > 0;
}

export async function saveForLater(db, { orgId, login, messageId, key, remindAt }) {
  const row = await getMessage(db, orgId, messageId);
  if (!row || row.channel !== key || row.deleted_at) return { error: "No such message." };
  let remind = null;
  if (remindAt) {
    const at = when(remindAt);
    if (!Number.isFinite(at) || at < Date.now() || at > Date.now() + MAX_AHEAD_DAYS * 86400000) return { error: "Pick a reminder time in the next few months." };
    remind = new Date(at).toISOString();
  }
  const existing = await db.prepare("SELECT id FROM saved_items WHERE org_id = ?1 AND login = ?2 AND message_id = ?3 AND done_at IS NULL")
    .bind(orgId, login, messageId).first();
  if (existing) {
    await db.prepare("UPDATE saved_items SET remind_at = ?2, reminded_at = NULL WHERE id = ?1").bind(existing.id, remind).run();
    return { id: existing.id };
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO saved_items (id, org_id, login, message_id, channel, remind_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, orgId, login, messageId, key, remind, new Date().toISOString()).run();
  return { id };
}

export async function listSaved(db, orgId, login) {
  const { results } = await db.prepare(
    `SELECT s.id, s.message_id, s.channel, s.remind_at, s.reminded_at, s.created_at, m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login)) AS author_name,
            s.id AS saved_id, s.created_at AS saved_at
       FROM saved_items s JOIN channel_messages m ON m.id = s.message_id AND m.org_id = s.org_id
       LEFT JOIN users u ON u.login = m.author_login
      WHERE s.org_id = ?1 AND s.login = ?2 AND s.done_at IS NULL AND m.deleted_at IS NULL
      ORDER BY COALESCE(s.remind_at, '9999'), s.created_at DESC LIMIT 100`
  ).bind(orgId, login).all();
  return results || [];
}

export async function finishSaved(db, orgId, login, id) {
  const res = await db.prepare("UPDATE saved_items SET done_at = ?4 WHERE id = ?1 AND org_id = ?2 AND login = ?3 AND done_at IS NULL")
    .bind(id, orgId, login, new Date().toISOString()).run();
  return (res.meta?.changes || 0) > 0;
}

/// Every minute: send what is due, and bring back what was saved for now.
/// Each row is claimed before it is acted on, so two overlapping runs never
/// send one message twice.
export async function runMinuteJobs(env, { now = new Date(), broadcast } = {}) {
  const db = env.DB;
  const at = now.toISOString();
  let sent = 0; let reminded = 0;
  const { results: due } = await db.prepare(
    "SELECT * FROM scheduled_messages WHERE sent_at IS NULL AND send_at <= ?1 ORDER BY send_at LIMIT 50"
  ).bind(at).all();
  for (const row of due || []) {
    try {
      const claim = await db.prepare("UPDATE scheduled_messages SET sent_at = ?2 WHERE id = ?1 AND sent_at IS NULL").bind(row.id, at).run();
      if (!(claim.meta?.changes > 0)) continue;
      // Still a member? A message scheduled by somebody who has since left
      // is not sent in their name.
      const member = await db.prepare(
        "SELECT 1 FROM memberships ms JOIN users u ON u.github_id = ms.user_github_id WHERE ms.org_id = ?1 AND u.login = ?2"
      ).bind(row.org_id, row.author_login).first();
      if (!member) continue;
      // Nor into a private channel or group they are no longer in.
      if (!mayRead(row.channel, await accessFor(db, row.org_id, row.author_login))) continue;
      const out = await postMessage(db, { orgId: row.org_id, key: row.channel, authorLogin: row.author_login, body: row.body, parentId: row.parent_id });
      if (out.row) { sent += 1; if (broadcast) await broadcast(row.org_id, row.channel, out.row).catch(() => {}); }
    } catch (err) {
      console.error("scheduled send failed", err?.message || err);
    }
  }
  // Messages that waited a minute to see whether they were read.
  await sendDuePushes(env, now.getTime()).catch((err) => console.error("message pushes failed", err?.message || err));
  const { results: remind } = await db.prepare(
    `SELECT s.*, m.body, m.author_login, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login)) AS author_name, me.locale AS reader_locale FROM saved_items s
       JOIN channel_messages m ON m.id = s.message_id AND m.org_id = s.org_id
       LEFT JOIN users u ON u.login = m.author_login
       LEFT JOIN users me ON me.login = s.login
      WHERE s.done_at IS NULL AND s.reminded_at IS NULL AND s.remind_at IS NOT NULL AND s.remind_at <= ?1 LIMIT 50`
  ).bind(at).all();
  for (const r of remind || []) {
    try {
      const claim = await db.prepare("UPDATE saved_items SET reminded_at = ?2 WHERE id = ?1 AND reminded_at IS NULL").bind(r.id, at).run();
      if (!(claim.meta?.changes > 0)) continue;
      const lang = await loadCopy(env, r.reader_locale || "en", { orgId: r.org_id });
      const card = {
        id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "notification",
        format: "fyi",
        status: "pending",
        recipientUserID: r.login,
        senderUserID: r.login,
        title: serverText(lang, "reminder.title", { text: String(r.body || "").replace(/\s+/g, " ").slice(0, 120) }),
        summary: String(r.body || "").slice(0, 1500),
        context: r.author_name ? serverText(lang, "reminder.savedBy", { name: r.author_name }) : serverText(lang, "reminder.saved"),
        priority: "medium",
        createdAt: at,
        sourceApp: "Your AI",
        reminder: { savedId: r.id, messageId: r.message_id },
      };
      await saveCard(db, r.org_id, card);
      await appendCardEvent(db, r.org_id, { cardId: card.id, type: "created", actorUserId: r.login, note: "reminder", snapshot: card });
      // The saved message may be a colleague's, in their language.
      await announceCards(env, r.org_id, [await localizeForRecipient(env, r.org_id, card)]);
      reminded += 1;
    } catch (err) {
      console.error("reminder failed", err?.message || err);
    }
  }
  return { sent, reminded };
}

import { accessFor, mayRead } from "./access.js";
import { sendDuePushes } from "./pushes.js";
import { getMessage, postMessage } from "./channels.js";
import { getCard, saveCard } from "./db.js";
import { appendCardEvent } from "./events.js";
import { announceCards } from "./announce.js";
import { notifyCard } from "./notify.js";
import { localizeForRecipient } from "./localize.js";
import { loadCopy } from "./copy.js";
import { serverText } from "./serverCopy.js";

// Time, in a conversation: messages written now and sent later, messages
// saved to come back to, and the reminder that brings one back as a card.

const MAX_AHEAD_DAYS = 120;
/// How long a run sending a scheduled message holds it, and how long after
/// its time a message that could not be sent is still tried.
const SEND_LEASE_MS = 5 * 60_000;
const SEND_RETRY_MS = 86400000;

function when(raw) {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : NaN;
}

export async function scheduleMessage(db, { orgId, key, authorLogin, body, parentId, sendAt, alsoChannel = false, mcpAuthority = null }) {
  const at = when(sendAt);
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  const id = mcpAuthority?.requestId || crypto.randomUUID();
  const previous = mcpAuthority ? await db.prepare('SELECT * FROM scheduled_messages WHERE id=?1 AND org_id=?2 AND author_login=?3').bind(id, orgId, authorLogin).first() : null;
  const agrees = row => row.channel === key && row.body === text && (row.parent_id || null) === (parentId || null) && Date.parse(row.send_at) === at && Boolean(row.also_channel) === Boolean(parentId && alsoChannel);
  const result = row => ({ scheduled: { id: row.id, body: row.body, sendAt: row.send_at, parentId: row.parent_id || null, ...(row.also_channel ? { alsoChannel: true } : {}) } });
  if (previous) return agrees(previous) ? result(previous) : { error: 'This requestId was already used with different scheduled message content.' };
  if (mcpAuthority && await db.prepare('SELECT 1 FROM mcp_scheduled_authority WHERE scheduled_id=?1 AND org_id=?2').bind(id, orgId).first()) return { error: 'This scheduled request was cancelled. Use a new requestId to schedule another message.' };
  if (!Number.isFinite(at)) return { error: "That time is not a time." };
  if (at < Date.now() + 30000) return { error: "Pick a time at least a minute from now." };
  if (at > Date.now() + MAX_AHEAD_DAYS * 86400000) return { error: `Pick a time within ${MAX_AHEAD_DAYS} days.` };
  if (!text) return { error: "Write something first." };
  if (text.length > 4000) return { error: "That is longer than 4000 characters." };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO scheduled_messages (id, org_id, channel, author_login, body, parent_id, send_at, created_at, also_channel)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(id, orgId, key, authorLogin, text, parentId || null, new Date(at).toISOString(), new Date().toISOString(), parentId && alsoChannel ? 1 : 0);
  if (mcpAuthority) {
    await db.batch([insert, db.prepare(`INSERT OR IGNORE INTO mcp_scheduled_authority(scheduled_id,org_id,user_id,membership_since,token_id,grant_id) VALUES (?1,?2,?3,?4,?5,?6)`)
      .bind(id, orgId, mcpAuthority.userId, mcpAuthority.membershipSince, mcpAuthority.tokenId, mcpAuthority.grantId)]);
    const saved = await db.prepare('SELECT * FROM scheduled_messages WHERE id=?1 AND org_id=?2 AND author_login=?3').bind(id, orgId, authorLogin).first();
    if (!saved || !agrees(saved)) return { error: 'This requestId was already used with different scheduled message content.' };
  } else await insert.run();
  return { scheduled: { id, body: text, sendAt: new Date(at).toISOString(), parentId: parentId || null, ...(parentId && alsoChannel ? { alsoChannel: true } : {}) } };
}

export async function listScheduled(db, orgId, login, key) {
  const { results } = await db.prepare(
    `SELECT id, channel, body, parent_id, send_at FROM scheduled_messages
      WHERE org_id = ?1 AND author_login = ?2 AND sent_at IS NULL ${key ? "AND channel = ?3" : ""} ORDER BY send_at`
  ).bind(...[orgId, login, ...(key ? [key] : [])]).all();
  return (results || []).map((r) => ({ id: r.id, key: r.channel, body: r.body, parentId: r.parent_id, sendAt: r.send_at }));
}

export async function cancelScheduled(db, orgId, login, id) {
  // Not while a run is sending it: that one would be said all the same.
  const res = await db.prepare(`DELETE FROM scheduled_messages WHERE id = ?1 AND org_id = ?2 AND author_login = ?3 AND sent_at IS NULL
      AND (lease_until IS NULL OR lease_until <= ?4)`)
    .bind(id, orgId, login, new Date().toISOString()).run();
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

/// What this person sent, newest first: their own messages and replies,
/// not what an agent or the AI said for them. The caller keeps only those
/// in conversations the person can still read.
export async function listSent(db, orgId, login, limit = 200) {
  const { results } = await db.prepare(
    `SELECT m.*, u.name AS author_name
       FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login
      WHERE m.org_id = ?1 AND m.author_login = ?2 AND m.kind = 'message' AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC LIMIT ?3`
  ).bind(orgId, login, limit).all();
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
  // Not finding the scheduled messages must not stop the rest of the
  // minute: the message pushes below run from here too. A message is held
  // while a run sends it and marked sent only once it is in the
  // conversation. A run that fails (or dies) leaves the hold to run out, and
  // a later minute tries again — for a day; past that it waits in its
  // author's list, unsent, for them to cancel.
  const { results: due } = await db.prepare(
    `SELECT * FROM scheduled_messages WHERE sent_at IS NULL AND send_at <= ?1 AND send_at > ?2
       AND (lease_until IS NULL OR lease_until <= ?1) ORDER BY send_at LIMIT 50`
  ).bind(at, new Date(now.getTime() - SEND_RETRY_MS).toISOString()).all().catch((err) => { console.error("scheduled messages unavailable", err?.message || err); return { results: [] }; });
  const done = (row) => db.prepare("UPDATE scheduled_messages SET sent_at = ?2, lease_until = NULL WHERE id = ?1 AND org_id = ?3").bind(row.id, at, row.org_id).run();
  for (const row of due || []) {
    try {
      const claim = await db.prepare("UPDATE scheduled_messages SET lease_until = ?2 WHERE id = ?1 AND org_id = ?4 AND sent_at IS NULL AND (lease_until IS NULL OR lease_until <= ?3)")
        .bind(row.id, new Date(now.getTime() + SEND_LEASE_MS).toISOString(), at, row.org_id).run();
      if (!(claim.meta?.changes > 0)) continue;
      // Still a member? A message scheduled by somebody who has since left
      // is not sent in their name.
      const member = await db.prepare(
        "SELECT 1 FROM memberships ms JOIN users u ON u.github_id = ms.user_github_id WHERE ms.org_id = ?1 AND u.login = ?2"
      ).bind(row.org_id, row.author_login).first();
      if (!member) { await done(row); continue; }
      // Nor into a private channel or group they are no longer in.
      if (!mayRead(row.channel, await accessFor(db, row.org_id, row.author_login))) { await done(row); continue; }
      const mcp = await db.prepare('SELECT * FROM mcp_scheduled_authority WHERE scheduled_id=?1 AND org_id=?2').bind(row.id, row.org_id).first();
      if (mcp) {
        // "Not sent" here means its authority is gone for good, so it is
        // closed. A failure that may pass throws instead, and the hold above
        // runs out and a later minute tries again, as for any other message.
        const { deliverMcpScheduledMessage } = await import('./mcpScheduled.js');
        const result = await deliverMcpScheduledMessage(env, row, mcp);
        await done(row);
        if (result.sent) sent += 1;
        continue;
      }
      // Its own retry key: tried again after the post landed but before it
      // was marked sent, it finds that message rather than saying it twice.
      const out = await postMessage(db, { orgId: row.org_id, key: row.channel, authorLogin: row.author_login, body: row.body, parentId: row.parent_id, alsoChannel: Boolean(row.also_channel), clientId: `tmp-later-${row.id}` });
      await done(row);
      if (out.row) { sent += 1; if (broadcast) await broadcast(row.org_id, row.channel, out.row).catch(() => {}); }
    } catch (err) {
      console.error("scheduled send failed", err?.message || err);
    }
  }
  // Messages that waited a minute to see whether they were read.
  await sendDuePushes(env, now.getTime()).catch((err) => console.error("message pushes failed", err?.message || err));
  // A reminder is held while a run brings it back, as a scheduled message is,
  // and closed (`reminded_at`) only once its card is saved and announced, or
  // once there is a lasting reason not to bring it back. A run that fails or
  // dies leaves the hold to run out and a later minute tries again, for a
  // day; past that it is closed as given up rather than tried for ever. The
  // card id comes from the reminder, so a retry after the card was saved
  // finds that card instead of making a second one.
  const { results: remind } = await db.prepare(
    `SELECT s.*, m.body, m.author_login, m.channel AS message_channel, m.deleted_at AS message_deleted_at, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login)) AS author_name, me.locale AS reader_locale FROM saved_items s
       JOIN channel_messages m ON m.id = s.message_id AND m.org_id = s.org_id
       LEFT JOIN users u ON u.login = m.author_login
       LEFT JOIN users me ON me.login = s.login
      WHERE s.done_at IS NULL AND s.reminded_at IS NULL AND s.remind_at IS NOT NULL AND s.remind_at <= ?1
        AND (s.remind_lease_until IS NULL OR s.remind_lease_until <= ?1) LIMIT 50`
  ).bind(at).all();
  for (const r of remind || []) {
    // Matched on its reminder time too: one set again meanwhile is a new
    // reminder, neither claimed nor closed by this run.
    const close = () => db.prepare("UPDATE saved_items SET reminded_at = ?2, remind_lease_until = NULL WHERE id = ?1 AND org_id = ?3 AND remind_at = ?4")
      .bind(r.id, at, r.org_id, r.remind_at).run();
    try {
      const claim = await db.prepare(`UPDATE saved_items SET remind_lease_until = ?2 WHERE id = ?1 AND org_id = ?4 AND remind_at = ?5 AND reminded_at IS NULL
          AND (remind_lease_until IS NULL OR remind_lease_until <= ?3)`)
        .bind(r.id, new Date(now.getTime() + SEND_LEASE_MS).toISOString(), at, r.org_id, r.remind_at).run();
      if (!(claim.meta?.changes > 0)) continue;
      if (Date.parse(r.remind_at) <= now.getTime() - SEND_RETRY_MS) {
        console.error("reminder given up after a day of failed tries", r.id);
        await close(); continue;
      }
      // The message as it is now, so only for someone who may still read it:
      // still in the workspace, still in its conversation, and the message
      // not deleted — as the Later screen shows it. None of these changes
      // back by waiting, so each closes the reminder.
      if (r.message_deleted_at) { await close(); continue; }
      const member = await db.prepare(
        "SELECT 1 FROM memberships ms JOIN users u ON u.github_id = ms.user_github_id WHERE ms.org_id = ?1 AND u.login = ?2"
      ).bind(r.org_id, r.login).first();
      if (!member) { await close(); continue; }
      if (!mayRead(r.message_channel, await accessFor(db, r.org_id, r.login))) { await close(); continue; }
      const cardId = `card-reminder-${r.id}-${Date.parse(r.remind_at)}`;
      let card = await getCard(db, r.org_id, cardId);
      if (!card) {
        const lang = await loadCopy(env, r.reader_locale || "en", { orgId: r.org_id });
        card = {
          id: cardId,
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
      }
      // The saved message may be a colleague's, in their language.
      const shown = await localizeForRecipient(env, r.org_id, card);
      await announceCards(env, r.org_id, [shown]);
      // And to the phone: a reminder only shown to an open app is no
      // reminder. Its sender is its reader, so no one is left out as "who
      // did it".
      await notifyCard(env, { card: shown, kind: "created", excludeLogin: null, orgId: r.org_id })
        .catch((err) => console.error("reminder push failed", err?.message || err));
      await close();
      reminded += 1;
    } catch (err) {
      console.error("reminder failed", err?.message || err);
    }
  }
  return { sent, reminded };
}

// A message that needs somebody, pushed to their phone — but only when they
// are not already looking.
//
// Slack's rule, and Ando's: a direct message, an @mention, or a reply in a
// thread you are part of reaches your phone after a minute, unless in that
// minute you read it or you were at the app somewhere. So a person at their
// laptop hears it once, from the laptop, and their phone stays still.
//
// A message is queued for each person it is for; the every-minute cron
// sends what is due. "At the app" is `user_activity`: the web and iOS
// clients say so over the relay while someone is using them (not merely
// while a tab is open), at most every thirty seconds.
//
// A decision card is the other kind of thing that reaches a phone; the hub
// (notify.js) asks isActive() before it pushes one.

import { devicesForLogin, removeDevice, subscriptionsForLogin, removeSubscription } from "./db.js";
import { sendPush, isDeadToken, isConfigured as apnsConfigured } from "./apns.js";
import { sendWebPush, isWebPushConfigured, isDeadSubscription } from "./webpush.js";
import { audienceOf } from "./access.js";
import { resolveMentions } from "./threads.js";
import { viewOf } from "./channels.js";
import { listMembers } from "./team.js";
import { quietFor, keywordsIn, keywordHit } from "./quiet.js";

export const PUSH_DELAY_MS = 60_000;
/// How recent "at the app" has to be for a card not to be pushed.
export const ACTIVE_WINDOW_MS = 2 * 60_000;

/// Somebody is using the app, on this client. Written at most every thirty
/// seconds per socket by the relay.
export async function noteActivity(db, login, client = "web", now = Date.now()) {
  if (!login) return;
  await db.prepare(
    `INSERT INTO user_activity (login, last_active_at, client) VALUES (?1, ?2, ?3)
     ON CONFLICT(login) DO UPDATE SET last_active_at = excluded.last_active_at, client = excluded.client`
  ).bind(login, new Date(now).toISOString(), String(client).slice(0, 16)).run();
}

async function lastActive(db, login) {
  const row = await db.prepare("SELECT last_active_at FROM user_activity WHERE login = ?1").bind(login).first().catch(() => null);
  return row?.last_active_at || "";
}

/// Whether this person wants their phone told even while they are at the
/// app on another device. Off unless they turned it on.
async function pushesWhileActive(db, login) {
  const row = await db.prepare("SELECT push_while_active FROM users WHERE login = ?1").bind(login).first().catch(() => null);
  return Boolean(row?.push_while_active);
}

/// At the app in the last two minutes, and not asking to be pushed anyway.
export async function isActive(db, login, now = Date.now()) {
  if (await pushesWhileActive(db, login)) return false;
  const at = await lastActive(db, login);
  return Boolean(at) && now - Date.parse(at) < ACTIVE_WINDOW_MS;
}

/// Who a message is for, and why: everyone in a DM or group, whoever it
/// names, and whoever wrote in the thread it replies to. Never its author;
/// never somebody who muted the conversation, and in one set to mentions
/// only, only for a mention or a DM.
export async function recipientsOf(db, orgId, row, members) {
  // An agent's answer reaches whoever called it the way a teammate's reply
  // would: through the thread it answers in.
  if (!row?.id || row.deleted_at || (row.kind !== "message" && row.kind !== "agent")) return [];
  const author = row.author_login;
  const out = new Map();
  const add = (login, reason) => { if (login && login !== author && !String(login).startsWith("agent:") && !out.has(login)) out.set(login, reason); };
  const key = String(row.channel || "");
  if (key.startsWith("dm:") || key.startsWith("g:") || key.startsWith("ag:")) {
    for (const login of (await audienceOf(db, orgId, key)) || []) add(login, "direct");
  }
  for (const m of resolveMentions(row.body || "", members)) add(m.login, "mention");
  // Words they asked to hear about, said anywhere they can read.
  for (const k of await keywordsIn(db, orgId)) if (keywordHit(row.body, k.keywords)) add(k.login, "keyword");
  if (row.parent_id) {
    const { results } = await db.prepare(
      `SELECT DISTINCT author_login FROM channel_messages
        WHERE org_id = ?1 AND (id = ?2 OR parent_id = ?2) AND author_login IS NOT NULL AND deleted_at IS NULL`
    ).bind(orgId, row.parent_id).all();
    for (const r of results || []) add(r.author_login, "thread");
  }
  // A closed conversation's words go only to the people in it.
  const audience = await audienceOf(db, orgId, key);
  if (audience) for (const login of [...out.keys()]) if (!audience.includes(login)) out.delete(login);
  if (!out.size) return [];
  const marks = [...out.keys()].map((_, i) => `?${i + 3}`).join(", ");
  const { results: prefs } = await db.prepare(
    `SELECT login, level FROM channel_prefs WHERE org_id = ?1 AND channel = ?2 AND login IN (${marks})`
  ).bind(orgId, key, ...out.keys()).all();
  for (const p of prefs || []) {
    const reason = out.get(p.login);
    if (p.level === "mute" || (p.level === "mentions" && reason === "thread")) out.delete(p.login);
  }
  return [...out.entries()].map(([login, reason]) => ({ login, reason }));
}

/// Queue the pushes for a message just said. Cheap: one query when nobody
/// is for it.
export async function queueMessagePushes(env, orgId, row, { members = null, now = Date.now() } = {}) {
  if (!env?.DB || !row?.id) return 0;
  const list = members || await listMembers(env.DB, orgId, null);
  const to = await recipientsOf(env.DB, orgId, row, list);
  if (!to.length) return 0;
  const due = new Date(now + PUSH_DELAY_MS).toISOString();
  const at = new Date(now).toISOString();
  await env.DB.batch(to.map(({ login, reason }) => env.DB.prepare(
    `INSERT OR IGNORE INTO push_queue (org_id, login, message_id, reason, created_at, due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(orgId, login, row.id, reason, at, due)));
  return to.length;
}

const clip = (text, n) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/// Send what is due. Each row is claimed first, so two overlapping runs
/// never push one message twice.
export async function sendDuePushes(env, now = Date.now()) {
  const db = env.DB;
  const at = new Date(now).toISOString();
  const { results: due } = await db.prepare(
    "SELECT * FROM push_queue WHERE sent_at IS NULL AND due_at <= ?1 ORDER BY due_at LIMIT 100"
  ).bind(at).all();
  let sent = 0; let skipped = 0;
  const membersOf = new Map();
  for (const job of due || []) {
    const claim = await db.prepare("UPDATE push_queue SET sent_at = ?2 WHERE id = ?1 AND sent_at IS NULL").bind(job.id, at).run().catch(() => null);
    if (!(claim?.meta?.changes > 0)) continue;
    try {
      const msg = await db.prepare(
        "SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login WHERE m.org_id = ?1 AND m.id = ?2"
      ).bind(job.org_id, job.message_id).first();
      if (!msg || msg.deleted_at) { skipped += 1; continue; }
      // Read it already, here or anywhere.
      const read = await db.prepare("SELECT last_read_at FROM channel_reads WHERE org_id = ?1 AND login = ?2 AND channel = ?3")
        .bind(job.org_id, job.login, msg.channel).first().catch(() => null);
      if (read?.last_read_at && read.last_read_at >= msg.created_at) { skipped += 1; continue; }
      // At the app since it arrived: they saw it come in, and heard it there.
      // Paused, or outside the hours they set.
      if (await quietFor(db, job.login, new Date(now))) { skipped += 1; continue; }
      if (!(await pushesWhileActive(db, job.login))) {
        const active = await lastActive(db, job.login);
        if (active && active >= msg.created_at) { skipped += 1; continue; }
      }
      if (!membersOf.has(job.org_id)) membersOf.set(job.org_id, await listMembers(db, job.org_id, null));
      const members = membersOf.get(job.org_id);
      const view = viewOf(msg.channel, job.login, members);
      if (!view) { skipped += 1; continue; }
      const where = msg.channel.startsWith("b:")
        ? `#${(await db.prepare("SELECT name FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(job.org_id, msg.channel.slice(2)).first().catch(() => null))?.name || msg.channel.slice(2)}`
        : null;
      const who = msg.author_name || "Someone";
      const title = where ? `${who} · ${where}` : who;
      const files = msg.body ? "" : "📎";
      const body = clip(msg.body || files, 180);
      const delivered = await pushMessage(env, job.login, { title, body, orgId: job.org_id, channel: view, messageId: msg.id, parentId: msg.parent_id || null });
      if (delivered) sent += 1; else skipped += 1;
    } catch (err) {
      console.error("message push failed", err?.message || err);
    }
  }
  // Kept a day for looking into, then gone.
  await db.prepare("DELETE FROM push_queue WHERE created_at < ?1").bind(new Date(now - 86400000).toISOString()).run().catch(() => {});
  return { sent, skipped };
}

/// One message to every phone and browser this person has.
async function pushMessage(env, login, { title, body, orgId, channel, messageId, parentId }) {
  let delivered = 0;
  if (apnsConfigured(env)) {
    for (const device of await devicesForLogin(env.DB, login)) {
      const result = await sendPush(env, {
        deviceToken: device.device_token,
        collapseId: messageId,
        payload: { aps: { alert: { title, body }, sound: "default", "thread-id": channel }, kind: "message", orgId, channel, messageId, parentId },
      });
      if (result.ok) delivered += 1;
      else if (isDeadToken(result)) await removeDevice(env.DB, device.device_token);
    }
  }
  if (isWebPushConfigured(env)) {
    const base = env.APP_WEB_URL ? String(env.APP_WEB_URL).replace(/\/$/, "") : "";
    for (const subscription of await subscriptionsForLogin(env.DB, login)) {
      const result = await sendWebPush(env, {
        subscription, topic: messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
        payload: { title, body, kind: "message", tag: channel, orgId, channel, messageId, ...(base ? { url: `${base}/#/m/${encodeURIComponent(messageId)}` } : {}) },
      });
      if (result.ok) delivered += 1;
      else if (isDeadSubscription(result)) await removeSubscription(env.DB, subscription.endpoint);
    }
  }
  return delivered;
}

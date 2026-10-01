import { deliverOnce, retryable, retryDelay, MAX_ATTEMPTS } from './notificationJobs.js';
// A message that needs somebody, pushed to their phone — but only when they
// are not already looking.
//
// Slack's rule, and Ando's: a direct message, an @mention, or a reply in a
// thread you are part of reaches your phone after a minute, unless in that
// minute you read it or you were at the app somewhere. So a person at their
// laptop hears it once, from the laptop, and their phone stays still.
//
// A message is queued for each person it is for; the every-minute cron
// sends what is due. "At the app" is `workspace_activity`, per workspace: the web and iOS
// clients say so over the relay while someone is using them (not merely
// while a tab is open), at most every thirty seconds.
//
// A decision card is the other kind of thing that reaches a phone; the hub
// (notify.js) asks isActive() before it pushes one.

import { devicesForLogin, removeDevice, subscriptionsForLogin, removeSubscription } from "./db.js";
import { sendPush, isDeadToken, isConfigured as apnsConfigured } from "./apns.js";
import { sendFcm, isDeadFcmToken, isFcmConfigured } from "./fcm.js";
import { sendWebPush, isWebPushConfigured, isDeadSubscription } from "./webpush.js";
import { audienceOf } from "./access.js";
import { resolveMentions, mentionTokens, broadcastOf } from "./threads.js";
import { viewOf } from "./channels.js";
import { listMembers } from "./team.js";
import { quietFor, keywordsIn, keywordHit } from "./quiet.js";

export const PUSH_DELAY_MS = 60_000;
/// How recent "at the app" has to be for a card not to be pushed.
export const ACTIVE_WINDOW_MS = 2 * 60_000;

/// Somebody is using the app, on this client, in this workspace. Written at
/// most every thirty seconds per socket by the relay. Per workspace: being
/// at one team's app is not seeing another's, so it neither silences that
/// team's pushes nor counts as "@here" there.
export async function noteActivity(db, orgId, login, client = "web", now = Date.now()) {
  if (!login || !orgId) return;
  await db.prepare(
    `INSERT INTO workspace_activity (org_id, login, last_active_at, client) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(org_id, login) DO UPDATE SET last_active_at = excluded.last_active_at, client = excluded.client`
  ).bind(orgId, login, new Date(now).toISOString(), String(client).slice(0, 16)).run();
}

const HERE_WINDOW_MS = 10 * 60_000;

/// Who has been at the app in the last ten minutes: "@here" reaches them.
export async function onlineLogins(db, orgId, now = Date.now()) {
  const since = new Date(now - HERE_WINDOW_MS).toISOString();
  const { results } = await db.prepare("SELECT login FROM workspace_activity WHERE org_id = ?1 AND last_active_at >= ?2").bind(orgId, since).all().catch(() => ({ results: [] }));
  return new Set((results || []).map((r) => r.login));
}

async function lastActive(db, orgId, login) {
  const row = await db.prepare("SELECT last_active_at FROM workspace_activity WHERE org_id = ?1 AND login = ?2").bind(orgId, login).first().catch(() => null);
  return row?.last_active_at || "";
}

/// Whether this person wants their phone told even while they are at the
/// app on another device. Off unless they turned it on.
async function pushesWhileActive(db, login) {
  const row = await db.prepare("SELECT push_while_active FROM users WHERE login = ?1").bind(login).first().catch(() => null);
  return Boolean(row?.push_while_active);
}

/// At this workspace's app in the last two minutes, and not asking to be
/// pushed anyway.
export async function isActive(db, orgId, login, now = Date.now()) {
  if (await pushesWhileActive(db, login)) return false;
  const at = await lastActive(db, orgId, login);
  return Boolean(at) && now - Date.parse(at) < ACTIVE_WINDOW_MS;
}

/// Who a message is for, and why: everyone in a DM or group, whoever it
/// names, whoever wrote the message it answers inline, and whoever wrote in
/// the thread it replies to. Never its author; never somebody who is not in
/// the workspace any more (`members` is everyone who is); never somebody
/// who muted the conversation, and in one set to mentions only, only for a
/// mention, an inline reply to them, or a DM.
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
  // "@here": the people at the app in the last ten minutes.
  const online = mentionTokens(row.body || "").some((t) => broadcastOf(t) === "here") ? await onlineLogins(db, orgId) : null;
  for (const m of resolveMentions(row.body || "", members, { online })) add(m.login, "mention");
  // Words they asked to hear about, said anywhere they can read.
  for (const k of await keywordsIn(db, orgId)) if (keywordHit(row.body, k.keywords)) add(k.login, "keyword");
  // Answered inline: Discord pings whoever is replied to, and so does this —
  // as a mention would, before "thread" can claim them.
  if (row.reply_to_id) {
    const original = await db.prepare(
      "SELECT author_login FROM channel_messages WHERE org_id = ?1 AND id = ?2 AND channel = ?3 AND deleted_at IS NULL"
    ).bind(orgId, row.reply_to_id, key).first();
    if (original) add(original.author_login, "reply");
  }
  if (row.parent_id) {
    const { results } = await db.prepare(
      `SELECT DISTINCT author_login FROM channel_messages
        WHERE org_id = ?1 AND (id = ?2 OR parent_id = ?2) AND author_login IS NOT NULL AND deleted_at IS NULL`
    ).bind(orgId, row.parent_id).all();
    for (const r of results || []) add(r.author_login, "thread");
  }
  // What somebody wrote stays when they leave, and can still be answered
  // or have its thread carried on; what is said after they left is not
  // theirs to be told.
  const here = new Set((members || []).map((m) => m.login));
  for (const login of [...out.keys()]) if (!here.has(login)) out.delete(login);
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

/// What a message says, as a lock screen may show it: one line, and a
/// ||spoiler|| never given away: its writer hid it until clicked.
// A ||spoiler|| — or an inline code span, matched first so the `||` of
// `a || b` never pairs with a real spoiler's bars. A spoiler may hold code.
const SPOILER = /`[^`\n]+`|\|\|(?:`[^`\n]+`|[^|\n])+?\|\|/g;
const isSpoiler = (match) => match[0] !== "`";
export const pushPreview = (text, n = 180) => clip(String(text || "").replace(SPOILER, (m) => (isSpoiler(m) ? "▇▇▇" : m)), n);
const spoilers = (text) => (String(text || "").match(SPOILER) || []).filter(isSpoiler).length;

/// The words a push shows: the reader's translation, unless it lost a
/// ||spoiler|| mark on the way (a model may drop the bars or write them
/// full-width), in which case the words as written, whose spoiler is masked.
export function pushWords(written, translated) {
  if (!translated) return written || "";
  return spoilers(translated) === spoilers(written) ? translated : written;
}

/// Send what is due. Each row is claimed first, so two overlapping runs
/// never push one message twice.
export async function sendDuePushes(env, now = Date.now()) {
  const db = env.DB;
  const at = new Date(now).toISOString();
  const { results: due } = await db.prepare(
    "SELECT * FROM push_queue WHERE sent_at IS NULL AND due_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1) AND attempts < 5 ORDER BY due_at LIMIT 25"
  ).bind(at).all();
  let sent = 0; let skipped = 0;
  const membersOf = new Map();
  for (const job of due || []) {
    const lease = new Date(now + 5 * 60_000).toISOString();
    const claim = await db.prepare("UPDATE push_queue SET lease_until = ?2, attempts = attempts + 1 WHERE id = ?1 AND sent_at IS NULL AND (lease_until IS NULL OR lease_until <= ?3) AND attempts < 5").bind(job.id, lease, at).run();
    if (!(claim?.meta?.changes > 0)) continue;
    let retry = false;
    let error = null;
    try {
      const msg = await db.prepare(
        "SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login WHERE m.org_id = ?1 AND m.id = ?2"
      ).bind(job.org_id, job.message_id).first();
      if (!msg || msg.deleted_at) { skipped += 1; continue; }
      // Read it already, here or anywhere: in its conversation, in its
      // thread, or looked at in Activity.
      if (await readAlready(db, job.org_id, job.login, msg)) { skipped += 1; continue; }
      // At the app since it arrived: they saw it come in, and heard it there.
      // Paused, or outside the hours they set.
      if (await quietFor(db, job.login, new Date(now))) { skipped += 1; continue; }
      if (!(await pushesWhileActive(db, job.login))) {
        const active = await lastActive(db, job.org_id, job.login);
        if (active && active >= msg.created_at) { skipped += 1; continue; }
      }
      if (!membersOf.has(job.org_id)) membersOf.set(job.org_id, await listMembers(db, job.org_id, null));
      const members = membersOf.get(job.org_id);
      // Out of the workspace in the minute since it was queued: a channel's
      // key is the same for everyone, so nothing below would stop it.
      if (!members.some((m) => m.login === job.login)) { skipped += 1; continue; }
      const view = viewOf(msg.channel, job.login, members);
      if (!view) { skipped += 1; continue; }
      const where = msg.channel.startsWith("b:")
        ? `#${(await db.prepare("SELECT name FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(job.org_id, msg.channel.slice(2)).first().catch(() => null))?.name || msg.channel.slice(2)}`
        : null;
      const who = msg.author_name || "Someone";
      const title = where ? `${who} · ${where}` : who;
      const files = msg.body ? "" : "📎";
      // In the language they set.
      const { textFor } = await import("./translate.js");
      const translated = msg.body ? await textFor(env, job.org_id, msg, job.login).catch(() => msg.body) : "";
      const said = pushWords(msg.body, translated);
      const body = said ? pushPreview(said) : files;
      const result = await pushMessage(env, job.login, { deliveryJobId: `message:${job.id}`, title, body, orgId: job.org_id, channel: view, messageId: msg.id, parentId: msg.parent_id || null, at: msg.created_at });
      retry = result.retry;
      if (result.delivered) sent += 1; else skipped += 1;
      error = retry ? "transient delivery failure" : result.delivered ? null : "no accepted delivery";
    } catch (err) {
      retry = true; error = 'delivery exception';
    } finally {
      const again = retry && job.attempts + 1 < MAX_ATTEMPTS;
      await db.prepare('UPDATE push_queue SET sent_at = ?2, due_at = ?3, lease_until = NULL, last_error = ?4 WHERE id = ?1 AND lease_until = ?5')
        .bind(job.id, again ? null : at, new Date(now + retryDelay(job.attempts + 1)).toISOString(), error, lease).run();
    }
  }
  // Kept a day for looking into, then gone; what Activity was looked at,
  // as long as Activity looks back.
  await db.prepare("DELETE FROM push_queue WHERE created_at < ?1").bind(new Date(now - 86400000).toISOString()).run().catch(() => {});
  await db.prepare("DELETE FROM activity_reads WHERE read_at < ?1").bind(new Date(now - 35 * 86400000).toISOString()).run().catch(() => {});
  return { sent, skipped };
}

/// Seen already, on some device: read up to it where it was said (its
/// thread, for a reply), or opened from Activity.
export async function readAlready(db, orgId, login, msg) {
  const keys = [msg.channel, ...(msg.parent_id ? [`t:${msg.parent_id}`] : [])];
  const { results } = await db.prepare(
    `SELECT channel, last_read_at FROM channel_reads WHERE org_id = ?1 AND login = ?2 AND channel IN (${keys.map((_, i) => `?${i + 3}`).join(", ")})`
  ).bind(orgId, login, ...keys).all().catch(() => ({ results: [] }));
  const at = new Map((results || []).map((r) => [r.channel, r.last_read_at || ""]));
  if (keys.some((k) => (at.get(k) || "") >= msg.created_at)) return true;
  const looked = await db.prepare("SELECT 1 AS hit FROM activity_reads WHERE org_id = ?1 AND login = ?2 AND item = ?3")
    .bind(orgId, login, `m:${msg.id}`).first().catch(() => null);
  return Boolean(looked);
}

/// Which push service a registered device is reached through. A row from
/// before the platform column is an iPhone.
export const isIPhone = (device) => (device?.platform || "ios") === "ios";
export const isAndroid = (device) => device?.platform === "android";

/// Read somewhere, so a phone that still shows its notifications for it
/// takes them down: a silent push, sent only when one was pushed there in
/// the last day and is now read.
export async function clearDelivered(env, orgId, login, { key, view, thread, lastReadAt }) {
  if (!apnsConfigured(env) || !key || !view) return 0;
  const since = new Date(Date.now() - 86400000).toISOString();
  const hit = await env.DB.prepare(
    `SELECT 1 AS hit FROM push_queue q JOIN channel_messages m ON m.org_id = q.org_id AND m.id = q.message_id
      WHERE q.org_id = ?1 AND q.login = ?2 AND q.sent_at IS NOT NULL AND q.sent_at >= ?3
        AND m.channel = ?4 AND m.created_at <= ?5 AND ${thread ? "m.parent_id = ?6" : "m.parent_id IS NULL"}
      LIMIT 1`
  ).bind(orgId, login, since, key, lastReadAt || new Date().toISOString(), ...(thread ? [thread] : [])).first().catch(() => null);
  if (!hit) return 0;
  let sent = 0;
  // iPhones only. An Android token sent to Apple comes back BadDeviceToken
  // and would be deleted as dead; clearing on Android waits for the app to
  // handle a silent FCM message.
  for (const device of (await devicesForLogin(env.DB, login)).filter(isIPhone)) {
    const result = await sendPush(env, {
      deviceToken: device.device_token, device,
      pushType: "background",
      priority: 5,
      payload: { aps: { "content-available": 1 }, kind: "read", orgId, channel: view, parentId: thread || null, lastReadAt: lastReadAt || null },
    });
    if (result.ok) sent += 1;
    else if (isDeadToken(result)) await removeDevice(env.DB, device.device_token);
  }
  return sent;
}

/// Messages looked at one by one (in Activity): their notifications come
/// off this person's phones, the same as for a conversation read. Only when
/// one of them was pushed there in the last day.
export async function clearDeliveredMessages(env, orgId, login, messageIds) {
  const ids = [...new Set((messageIds || []).map(String))].filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 100);
  if (!apnsConfigured(env) || !ids.length) return 0;
  const since = new Date(Date.now() - 86400000).toISOString();
  const marks = ids.map((_, i) => `?${i + 4}`).join(", ");
  const hit = await env.DB.prepare(
    `SELECT 1 AS hit FROM push_queue WHERE org_id = ?1 AND login = ?2 AND sent_at IS NOT NULL AND sent_at >= ?3 AND message_id IN (${marks}) LIMIT 1`
  ).bind(orgId, login, since, ...ids).first().catch(() => null);
  if (!hit) return 0;
  let sent = 0;
  for (const device of (await devicesForLogin(env.DB, login)).filter(isIPhone)) {
    const result = await sendPush(env, {
      deviceToken: device.device_token, device,
      pushType: "background",
      priority: 5,
      payload: { aps: { "content-available": 1 }, kind: "read", orgId, messageIds: ids },
    });
    if (result.ok) sent += 1;
    else if (isDeadToken(result)) await removeDevice(env.DB, device.device_token);
  }
  return sent;
}

/// One message to every phone and browser this person has: iPhones through
/// APNs, Android phones through FCM, each only when its key is set.
async function pushMessage(env, login, { title, body, orgId, channel, messageId, parentId, at = null, deliveryJobId }) {
  let delivered = 0; let retry = false;
  const devices = (apnsConfigured(env) || isFcmConfigured(env)) ? await devicesForLogin(env.DB, login) : [];
  if (isFcmConfigured(env)) {
    for (const device of devices.filter(isAndroid)) {
      const result = await deliverOnce(env.DB, deliveryJobId, 'fcm', device.device_token, () => sendFcm(env, {
        token: device.device_token,
        title, text: body,
        // One notification per workspace and conversation in the tray, as the
        // iPhone groups them by thread-id; the newest replaces the last.
        tag: `${orgId}|${channel}`,
        data: { kind: "message", orgId, channel, messageId, parentId },
      }));
      retry ||= retryable(result);
      if (result.ok) delivered += 1;
      else if (isDeadFcmToken(result)) await removeDevice(env.DB, device.device_token);
    }
  }
  if (apnsConfigured(env)) {
    for (const device of devices.filter(isIPhone)) {
      const result = await deliverOnce(env.DB, deliveryJobId, 'apns', device.device_token, () => sendPush(env, {
        deviceToken: device.device_token, device,
        collapseId: messageId,
        // Grouped by workspace and conversation: two teams' #general are not one thread.
        payload: { aps: { alert: { title, body }, sound: "default", "thread-id": `${orgId}|${channel}` }, kind: "message", orgId, channel, messageId, parentId },
      }));
      retry ||= retryable(result);
      if (result.ok) delivered += 1;
      else if (isDeadToken(result)) await removeDevice(env.DB, device.device_token);
    }
  }
  if (isWebPushConfigured(env)) {
    const base = env.APP_WEB_URL ? String(env.APP_WEB_URL).replace(/\/$/, "") : "";
    for (const subscription of await subscriptionsForLogin(env.DB, login)) {
      const result = await deliverOnce(env.DB, deliveryJobId, 'webpush', subscription.endpoint, () => sendWebPush(env, {
        subscription, topic: messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
        // `at`: when it was written, so a browser that already shows a later
        // message in this conversation keeps that one (web-react/public/sw.js).
        payload: { title, body, kind: "message", tag: `${orgId}|${channel}`, orgId, channel, messageId, ...(at ? { at } : {}), ...(base ? { url: `${base}/#/m/${encodeURIComponent(messageId)}/${encodeURIComponent(orgId)}` } : {}) },
      }));
      retry ||= retryable(result);
      if (result.ok) delivered += 1;
      else if (isDeadSubscription(result)) await removeSubscription(env.DB, subscription.endpoint);
    }
  }
  return {delivered, retry};
}

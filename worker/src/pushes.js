import {messageDeliveryAllowed,discardPendingMessagePushes} from './messageDelivery.js';
import { deliverOnce, retryable, retryDelay, MAX_ATTEMPTS, digest } from './notificationJobs.js';
import { threadMuted, threadLeft } from "./threadNotifications.js";
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

import { devicesForLogin, removeDevice, subscriptionsForLogin, removeSubscription, getUserByLogin } from "./db.js";
import { sendPush, isDeadToken, isConfigured as apnsConfigured } from "./apns.js";
import { sendFcm, isDeadFcmToken, isFcmConfigured } from "./fcm.js";
import { sendWebPush, isWebPushConfigured, isDeadSubscription } from "./webpush.js";
import { audienceOf } from "./access.js";
import { resolveMentions, mentionTokens, broadcastOf, isRoomMention } from "./threads.js";
import { viewOf } from "./channels.js";
import { listMembers } from "./team.js";
import { quietFor, quietEnds, HOLD_MAX_MS, keywordsIn, keywordHit } from "./quiet.js";
import { announceTo } from "./announce.js";
import { custom as customEvent } from "./agui/events.js";
import { visibleAppNotifications } from "./harness/appActivity.js";
import { appConversation } from "./harness/appConversations.js";

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

// A Room-wide mention uses the same read audience as the rest of the
// conversation, intersected with current workspace people (never Agents).
async function roomAudienceLogins(db, orgId, channel, members) {
  if (!String(channel || "").startsWith("b:")) return null;
  const audience = await audienceOf(db, orgId, channel);
  const currentPeople = new Set((members || []).map(member => member.login));
  return new Set((audience || [...currentPeople]).filter(login => currentPeople.has(login)));
}

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
/// the workspace any more (`members` is everyone who is); a muted
/// conversation still reaches someone it explicitly mentions. In mentions
/// only, DMs and inline replies also count as relevant.
export async function recipientsOf(db, orgId, row, members, { askedBy = null } = {}) {
  // An agent's answer reaches whoever called it the way a teammate's reply
  // would: through the thread it answers in. The AI's own answer (kind
  // "ai") reaches whoever asked it — it used to reach nobody, so asking
  // and switching away meant never hearing that it had answered.
  if (!row?.id || row.deleted_at) return [];
  if (row.parent_id) {
    const { results: left } = await db.prepare("SELECT login FROM channel_thread_leaves WHERE org_id=?1 AND message_id=?2")
      .bind(orgId, row.parent_id).all();
    const departed = new Set((left || []).map((entry) => entry.login));
    // Leaving suppresses all later thread notices, including direct mentions.
    if (departed.size) {
      // Filter after all recipient sources are assembled below.
      row = { ...row, _leftThreadLogins: departed };
    }
  }
  if (row.kind !== "message" && row.kind !== "agent" && !(row.kind === "ai" && askedBy)) return [];
  const author = row.author_login;
  const out = new Map();
  const add = (login, reason) => { if (login && login !== author && !String(login).startsWith("agent:") && !out.has(login)) out.set(login, reason); };
  if (row.kind === "ai") add(askedBy, "reply");
  const key = String(row.channel || "");
  if (key.startsWith("dm:") || key.startsWith("g:") || key.startsWith("ag:")) {
    for (const login of (await audienceOf(db, orgId, key)) || []) add(login, "direct");
  }
  // "@here": the people at the app in the last ten minutes.
  const online = mentionTokens(row.body || "").some((t) => broadcastOf(t) === "here") ? await onlineLogins(db, orgId) : null;
  const roomLogins = await roomAudienceLogins(db, orgId, key, members);
  const explicitMentions = new Set(resolveMentions(row.body || "", members, { online, roomLogins }).map((m) => m.login));
  for (const login of explicitMentions) add(login, "mention");
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
  // Whoever asked for every new post in this channel: a post in it, or a
  // reply also sent to it — not a reply that stays in its thread.
  if (key.startsWith("b:") && (!row.parent_id || row.also_channel)) {
    const { results: every } = await db.prepare(
      "SELECT login FROM channel_prefs WHERE org_id = ?1 AND channel = ?2 AND level = 'all'"
    ).bind(orgId, key).all();
    for (const r of every || []) add(r.login, "channel");
  }
  // What somebody wrote stays when they leave, and can still be answered
  // or have its thread carried on; what is said after they left is not
  // theirs to be told.
  const here = new Set((members || []).map((m) => m.login));
  for (const login of [...out.keys()]) if (!here.has(login)) out.delete(login);
  for (const login of row._leftThreadLogins || []) out.delete(login);
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
    if ((p.level === "mute" && !explicitMentions.has(p.login)) || (p.level === "mentions" && reason === "thread")) out.delete(p.login);
  }
  if (row.parent_id && out.size) {
    const { results: muted } = await db.prepare("SELECT login FROM channel_thread_mutes WHERE org_id=?1 AND message_id=?2")
      .bind(orgId, row.parent_id).all();
    for (const pref of muted || []) if (!explicitMentions.has(pref.login)) out.delete(pref.login);
  }
  return [...out.entries()].map(([login, reason]) => ({ login, reason }));
}

/// Queue the pushes for a message just said. Cheap: one query when nobody
/// is for it.
export async function queueMessagePushes(env, orgId, row, { members = null, now = Date.now(), askedBy = null, durable = false } = {}) {
  if (!env?.DB || !row?.id) return 0;
  const list = members || await listMembers(env.DB, orgId, null);
  const to = await recipientsOf(env.DB, orgId, row, list, { askedBy });
  if (durable && !await messageDeliveryAllowed(env.DB,orgId,row.id,{requireIntent:true})) {
    await discardPendingMessagePushes(env.DB,orgId,row.id);
    return 0;
  }
  if (!to.length) return 0;
  // The same decision, told to each of these people's open apps at once: a
  // desktop app has no push service, and shows a notification for exactly
  // what the phone will be told (web-react utils/forYou.ts) — a group
  // message, a reply to you, a keyword, a thread you wrote in — rather than
  // guessing from the message alone.
  const deliveries = to.map(({ login, reason }) => ({ to: login, event: customEvent("message_for_you", { id: row.id, reason }) }));
  if (!durable) await announceTo(env, orgId, deliveries);
  const due = new Date(now + PUSH_DELAY_MS).toISOString();
  const at = new Date(now).toISOString();
  try {
    await env.DB.batch(to.map(({ login, reason }) => env.DB.prepare(
      `INSERT OR IGNORE INTO push_queue (org_id, login, message_id, reason, created_at, due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(orgId, login, row.id, reason, at, due)));
  } catch (err) {
    if (durable) throw err;
    // A queue that cannot be written to (D1 refusing writes past its daily
    // limit) used to lose these pushes: the callers only log the throw. Then
    // they go now, without the minute's wait to see whether it was read.
    console.error("push queue unavailable; pushing directly", err?.message || err);
    const membersOf = new Map([[orgId, list]]);
    await Promise.all(to.map(({ login, reason }) => deliverMessagePush(env, { org_id: orgId, login, message_id: row.id, reason }, { now, membersOf })
      .catch((e) => console.error("direct push failed", e?.message || e))));
  }
  // Phone jobs survive relay failure; the durable intent retries the desktop
  // notification until that relay accepts it, without inserting another push.
  if (durable) {
    if (!await messageDeliveryAllowed(env.DB,orgId,row.id,{requireIntent:true})) {
      await discardPendingMessagePushes(env.DB,orgId,row.id);
      return 0;
    }
    await announceTo(env, orgId, deliveries, { strict: true });
  }
  return to.length;
}

const appQueueKey = (orgId, appId, messageId) => `app:${encodeURIComponent(orgId)}:${encodeURIComponent(appId)}:${messageId}`;
function appQueueParts(value) {
  const match = /^app:([^:]+):([^:]+):([1-9][0-9]*)$/.exec(String(value || ''));
  if (!match) return null;
  try { return {orgId:decodeURIComponent(match[1]),appId:decodeURIComponent(match[2]),messageId:Number(match[3])}; }
  catch { return null; }
}

/// Queue an App mention or AI reply only while its authorized inbox item is
/// still unread. The durable queue's unique recipient/key pair handles retries.
export async function queueAppNotificationPush(env,{orgId,appId,messageId,userId,login,now=Date.now()}={}) {
  if(!env?.DB||!orgId||!appId||!Number.isSafeInteger(Number(messageId))||Number(messageId)<1||!userId||!login)return 0;
  const visible=await visibleAppNotifications(env.DB,orgId,String(userId),undefined,appId,Number(messageId));
  const item=visible.find(row=>Number(row.message_id)===Number(messageId)&&!row.read_at);
  if(!item)return 0;
  const key=appQueueKey(orgId,appId,Number(messageId)),at=new Date(now).toISOString();
  const queued=await env.DB.prepare(`INSERT OR IGNORE INTO push_queue(org_id,login,message_id,reason,created_at,due_at)
    SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(
      SELECT 1 FROM hx_app_notifications n JOIN hx_app_messages m ON m.org_id=n.org_id AND m.app_id=n.app_id AND m.sequence=n.message_id
      WHERE n.org_id=?1 AND n.app_id=?7 AND n.message_id=?8 AND n.user_id=?9 AND n.read_at IS NULL
    )`).bind(orgId,login,key,`app-${item.kind==='ai'?'ai':'mention'}`,at,new Date(now+PUSH_DELAY_MS).toISOString(),appId,Number(messageId),String(userId)).run();
  return queued?.meta?.changes||0;
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

/// One message's push to one person, if it should still go: not read yet,
/// not paused, still in the workspace. Being at the app elsewhere does not
/// count as having seen it — only reading the conversation does.
/// `{ skipped: true }` when it should not; otherwise what delivery said.
async function deliverMessagePush(env, job, { now = Date.now(), membersOf = new Map(), deliveryJobId } = {}) {
  const db = env.DB;
  const msg = await db.prepare(
    "SELECT m.*, COALESCE(u.name, (SELECT ca.name FROM custom_agents ca WHERE ca.org_id = m.org_id AND 'agent:' || ca.id = m.author_login)) AS author_name FROM channel_messages m LEFT JOIN users u ON u.login = m.author_login WHERE m.org_id = ?1 AND m.id = ?2"
  ).bind(job.org_id, job.message_id).first();
  if (!msg || msg.deleted_at) return { skipped: true };
  // Access and preferences may have changed during the delay or quiet hours.
  // Recheck before translating or sending any of the message's contents.
  const audience = await audienceOf(db, job.org_id, msg.channel);
  if (audience && !audience.includes(job.login)) return { skipped: true };
  if (!membersOf.has(job.org_id)) membersOf.set(job.org_id, await listMembers(db, job.org_id, null));
  const members = membersOf.get(job.org_id);
  const roomLogins = await roomAudienceLogins(db, job.org_id, msg.channel, members);
  const hasRoomMention = mentionTokens(msg.body || "").some(isRoomMention);
  if (hasRoomMention && roomLogins && !roomLogins.has(job.login)) return { skipped: true };
  const explicitMention = resolveMentions(msg.body || "", members, { here: false }).some((person) => person.login === job.login);
  if (job.reason !== "mention" && !explicitMention && await threadMuted(db, job.org_id, job.login, msg.parent_id)) return { skipped: true };
  if (msg.parent_id && await threadLeft(db, job.org_id, job.login, msg.parent_id)) return { skipped: true };
  if (!await messageDeliveryAllowed(db,job.org_id,msg.id)) return { skipped: true };
  const pref = await db.prepare(
    "SELECT level FROM channel_prefs WHERE org_id = ?1 AND login = ?2 AND channel = ?3"
  ).bind(job.org_id, job.login, msg.channel).first();
  if ((pref?.level === "mute" && job.reason !== "mention" && !explicitMention) || (pref?.level === "mentions" && job.reason === "thread")) return { skipped: true };
  // Read it already, here or anywhere: in its conversation, in its
  // thread, or looked at in Activity.
  if (await readAlready(db, job.org_id, job.login, msg)) return { skipped: true };
  // Paused, or outside the hours they set: held until they end, if that is
  // soon enough to still be news (quiet.js), rather than dropped.
  if (await quietFor(db, job.login, new Date(now))) {
    const ends = await quietEnds(db, job.login, new Date(now));
    return ends ? { deferUntil: ends.getTime() } : { skipped: true };
  }
  // Held through quiet time with others: only the latest few go, not a
  // morning's worth of buzzing.
  if (job.last_error === "held") {
    const newer = await db.prepare(
      "SELECT COUNT(*) AS n FROM push_queue WHERE login = ?1 AND sent_at IS NULL AND last_error = 'held' AND id > ?2"
    ).bind(job.login, job.id).first();
    if ((newer?.n || 0) >= HELD_SENT) return { skipped: true };
  }
  // Being at the app is not having seen it. A message in a conversation
  // they had open in front of them is read by the time this runs (the
  // client reads what it shows), and stops above; one somewhere else is
  // not, and reaches the phone after its minute — as Notifications says.
  // This used to stop on any use of the app at all since the message: a
  // person working on a laptop, in another conversation or another window,
  // got neither the laptop's banner (it was in front) nor the phone's.
  // Out of the workspace in the minute since it was queued: a channel's
  // key is the same for everyone, so nothing below would stop it.
  if (!members.some((m) => m.login === job.login)) return { skipped: true };
  const view = viewOf(msg.channel, job.login, members);
  if (!view) return { skipped: true };
  const where = msg.channel.startsWith("b:")
    ? `#${(await db.prepare("SELECT name FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(job.org_id, msg.channel.slice(2)).first().catch(() => null))?.name || msg.channel.slice(2)}`
    : null;
  const who = msg.author_name || (msg.kind === "ai" ? "AI" : "Someone");
  const title = where ? `${who} · ${where}` : who;
  const files = msg.body ? "" : "📎";
  // In the language they set.
  const { textFor } = await import("./translate.js");
  const translated = msg.body ? await textFor(env, job.org_id, msg, job.login).catch(() => msg.body) : "";
  const said = pushWords(msg.body, translated);
  const body = said ? pushPreview(said) : files;
  return pushMessage(env, job.login, { deliveryJobId, title, body, orgId: job.org_id, channel: view, messageId: msg.id, parentId: msg.parent_id || null, at: msg.created_at });
}

async function deliverAppNotificationPush(env,job,parts,{now=Date.now(),deliveryJobId}={}){
 const db=env.DB,user=await getUserByLogin(db,job.login);
 if(!user)return {skipped:true};
 const appRow=await db.prepare('SELECT id FROM hx_apps WHERE org_id=?1 AND id=?2').bind(parts.orgId,parts.appId).first();
 if(!appRow)return {skipped:true};
 const visible=await visibleAppNotifications(db,parts.orgId,String(user.github_id),undefined,parts.appId,parts.messageId);
 const item=visible.find(row=>Number(row.message_id)===parts.messageId&&!row.read_at);
 if(!item)return {skipped:true};
 const access=await appConversation(db,parts.orgId,String(user.github_id),parts.appId,{tableId:item.table_id||'',rowId:item.row_id||''});
 if(access.error)return {skipped:true};
 if(await isActive(db,parts.orgId,job.login,now))return {skipped:true};
 if(await quietFor(db,job.login,new Date(now))){
  const ends=await quietEnds(db,job.login,new Date(now));
  return ends?{deferUntil:ends.getTime()}:{skipped:true};
 }
 if(job.last_error==='held'){
  const newer=await db.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE org_id=?1 AND login=?2 AND sent_at IS NULL AND last_error='held' AND id>?3").bind(parts.orgId,job.login,job.id).first();
  if((newer?.n||0)>=HELD_SENT)return {skipped:true};
 }
 const tableId=item.table_id||'',rowId=item.row_id||'';
 const query=new URLSearchParams({chat:'1'});
 if(tableId&&rowId){query.set('table',tableId);query.set('row',rowId)}
 const hash=`#/apps/${encodeURIComponent(parts.appId)}/${encodeURIComponent(parts.orgId)}?${query.toString()}`;
 let url=hash;
 try{const base=new URL(String(env.APP_WEB_URL||''));if(['https:','http:'].includes(base.protocol)&&!base.username&&!base.password)url=`${base.origin}${base.pathname.replace(/\/$/,'')}/${hash}`}catch{/* A hash remains usable by a native client when no web origin is configured. */}
 const kind=item.kind==='ai'?'ai':'mention',locale=String(user.locale||'en').split('-')[0].toLowerCase();
 const copy={
  ja:{title:'Honmaru AI',ai:'Appの会話にAIから返信が届きました。',mention:'Appの会話でメンションされました。'},
  es:{title:'Honmaru AI',ai:'La IA respondió en una conversación de la aplicación.',mention:'Te mencionaron en una conversación de la aplicación.'},
  fr:{title:'Honmaru AI',ai:'L’IA a répondu dans une conversation de l’application.',mention:'Vous avez été mentionné dans une conversation de l’application.'},
  de:{title:'Honmaru AI',ai:'Die KI hat in einer App-Konversation geantwortet.',mention:'Du wurdest in einer App-Konversation erwähnt.'},
  en:{title:'Honmaru AI',ai:'AI replied in an App conversation.',mention:'You were mentioned in an App conversation.'},
 }[locale]||{title:'Honmaru AI',ai:'AI replied in an App conversation.',mention:'You were mentioned in an App conversation.'};
 return pushAppActivity(env,job.login,{deliveryJobId,title:copy.title,body:copy[kind],orgId:parts.orgId,appId:parts.appId,messageId:String(parts.messageId),tableId,rowId,url,createdAt:item.created_at});
}

const PUSH_CONCURRENCY = 5;
/// Of the pushes held through quiet time, how many go when it ends: the latest.
const HELD_SENT = 3;

/// Send what is due. Each row is claimed first, so two overlapping runs
/// never push one message twice.
export async function sendDuePushes(env, now = Date.now()) {
  const db = env.DB;
  const at = new Date(now).toISOString();
  const { results: due } = await db.prepare(
    "SELECT * FROM push_queue WHERE sent_at IS NULL AND due_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1) AND attempts < 5 ORDER BY due_at LIMIT 100"
  ).bind(at).all();
  let sent = 0; let skipped = 0;
  const membersOf = new Map();
  // A few at a time. One by one, each waiting on a translation and on
  // Apple, an @channel to a hundred people took minutes to reach the last
  // of them, and the queue behind it waited too.
  const one = async (job) => {
    const lease = new Date(now + 5 * 60_000).toISOString();
    const claim = await db.prepare("UPDATE push_queue SET lease_until = ?2, attempts = attempts + 1 WHERE id = ?1 AND sent_at IS NULL AND (lease_until IS NULL OR lease_until <= ?3) AND attempts < 5").bind(job.id, lease, at).run();
    if (!(claim?.meta?.changes > 0)) return;
    let retry = false;
    let error = null;
    let held = null;
    try {
      const appParts=appQueueParts(job.message_id);
      const result = appParts
        ? await deliverAppNotificationPush(env,job,appParts,{now,deliveryJobId:`message:${job.id}`})
        : await deliverMessagePush(env, job, { now, membersOf, deliveryJobId: `message:${job.id}` });
      // Not pushed: marked done, but not as sent — clearDelivered sends a
      // phone a "read" for what was pushed to it, and nothing was.
      if (result.skipped) { skipped += 1; error = "skipped"; return; }
      if (result.deferUntil) { held = result.deferUntil; return; }
      retry = result.retry;
      if (result.delivered) sent += 1; else skipped += 1;
      error = retry ? "transient delivery failure" : result.delivered ? null : "no accepted delivery";
    } catch (err) {
      retry = true; error = 'delivery exception';
    } finally {
      if (held) {
        // Waits, unspent, for the quiet time to end.
        await db.prepare("UPDATE push_queue SET due_at = ?2, lease_until = NULL, attempts = attempts - 1, last_error = 'held' WHERE id = ?1 AND lease_until = ?3")
          .bind(job.id, new Date(held).toISOString(), lease).run();
        return;
      }
      const again = retry && job.attempts + 1 < MAX_ATTEMPTS;
      await db.prepare('UPDATE push_queue SET sent_at = ?2, due_at = ?3, lease_until = NULL, last_error = ?4 WHERE id = ?1 AND lease_until = ?5')
        .bind(job.id, again ? null : at, new Date(now + retryDelay(job.attempts + 1)).toISOString(), error, lease).run();
    }
  };
  const list = due || [];
  for (let i = 0; i < list.length; i += PUSH_CONCURRENCY) {
    await Promise.all(list.slice(i, i + PUSH_CONCURRENCY).map((job) => one(job).catch((err) => console.error("push failed", err?.message || err))));
  }
  // Kept a day for looking into, then gone; what Activity was looked at,
  // as long as Activity looks back.
  await db.prepare("DELETE FROM push_queue WHERE created_at < ?1").bind(new Date(now - 86400000 - HOLD_MAX_MS).toISOString()).run().catch(() => {});
  await db.prepare("DELETE FROM activity_reads WHERE read_at < ?1").bind(new Date(now - 35 * 86400000).toISOString()).run().catch(() => {});
  return { sent, skipped };
}

/// Seen already, on some device: read up to it where it was said (its
/// thread, for a reply), or opened from Activity.
export async function readAlready(db, orgId, login, msg) {
  // A reply in a thread is read in its thread. Reading (or writing in) the
  // channel it hangs off said nothing about it, and used to cancel the push
  // for replies and @mentions in threads the person had never opened. One
  // also sent to the channel is read either way.
  const keys = msg.parent_id
    ? [`t:${msg.parent_id}`, ...(msg.also_channel ? [msg.channel] : [])]
    : [msg.channel];
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
      WHERE q.org_id = ?1 AND q.login = ?2 AND q.sent_at IS NOT NULL AND q.sent_at >= ?3 AND q.last_error IS NULL
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
    `SELECT 1 AS hit FROM push_queue WHERE org_id = ?1 AND login = ?2 AND sent_at IS NOT NULL AND sent_at >= ?3 AND last_error IS NULL AND message_id IN (${marks}) LIMIT 1`
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
        // `at`: when it was said, so a late "read" push takes down only what
        // was read (TikTokForWork PushService.clearDelivered), not newer ones.
        payload: { aps: { alert: { title, body }, sound: "default", "thread-id": `${orgId}|${channel}` }, kind: "message", orgId, channel, messageId, parentId, ...(at ? { at } : {}) },
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
        // The thread it is in, so reading the thread takes it down.
        payload: { title, body, kind: "message", tag: `${orgId}|${channel}`, orgId, channel, messageId, ...(parentId ? { parentId } : {}), ...(at ? { at } : {}), ...(base ? { url: `${base}/#/m/${encodeURIComponent(messageId)}/${encodeURIComponent(orgId)}` } : {}) },
      }));
      retry ||= retryable(result);
      if (result.ok) delivered += 1;
      else if (isDeadSubscription(result)) await removeSubscription(env.DB, subscription.endpoint);
    }
  }
  return {delivered, retry};
}

async function pushAppActivity(env,login,{deliveryJobId,title,body,orgId,appId,messageId,tableId,rowId,url,createdAt}){
 let delivered=0,retry=false;
 const devices=(apnsConfigured(env)||isFcmConfigured(env))?await devicesForLogin(env.DB,login):[];
 const scope=`${orgId}|app:${appId}`,collapseId=(await digest(`${orgId}:${appId}:${messageId}`)).slice(0,32);
 const data={kind:'app_activity',orgId,appId,messageId,tableId,rowId,url};
 if(isFcmConfigured(env))for(const device of devices.filter(isAndroid)){
  const result=await deliverOnce(env.DB,deliveryJobId,'fcm',device.device_token,()=>sendFcm(env,{token:device.device_token,title,text:body,tag:scope,data}));
  retry||=retryable(result);if(result.ok)delivered++;else if(isDeadFcmToken(result))await removeDevice(env.DB,device.device_token);
 }
 if(apnsConfigured(env))for(const device of devices.filter(isIPhone)){
  const result=await deliverOnce(env.DB,deliveryJobId,'apns',device.device_token,()=>sendPush(env,{deviceToken:device.device_token,device,collapseId,payload:{aps:{alert:{title,body},sound:'default','thread-id':scope},...data,at:createdAt}}));
  retry||=retryable(result);if(result.ok)delivered++;else if(isDeadToken(result))await removeDevice(env.DB,device.device_token);
 }
 if(isWebPushConfigured(env))for(const subscription of await subscriptionsForLogin(env.DB,login)){
  const result=await deliverOnce(env.DB,deliveryJobId,'webpush',subscription.endpoint,()=>sendWebPush(env,{subscription,topic:`app-${collapseId}`.slice(0,32),payload:{title,body,tag:scope,...data,at:createdAt}}));
  retry||=retryable(result);if(result.ok)delivered++;else if(isDeadSubscription(result))await removeSubscription(env.DB,subscription.endpoint);
 }
 return {delivered,retry};
}

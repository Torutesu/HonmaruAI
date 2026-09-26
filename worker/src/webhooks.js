import { audienceOf } from "./access.js";
import { getSession, isMember, getUserByGithubId } from "./db.js";
import { enforce } from "./ratelimit.js";
import { allowed } from "./permissions.js";
import { safe } from "./log.js";

// Webhooks: this workspace's events, posted to a service of the team's own.
//
// A webhook belongs to the member who made it and hears only what they
// could see: every channel's messages and decisions, and — when they ask for
// it — the direct conversations they are one of. Each delivery is signed
// with a secret shown once, when the webhook is made:
//
//   honmaru-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
//
// Deliveries are sent after the request that caused them has answered, and
// a receiver that is down or slow never holds anything up. The last answer
// is kept on the webhook, so the screen can say whether it is working, and
// the last 50 attempts are kept in full — what was sent, what came back — so
// a failed one can be read and sent again. The secret can be replaced; the
// new one is shown once, like the first.

export const WEBHOOK_EVENTS = [
  "message.created",
  "message.updated",
  "card.created",
  "card.decided",
  "call.started",
  "call.ended",
  "webhook.test",
];
const MAX_PER_ORG = 20;
const KEEP_DELIVERIES = 50;
const TIMEOUT_MS = 10_000;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS },
  });
}

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${hex(bytes)}`;
}

/// The signature a receiver checks: HMAC-SHA256 over "<t>.<body>".
export async function sign(secret, timestamp, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

/// An address a delivery may go to: https, a real host, no credentials in it.
export function validEndpoint(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null;
  return url.toString().slice(0, 500);
}

function shown(row, viewerLogin, names) {
  return {
    id: row.id,
    name: row.name || null,
    url: row.url,
    events: parse(row.events, []),
    includeDms: Boolean(row.include_dms),
    createdAt: row.created_at,
    createdBy: names.get(row.created_by) || null,
    mine: row.created_by === viewerLogin,
    lastStatus: row.last_status ?? null,
    lastDeliveryAt: row.last_delivery_at || null,
    lastError: row.last_error || null,
  };
}

/// Who a closed conversation is for — a DM's two, a group's people, a
/// private channel's members — and whether its words are a direct
/// conversation's, which a webhook hears only when it asked to.
async function scopeOf(db, orgId, key) {
  const participants = await audienceOf(db, orgId, key);
  if (!participants) return {};
  const k = String(key || "");
  return { participants, direct: k.startsWith("dm:") || k.startsWith("g:") || k.startsWith("ag:") };
}

/// Whether the member who made a webhook could see this event.
function reaches(hook, scope) {
  if (scope.participants) {
    if (!scope.participants.includes(hook.created_by)) return false;
    // A direct conversation's words only when the webhook asked for them.
    if (scope.direct && !hook.include_dms) return false;
  }
  return true;
}

async function deliver(env, hook, event, { redelivery = false } = {}) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  let status = null;
  let error = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "Honmaru-Webhooks/1.0",
        "honmaru-webhook-id": hook.id,
        "honmaru-event-id": event.id,
        "honmaru-event": event.type,
        "honmaru-signature": `t=${timestamp},v1=${await sign(hook.secret, timestamp, body)}`,
      },
      body,
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = safe(err?.message || String(err)).slice(0, 200);
  }
  const at = new Date().toISOString();
  const deliveryId = `dlv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await env.DB.batch([
    env.DB.prepare("UPDATE org_webhooks SET last_status = ?1, last_delivery_at = ?2, last_error = ?3 WHERE id = ?4").bind(status, at, error, hook.id),
    env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, org_id, event_id, event_type, body, status, error, duration_ms, redelivery, attempted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(deliveryId, hook.id, hook.org_id, event.id, event.type, body, status, error, Date.now() - started, redelivery ? 1 : 0, at),
    env.DB.prepare(
      `DELETE FROM webhook_deliveries WHERE webhook_id = ?1 AND id NOT IN (
         SELECT id FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY attempted_at DESC LIMIT ${KEEP_DELIVERIES})`
    ).bind(hook.id),
  ]).catch((err) => console.error("webhook delivery record failed", safe(err?.message)));
  return { status, error, deliveryId };
}

/// A delivery as the screen shows it.
function shownDelivery(row, withBody = false) {
  return {
    id: row.id,
    eventId: row.event_id,
    event: row.event_type,
    status: row.status ?? null,
    ok: row.status !== null && row.status >= 200 && row.status < 300,
    error: row.error || null,
    durationMs: row.duration_ms ?? null,
    redelivery: Boolean(row.redelivery),
    at: row.attempted_at,
    ...(withBody ? { body: parse(row.body, null) } : {}),
  };
}

function eventOf(type, orgId, data) {
  return { id: `evt_${crypto.randomUUID()}`, type, createdAt: new Date().toISOString(), workspaceId: orgId, data };
}

/// Send one event to every webhook in the workspace that wants it and could
/// see it. Never throws: a webhook is somebody else's server.
///
/// `scope.participants` are the logins an event belongs to when it is not
/// the whole workspace's (a direct conversation, a card between two
/// people); `scope.direct` marks a direct conversation's words.
export async function emitWebhook(env, orgId, type, data, scope = {}) {
  try {
    if (!env?.DB || !orgId) return 0;
    const { results } = await env.DB.prepare(
      "SELECT * FROM org_webhooks WHERE org_id = ?1 AND events LIKE ?2"
    ).bind(orgId, `%"${type}"%`).all();
    const hooks = (results || []).filter((h) => reaches(h, scope));
    if (!hooks.length) return 0;
    const event = eventOf(type, orgId, data);
    await Promise.all(hooks.map((h) => deliver(env, h, event)));
    return hooks.length;
  } catch (err) {
    console.error("webhook emit failed", safe(err?.message));
    return 0;
  }
}

// ---- What an event says. Names, never logins: a login is an address. ----

async function channelLabel(db, orgId, key) {
  if (String(key).startsWith("b:")) {
    const slug = key.slice(2);
    const row = await db.prepare("SELECT name, private FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug).first().catch(() => null);
    return { kind: "channel", slug, name: row?.name || slug, ...(row?.private ? { private: true } : {}) };
  }
  if (String(key).startsWith("g:")) return { kind: "group", id: key.slice(2) };
  return { kind: "direct" };
}

async function nameOf(db, login) {
  if (!login) return null;
  const row = await db.prepare("SELECT name FROM users WHERE login = ?1").bind(login).first().catch(() => null);
  return row?.name || null;
}

async function agentNameOf(db, orgId, login) {
  const id = String(login || "").replace(/^agent:/, "");
  const row = await db.prepare("SELECT name FROM custom_agents WHERE org_id = ?1 AND id = ?2").bind(orgId, id).first().catch(() => null);
  return row?.name || null;
}

/// A channel message, created or changed.
/// Whether any webhook in the workspace wants this event at all — asked
/// first, so a workspace with none (most) pays one query per event, not the
/// names, labels and audience an event is built from.
async function anyoneListens(env, orgId, type) {
  if (!env?.DB || !orgId) return false;
  try {
    return Boolean(await env.DB.prepare("SELECT 1 FROM org_webhooks WHERE org_id = ?1 AND events LIKE ?2 LIMIT 1").bind(orgId, `%"${type}"%`).first());
  } catch {
    return false;
  }
}

export async function emitMessage(env, orgId, row, { updated = false } = {}) {
  if (!row?.id) return 0;
  if (!(await anyoneListens(env, orgId, updated ? "message.updated" : "message.created"))) return 0;
  const scope = await scopeOf(env.DB, orgId, row.channel);
  const data = {
    message: {
      id: row.id,
      channel: await channelLabel(env.DB, orgId, row.channel),
      text: row.deleted_at ? "" : String(row.body || ""),
      author: row.kind === "agent" ? { name: await agentNameOf(env.DB, orgId, row.author_login), agent: true }
        : row.author_login ? { name: await nameOf(env.DB, row.author_login) } : { name: "AI", ai: true },
      parentId: row.parent_id || null,
      createdAt: row.created_at,
      editedAt: row.edited_at || null,
      deleted: Boolean(row.deleted_at),
    },
  };
  return emitWebhook(env, orgId, updated ? "message.updated" : "message.created", data, scope);
}

/// A decision, made or decided.
export async function emitCard(env, orgId, card, type) {
  if (!card?.id) return 0;
  if (!(await anyoneListens(env, orgId, type))) return 0;
  const data = {
    card: {
      id: card.id,
      title: card.title || "",
      summary: card.summary || "",
      status: card.status || null,
      priority: card.priority || null,
      channel: card.business ? await channelLabel(env.DB, orgId, `b:${card.business}`) : null,
      from: { name: card.requestedBy?.name || (await nameOf(env.DB, card.senderUserID)) },
      to: { name: await nameOf(env.DB, card.recipientUserID) },
      decision: card.decision?.action ? {
        action: card.decision.action,
        note: card.decision.note || card.decision.replyText || null,
        by: { name: await nameOf(env.DB, card.decision.actorUserID) },
        at: card.decision.decidedAt || null,
      } : null,
      createdAt: card.createdAt || null,
    },
  };
  // A public channel's decision is the channel's; a private channel's is
  // its members' and the two people on it; any other is its two people's.
  const closed = card.business ? await audienceOf(env.DB, orgId, `b:${card.business}`) : null;
  const scope = card.business && !closed ? {} : { participants: [...(closed || []), card.senderUserID, card.recipientUserID].filter(Boolean) };
  return emitWebhook(env, orgId, type, data, scope);
}

/// A Jam, started or ended.
export async function emitCall(env, orgId, key, type, extra = {}) {
  if (!(await anyoneListens(env, orgId, type))) return 0;
  return emitWebhook(env, orgId, type, { call: { channel: await channelLabel(env.DB, orgId, key), ...extra } }, await scopeOf(env.DB, orgId, key));
}

// ---- The routes ----

async function caller(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return { denied: json({ message: "Please sign in." }, 401) };
  if (!orgId) return { denied: json({ message: "orgId is required" }, 400) };
  if (!(await isMember(env.DB, orgId, session.github_id))) return { denied: json({ message: "not a member of this org" }, 403) };
  { const { policyDenial } = await import("./policy.js"); const held = await policyDenial(env, session, orgId); if (held) return { denied: json(held.body, held.status) }; }
  const user = await getUserByGithubId(env.DB, session.github_id);
  if (!user?.login) return { denied: json({ message: "Please sign in." }, 401) };
  return { session, user };
}

async function namesFor(db, logins) {
  const unique = [...new Set(logins.filter(Boolean))];
  if (!unique.length) return new Map();
  const marks = unique.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db.prepare(`SELECT login, name FROM users WHERE login IN (${marks})`).bind(...unique).all();
  return new Map((results || []).map((r) => [r.login, r.name || null]));
}

/// GET, POST /webhooks · DELETE /webhooks/:id · POST /webhooks/:id/test
export async function handleWebhooks(request, env, url) {
  const path = url.pathname;
  // Only these: "/webhooks/email" and the like are other people's inbound
  // hooks, handled elsewhere, and must never land here.
  const one = path.match(/^\/webhooks\/(wh_[0-9a-f]{20})(?:\/(test|rotate|deliveries)(?:\/(dlv_[0-9a-f]{20})\/redeliver)?)?$/);
  if (path !== "/webhooks" && !one) return null;
  const limited = await enforce(env, request, "webhooks");
  if (limited) return limited;

  if (path === "/webhooks" && request.method === "GET") {
    const orgId = url.searchParams.get("orgId");
    const who = await caller(env, request, orgId);
    if (who.denied) return who.denied;
    const { results } = await env.DB.prepare("SELECT * FROM org_webhooks WHERE org_id = ?1 ORDER BY created_at ASC").bind(orgId).all();
    const rows = results || [];
    const names = await namesFor(env.DB, rows.map((r) => r.created_by));
    return json({ webhooks: rows.map((r) => shown(r, who.user.login, names)), events: WEBHOOK_EVENTS });
  }

  if (path === "/webhooks" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ message: "Invalid JSON body." }, 400);
    const who = await caller(env, request, body.orgId);
    if (who.denied) return who.denied;
    const { isGuest } = await import("./access.js");
    if (await isGuest(env.DB, body.orgId, who.session.github_id)) return json({ message: "A guest cannot add webhooks." }, 403);
    const endpoint = validEndpoint(body.url);
    if (!endpoint) return json({ message: "Use a public https:// address." }, 400);
    const events = Array.isArray(body.events) ? [...new Set(body.events.filter((e) => WEBHOOK_EVENTS.includes(e)))] : [];
    if (!events.length) return json({ message: "Choose at least one event." }, 400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM org_webhooks WHERE org_id = ?1").bind(body.orgId).first();
    if ((count?.n || 0) >= MAX_PER_ORG) return json({ message: `A workspace has at most ${MAX_PER_ORG} webhooks.` }, 400);
    const row = {
      id: `wh_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      org_id: body.orgId,
      created_by: who.user.login,
      name: typeof body.name === "string" ? body.name.trim().slice(0, 80) || null : null,
      url: endpoint,
      events: JSON.stringify(events),
      include_dms: body.includeDms === true ? 1 : 0,
      secret: newSecret(),
      created_at: new Date().toISOString(),
    };
    await env.DB.prepare(
      `INSERT INTO org_webhooks (id, org_id, created_by, name, url, events, include_dms, secret, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(row.id, row.org_id, row.created_by, row.name, row.url, row.events, row.include_dms, row.secret, row.created_at).run();
    const names = new Map([[who.user.login, who.user.name || null]]);
    const { audit, person } = await import("./audit.js");
    await audit(env, request, { orgId: body.orgId, action: "webhook.created", actor: person(who.user), entity: { type: "webhook", id: row.id, name: row.name || new URL(endpoint).hostname }, details: { host: new URL(endpoint).hostname, events, includeDms: Boolean(row.include_dms) } });
    // The secret, this once. It is never sent again.
    return json({ webhook: shown(row, who.user.login, names), secret: row.secret }, 201);
  }

  if (!one) return json({ message: "not found" }, 404);
  const id = one[1];
  const action = one[2] || null;
  const deliveryId = one[3] || null;
  const orgId = request.method === "DELETE" || request.method === "GET" ? url.searchParams.get("orgId") : (await request.clone().json().catch(() => ({}))).orgId;
  const who = await caller(env, request, orgId);
  if (who.denied) return who.denied;
  const hook = await env.DB.prepare("SELECT * FROM org_webhooks WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first();
  if (!hook) return json({ message: "No such webhook." }, 404);

  const { audit, person } = await import("./audit.js");
  const entity = { type: "webhook", id: hook.id, name: hook.name || (() => { try { return new URL(hook.url).hostname; } catch { return null; } })() };
  const mayManage = hook.created_by === who.user.login || await allowed(env.DB, orgId, who.session.github_id, "webhook.delete_others");

  if (!action && request.method === "DELETE") {
    if (!mayManage) return json({ message: "Only whoever made this webhook, or an admin, can delete it." }, 403);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM org_webhooks WHERE id = ?1").bind(id),
      env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?1").bind(id),
    ]);
    await audit(env, request, { orgId, action: "webhook.deleted", actor: person(who.user), entity });
    return json({ ok: true });
  }

  // What was sent, and what came back: its maker's, or an admin's to read.
  if (action === "deliveries" && !deliveryId && request.method === "GET") {
    if (!mayManage) return json({ message: "Only whoever made this webhook, or an admin, can read its deliveries." }, 403);
    const { results } = await env.DB.prepare(
      "SELECT * FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY attempted_at DESC LIMIT ?2"
    ).bind(id, KEEP_DELIVERIES).all();
    return json({ deliveries: (results || []).map((r) => shownDelivery(r, true)) });
  }

  // Send one again, as it was — same event id, so a receiver can tell.
  if (action === "deliveries" && deliveryId && request.method === "POST") {
    if (!mayManage) return json({ message: "Only whoever made this webhook, or an admin, can send a delivery again." }, 403);
    const row = await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ?1 AND webhook_id = ?2").bind(deliveryId, id).first();
    if (!row) return json({ message: "No such delivery." }, 404);
    const event = parse(row.body, null);
    if (!event) return json({ message: "That delivery cannot be read." }, 400);
    const out = await deliver(env, hook, event, { redelivery: true });
    await audit(env, request, { orgId, action: "webhook.redelivered", actor: person(who.user), entity, details: { event: event.type, eventId: event.id, status: out.status } });
    const fresh = await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ?1").bind(out.deliveryId).first();
    return json({ ok: !out.error, status: out.status, error: out.error, delivery: fresh ? shownDelivery(fresh, true) : null });
  }

  // A new secret, shown this once; the old one stops working now.
  if (action === "rotate" && request.method === "POST") {
    if (!mayManage) return json({ message: "Only whoever made this webhook, or an admin, can replace its secret." }, 403);
    const secret = newSecret();
    await env.DB.prepare("UPDATE org_webhooks SET secret = ?1 WHERE id = ?2").bind(secret, id).run();
    await audit(env, request, { orgId, action: "webhook.secret_rotated", actor: person(who.user), entity });
    return json({ secret });
  }

  if (action === "test" && request.method === "POST") {
    if (hook.created_by !== who.user.login) return json({ message: "Only whoever made this webhook can test it." }, 403);
    const out = await deliver(env, hook, eventOf("webhook.test", orgId, { message: "A test from Honmaru." }));
    return json({ ok: !out.error, status: out.status, error: out.error });
  }
  return json({ message: "not found" }, 404);
}

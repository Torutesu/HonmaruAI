// The audit log: who did what, to what, from where — in one workspace.
//
// docs/enterprise-audit-log.md is the design. This is its first phase: the
// record, and reading it back. An event is "an actor did an action to an
// entity, in a context", Slack's shape, with an outcome and a severity; it
// never carries what was said, only ids and names.
//
// One way in: `audit()`. It never throws — a log that can fail a request is
// a log people learn to switch off — and it is written append-only. `seq`
// counts up per workspace, so a missing number is a deleted row, and each
// row's hash covers the row before it, so an edited one breaks the chain.

import { getSession, isMember, getUserByGithubId } from "./db.js";
import { ROLE_RANK, sha256Hex } from "./auth.js";
import { memberRef } from "./team.js";
import { safe } from "./log.js";
import { auditCryptoReady, encryptBody, decryptBody, principalOf } from "./auditCrypto.js";

/// Every action this deployment records: its category, how much it
/// matters, and a sentence for the screen ({actor} did it to {entity}).
export const AUDIT_ACTIONS = {
  "auth.login": { category: "auth", severity: "info", text: "{actor} signed in" },
  "auth.login_failed": { category: "auth", severity: "warning", text: "A sign-in failed" },
  "sso.configured": { category: "workspace", severity: "critical", text: "{actor} changed single sign-on" },
  "sso.tested": { category: "workspace", severity: "notice", text: "{actor} tested single sign-on" },
  "sso.activated": { category: "workspace", severity: "critical", text: "{actor} turned on single sign-on" },
  "sso.enforced": { category: "workspace", severity: "critical", text: "{actor} made single sign-on required" },
  "sso.enforcement_removed": { category: "workspace", severity: "critical", text: "{actor} stopped requiring single sign-on" },
  "sso.disabled": { category: "workspace", severity: "critical", text: "{actor} turned off single sign-on" },
  "sso.identity_unlinked": { category: "auth", severity: "warning", text: "{actor} unlinked {entity} from single sign-on" },
  "auth.logout": { category: "auth", severity: "info", text: "{actor} signed out" },
  "auth.session_revoked": { category: "auth", severity: "notice", text: "{actor} signed out a session of {entity}" },
  "member.joined": { category: "membership", severity: "notice", text: "{actor} joined" },
  "member.removed": { category: "membership", severity: "notice", text: "{actor} removed {entity}" },
  "member.left": { category: "membership", severity: "notice", text: "{actor} left the workspace" },
  "member.role_changed": { category: "membership", severity: "warning", text: "{actor} changed the role of {entity}" },
  "member.channels_changed": { category: "membership", severity: "notice", text: "{actor} changed the channels of guest {entity}" },
  "owner.added": { category: "membership", severity: "critical", text: "{actor} made {entity} an owner" },
  "owner.removed": { category: "membership", severity: "critical", text: "{actor} took owner away from {entity}" },
  "owner.transfer_offered": { category: "membership", severity: "critical", text: "{actor} offered the workspace to {entity}" },
  "owner.transfer_cancelled": { category: "membership", severity: "warning", text: "{actor} called off handing the workspace on" },
  "owner.transferred": { category: "membership", severity: "critical", text: "{actor} accepted the workspace from {entity}" },
  "owner.assigned": { category: "membership", severity: "critical", text: "The workspace was given an owner: {entity}" },
  "member.join_requested": { category: "membership", severity: "notice", text: "{actor} asked to join" },
  "member.join_approved": { category: "membership", severity: "notice", text: "{actor} let {entity} join" },
  "member.join_declined": { category: "membership", severity: "notice", text: "{actor} declined {entity}'s request to join" },
  "domain.added": { category: "workspace", severity: "warning", text: "{actor} added the domain {entity}" },
  "domain.verified": { category: "workspace", severity: "warning", text: "{actor} verified the domain {entity}" },
  "domain.removed": { category: "workspace", severity: "critical", text: "{actor} removed the domain {entity}" },
  "domain.join_policy_changed": { category: "workspace", severity: "critical", text: "{actor} changed who joins by {entity}" },
  "domain.verification_lost": { category: "workspace", severity: "critical", text: "{entity} is no longer verified" },
  "invite.created": { category: "membership", severity: "notice", text: "{actor} created an invitation" },
  "invite.revoked": { category: "membership", severity: "notice", text: "{actor} cancelled an invitation" },
  "invite.email_sent": { category: "membership", severity: "info", text: "{actor} emailed an invitation" },
  "workspace.created": { category: "workspace", severity: "warning", text: "{actor} created the workspace" },
  "workspace.renamed": { category: "workspace", severity: "warning", text: "{actor} renamed the workspace" },
  "workspace.icon_changed": { category: "workspace", severity: "info", text: "{actor} changed the workspace icon" },
  "workspace.session_policy_changed": { category: "workspace", severity: "critical", text: "{actor} changed the login rules" },
  "workspace.session_policy_applied": { category: "workspace", severity: "warning", text: "{actor} signed out everyone the login rules no longer allow" },
  "workspace.ai_settings_changed": { category: "workspace", severity: "warning", text: "{actor} changed the workspace AI settings" },
  "channel.created": { category: "channel", severity: "notice", text: "{actor} created {entity}" },
  "channel.member_added": { category: "channel", severity: "notice", text: "{actor} added {entity} to a channel" },
  "channel.member_removed": { category: "channel", severity: "notice", text: "{actor} removed {entity} from a channel" },
  "emoji.added": { category: "workspace", severity: "info", text: "{actor} added the emoji {entity}" },
  "emoji.removed": { category: "workspace", severity: "info", text: "{actor} removed the emoji {entity}" },
  "org_key.created": { category: "integration", severity: "critical", text: "{actor} made the workspace key {entity}" },
  "org_key.updated": { category: "integration", severity: "critical", text: "{actor} changed the workspace key {entity}" },
  "org_key.revoked": { category: "integration", severity: "critical", text: "{actor} revoked the workspace key {entity}" },
  "org_key.used_from_new_ip": { category: "security", severity: "warning", text: "The workspace key {actor} was used from a new address" },
  "channel.updated": { category: "channel", severity: "notice", text: "{actor} changed {entity}" },
  "api_token.created": { category: "integration", severity: "warning", text: "{actor} created the API key {entity}" },
  "api_token.revoked": { category: "integration", severity: "warning", text: "{actor} revoked the API key {entity}" },
  "webhook.created": { category: "integration", severity: "warning", text: "{actor} created the webhook {entity}" },
  "webhook.deleted": { category: "integration", severity: "warning", text: "{actor} deleted the webhook {entity}" },
  "webhook.secret_rotated": { category: "integration", severity: "warning", text: "{actor} made a new secret for the webhook {entity}" },
  "webhook.redelivered": { category: "integration", severity: "info", text: "{actor} sent a delivery of {entity} again" },
  "data.account_exported": { category: "data", severity: "warning", text: "{actor} downloaded their data" },
  "audit.viewed": { category: "audit", severity: "notice", text: "{actor} read the audit log" },
  "audit.exported": { category: "audit", severity: "notice", text: "{actor} downloaded the audit log" },
  "audit.principal_shredded": { category: "audit", severity: "notice", text: "A deleted account's entries were made unreadable" },
  "audit.chain_migrated": { category: "audit", severity: "critical", text: "The audit log was moved to per-person encryption" },
  "security.permission_denied": { category: "security", severity: "warning", text: "{actor} was refused: {entity}" },
};

export const SEVERITIES = ["info", "notice", "warning", "critical"];
const MAX_LIMIT = 1000;

/// Where a request came from, as the log keeps it.
export function contextOf(request) {
  if (!request?.headers) return {};
  const h = request.headers;
  const ua = String(h.get("user-agent") || "").slice(0, 300) || null;
  return {
    ip_address: h.get("cf-connecting-ip") || null,
    country: request.cf?.country || h.get("cf-ipcountry") || null,
    ua,
    client: clientOf(h.get("x-client"), ua),
    request_id: h.get("cf-ray") || null,
  };
}

/// "web" or "ios", as a client says or as its user agent gives away.
export function clientOf(said, ua) {
  const s = String(said || "").toLowerCase();
  if (s === "ios" || s === "web" || s === "api") return s;
  const u = String(ua || "");
  if (/CFNetwork|Darwin\//.test(u) && !/Mozilla/.test(u)) return "ios";
  return u ? "web" : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/// Record one event. `actor` and `entity` are { type, id, name }; `id` is a
/// login for a person. Never throws.
export async function audit(env, request, { orgId, action, actor, entity = null, details = null, outcome = "success", severity = null }) {
  try {
    if (!env?.DB || !orgId || !action) return null;
    const known = AUDIT_ACTIONS[action] || { category: action.split(".")[0], severity: "info" };
    const now = Date.now();
    const id = `aud_${now.toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const body = {
      id,
      date_create: Math.floor(now / 1000),
      action,
      category: known.category,
      severity: severity || known.severity,
      outcome,
      actor: actor || { type: "system" },
      entity,
      context: contextOf(request),
      details,
    };
    // People go in under their own keys, when this deployment has them.
    let stored = body;
    let actorId = body.actor.id || null;
    let entityId = entity?.id || null;
    let encrypted = 0;
    if (auditCryptoReady(env)) {
      const hidden = await encryptBody(env, orgId, body);
      stored = hidden.body;
      actorId = hidden.actorId;
      entityId = hidden.entityId;
      encrypted = 1;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = await env.DB.prepare("SELECT seq, hash FROM audit_events WHERE org_id = ?1 ORDER BY seq DESC LIMIT 1").bind(orgId).first();
      const seq = (last?.seq || 0) + 1;
      const prev = last?.hash || null;
      const hash = await sha256Hex(`${prev || ""}\n${seq}\n${canonical(stored)}`);
      try {
        await env.DB.prepare(
          `INSERT INTO audit_events (org_id, seq, id, created_at, action, category, severity, outcome, actor_type, actor_id, entity_type, entity_id, body, prev_hash, hash, enc)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
        ).bind(orgId, seq, id, body.date_create, action, body.category, body.severity, outcome,
          body.actor.type || "user", actorId, entity?.type || null, entityId,
          JSON.stringify(stored), prev, hash, encrypted).run();
        return id;
      } catch (err) {
        // Somebody else took this number between the read and the write.
        if (!/UNIQUE|PRIMARY KEY|constraint/i.test(String(err?.message))) throw err;
      }
    }
    return null;
  } catch (err) {
    console.error("audit failed", action, safe(err?.message));
    return null;
  }
}

/// A person as an actor or entity: their login and name.
export function person(user, type = "user") {
  if (!user) return null;
  return { type, id: user.login || null, name: user.name || user.login || null };
}

/// The same event in every workspace this person is in — a sign-in, a
/// sign-out, a download of their own data.
export async function auditEverywhere(env, request, githubId, event) {
  try {
    const { results } = await env.DB.prepare("SELECT org_id FROM memberships WHERE user_github_id = ?1").bind(String(githubId)).all();
    for (const r of results || []) await audit(env, request, { ...event, orgId: r.org_id });
  } catch (err) {
    console.error("audit everywhere failed", safe(err?.message));
  }
}

/// Whether the chain from `from` to `to` is whole: every number there, and
/// every hash what the row before it and the row itself make.
export async function verifyChain(db, orgId, { from = 1, to = null } = {}) {
  const { results } = await db.prepare(
    `SELECT seq, body, prev_hash, hash FROM audit_events WHERE org_id = ?1 AND seq >= ?2 ${to ? "AND seq <= ?3" : ""} ORDER BY seq`
  ).bind(...[orgId, from, ...(to ? [to] : [])]).all();
  let prev = null;
  let expected = from;
  for (const r of results || []) {
    if (r.seq !== expected) return { ok: false, firstBrokenSeq: expected, reason: "missing" };
    if (expected > from && r.prev_hash !== prev) return { ok: false, firstBrokenSeq: r.seq, reason: "chain" };
    const hash = await sha256Hex(`${r.prev_hash || ""}\n${r.seq}\n${canonical(JSON.parse(r.body))}`);
    if (hash !== r.hash) return { ok: false, firstBrokenSeq: r.seq, reason: "hash" };
    prev = r.hash;
    expected += 1;
  }
  return { ok: true, checked: (results || []).length };
}

// ---- Reading it ----

const encodeCursor = (row) => btoa(`${row.created_at}:${row.seq}`);
function decodeCursor(raw) {
  try {
    const [at, seq] = atob(String(raw)).split(":").map(Number);
    return Number.isFinite(at) && Number.isFinite(seq) ? { at, seq } : null;
  } catch { return null; }
}

const seconds = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.floor(n > 1e12 ? n / 1000 : n);
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

/// The log, newest first, as filters narrow it.
export async function readAudit(db, orgId, filters = {}) {
  const where = ["org_id = ?1"];
  const binds = [orgId];
  const add = (sql, ...values) => {
    let s = sql;
    for (const v of values) { binds.push(v); s = s.replace(/\?(?!\d)/, `?${binds.length}`); }
    where.push(s);
  };
  const oldest = seconds(filters.oldest);
  const latest = seconds(filters.latest);
  if (oldest !== null) add("created_at >= ?", oldest);
  if (latest !== null) add("created_at <= ?", latest);
  const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const actions = list(filters.action);
  if (actions.length) add(`action IN (${actions.map(() => "?").join(", ")})`, ...actions);
  const categories = list(filters.category);
  if (categories.length) add(`category IN (${categories.map(() => "?").join(", ")})`, ...categories);
  if (filters.severity && SEVERITIES.includes(filters.severity)) {
    const at = SEVERITIES.slice(SEVERITIES.indexOf(filters.severity));
    add(`severity IN (${at.map(() => "?").join(", ")})`, ...at);
  }
  // A person is their login in a phase 1 row and their pseudonym in one
  // written since; `actorIds` holds both.
  const actorIds = (filters.actorIds || (filters.actorLogin ? [filters.actorLogin] : [])).filter(Boolean);
  if (actorIds.length) add(`actor_id IN (${actorIds.map(() => "?").join(", ")})`, ...actorIds);
  if (filters.entityId) add("entity_id = ?", filters.entityId);
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) add("(created_at < ? OR (created_at = ? AND seq < ?))", cursor.at, cursor.at, cursor.seq);
  const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(filters.limit, 10) || 100));
  const { results } = await db.prepare(
    `SELECT seq, created_at, body FROM audit_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC, seq DESC LIMIT ${limit + 1}`
  ).bind(...binds).all();
  const rows = results || [];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    entries: page.map((r) => ({ seq: r.seq, ...JSON.parse(r.body) })),
    next: more ? encodeCursor(page[page.length - 1]) : null,
  };
}

/// An entry as a screen or an export shows it: people by name and member
/// ref, never by login — a login can be somebody's email address.
/// `ids` maps the workspace's logins to account ids; `cache` keeps refs.
export async function presentEntry(entry, orgId, ids, cache = new Map()) {
  const who = async (p) => {
    if (!p) return null;
    // Someone whose account is gone: their key went with it.
    if (p.deleted) return { type: p.type, name: null, deleted: true, principal: p.principal };
    const out = { type: p.type, name: p.name || null };
    if ((p.type === "user" || p.type === "agent") && p.id) {
      if (!cache.has(p.id)) cache.set(p.id, ids.has(p.id) ? await memberRef(orgId, ids.get(p.id)) : null);
      out.ref = cache.get(p.id);
    } else if (p.id) out.id = p.id;
    if (p.via) out.via = { type: p.via.type };
    return out;
  };
  const { context = {}, ...rest } = entry;
  return {
    ...rest,
    actor: await who(entry.actor),
    entity: await who(entry.entity),
    context: { country: context.country || null, client: context.client || null, ip_address: context.ip_address || null, request_id: context.request_id || null },
    text: AUDIT_ACTIONS[entry.action]?.text || entry.action,
  };
}

const CSV_COLUMNS = ["date", "action", "severity", "outcome", "actor", "actor_type", "entity", "entity_type", "country", "client", "ip_address", "details"];
const cell = (v) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // A leading =, +, - or @ is a formula to a spreadsheet.
  const safeText = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safeText) ? `"${safeText.replace(/"/g, '""')}"` : safeText;
};

export function toCsv(entries) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of entries) {
    lines.push([
      new Date(e.date_create * 1000).toISOString(), e.action, e.severity, e.outcome,
      e.actor?.name || e.actor?.id || (e.actor?.deleted ? `deleted user (${e.actor.principal})` : ""), e.actor?.type || "",
      e.entity?.name || e.entity?.id || (e.entity?.deleted ? `deleted user (${e.entity.principal})` : ""), e.entity?.type || "",
      e.context?.country, e.context?.client, e.context?.ip_address, e.details,
    ].map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

// ---- The routes ----

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-client, authorization",
  "access-control-allow-methods": "GET, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS } });
}

async function isAdmin(db, orgId, githubId) {
  const { allowed } = await import("./permissions.js");
  return allowed(db, orgId, githubId, "audit.read");
}

/// Who is reading: an admin's session, or an API key with `audit:read`
/// whose owner is an admin.
async function reader(env, request, orgId) {
  if (!orgId) return { denied: json({ message: "orgId is required" }, 400) };
  const bearer = request.headers.get("authorization");
  if (bearer) {
    const { resolveApiToken, hasScope } = await import("./mcp.js");
    const agent = await resolveApiToken(env.DB, bearer);
    if (!agent || agent.orgId !== orgId) return { denied: json({ message: "That key does not open this workspace." }, 401) };
    if (!hasScope(agent.scopes, "audit:read")) return { denied: json({ message: "This key needs the audit:read scope." }, 403) };
    if (!(await isAdmin(env.DB, orgId, agent.githubId))) return { denied: json({ message: "Only an admin's key can read the audit log." }, 403) };
    return { user: { login: agent.login, name: agent.name }, via: { type: "api_token", id: agent.tokenId } };
  }
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return { denied: json({ message: "Please sign in." }, 401) };
  if (!(await isMember(env.DB, orgId, session.github_id))) return { denied: json({ message: "not a member of this org" }, 403) };
  { const { policyDenial } = await import("./policy.js"); const held = await policyDenial(env, session, orgId); if (held) return { denied: json(held.body, held.status) }; }
  const user = await getUserByGithubId(env.DB, session.github_id);
  if (!(await isAdmin(env.DB, orgId, session.github_id))) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "audit_log", name: "the audit log" }, outcome: "denied" });
    return { denied: json({ message: "Only an admin can read the audit log." }, 403) };
  }
  return { user, via: { type: "session" } };
}

/// GET /audit/logs · GET /audit/actions · GET /audit/verify
export async function handleAudit(request, env, url) {
  if (!url.pathname.startsWith("/audit/") || request.method !== "GET") return null;
  if (url.pathname === "/audit/actions") {
    return json({ actions: Object.entries(AUDIT_ACTIONS).map(([action, a]) => ({ action, ...a })), severities: SEVERITIES });
  }
  const orgId = url.searchParams.get("orgId");
  const who = await reader(env, request, orgId);
  if (who.denied) return who.denied;

  if (url.pathname === "/audit/verify") {
    return json(await verifyChain(env.DB, orgId, { from: parseInt(url.searchParams.get("from"), 10) || 1, to: parseInt(url.searchParams.get("to"), 10) || null }));
  }
  if (url.pathname !== "/audit/logs") return json({ message: "not found" }, 404);

  const q = url.searchParams;
  const members = (await env.DB.prepare(
    "SELECT u.login, m.user_github_id AS id FROM memberships m JOIN users u ON u.github_id = m.user_github_id WHERE m.org_id = ?1"
  ).bind(orgId).all()).results || [];
  const ids = new Map(members.map((m) => [m.login, String(m.id)]));
  const refs = new Map();
  // "actor" is a member ref, as the screen knows people.
  // Or a pseudonym, `p_…`, for someone who has left and is known by no other.
  let actorIds = null;
  if (q.get("actor")) {
    const asked = q.get("actor");
    if (/^p_[0-9a-f]{16}$/.test(asked)) actorIds = [asked];
    else {
      for (const m of members) {
        if ((await memberRef(orgId, String(m.id))) === asked) {
          actorIds = [m.login, ...(auditCryptoReady(env) ? [await principalOf(env, orgId, m.login)] : [])];
        }
      }
    }
    if (!actorIds) return json({ entries: [], response_metadata: { next_cursor: "" } });
  }
  const format = q.get("format");
  const exporting = format === "csv" || format === "jsonl";
  const out = await readAudit(env.DB, orgId, {
    oldest: q.get("oldest"), latest: q.get("latest"), action: q.get("action"), category: q.get("category"),
    severity: q.get("severity"), actorIds, cursor: q.get("cursor"),
    limit: exporting ? MAX_LIMIT : q.get("limit"),
  });
  const entries = [];
  const keys = new Map();
  for (const e of out.entries) entries.push(await presentEntry(await decryptBody(env, orgId, e, keys), orgId, ids, refs));

  // Reading the log is itself on it: once an hour per reader, every export.
  const actor = { ...person(who.user), ...(who.via.type === "api_token" ? { via: who.via } : {}) };
  if (exporting) {
    await audit(env, request, { orgId, action: "audit.exported", actor, details: { format, count: entries.length } });
  } else {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const self = auditCryptoReady(env) ? await principalOf(env, orgId, who.user.login) : who.user.login;
    const recent = await env.DB.prepare("SELECT 1 FROM audit_events WHERE org_id = ?1 AND action = 'audit.viewed' AND actor_id IN (?2, ?4) AND created_at >= ?3 LIMIT 1").bind(orgId, who.user.login, hourAgo, self).first();
    if (!recent && !q.get("cursor")) await audit(env, request, { orgId, action: "audit.viewed", actor });
  }

  if (format === "csv") {
    return new Response(toCsv(entries), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-log.csv"`, "cache-control": "no-store", ...CORS_HEADERS } });
  }
  if (format === "jsonl") {
    return new Response(entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="audit-log.jsonl"`, "cache-control": "no-store", ...CORS_HEADERS } });
  }
  return json({ entries, response_metadata: { next_cursor: out.next || "" } });
}

// ---- Phase 1 rows, moved to per-person encryption ----

/// Rewrite one workspace's phase 1 rows in the encrypted form and chain the
/// whole log again from the first row, then record where the plaintext chain
/// ended (docs/audit-log-phase2.md §2.5). One transaction: an event written
/// meanwhile takes the marker's number, the batch fails, and the next run
/// tries again. People whose accounts were deleted before this ran are
/// encrypted and their keys thrown away at once.
export async function migrateOrgAudit(env, orgId) {
  if (!auditCryptoReady(env)) return null;
  const { results } = await env.DB.prepare("SELECT seq, body, hash, enc, actor_id, entity_id FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(orgId).all();
  const rows = results || [];
  const legacy = rows.filter((r) => !r.enc);
  if (!legacy.length) return null;
  const lastLegacy = legacy[legacy.length - 1];
  const gone = new Set();
  const statements = [];
  let prev = null;
  for (const r of rows) {
    let stored = JSON.parse(r.body);
    let actorId = r.actor_id;
    let entityId = r.entity_id;
    if (!r.enc) {
      for (const p of [stored.actor, stored.entity]) {
        if (p?.type === "user" && p.id && !(await env.DB.prepare("SELECT 1 FROM users WHERE login = ?1").bind(p.id).first())) gone.add(p.id);
      }
      const hidden = await encryptBody(env, orgId, stored);
      stored = hidden.body;
      actorId = hidden.actorId;
      entityId = hidden.entityId;
    }
    const hash = await sha256Hex(`${prev || ""}\n${r.seq}\n${canonical(stored)}`);
    statements.push(env.DB.prepare(
      "UPDATE audit_events SET body = ?3, actor_id = ?4, entity_id = ?5, enc = 1, prev_hash = ?6, hash = ?7 WHERE org_id = ?1 AND seq = ?2"
    ).bind(orgId, r.seq, JSON.stringify(stored), actorId, entityId, prev, hash));
    prev = hash;
  }
  const now = Date.now();
  const marker = {
    id: `aud_${now.toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    date_create: Math.floor(now / 1000),
    action: "audit.chain_migrated",
    category: "audit",
    severity: "critical",
    outcome: "success",
    actor: { type: "system" },
    entity: null,
    context: {},
    details: { legacy_last_seq: lastLegacy.seq, legacy_last_hash: lastLegacy.hash, rows: legacy.length },
    v: 2,
  };
  const seq = rows[rows.length - 1].seq + 1;
  const hash = await sha256Hex(`${prev || ""}\n${seq}\n${canonical(marker)}`);
  statements.push(env.DB.prepare(
    `INSERT INTO audit_events (org_id, seq, id, created_at, action, category, severity, outcome, actor_type, actor_id, entity_type, entity_id, body, prev_hash, hash, enc)
     VALUES (?1, ?2, ?3, ?4, 'audit.chain_migrated', 'audit', 'critical', 'success', 'system', NULL, NULL, NULL, ?5, ?6, ?7, 1)`
  ).bind(orgId, seq, marker.id, marker.date_create, JSON.stringify(marker), prev, hash));
  try {
    await env.DB.batch(statements);
  } catch (err) {
    console.error("audit migration deferred", orgId, safe(err?.message));
    return null;
  }
  const { shredPrincipal } = await import("./auditCrypto.js");
  for (const login of gone) await shredPrincipal(env, orgId, await principalOf(env, orgId, login));
  return { orgId, rows: legacy.length, shredded: gone.size };
}

/// A few workspaces' phase 1 rows per run, from the 15-minute cron.
export async function migrateLegacyAudit(env, { orgs = 5 } = {}) {
  if (!auditCryptoReady(env)) return [];
  const { results } = await env.DB.prepare("SELECT DISTINCT org_id FROM audit_events WHERE enc = 0 LIMIT ?1").bind(orgs).all();
  const done = [];
  for (const r of results || []) {
    const out = await migrateOrgAudit(env, r.org_id).catch((err) => { console.error("audit migration failed", safe(err?.message)); return null; });
    if (out) done.push(out);
  }
  return done;
}

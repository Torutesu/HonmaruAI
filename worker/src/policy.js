// How long a sign-in lasts in a workspace, and when an admin has to prove it
// is them again (docs/admin-controls.md §3).
//
// A session belongs to a person and opens every workspace they are in, so a
// workspace's rules are applied when that workspace is entered: the same
// session keeps working in a workspace with no rules, and is refused, with
// `code: "session-policy"`, in one whose rules it has outgrown. An owner's
// actions — and, where a workspace asks, an admin's — need a sign-in from
// the last few minutes (`code: "reauth-required"`); an email code or the
// password gives one without signing out.

import { getSession, getUserByGithubId, isMember } from "./db.js";
import { audit, person } from "./audit.js";
import { allowed } from "./permissions.js";
import { sessionRef, endSessions } from "./sessions.js";
import { hashPassword, safeEqual } from "./auth.js";

/// Each rule, the range it may take, and what it is called in the API.
export const POLICY_FIELDS = {
  web_max_hours: { key: "webMaxHours", min: 1, max: 2160 },
  mobile_max_hours: { key: "mobileMaxHours", min: 1, max: 8760 },
  idle_hours: { key: "idleHours", min: 1, max: 720 },
  reauth_for_admin_minutes: { key: "reauthForAdminMinutes", min: 5, max: 1440 },
};

/// Without a rule, an owner's actions still ask for a sign-in within an hour.
export const OWNER_REAUTH_MINUTES = 60;

const HOUR = 3_600_000;
const cache = new Map(); // orgId -> { policy, at }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-session-token, x-ai-key",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    },
  });
}

/// A workspace's rules, or null when it has none. Cached for half a minute:
/// this is read on every request that enters a workspace.
export async function sessionPolicy(db, orgId) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < 30_000) return hit.policy;
  const row = await db.prepare("SELECT * FROM org_session_policy WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  const policy = row && Object.keys(POLICY_FIELDS).some((f) => row[f]) ? row : null;
  cache.set(orgId, { policy, at: Date.now() });
  return policy;
}

export function forgetPolicies() {
  cache.clear();
}

/// The rules as the API shows them.
export function presentPolicy(row) {
  const out = {};
  for (const [field, { key }] of Object.entries(POLICY_FIELDS)) out[key] = row?.[field] ?? null;
  return out;
}

const isPhone = (session) => String(session?.client || "").toLowerCase() === "ios";

/// Which rule this session breaks in this workspace, or null.
export function brokenRule(policy, session, now = Date.now()) {
  if (!policy || !session) return null;
  const created = Date.parse(session.created_at || "");
  const max = isPhone(session) ? policy.mobile_max_hours : policy.web_max_hours;
  if (max && Number.isFinite(created) && now - created > max * HOUR) return isPhone(session) ? "mobile_max_hours" : "web_max_hours";
  if (policy.idle_hours) {
    const seen = Date.parse(session.last_seen_at || session.created_at || "");
    const idle = Math.max(Number(session.longest_idle_ms) || 0, Number.isFinite(seen) ? now - seen : 0);
    if (idle > policy.idle_hours * HOUR) return "idle_hours";
  }
  return null;
}

/// When this session stops being allowed in this workspace, however it is
/// used meanwhile — for a socket that is held open rather than re-asked.
export function sessionDeadline(policy, session) {
  if (!policy || !session) return null;
  const created = Date.parse(session.created_at || "");
  const max = isPhone(session) ? policy.mobile_max_hours : policy.web_max_hours;
  return max && Number.isFinite(created) ? created + max * HOUR : null;
}

/// The refusal for a session this workspace's rules have outgrown, or null.
export async function policyDenial(env, session, orgId) {
  if (!session || !orgId) return null;
  // The workspace's single sign-on first: required of this person, or
  // an SSO sign-in past its hours.
  const { ssoDenial } = await import("./sso.js");
  const sso = await ssoDenial(env, session, orgId);
  if (sso) return sso;
  const policy = await sessionPolicy(env.DB, orgId);
  const rule = brokenRule(policy, session);
  if (!rule) return null;
  return {
    status: 401,
    body: { message: "This workspace asks you to sign in again.", code: "session-policy", orgId, rule },
  };
}

/// Membership and the workspace's rules together, as a Response to return,
/// or null when this session may go on.
export async function memberGate(env, session, orgId) {
  if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
  const held = await policyDenial(env, session, orgId);
  return held ? json(held.body, held.status) : null;
}

/// The refusal for an action that needs a recent sign-in, or null. An
/// owner's action always does; an admin's does where the workspace asks.
export async function reauthDenial(env, session, orgId, { owner = false } = {}) {
  const policy = await sessionPolicy(env.DB, orgId);
  const minutes = policy?.reauth_for_admin_minutes || (owner ? OWNER_REAUTH_MINUTES : null);
  if (!minutes) return null;
  const last = Math.max(Date.parse(session.created_at || "") || 0, Date.parse(session.reauth_at || "") || 0);
  if (Date.now() - last <= minutes * 60_000) return null;
  return {
    status: 401,
    body: { message: "Confirm it's you to do this.", code: "reauth-required", minutes },
  };
}

/// Validate and save a workspace's rules. Returns the saved row, or an error.
export async function savePolicy(db, orgId, input, updatedBy) {
  const row = {};
  for (const [field, { key, min, max }] of Object.entries(POLICY_FIELDS)) {
    const raw = input?.[key];
    if (raw === null || raw === undefined || raw === "") { row[field] = null; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${key} must be a whole number from ${min} to ${max}.` };
    row[field] = n;
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO org_session_policy (org_id, web_max_hours, mobile_max_hours, idle_hours, reauth_for_admin_minutes, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(org_id) DO UPDATE SET web_max_hours = excluded.web_max_hours, mobile_max_hours = excluded.mobile_max_hours,
       idle_hours = excluded.idle_hours, reauth_for_admin_minutes = excluded.reauth_for_admin_minutes,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(orgId, row.web_max_hours, row.mobile_max_hours, row.idle_hours, row.reauth_for_admin_minutes, String(updatedBy), now).run();
  cache.delete(orgId);
  return { row };
}

/// End, now, every session of this workspace's people that its rules have
/// outgrown. Their other workspaces lose them too: a session is one thing.
export async function applyPolicyNow(env, orgId) {
  const policy = await sessionPolicy(env.DB, orgId);
  if (!policy) return 0;
  const { results } = await env.DB.prepare(
    `SELECT s.token, s.github_id, s.created_at, s.last_seen_at, s.client, s.longest_idle_ms FROM sessions s
       JOIN memberships m ON m.user_github_id = s.github_id AND m.org_id = ?1`
  ).bind(orgId).all();
  let ended = 0;
  for (const s of results || []) {
    if (!brokenRule(policy, s)) continue;
    ended += await endSessions(env.DB, s.github_id, { refs: [await sessionRef(s.token)] });
  }
  return ended;
}

/// GET/PUT /orgs/session-policy · POST /orgs/session-policy/apply ·
/// POST /auth/reauth/start · POST /auth/reauth
export async function handlePolicy(request, env, url) {
  const path = url.pathname;
  if (!["/orgs/session-policy", "/orgs/session-policy/apply", "/auth/reauth/start", "/auth/reauth"].includes(path)) return null;
  const token = request.headers.get("x-session-token");
  const session = await getSession(env.DB, token);
  if (!session) return json({ message: "Please sign in." }, 401);
  const user = await getUserByGithubId(env.DB, session.github_id);

  // Proving it is you again, without signing out: a code to your email, or
  // your password. An account with neither signs in again instead.
  if (path === "/auth/reauth/start" && request.method === "POST") {
    const row = await env.DB.prepare("SELECT email, password_hash FROM users WHERE github_id = ?1").bind(String(session.github_id)).first();
    const { isMailConfigured } = await import("./mailer.js");
    if (row?.email && isMailConfigured(env)) {
      const { requestCode } = await import("./otp.js");
      const sent = await requestCode(env, { email: row.email, locale: user?.locale });
      if (sent.error && sent.status !== 429) return json({ message: sent.error }, sent.status || 400);
      return json({ method: "email_code", email: row.email.replace(/^(.).*(@.*)$/, "$1…$2") });
    }
    if (row?.password_hash) return json({ method: "password" });
    return json({ method: "sign_in_again" });
  }
  if (path === "/auth/reauth" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT email, password_hash, password_salt FROM users WHERE github_id = ?1").bind(String(session.github_id)).first();
    let ok = false;
    if (typeof body.code === "string" && row?.email) {
      const { consumeCode } = await import("./otp.js");
      const spent = await consumeCode(env, row.email.trim().toLowerCase(), body.code);
      if (spent.error) return json({ message: spent.error }, spent.status || 400);
      ok = true;
    } else if (typeof body.password === "string" && row?.password_hash) {
      ok = safeEqual(await hashPassword(body.password, row.password_salt), row.password_hash);
      if (!ok) return json({ message: "That password is not right." }, 400);
    }
    if (!ok) return json({ message: "Enter the code from your email, or your password." }, 400);
    await env.DB.prepare("UPDATE sessions SET reauth_at = ?2 WHERE token = ?1").bind(token, new Date().toISOString()).run();
    return json({ ok: true });
  }

  const body = request.method === "GET" ? null : await request.json().catch(() => ({}));
  const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body?.orgId;
  if (!orgId) return json({ message: "orgId is required" }, 400);
  const gate = await memberGate(env, session, orgId);
  if (gate) return gate;
  const canEdit = await allowed(env.DB, orgId, session.github_id, "session_policy.manage");

  if (path === "/orgs/session-policy" && request.method === "GET") {
    if (!(await allowed(env.DB, orgId, session.github_id, "audit.read"))) return json({ message: "Only an admin can see the login rules." }, 403);
    return json({ policy: presentPolicy(await sessionPolicy(env.DB, orgId)), canEdit, limits: Object.fromEntries(Object.values(POLICY_FIELDS).map((f) => [f.key, { min: f.min, max: f.max }])) });
  }
  if (!canEdit) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "session_policy", name: "the login rules" }, outcome: "denied" });
    return json({ message: "Only an owner can change the login rules." }, 403);
  }
  const again = await reauthDenial(env, session, orgId, { owner: true });
  if (again) return json(again.body, again.status);

  if (path === "/orgs/session-policy" && request.method === "PUT") {
    const before = presentPolicy(await sessionPolicy(env.DB, orgId));
    const saved = await savePolicy(env.DB, orgId, body, session.github_id);
    if (saved.error) return json({ message: saved.error }, 400);
    const after = presentPolicy(saved.row);
    await audit(env, request, { orgId, action: "workspace.session_policy_changed", actor: person(user), details: { before, after } });
    return json({ policy: after, canEdit: true });
  }
  if (path === "/orgs/session-policy/apply" && request.method === "POST") {
    const ended = await applyPolicyNow(env, orgId);
    await audit(env, request, { orgId, action: "workspace.session_policy_applied", actor: person(user), details: { ended } });
    return json({ ended });
  }
  return json({ message: "not found" }, 404);
}

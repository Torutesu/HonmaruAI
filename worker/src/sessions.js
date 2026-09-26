// Where you are signed in: every session of yours — which app or browser,
// from where, last used when — and signing any of them out, or all of them.
// An admin can sign a member out everywhere, as Slack's admins can.
//
// A session is named to a client by a reference (a hash of its token cut
// short), never by the token: the list is read in a browser, and a token in
// it would be a way in.

import { getSession, isMember, getUserByGithubId } from "./db.js";
import { ROLE_RANK, sha256Hex } from "./auth.js";
import { audit, auditEverywhere, clientOf, person } from "./audit.js";
import { listMembers } from "./team.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, x-client, authorization",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS_HEADERS } });
}

export const sessionRef = async (token) => (await sha256Hex(`session\u0000${token}`)).slice(0, 16);

/// What a request says about the device it came from.
export function sessionMeta(request) {
  const h = request?.headers;
  if (!h) return {};
  const ua = String(h.get("user-agent") || "").slice(0, 300) || null;
  const cf = request.cf || {};
  const place = [cf.city, cf.country || h.get("cf-ipcountry")].filter(Boolean).join(", ") || null;
  return { client: clientOf(h.get("x-client"), ua), userAgent: ua, place };
}

/// A user agent's browser and system, each a proper name ("Chrome",
/// "macOS"), so a client can say them in its own language.
export function deviceParts(ua, client) {
  const u = String(ua || "");
  if (client === "ios") return { app: /iPad/.test(u) ? "ipad" : "iphone", browser: null, os: /iPad/.test(u) ? "iPad" : "iPhone" };
  const browser = /Edg\//.test(u) ? "Edge"
    : /OPR\/|Opera/.test(u) ? "Opera"
      : /Firefox\//.test(u) ? "Firefox"
        : /Chrome\//.test(u) ? "Chrome"
          : /Safari\//.test(u) ? "Safari" : null;
  const os = /iPhone/.test(u) ? "iPhone"
    : /iPad/.test(u) ? "iPad"
      : /Android/.test(u) ? "Android"
        : /Mac OS X|Macintosh/.test(u) ? "macOS"
          : /Windows/.test(u) ? "Windows"
            : /CrOS/.test(u) ? "ChromeOS"
              : /Linux/.test(u) ? "Linux" : null;
  return { app: null, browser, os };
}

/// A user agent, as a person reads it: "Chrome on macOS", "iPhone app".
export function describeDevice(ua, client) {
  const u = String(ua || "");
  if (client === "ios") return /iPad/.test(u) ? "iPad app" : "iPhone app";
  const browser = /Edg\//.test(u) ? "Edge"
    : /OPR\/|Opera/.test(u) ? "Opera"
      : /Firefox\//.test(u) ? "Firefox"
        : /Chrome\//.test(u) ? "Chrome"
          : /Safari\//.test(u) ? "Safari" : null;
  const os = /iPhone/.test(u) ? "iPhone"
    : /iPad/.test(u) ? "iPad"
      : /Android/.test(u) ? "Android"
        : /Mac OS X|Macintosh/.test(u) ? "macOS"
          : /Windows/.test(u) ? "Windows"
            : /CrOS/.test(u) ? "ChromeOS"
              : /Linux/.test(u) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown device";
}

/// After a sign-in: the device written on the session, and the sign-in on
/// the audit log of every workspace the person is in.
export async function signedIn(env, request, token, githubId, method) {
  if (!token) return;
  const meta = sessionMeta(request);
  await env.DB.prepare("UPDATE sessions SET client = ?1, user_agent = ?2, place = ?3, last_seen_at = ?4, auth_method = ?6 WHERE token = ?5")
    .bind(meta.client || null, meta.userAgent || null, meta.place || null, new Date().toISOString(), token, method || null).run().catch(() => {});
  const user = await getUserByGithubId(env.DB, String(githubId)).catch(() => null);
  await auditEverywhere(env, request, githubId, { action: "auth.login", actor: person(user), details: { method } });
}

/// Every live session of one account, the one asking first.
export async function sessionsOf(db, githubId, currentToken = null) {
  const { results } = await db.prepare(
    `SELECT token, client, user_agent, place, created_at, last_seen_at FROM sessions
      WHERE github_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)
      ORDER BY COALESCE(last_seen_at, created_at) DESC`
  ).bind(String(githubId), new Date().toISOString()).all();
  const out = [];
  for (const r of results || []) {
    out.push({
      ref: await sessionRef(r.token),
      client: r.client || clientOf(null, r.user_agent) || null,
      device: describeDevice(r.user_agent, r.client),
      ...deviceParts(r.user_agent, r.client),
      place: r.place || null,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at || r.created_at,
      current: r.token === currentToken,
    });
  }
  out.sort((a, b) => Number(b.current) - Number(a.current));
  return out;
}

/// Sign out sessions of one account: the ones named, or all of them but
/// (when given) the one to keep. Returns how many went.
export async function endSessions(db, githubId, { refs = null, keep = null } = {}) {
  const { results } = await db.prepare("SELECT token FROM sessions WHERE github_id = ?1").bind(String(githubId)).all();
  const gone = [];
  for (const r of results || []) {
    if (keep && r.token === keep) continue;
    if (refs && !refs.includes(await sessionRef(r.token))) continue;
    gone.push(r.token);
  }
  if (!gone.length) return 0;
  await db.batch(gone.map((t) => db.prepare("DELETE FROM sessions WHERE token = ?1").bind(t)));
  // Their pushes stop with them: a browser signed out is no longer theirs.
  return gone.length;
}

async function roleIn(db, orgId, githubId) {
  const row = await db.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, String(githubId)).first();
  return String(row?.role || "member").toLowerCase();
}
const rank = (role) => ROLE_RANK.get(role) ?? 0;

/// GET /sessions · DELETE /sessions · POST /auth/logout ·
/// GET /members/sessions · DELETE /members/sessions (an admin, for a member)
export async function handleSessions(request, env, url) {
  const path = url.pathname;
  if (!["/sessions", "/auth/logout", "/members/sessions"].includes(path)) return null;
  const token = request.headers.get("x-session-token");
  const session = await getSession(env.DB, token);
  if (!session) return json({ message: "Please sign in." }, 401);
  const user = await getUserByGithubId(env.DB, session.github_id);

  if (path === "/auth/logout" && request.method === "POST") {
    await endSessions(env.DB, session.github_id, { refs: [await sessionRef(token)] });
    await auditEverywhere(env, request, session.github_id, { action: "auth.logout", actor: person(user) });
    return json({ ok: true });
  }

  if (path === "/sessions" && request.method === "GET") {
    return json({ sessions: await sessionsOf(env.DB, session.github_id, token) });
  }

  if (path === "/sessions" && request.method === "DELETE") {
    const body = await request.json().catch(() => ({}));
    const refs = typeof body.ref === "string" ? [body.ref] : null;
    if (!refs && body.others !== true) return json({ message: "Say which session, or all the others." }, 400);
    const ended = await endSessions(env.DB, session.github_id, refs ? { refs, keep: token } : { keep: token });
    if (ended) await auditEverywhere(env, request, session.github_id, { action: "auth.session_revoked", actor: person(user), entity: person(user), details: { count: ended, others: !refs } });
    return json({ ended, sessions: await sessionsOf(env.DB, session.github_id, token) });
  }

  // An admin, for someone in their workspace.
  if (path === "/members/sessions") {
    const body = request.method === "DELETE" ? await request.json().catch(() => ({})) : {};
    const orgId = request.method === "GET" ? url.searchParams.get("orgId") : body.orgId;
    const ref = request.method === "GET" ? url.searchParams.get("ref") : body.ref;
    if (!orgId || !ref) return json({ message: "orgId and ref are required" }, 400);
    if (!(await isMember(env.DB, orgId, session.github_id))) return json({ message: "not a member of this org" }, 403);
    { const { policyDenial } = await import("./policy.js"); const held = await policyDenial(env, session, orgId); if (held) return json(held.body, held.status); }
    const members = await listMembers(env.DB, orgId, session.github_id);
    const target = members.find((m) => m.ref === ref);
    if (!target) return json({ message: "That person is not in this workspace." }, 404);
    const mine = await roleIn(env.DB, orgId, session.github_id);
    const self = target.userId === String(session.github_id);
    if (!self && (rank(mine) < rank("admin") || rank(mine) <= rank(target.role))) {
      await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "member_sessions", name: "a member's sessions" }, outcome: "denied" });
      return json({ message: "Only an admin can see or end someone else's sessions." }, 403);
    }
    if (request.method === "GET") {
      const list = await sessionsOf(env.DB, target.userId, token);
      return json({ sessions: list.map(({ ref: r, ...s }) => ({ ...s })) });
    }
    if (request.method === "DELETE") {
      if (!self) {
        const { reauthDenial } = await import("./policy.js");
        const again = await reauthDenial(env, session, orgId, { owner: mine === "owner" });
        if (again) return json(again.body, again.status);
      }
      const ended = await endSessions(env.DB, target.userId, self ? { keep: token } : {});
      await audit(env, request, { orgId, action: "auth.session_revoked", actor: person(user), entity: { type: "user", id: target.login, name: target.name }, details: { count: ended, everywhere: true } });
      return json({ ended });
    }
  }
  return json({ message: "not found" }, 404);
}

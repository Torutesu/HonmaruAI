// The admin API, v1: what a workspace key (orgKeys.js) opens.
//
// docs/admin-controls.md §2.4. Stable paths under /admin/v1/, JSON in and
// out, errors as { error: { code, message } }, pages by cursor, and an
// Idempotency-Key header that gives the same answer for 24 hours. People by
// member ref; email addresses are returned to `members:read`, because an HR
// system has to match on them. Nothing here reads a message, and nothing here
// makes, unmakes or removes an owner.

import { getUserByGithubId, upsertBusiness, businessSlug } from "./db.js";
import { audit } from "./audit.js";
import { listMembers, removeMember, changeRole, inviteRef, memberRef } from "./team.js";
import { endSessions } from "./sessions.js";
import { enforceSubject } from "./ratelimit.js";
import { resolveOrgKey, keyActor, actingOwner, apiError } from "./orgKeys.js";
import openapi from "../../docs/admin-api.openapi.json";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, idempotency-key",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS } });
}

const IDEMPOTENT_HOURS = 24;
const pageOf = (items, cursor, limit) => {
  const start = Math.max(0, parseInt(cursor ? atob(cursor) : "0", 10) || 0);
  const size = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
  const page = items.slice(start, start + size);
  return { data: page, next_cursor: start + size < items.length ? btoa(String(start + size)) : null };
};

async function emailsOf(db, ids) {
  const out = new Map();
  for (const id of ids) {
    const row = await db.prepare("SELECT email FROM users WHERE github_id = ?1").bind(id).first().catch(() => null);
    out.set(id, row?.email || null);
  }
  return out;
}

function presentMember(m, email) {
  return { ref: m.ref, name: m.name, email: email || null, role: m.role, joined_at: m.joinedAt, joined_via: m.joinedVia || null, ...(m.channels ? { channels: m.channels } : {}) };
}

/// One call. Returns a Response.
async function route(request, env, url, key) {
  const path = url.pathname.replace(/^\/admin\/v1/, "") || "/";
  const orgId = key.orgId;
  const need = (scope) => (key.scopes.includes(scope) ? null : apiError(403, "insufficient_scope", `This key needs the ${scope} scope.`));
  const actor = keyActor(key);
  // A body where there is one; an empty one is {} (sign-out needs none).
  let body = null;
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const raw = await request.text().catch(() => "");
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "invalid_json", "The body must be a JSON object.");
  }
  const members = async () => listMembers(env.DB, orgId, null);
  const byRef = async (ref) => (await members()).find((m) => m.ref === ref) || null;

  // ---- Members ----
  if (path === "/members" && request.method === "GET") {
    const denied = need("members:read");
    if (denied) return denied;
    const all = await members();
    const emails = await emailsOf(env.DB, all.map((m) => m.userId));
    const page = pageOf(all, url.searchParams.get("cursor"), url.searchParams.get("limit"));
    return json({ data: page.data.map((m) => presentMember(m, emails.get(m.userId))), next_cursor: page.next_cursor });
  }
  const memberMatch = path.match(/^\/members\/([^/]+)(\/sign-out)?$/);
  if (memberMatch) {
    const target = await byRef(decodeURIComponent(memberMatch[1]));
    if (!target) return apiError(404, "not_found", "No such member.");
    const entity = { type: "user", id: target.login, name: target.name };
    if (request.method === "GET" && !memberMatch[2]) {
      const denied = need("members:read");
      if (denied) return denied;
      return json({ data: presentMember(target, (await emailsOf(env.DB, [target.userId])).get(target.userId)) });
    }
    const denied = need("members:write");
    if (denied) return denied;
    if (target.role === "owner") return apiError(403, "owner_protected", "A workspace key cannot change or remove an owner.");
    if (memberMatch[2] && request.method === "POST") {
      const ended = await endSessions(env.DB, target.userId);
      await audit(env, request, { orgId, action: "auth.session_revoked", actor, entity, details: { count: ended, everywhere: true } });
      return json({ data: { ended } });
    }
    if (request.method === "PATCH") {
      if (body.role === "owner") return apiError(403, "owner_protected", "A workspace key cannot make an owner.");
      const owner = await actingOwner(env.DB, key);
      if (!owner) return apiError(409, "no_owner", "This workspace has no owner to act for.");
      const out = await changeRole(env, { orgId, actorId: owner, ref: target.ref, role: body.role, channels: body.channels });
      if (out.error) return apiError(out.status || 400, "invalid_request", out.error);
      if (out.from !== out.to) await audit(env, request, { orgId, action: "member.role_changed", actor, entity, details: { from: out.from, to: out.to } });
      if (out.channels) await audit(env, request, { orgId, action: "member.channels_changed", actor, entity, details: { channels: out.channels } });
      const { evictMember } = await import("./announce.js");
      if (out.from !== out.to) await evictMember(env, orgId, target.login).catch(() => {});
      return json({ data: presentMember({ ...target, role: out.to, channels: out.channels || target.channels }, null) });
    }
    if (request.method === "DELETE" && !memberMatch[2]) {
      const owner = await actingOwner(env.DB, key);
      if (!owner) return apiError(409, "no_owner", "This workspace has no owner to act for.");
      const out = await removeMember(env, { orgId, actorId: owner, targetId: target.userId });
      if (out.error) return apiError(out.status || 400, "invalid_request", out.error);
      const ended = await endSessions(env.DB, target.userId);
      const { evictMember } = await import("./announce.js");
      await evictMember(env, orgId, target.login).catch(() => {});
      await audit(env, request, { orgId, action: "member.removed", actor, entity, details: { sessions_ended: ended } });
      return json({ data: { removed: target.ref } });
    }
    return apiError(405, "method_not_allowed", "That method is not allowed here.");
  }

  // ---- Invitations ----
  if (path === "/invites" && request.method === "POST") {
    const denied = need("members:write");
    if (denied) return denied;
    const role = String(body.role || "member").toLowerCase();
    if (role === "owner") return apiError(403, "owner_protected", "A workspace key cannot invite an owner.");
    const owner = await actingOwner(env.DB, key);
    if (!owner) return apiError(409, "no_owner", "This workspace has no owner to act for.");
    const { createInvite } = await import("./auth.js");
    const minted = await createInvite(env, { orgId, createdBy: owner, role, uses: body.uses || (body.email ? 1 : undefined), channels: body.channels });
    if (minted.error) return apiError(400, "invalid_request", minted.error);
    await audit(env, request, { orgId, action: "invite.created", actor, entity: { type: "invite", id: minted.ref, name: minted.role }, details: { role: minted.role, maxUses: minted.maxUses, expiresAt: minted.expiresAt, channels: minted.channels } });
    let emailed = false;
    if (typeof body.email === "string" && body.email.includes("@")) {
      const { sendMail, isMailConfigured } = await import("./mailer.js");
      if (isMailConfigured(env)) {
        const name = (await env.DB.prepare("SELECT name FROM orgs WHERE id = ?1").bind(orgId).first().catch(() => null))?.name || "a workspace";
        const sent = await sendMail(env, { to: body.email.trim(), subject: `You're invited to ${name} on Honmaru`, text: `You're invited to join ${name} on Honmaru.\n\n${minted.link}\n\nThe link works for a few days.` });
        emailed = Boolean(sent?.ok);
        if (emailed) await audit(env, request, { orgId, action: "invite.email_sent", actor, entity: { type: "invite", id: minted.ref, name: minted.role }, details: { role: minted.role, domain: body.email.split("@")[1] } });
      }
    }
    return json({ data: { ref: minted.ref, code: minted.code, link: minted.link, role: minted.role, expires_at: minted.expiresAt, max_uses: minted.maxUses, emailed } }, 201);
  }
  const inviteMatch = path.match(/^\/invites\/([^/]+)$/);
  if (inviteMatch && request.method === "DELETE") {
    const denied = need("members:write");
    if (denied) return denied;
    const ref = decodeURIComponent(inviteMatch[1]);
    const { results } = await env.DB.prepare("SELECT code, ref FROM invites WHERE org_id = ?1").bind(orgId).all();
    let code = null;
    for (const r of results || []) if ((r.ref || await inviteRef(r.code)) === ref) code = r.code;
    if (!code) return apiError(404, "not_found", "No such invitation.");
    await env.DB.prepare("DELETE FROM invites WHERE org_id = ?1 AND code = ?2").bind(orgId, code).run();
    await audit(env, request, { orgId, action: "invite.revoked", actor, entity: { type: "invite", id: ref } });
    return json({ data: { revoked: ref } });
  }

  // ---- Channels ----
  const channelList = async () => {
    const { results } = await env.DB.prepare(
      `SELECT b.slug, b.name, b.private, b.created_at, b.archived_at,
              (SELECT COUNT(*) FROM conversation_members c WHERE c.org_id = b.org_id AND c.channel = 'b:' || b.slug) AS members
         FROM businesses b WHERE b.org_id = ?1 ORDER BY b.created_at`
    ).bind(orgId).all();
    return (results || []).map((r) => ({ slug: r.slug, name: r.name, private: Boolean(r.private), archived: Boolean(r.archived_at), created_at: r.created_at, ...(r.private ? { members: r.members } : {}) }));
  };
  if (path === "/channels" && request.method === "GET") {
    const denied = need("channels:read");
    if (denied) return denied;
    const page = pageOf(await channelList(), url.searchParams.get("cursor"), url.searchParams.get("limit"));
    return json({ data: page.data, next_cursor: page.next_cursor });
  }
  if (path === "/channels" && request.method === "POST") {
    const denied = need("channels:write");
    if (denied) return denied;
    const slug = businessSlug(body.name);
    if (!slug) return apiError(400, "invalid_request", "Give the channel a name.");
    if (await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug).first()) {
      return apiError(409, "exists", "A channel by that name already exists.");
    }
    const owner = await actingOwner(env.DB, key);
    const made = await upsertBusiness(env.DB, orgId, { name: body.name, createdBy: owner });
    if (body.private) await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = ?2").bind(orgId, made.slug).run();
    const added = await changeChannelMembers(env, orgId, made.slug, { add: body.members || [] }, owner);
    await audit(env, request, { orgId, action: "channel.created", actor, entity: { type: "channel", id: made.slug, name: `#${made.name}` }, details: { private: Boolean(body.private), members: added.added } });
    return json({ data: (await channelList()).find((c) => c.slug === made.slug) }, 201);
  }
  const channelMatch = path.match(/^\/channels\/([^/]+)(\/members)?$/);
  if (channelMatch) {
    const denied = need("channels:write");
    if (denied) return denied;
    const slug = decodeURIComponent(channelMatch[1]);
    const row = await env.DB.prepare("SELECT slug, name, private FROM businesses WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug).first();
    if (!row) return apiError(404, "not_found", "No such channel.");
    const entity = { type: "channel", id: slug, name: `#${row.name}` };
    if (channelMatch[2] && request.method === "PUT") {
      if (!row.private) return apiError(400, "invalid_request", "Only a private channel has members to add or remove.");
      const out = await changeChannelMembers(env, orgId, slug, body, await actingOwner(env.DB, key));
      if (out.error) return apiError(400, "invalid_request", out.error);
      for (const m of out.addedPeople) await audit(env, request, { orgId, action: "channel.member_added", actor, entity: { type: "user", id: m.login, name: m.name }, details: { channel: entity.name } });
      for (const m of out.removedPeople) await audit(env, request, { orgId, action: "channel.member_removed", actor, entity: { type: "user", id: m.login, name: m.name }, details: { channel: entity.name, left: false } });
      return json({ data: { added: out.added, removed: out.removed } });
    }
    if (!channelMatch[2] && request.method === "PATCH") {
      const details = {};
      if (typeof body.name === "string" && body.name.trim()) {
        await env.DB.prepare("UPDATE businesses SET name = ?3 WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug, body.name.trim().slice(0, 120)).run();
        details.name = body.name.trim().slice(0, 120);
      }
      if (typeof body.archived === "boolean") {
        await env.DB.prepare("UPDATE businesses SET archived_at = ?3 WHERE org_id = ?1 AND slug = ?2").bind(orgId, slug, body.archived ? new Date().toISOString() : null).run();
        details.archived = body.archived;
      }
      if (!Object.keys(details).length) return apiError(400, "invalid_request", "Nothing to change.");
      await audit(env, request, { orgId, action: "channel.updated", actor, entity, details });
      return json({ data: (await channelList()).find((c) => c.slug === slug) });
    }
    return apiError(405, "method_not_allowed", "That method is not allowed here.");
  }

  // ---- The audit log ----
  if (path === "/audit/logs" && request.method === "GET") {
    const denied = need("audit:read");
    if (denied) return denied;
    const { readAudit, presentEntry } = await import("./audit.js");
    const { decryptBody } = await import("./auditCrypto.js");
    const q = url.searchParams;
    const out = await readAudit(env.DB, orgId, { oldest: q.get("oldest"), latest: q.get("latest"), action: q.get("action"), category: q.get("category"), severity: q.get("severity"), cursor: q.get("cursor"), limit: q.get("limit") });
    const all = await members();
    const ids = new Map(all.map((m) => [m.login, m.userId]));
    const refs = new Map();
    const keys = new Map();
    const entries = [];
    for (const e of out.entries) entries.push(await presentEntry(await decryptBody(env, orgId, e, keys), orgId, ids, refs));
    await audit(env, request, { orgId, action: "audit.exported", actor, details: { format: "api", count: entries.length } });
    return json({ data: entries, next_cursor: out.next || null });
  }
  return apiError(404, "not_found", "No such endpoint.");
}

/// Add people to, and take them out of, a private channel: by member ref or
/// email address.
async function changeChannelMembers(env, orgId, slug, { add = [], remove = [] } = {}, addedBy) {
  const { addMembers, removeMember: leave, membersOf } = await import("./access.js");
  const all = await listMembers(env.DB, orgId, null);
  const emails = await emailsOf(env.DB, all.map((m) => m.userId));
  const find = (who) => all.find((m) => m.ref === who || (typeof who === "string" && who.includes("@") && (emails.get(m.userId) || "").toLowerCase() === who.toLowerCase()));
  const key = `b:${slug}`;
  const inside = new Set(await membersOf(env.DB, orgId, key));
  const adding = (Array.isArray(add) ? add : []).map(find).filter((m) => m && !inside.has(m.login));
  const removing = (Array.isArray(remove) ? remove : []).map(find).filter((m) => m && inside.has(m.login));
  const by = addedBy ? (await getUserByGithubId(env.DB, addedBy).catch(() => null))?.login || null : null;
  if (adding.length) await addMembers(env.DB, { orgId, key, logins: adding.map((m) => m.login), addedBy: by });
  for (const m of removing) await leave(env.DB, { orgId, key, login: m.login });
  return { added: adding.map((m) => m.ref), removed: removing.map((m) => m.ref), addedPeople: adding, removedPeople: removing };
}

/// Everything under /admin/v1/.
export async function handleAdminApi(request, env, url) {
  if (!url.pathname.startsWith("/admin/v1/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // The API described, for whoever is wiring it up: no key needed.
  if (url.pathname === "/admin/v1/openapi.json" && request.method === "GET") return json(openapi);
  const resolved = await resolveOrgKey(env, request);
  if (!resolved.key) {
    if (resolved.refused === "ip" && resolved.row) {
      await audit(env, request, { orgId: resolved.row.org_id, action: "security.permission_denied", actor: { type: "api_key", id: resolved.row.prefix, name: resolved.row.name }, entity: { type: "resource", id: "admin_api", name: "the admin API from an address the key does not allow" }, outcome: "denied" });
      return apiError(403, "ip_not_allowed", "This key may not be used from this address.");
    }
    return apiError(401, resolved.refused === "expired" ? "key_expired" : "invalid_key", resolved.refused === "expired" ? "This key has expired." : "Send a workspace key as Authorization: Bearer hmo_….");
  }
  const key = resolved.key;
  const limited = await enforceSubject(env, "admin-api", `k:${key.id}`);
  if (limited) return apiError(429, "rate_limited", "Too many requests for this key. Try again in a minute.");
  if (key.newIp) {
    await audit(env, request, { orgId: key.orgId, action: "org_key.used_from_new_ip", actor: keyActor(key) });
  }
  // The same answer to the same Idempotency-Key, for a day.
  const idem = request.method !== "GET" ? String(request.headers.get("idempotency-key") || "").slice(0, 200) : "";
  if (idem) {
    const since = new Date(Date.now() - IDEMPOTENT_HOURS * 3_600_000).toISOString();
    const seen = await env.DB.prepare("SELECT status, body FROM admin_idempotency WHERE key_id = ?1 AND idem_key = ?2 AND created_at > ?3")
      .bind(key.id, idem, since).first().catch(() => null);
    if (seen) return new Response(seen.body, { status: seen.status, headers: { "cache-control": "no-store", "content-type": "application/json", "idempotent-replayed": "true", ...CORS } });
  }
  const res = await route(request, env, url, key);
  if (idem && res.status < 500) {
    const text = await res.clone().text();
    await env.DB.prepare(
      `INSERT INTO admin_idempotency (key_id, idem_key, status, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key_id, idem_key) DO NOTHING`
    ).bind(key.id, idem, res.status, text, new Date().toISOString()).run().catch(() => {});
  }
  return res;
}

export { memberRef };

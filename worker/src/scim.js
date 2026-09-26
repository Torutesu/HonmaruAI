// SCIM 2.0: the company's identity provider keeping the member list.
//
// docs/sso-and-domain-join.md §11. Okta, Entra ID and the rest send people
// and groups here with a workspace key that has the `scim:write` scope
// (orgKeys.js). A person made active joins the workspace; made inactive,
// they leave it and every session they have ends, at once. Groups become
// user groups (`@sales`). Only addresses at one of the workspace's verified
// domains are taken: a provider speaks for its own company's people, not for
// anyone's. And, as with the admin API, provisioning never touches an owner.

import { getUserByGithubId, upsertUser, upsertMembership } from "./db.js";
import { audit } from "./audit.js";
import { sha256Hex } from "./auth.js";
import { removeMember } from "./team.js";
import { endSessions } from "./sessions.js";
import { enforceSubject } from "./ratelimit.js";
import { resolveOrgKey, keyActor, actingOwner } from "./orgKeys.js";
import { domainOf, domainMatches } from "./domains.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

function scim(body, status = 200, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/scim+json", ...extra } });
}
function scimError(status, detail, scimType) {
  return scim({ schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
}

const fold = (s) => String(s || "").trim().toLowerCase();
const newId = () => crypto.randomUUID();

// ---- What the provider sends ----

/// The address a SCIM user is: the primary email, else the userName when it
/// is one.
function emailOf(body) {
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const primary = emails.find((e) => e && e.primary && e.value) || emails.find((e) => e && e.value);
  const candidate = fold(primary?.value || body.userName);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate : null;
}
function nameOf(body) {
  if (typeof body.displayName === "string" && body.displayName.trim()) return body.displayName.trim().slice(0, 120);
  const n = body.name || {};
  const joined = [n.givenName, n.familyName].filter(Boolean).join(" ").trim() || (typeof n.formatted === "string" ? n.formatted.trim() : "");
  return joined ? joined.slice(0, 120) : null;
}
function activeOf(value) {
  if (typeof value === "string") return value.toLowerCase() !== "false";
  return value !== false;
}

/// `attr eq "value"`, the one filter every provider sends before it creates
/// someone. Anything else is refused rather than guessed at.
function parseFilter(text) {
  if (!text) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(text);
  if (!m) return { invalid: true };
  return { attr: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, "$1") };
}

function listResponse(items, startIndex, count) {
  const start = Math.max(1, parseInt(startIndex, 10) || 1);
  const size = count === null || count === undefined || count === "" ? 100 : Math.max(0, Math.min(200, parseInt(count, 10) || 0));
  const page = items.slice(start - 1, start - 1 + size);
  return scim({ schemas: [LIST], totalResults: items.length, startIndex: start, itemsPerPage: page.length, Resources: page });
}

// ---- Users ----

async function verifiedDomains(db, orgId) {
  const { results } = await db.prepare("SELECT domain FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL").bind(orgId).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => r.domain);
}

async function presentUser(env, base, row) {
  const user = await getUserByGithubId(env.DB, row.user_github_id).catch(() => null);
  const name = user?.name || row.display_name || row.user_name;
  return {
    schemas: [USER],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    displayName: name,
    name: { formatted: name },
    emails: [{ value: row.user_name, primary: true, type: "work" }],
    active: Boolean(row.active),
    meta: { resourceType: "User", created: row.created_at, lastModified: row.updated_at, location: `${base}/Users/${row.id}` },
  };
}

/// The account an address is: someone already here with it, or a new one.
/// The domain is the workspace's own, so the address is the company's to
/// speak for — the same rule single sign-on links accounts by.
async function accountFor(env, orgId, email, name) {
  const existing = await env.DB.prepare("SELECT github_id FROM users WHERE email = ?1").bind(email).first();
  if (existing) return { githubId: String(existing.github_id), created: false };
  const githubId = `scim:${orgId}:${(await sha256Hex(`scim\u0000${orgId}\u0000${email}`)).slice(0, 24)}`;
  await upsertUser(env.DB, { githubId, login: `u:${email}`, name: name || email.split("@")[0], avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind(githubId, email).run();
  return { githubId, created: true };
}

/// In the workspace, or out of it. Out means every session ends now and the
/// socket closes, not at the next sign-in.
async function setActive(env, request, key, row, active) {
  const orgId = key.orgId;
  const actor = keyActor(key);
  const user = await getUserByGithubId(env.DB, row.user_github_id).catch(() => null);
  const entity = { type: "user", id: user?.login || row.user_github_id, name: user?.name || row.user_name };
  const member = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, row.user_github_id).first();
  if (active) {
    if (!member) {
      await upsertMembership(env.DB, orgId, row.user_github_id, "member", "scim");
      await audit(env, request, { orgId, action: "scim.user_activated", actor, entity });
    }
    return null;
  }
  if (!member) return null;
  if (member.role === "owner") {
    await audit(env, request, { orgId, action: "security.permission_denied", actor, entity: { type: "resource", id: "scim", name: "deactivating an owner by provisioning" }, outcome: "denied" });
    return scimError(403, "An owner cannot be deactivated by provisioning. Make someone else the owner in Honmaru first.");
  }
  const owner = await actingOwner(env.DB, key);
  if (!owner) return scimError(409, "This workspace has no owner to act for.");
  const out = await removeMember(env, { orgId, actorId: owner, targetId: row.user_github_id });
  if (out.error && out.status !== 404) return scimError(out.status || 400, out.error);
  const ended = await endSessions(env.DB, row.user_github_id);
  if (user?.login) {
    const { evictMember } = await import("./announce.js");
    await evictMember(env, orgId, user.login).catch(() => {});
  }
  await audit(env, request, { orgId, action: "scim.user_deactivated", actor, entity, details: { sessions_ended: ended } });
  return null;
}

async function userRows(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM scim_users WHERE org_id = ?1 ORDER BY created_at, id").bind(orgId).all();
  return results || [];
}
async function userRow(db, orgId, id) {
  return db.prepare("SELECT * FROM scim_users WHERE org_id = ?1 AND id = ?2").bind(orgId, id).first();
}

/// Apply a PATCH's operations to a user: `active`, the name, `externalId`.
/// Providers send both `{path: "active", value: false}` and
/// `{value: {active: false}}`; both are read.
function patchedUser(ops) {
  const out = {};
  for (const op of ops) {
    const kind = fold(op?.op);
    if (!["replace", "add"].includes(kind)) continue;
    const path = fold(op.path);
    const fields = path ? { [path]: op.value } : (op.value && typeof op.value === "object" ? Object.fromEntries(Object.entries(op.value).map(([k, v]) => [fold(k), v])) : {});
    if ("active" in fields) out.active = activeOf(fields.active);
    if ("displayname" in fields) out.displayName = fields.displayname;
    if ("name.givenname" in fields || "name.familyname" in fields) out.name = { givenName: fields["name.givenname"], familyName: fields["name.familyname"] };
    if ("name" in fields && typeof fields.name === "object") out.name = fields.name;
    if ("externalid" in fields) out.externalId = fields.externalid;
  }
  return out;
}

async function users(request, env, url, key, base, rest, body) {
  const orgId = key.orgId;
  const actor = keyActor(key);
  if (!rest && request.method === "GET") {
    const filter = parseFilter(url.searchParams.get("filter"));
    if (filter?.invalid) return scimError(400, "Only `attribute eq \"value\"` filters are supported.", "invalidFilter");
    let rows = await userRows(env.DB, orgId);
    if (filter) {
      if (["username", "emails.value", "emails"].includes(filter.attr)) rows = rows.filter((r) => r.user_name === fold(filter.value));
      else if (filter.attr === "externalid") rows = rows.filter((r) => r.external_id === filter.value);
      else if (filter.attr === "id") rows = rows.filter((r) => r.id === filter.value);
      else return scimError(400, `Filtering by ${filter.attr} is not supported.`, "invalidFilter");
    }
    const all = [];
    for (const r of rows) all.push(await presentUser(env, base, r));
    return listResponse(all, url.searchParams.get("startIndex"), url.searchParams.get("count"));
  }
  if (!rest && request.method === "POST") {
    const email = emailOf(body);
    if (!email) return scimError(400, "userName, or a primary email, must be an email address.", "invalidValue");
    const domains = await verifiedDomains(env.DB, orgId);
    if (!domains.some((d) => domainMatches(domainOf(email), d))) {
      return scimError(400, `${domainOf(email)} is not one of this workspace's verified domains. Verify it under Domains & SSO first.`, "invalidValue");
    }
    if (await env.DB.prepare("SELECT 1 FROM scim_users WHERE org_id = ?1 AND user_name = ?2").bind(orgId, email).first()) {
      return scimError(409, "That user is already provisioned.", "uniqueness");
    }
    const name = nameOf(body);
    const account = await accountFor(env, orgId, email, name);
    if (await env.DB.prepare("SELECT 1 FROM scim_users WHERE org_id = ?1 AND user_github_id = ?2").bind(orgId, account.githubId).first()) {
      return scimError(409, "That person is already provisioned under another userName.", "uniqueness");
    }
    const now = new Date().toISOString();
    const row = { org_id: orgId, id: newId(), user_github_id: account.githubId, user_name: email, external_id: body.externalId ? String(body.externalId).slice(0, 200) : null, display_name: name, active: activeOf(body.active) ? 1 : 0, created_at: now, updated_at: now };
    await env.DB.prepare(
      `INSERT INTO scim_users (org_id, id, user_github_id, user_name, external_id, display_name, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(row.org_id, row.id, row.user_github_id, row.user_name, row.external_id, row.display_name, row.active, row.created_at, row.updated_at).run();
    const user = await getUserByGithubId(env.DB, account.githubId).catch(() => null);
    await audit(env, request, { orgId, action: "scim.user_provisioned", actor, entity: { type: "user", id: user?.login || account.githubId, name: user?.name || email }, details: { domain: domainOf(email), new_account: account.created, active: Boolean(row.active) } });
    if (row.active) {
      const refused = await setActive(env, request, key, row, true);
      if (refused) return refused;
    }
    return scim(await presentUser(env, base, row), 201, { location: `${base}/Users/${row.id}` });
  }
  if (!rest) return scimError(405, "That method is not allowed here.");

  const row = await userRow(env.DB, orgId, rest);
  if (!row) return scimError(404, "No such user.");
  if (request.method === "GET") return scim(await presentUser(env, base, row));
  if (request.method === "DELETE") {
    const refused = await setActive(env, request, key, row, false);
    if (refused) return refused;
    await env.DB.prepare("DELETE FROM scim_users WHERE org_id = ?1 AND id = ?2").bind(orgId, row.id).run();
    await audit(env, request, { orgId, action: "scim.user_deleted", actor, entity: { type: "user", id: row.user_github_id, name: row.user_name } });
    return scim(null, 204);
  }
  let change;
  if (request.method === "PUT") change = { active: activeOf(body.active), displayName: body.displayName, name: body.name, externalId: body.externalId };
  else if (request.method === "PATCH") {
    if (!Array.isArray(body.Operations)) return scimError(400, "A PATCH needs Operations.", "invalidSyntax");
    change = patchedUser(body.Operations);
  } else return scimError(405, "That method is not allowed here.");

  const name = nameOf({ displayName: change.displayName, name: change.name });
  const next = {
    ...row,
    display_name: name || row.display_name,
    external_id: change.externalId !== undefined ? (change.externalId ? String(change.externalId).slice(0, 200) : null) : row.external_id,
    active: change.active === undefined ? row.active : change.active ? 1 : 0,
    updated_at: new Date().toISOString(),
  };
  if (Boolean(next.active) !== Boolean(row.active)) {
    const refused = await setActive(env, request, key, row, Boolean(next.active));
    if (refused) return refused;
  }
  await env.DB.prepare("UPDATE scim_users SET display_name = ?3, external_id = ?4, active = ?5, updated_at = ?6 WHERE org_id = ?1 AND id = ?2")
    .bind(orgId, row.id, next.display_name, next.external_id, next.active, next.updated_at).run();
  // A name is the person's own once they have an account of their own; only
  // an account provisioning made takes its name from the provider.
  if (name && name !== row.display_name && row.user_github_id.startsWith(`scim:${orgId}:`)) {
    await env.DB.prepare("UPDATE users SET name = ?2 WHERE github_id = ?1").bind(row.user_github_id, name).run().catch(() => {});
  }
  return scim(await presentUser(env, base, next));
}

// ---- Groups ----

/// A handle from a provider's group name: "Sales Team" → `sales-team`.
function handleFor(displayName) {
  const h = String(displayName || "").normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_.-]/gu, "").slice(0, 30);
  return h || null;
}

async function groupRow(db, orgId, id) {
  return db.prepare("SELECT * FROM scim_groups WHERE org_id = ?1 AND id = ?2").bind(orgId, id).first();
}

async function presentGroup(env, base, row) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_name FROM user_group_members g
       JOIN users u ON u.login = g.login
       JOIN scim_users s ON s.user_github_id = u.github_id AND s.org_id = g.org_id
      WHERE g.org_id = ?1 AND g.handle = ?2 ORDER BY s.user_name`
  ).bind(row.org_id, row.handle).all();
  return {
    schemas: [GROUP],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    displayName: row.display_name,
    members: (results || []).map((m) => ({ value: m.id, display: m.user_name, $ref: `${base}/Users/${m.id}` })),
    meta: { resourceType: "Group", created: row.created_at, lastModified: row.updated_at, location: `${base}/Groups/${row.id}` },
  };
}

/// Logins for SCIM user ids; people not provisioned here are left out.
async function loginsFor(db, orgId, ids) {
  const out = [];
  for (const id of ids) {
    const r = await db.prepare(
      "SELECT u.login FROM scim_users s JOIN users u ON u.github_id = s.user_github_id WHERE s.org_id = ?1 AND s.id = ?2"
    ).bind(orgId, String(id)).first();
    if (r?.login) out.push(r.login);
  }
  return out;
}

async function changeGroupMembers(db, orgId, handle, { add = [], remove = [], replace = null }) {
  if (replace) await db.prepare("DELETE FROM user_group_members WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle).run();
  for (const login of await loginsFor(db, orgId, replace || add)) {
    await db.prepare("INSERT OR IGNORE INTO user_group_members (org_id, handle, login) VALUES (?1, ?2, ?3)").bind(orgId, handle, login).run();
  }
  for (const login of await loginsFor(db, orgId, remove)) {
    await db.prepare("DELETE FROM user_group_members WHERE org_id = ?1 AND handle = ?2 AND login = ?3").bind(orgId, handle, login).run();
  }
}

const memberIds = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((m) => (m && typeof m === "object" ? m.value : m)).filter(Boolean);

async function groups(request, env, url, key, base, rest, body) {
  const orgId = key.orgId;
  const actor = keyActor(key);
  if (!rest && request.method === "GET") {
    const filter = parseFilter(url.searchParams.get("filter"));
    if (filter?.invalid) return scimError(400, "Only `attribute eq \"value\"` filters are supported.", "invalidFilter");
    const { results } = await env.DB.prepare("SELECT * FROM scim_groups WHERE org_id = ?1 ORDER BY created_at, id").bind(orgId).all();
    let rows = results || [];
    if (filter) {
      if (filter.attr === "displayname") rows = rows.filter((r) => fold(r.display_name) === fold(filter.value));
      else if (filter.attr === "externalid") rows = rows.filter((r) => r.external_id === filter.value);
      else if (filter.attr === "id") rows = rows.filter((r) => r.id === filter.value);
      else return scimError(400, `Filtering by ${filter.attr} is not supported.`, "invalidFilter");
    }
    const excluded = fold(url.searchParams.get("excludedAttributes")).includes("members");
    const all = [];
    for (const r of rows) {
      const g = await presentGroup(env, base, r);
      if (excluded) delete g.members;
      all.push(g);
    }
    return listResponse(all, url.searchParams.get("startIndex"), url.searchParams.get("count"));
  }
  if (!rest && request.method === "POST") {
    const displayName = String(body.displayName || "").trim().slice(0, 120);
    const handle = handleFor(displayName);
    if (!handle) return scimError(400, "A group needs a displayName.", "invalidValue");
    if (await env.DB.prepare("SELECT 1 FROM user_groups WHERE org_id = ?1 AND handle = ?2").bind(orgId, handle).first()) {
      return scimError(409, `There is already a group @${handle} in this workspace.`, "uniqueness");
    }
    const now = new Date().toISOString();
    const row = { org_id: orgId, id: newId(), handle, display_name: displayName, external_id: body.externalId ? String(body.externalId).slice(0, 200) : null, created_at: now, updated_at: now };
    await env.DB.prepare("INSERT INTO user_groups (org_id, handle, name, created_by, created_at) VALUES (?1, ?2, ?3, NULL, ?4)").bind(orgId, handle, displayName, now).run();
    await env.DB.prepare("INSERT INTO scim_groups (org_id, id, handle, display_name, external_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(row.org_id, row.id, row.handle, row.display_name, row.external_id, now, now).run();
    await changeGroupMembers(env.DB, orgId, handle, { replace: memberIds(body.members) });
    await audit(env, request, { orgId, action: "scim.group_created", actor, entity: { type: "group", id: handle, name: `@${handle}` } });
    return scim(await presentGroup(env, base, row), 201, { location: `${base}/Groups/${row.id}` });
  }
  if (!rest) return scimError(405, "That method is not allowed here.");

  const row = await groupRow(env.DB, orgId, rest);
  if (!row) return scimError(404, "No such group.");
  const entity = { type: "group", id: row.handle, name: `@${row.handle}` };
  if (request.method === "GET") return scim(await presentGroup(env, base, row));
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_group_members WHERE org_id = ?1 AND handle = ?2").bind(orgId, row.handle).run();
    await env.DB.prepare("DELETE FROM user_groups WHERE org_id = ?1 AND handle = ?2").bind(orgId, row.handle).run();
    await env.DB.prepare("DELETE FROM scim_groups WHERE org_id = ?1 AND id = ?2").bind(orgId, row.id).run();
    await audit(env, request, { orgId, action: "scim.group_deleted", actor, entity });
    return scim(null, 204);
  }
  let displayName = row.display_name;
  if (request.method === "PUT") {
    if (typeof body.displayName === "string" && body.displayName.trim()) displayName = body.displayName.trim().slice(0, 120);
    await changeGroupMembers(env.DB, orgId, row.handle, { replace: memberIds(body.members) });
  } else if (request.method === "PATCH") {
    if (!Array.isArray(body.Operations)) return scimError(400, "A PATCH needs Operations.", "invalidSyntax");
    for (const op of body.Operations) {
      const kind = fold(op?.op);
      const path = String(op?.path || "");
      // `members[value eq "id"]`, the way Entra ID removes one person.
      const one = /^members\[value eq "([^"]+)"\]$/i.exec(path);
      if (one && kind === "remove") await changeGroupMembers(env.DB, orgId, row.handle, { remove: [one[1]] });
      else if (fold(path) === "members") {
        if (kind === "add") await changeGroupMembers(env.DB, orgId, row.handle, { add: memberIds(op.value) });
        else if (kind === "remove") await changeGroupMembers(env.DB, orgId, row.handle, op.value ? { remove: memberIds(op.value) } : { replace: [] });
        else if (kind === "replace") await changeGroupMembers(env.DB, orgId, row.handle, { replace: memberIds(op.value) });
      } else if (fold(path) === "displayname" && typeof op.value === "string") displayName = op.value.trim().slice(0, 120) || displayName;
      else if (!path && op?.value && typeof op.value === "object") {
        if (typeof op.value.displayName === "string") displayName = op.value.displayName.trim().slice(0, 120) || displayName;
        if (op.value.members) await changeGroupMembers(env.DB, orgId, row.handle, kind === "add" ? { add: memberIds(op.value.members) } : { replace: memberIds(op.value.members) });
      }
    }
  } else return scimError(405, "That method is not allowed here.");
  const now = new Date().toISOString();
  // The handle stays what it was: people have already written `@sales`.
  await env.DB.prepare("UPDATE scim_groups SET display_name = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2").bind(orgId, row.id, displayName, now).run();
  await env.DB.prepare("UPDATE user_groups SET name = ?3 WHERE org_id = ?1 AND handle = ?2").bind(orgId, row.handle, displayName).run();
  await audit(env, request, { orgId, action: "scim.group_updated", actor, entity });
  return scim(await presentGroup(env, base, { ...row, display_name: displayName, updated_at: now }));
}

// ---- What this server supports ----

function serviceProviderConfig(base) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://github.com/Torutesu/HonmaruAI/blob/main/docs/sso-and-domain-join.md",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Workspace key", description: "A workspace key with the scim:write scope, as Authorization: Bearer hmo_…", primary: true }],
    meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
  };
}
function resourceTypes(base) {
  return [
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER, meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` } },
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP, meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` } },
  ];
}

/// Everything under /scim/v2/.
export async function handleScim(request, env, url) {
  if (!url.pathname.startsWith("/scim/v2")) return null;
  const base = `${url.origin}/scim/v2`;
  const path = url.pathname.replace(/^\/scim\/v2/, "").replace(/\/+$/, "");
  const resolved = await resolveOrgKey(env, request);
  if (!resolved.key) {
    if (resolved.refused === "ip" && resolved.row) {
      await audit(env, request, { orgId: resolved.row.org_id, action: "security.permission_denied", actor: { type: "api_key", id: resolved.row.prefix, name: resolved.row.name }, entity: { type: "resource", id: "scim", name: "SCIM from an address the key does not allow" }, outcome: "denied" });
      return scimError(403, "This key may not be used from this address.");
    }
    return scimError(401, resolved.refused === "expired" ? "This key has expired." : "Send a workspace key with the scim:write scope as Authorization: Bearer hmo_….");
  }
  const key = resolved.key;
  if (!key.scopes.includes("scim:write")) return scimError(403, "This key needs the scim:write scope.");
  const limited = await enforceSubject(env, "admin-api", `k:${key.id}`);
  if (limited) return scimError(429, "Too many requests for this key. Try again in a minute.");
  if (key.newIp) await audit(env, request, { orgId: key.orgId, action: "org_key.used_from_new_ip", actor: keyActor(key) });

  let body = {};
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const raw = await request.text().catch(() => "");
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return scimError(400, "The body must be a JSON object.", "invalidSyntax");
  }
  if (request.method === "PATCH" && body.schemas && !body.schemas.includes(PATCH_OP)) return scimError(400, "A PATCH is a PatchOp.", "invalidSyntax");

  if (path === "/ServiceProviderConfig") return scim(serviceProviderConfig(base));
  if (path === "/ResourceTypes") return scim({ schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: resourceTypes(base) });
  if (path === "/Schemas") return scim({ schemas: [LIST], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
  const m = path.match(/^\/(Users|Groups)(?:\/([^/]+))?$/);
  if (!m) return scimError(404, "No such endpoint.");
  const rest = m[2] ? decodeURIComponent(m[2]) : null;
  return m[1] === "Users" ? users(request, env, url, key, base, rest, body) : groups(request, env, url, key, base, rest, body);
}


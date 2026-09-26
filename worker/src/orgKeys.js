// A workspace's own keys, and the admin API they open.
//
// docs/admin-controls.md §2. An HR system or Terraform adds and removes
// people, sets up channels and pulls the audit log — with a key that belongs
// to the workspace, not to whoever made it, so it keeps working when that
// person leaves and never acts with their standing. Only an owner makes one.
// The key never reads what was said: there is no scope for messages.

import { getSession, getUserByGithubId } from "./db.js";
import { sha256Hex } from "./auth.js";
import { audit, person } from "./audit.js";
import { allowed, ownersOf } from "./permissions.js";
import { memberGate, reauthDenial } from "./policy.js";

export const KEY_PREFIX = "hmo_";
export const KEY_SCOPES = ["members:read", "members:write", "channels:read", "channels:write", "audit:read", "scim:write"];
const MAX_KEYS = 20;
const DEFAULT_DAYS = 90;
const SEEN_EVERY_MS = 5 * 60_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-session-token, authorization, idempotency-key",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json", ...CORS, ...extra } });
}
/// The admin API's errors: `{ error: { code, message } }`.
export function apiError(status, code, message) {
  return json({ error: { code, message } }, status);
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export function cleanKeyScopes(input) {
  if (!Array.isArray(input)) return [];
  return KEY_SCOPES.filter((s) => input.includes(s));
}

// ---- Addresses ----

function ipv4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) + BigInt(p);
  }
  return { bits: 32, value: n };
}

function ipv6(text) {
  let s = String(text).toLowerCase();
  if (!s.includes(":")) return null;
  // An IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const four = ipv4(v4[1]);
    if (!four) return null;
    s = s.slice(0, -v4[1].length) + `${((four.value >> 16n) & 0xffffn).toString(16)}:${(four.value & 0xffffn).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return { bits: 128, value: n };
}

const parseIp = (text) => ipv4(text) || ipv6(text);

/// A CIDR (or a single address) as the key's allow-list keeps it, or null.
export function parseCidr(text) {
  const [addr, len] = String(text || "").trim().split("/");
  const ip = parseIp(addr);
  if (!ip) return null;
  const prefix = len === undefined ? ip.bits : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return null;
  return { ...ip, prefix, text: `${addr}/${prefix}` };
}

/// Whether an address is inside any of these CIDRs.
export function ipAllowed(address, cidrs) {
  const ip = parseIp(address);
  if (!ip) return false;
  for (const raw of cidrs || []) {
    const c = parseCidr(raw);
    if (!c || c.bits !== ip.bits) continue;
    const shift = BigInt(c.bits - c.prefix);
    if ((ip.value >> shift) === (c.value >> shift)) return true;
  }
  return false;
}

// ---- The keys ----

export async function listOrgKeys(db, orgId) {
  const { results } = await db.prepare(
    `SELECT id, prefix, name, scopes, allowed_ips, expires_at, created_by, created_at, last_used_at, last_used_ip, revoked_at
       FROM org_keys WHERE org_id = ?1 ORDER BY created_at DESC`
  ).bind(orgId).all();
  const out = [];
  for (const r of results || []) {
    const maker = await getUserByGithubId(db, r.created_by).catch(() => null);
    out.push({
      id: r.id,
      prefix: r.prefix,
      name: r.name,
      scopes: JSON.parse(r.scopes || "[]"),
      allowedIps: r.allowed_ips ? JSON.parse(r.allowed_ips) : null,
      expiresAt: r.expires_at,
      createdBy: maker?.name || null,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      lastUsedIp: r.last_used_ip,
      revoked: Boolean(r.revoked_at),
    });
  }
  return out;
}

/// Make a key. The value is returned once, here, and stored only as a hash.
export async function createOrgKey(db, { orgId, createdBy, name, scopes, allowedIps, expiresInDays, neverExpires, reason }) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!clean) return { error: "Give the key a name." };
  const chosen = cleanKeyScopes(scopes);
  if (!chosen.length) return { error: "Choose what the key may do." };
  let ips = null;
  if (Array.isArray(allowedIps) && allowedIps.length) {
    const parsed = allowedIps.map(parseCidr);
    if (parsed.some((c) => !c)) return { error: "An address range is not valid. Use an address or a CIDR like 203.0.113.0/24." };
    ips = parsed.map((c) => c.text).slice(0, 50);
  }
  let expires = null;
  if (neverExpires) {
    if (!String(reason || "").trim()) return { error: "Say why this key should never expire." };
  } else {
    const days = expiresInDays === undefined || expiresInDays === null ? DEFAULT_DAYS : Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 730) return { error: "A key lasts from 1 to 730 days." };
    expires = new Date(Date.now() + days * 86_400_000).toISOString();
  }
  const count = await db.prepare("SELECT COUNT(*) AS n FROM org_keys WHERE org_id = ?1 AND revoked_at IS NULL").bind(orgId).first();
  if (Number(count?.n || 0) >= MAX_KEYS) return { error: "That is as many keys as one workspace can have. Revoke one first." };
  const secret = `${KEY_PREFIX}${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const id = `ok_${hex(crypto.getRandomValues(new Uint8Array(10)))}`;
  const prefix = secret.slice(0, KEY_PREFIX.length + 8);
  await db.prepare(
    `INSERT INTO org_keys (id, org_id, token_hash, prefix, name, scopes, allowed_ips, expires_at, never_reason, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  ).bind(id, orgId, await sha256Hex(secret), prefix, clean, JSON.stringify(chosen), ips ? JSON.stringify(ips) : null, expires,
    neverExpires ? String(reason).trim().slice(0, 300) : null, String(createdBy), new Date().toISOString()).run();
  return { id, key: secret, prefix, name: clean, scopes: chosen, allowedIps: ips, expiresAt: expires };
}

/// The key a request carries, checked: real, not revoked, not expired, and
/// from an allowed address. Returns the key or a reason it was refused.
export async function resolveOrgKey(env, request) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(request.headers.get("authorization") || "").trim());
  if (!match || !match[1].startsWith(KEY_PREFIX)) return { refused: "missing" };
  const row = await env.DB.prepare("SELECT * FROM org_keys WHERE token_hash = ?1").bind(await sha256Hex(match[1])).first();
  if (!row || row.revoked_at) return { refused: "invalid" };
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return { refused: "expired" };
  const ip = request.headers.get("cf-connecting-ip") || "";
  const allowedIps = row.allowed_ips ? JSON.parse(row.allowed_ips) : null;
  if (allowedIps && !ipAllowed(ip, allowedIps)) return { refused: "ip", row };
  const now = Date.now();
  const firstFromHere = ip && row.last_used_ip !== ip && !(await env.DB.prepare("SELECT 1 FROM org_key_ips WHERE key_id = ?1 AND ip = ?2").bind(row.id, ip).first());
  if (firstFromHere) {
    await env.DB.prepare("INSERT OR IGNORE INTO org_key_ips (key_id, ip, first_seen_at) VALUES (?1, ?2, ?3)").bind(row.id, ip, new Date(now).toISOString()).run().catch(() => {});
  }
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > SEEN_EVERY_MS || row.last_used_ip !== ip) {
    await env.DB.prepare("UPDATE org_keys SET last_used_at = ?2, last_used_ip = ?3 WHERE id = ?1").bind(row.id, new Date(now).toISOString(), ip || null).run().catch(() => {});
  }
  return {
    key: {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      prefix: row.prefix,
      scopes: JSON.parse(row.scopes || "[]"),
      createdBy: String(row.created_by),
      // A key that has been used before, seen from somewhere new.
      newIp: Boolean(firstFromHere && row.last_used_at),
    },
  };
}

/// The key as the audit log names it: not a person.
export function keyActor(key) {
  return { type: "api_key", id: key.prefix, name: key.name, via: { type: "org_key", id: key.id } };
}

/// Who a key's invitations and channels are made in the name of: the owner
/// who made it while they are an owner, and otherwise the longest-standing
/// owner. The key does not depend on them; the row needs somebody.
export async function actingOwner(db, key) {
  const owners = await ownersOf(db, key.orgId);
  return owners.includes(key.createdBy) ? key.createdBy : owners[0] || null;
}

/// Warn the owners, once, of keys that expire within a week.
export async function warnExpiringKeys(env) {
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, org_id, name, expires_at FROM org_keys WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > ?1 AND expires_at <= ?2 AND warned_at IS NULL LIMIT 50"
  ).bind(now, soon).all();
  const { mailOwners } = await import("./owners.js");
  for (const k of results || []) {
    await mailOwners(env, k.org_id, {
      subject: `The workspace key "${k.name}" expires soon`,
      text: `The workspace key "${k.name}" stops working on ${k.expires_at.slice(0, 10)}. Make a new one in Tools → API & Webhooks before then, and give it to whatever uses this one.`,
    });
    await env.DB.prepare("UPDATE org_keys SET warned_at = ?2 WHERE id = ?1").bind(k.id, now).run();
  }
  return (results || []).length;
}

/// GET/POST /orgs/keys · PATCH/DELETE /orgs/keys/:id — an owner's, with a
/// recent sign-in.
export async function handleOrgKeys(request, env, url) {
  const m = url.pathname.match(/^\/orgs\/keys(?:\/([^/]+))?$/);
  if (!m) return null;
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "Please sign in." }, 401);
  const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => ({}));
  const orgId = body?.orgId || url.searchParams.get("orgId");
  if (!orgId) return json({ message: "orgId is required" }, 400);
  const gate = await memberGate(env, session, orgId);
  if (gate) return gate;
  const user = await getUserByGithubId(env.DB, session.github_id);
  const owner = await allowed(env.DB, orgId, session.github_id, "org_key.manage");
  if (request.method === "GET" && !m[1]) {
    if (!(await allowed(env.DB, orgId, session.github_id, "audit.read"))) return json({ message: "Only an admin can see the workspace's keys." }, 403);
    return json({ keys: await listOrgKeys(env.DB, orgId), canEdit: owner, scopes: KEY_SCOPES });
  }
  if (!owner) {
    await audit(env, request, { orgId, action: "security.permission_denied", actor: person(user), entity: { type: "resource", id: "org_keys", name: "the workspace's keys" }, outcome: "denied" });
    return json({ message: "Only an owner can make or change the workspace's keys." }, 403);
  }
  const again = await reauthDenial(env, session, orgId, { owner: true });
  if (again) return json(again.body, again.status);

  if (request.method === "POST" && !m[1]) {
    const out = await createOrgKey(env.DB, { orgId, createdBy: session.github_id, ...body });
    if (out.error) return json({ message: out.error }, 400);
    await audit(env, request, { orgId, action: "org_key.created", actor: person(user), entity: { type: "org_key", id: out.prefix, name: out.name },
      details: { scopes: out.scopes, allowed_ips: out.allowedIps, expires_at: out.expiresAt, never_expires: !out.expiresAt } });
    return json(out, 201);
  }
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  const row = id ? await env.DB.prepare("SELECT * FROM org_keys WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first() : null;
  if (!row) return json({ message: "No such key." }, 404);
  const entity = { type: "org_key", id: row.prefix, name: row.name };
  if (request.method === "PATCH") {
    const sets = [];
    const binds = [];
    const details = {};
    if (body.name !== undefined) {
      const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!name) return json({ message: "Give the key a name." }, 400);
      sets.push("name = ?"); binds.push(name); details.name = name;
    }
    if (body.scopes !== undefined) {
      const scopes = cleanKeyScopes(body.scopes);
      if (!scopes.length) return json({ message: "Choose what the key may do." }, 400);
      sets.push("scopes = ?"); binds.push(JSON.stringify(scopes)); details.scopes = scopes;
    }
    if (body.allowedIps !== undefined) {
      const list = Array.isArray(body.allowedIps) ? body.allowedIps : [];
      const parsed = list.map(parseCidr);
      if (parsed.some((c) => !c)) return json({ message: "An address range is not valid." }, 400);
      sets.push("allowed_ips = ?"); binds.push(parsed.length ? JSON.stringify(parsed.map((c) => c.text)) : null); details.allowed_ips = parsed.map((c) => c.text);
    }
    if (!sets.length) return json({ message: "Nothing to change." }, 400);
    const sql = `UPDATE org_keys SET ${sets.map((s, i) => s.replace("?", `?${i + 2}`)).join(", ")} WHERE id = ?1`;
    await env.DB.prepare(sql).bind(id, ...binds).run();
    await audit(env, request, { orgId, action: "org_key.updated", actor: person(user), entity, details });
    return json({ ok: true, keys: await listOrgKeys(env.DB, orgId) });
  }
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE org_keys SET revoked_at = ?2, revoked_by = ?3 WHERE id = ?1 AND revoked_at IS NULL").bind(id, new Date().toISOString(), String(session.github_id)).run();
    await audit(env, request, { orgId, action: "org_key.revoked", actor: person(user), entity });
    return json({ ok: true, keys: await listOrgKeys(env.DB, orgId) });
  }
  return json({ message: "not found" }, 404);
}

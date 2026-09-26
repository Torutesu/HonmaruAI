import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { ipAllowed, parseCidr } from "../src/orgKeys.js";
import { memberRef } from "../src/team.js";

// A workspace's own keys and the admin API they open
// (docs/admin-controls.md §2): only an owner makes one, the value is shown
// once, and a key does what its scopes say — never read a message, never
// touch an owner.

const ORG = "team:hr";
let owner; let admin;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, { token, key, method = "GET", body, ip = "203.0.113.5", headers = {} } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: {
      "content-type": "application/json", "cf-connecting-ip": ip,
      ...(token ? { "x-session-token": token } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const makeKey = async (extra = {}) => {
  const res = await call("/orgs/keys", { token: owner, method: "POST", body: { orgId: ORG, name: "Workday", scopes: ["members:read", "members:write", "channels:read", "channels:write", "audit:read"], ...extra } });
  expect(res.status).toBe(201);
  return res.json();
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM org_keys; DELETE FROM org_key_ips; DELETE FROM admin_idempotency; DELETE FROM businesses; DELETE FROM invites; DELETE FROM conversation_members;");
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name, role, email] of [["7601", "u:toru@hr.jp", "Toru", "owner", "toru@hr.jp"], ["7602", "u:mika@hr.jp", "Mika", "admin", "mika@hr.jp"], ["7603", "u:aya@hr.jp", "Aya", "member", "aya@hr.jp"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind(id, email).run();
    await upsertMembership(env.DB, ORG, id, role);
  }
  owner = await createSession(env.DB, "7601", "x");
  admin = await createSession(env.DB, "7602", "x");
});

test("address ranges: IPv4 and IPv6, a single address, and nonsense refused", () => {
  expect(ipAllowed("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
  expect(ipAllowed("203.0.114.9", ["203.0.113.0/24"])).toBe(false);
  expect(ipAllowed("198.51.100.7", ["198.51.100.7"])).toBe(true);
  expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
  expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  expect(ipAllowed("203.0.113.9", ["2001:db8::/32"])).toBe(false);
  expect(parseCidr("300.1.1.1/8")).toBe(null);
  expect(parseCidr("10.0.0.0/33")).toBe(null);
});

test("only an owner makes a key; its value is shown once and never again", async () => {
  expect((await call("/orgs/keys", { token: admin, method: "POST", body: { orgId: ORG, name: "x", scopes: ["members:read"] } })).status).toBe(403);
  const made = await makeKey();
  expect(made.key).toMatch(/^hmo_[0-9a-f]{64}$/);
  expect(made.expiresAt).toBeTruthy();
  const listed = await (await call(`/orgs/keys?orgId=${ORG}`, { token: admin })).json();
  expect(listed.canEdit).toBe(false);
  expect(JSON.stringify(listed)).not.toContain(made.key);
  expect(listed.keys[0]).toMatchObject({ prefix: made.key.slice(0, 12), name: "Workday", revoked: false });
  // Never expiring needs a reason.
  expect((await call("/orgs/keys", { token: owner, method: "POST", body: { orgId: ORG, name: "Forever", scopes: ["members:read"], neverExpires: true } })).status).toBe(400);
  const row = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'org_key.created'").bind(ORG).first();
  expect(row.severity).toBe("critical");
});

test("the admin API: members with their email, a role changed, an owner out of reach, sessions ended", async () => {
  const { key } = await makeKey();
  const none = await call("/admin/v1/members");
  expect(none.status).toBe(401);
  expect((await none.json()).error.code).toBe("invalid_key");
  const list = await (await call("/admin/v1/members", { key })).json();
  expect(list.data.map((m) => m.email).sort()).toEqual(["aya@hr.jp", "mika@hr.jp", "toru@hr.jp"]);
  const aRef = await memberRef(ORG, "7603");
  const tRef = await memberRef(ORG, "7601");
  const up = await call(`/admin/v1/members/${aRef}`, { key, method: "PATCH", body: { role: "admin" } });
  expect(up.status).toBe(200);
  expect((await up.json()).data.role).toBe("admin");
  expect((await call(`/admin/v1/members/${tRef}`, { key, method: "DELETE" })).status).toBe(403);
  expect((await call(`/admin/v1/members/${aRef}`, { key, method: "PATCH", body: { role: "owner" } })).status).toBe(403);
  const { createSession } = await import("../src/db.js");
  await createSession(env.DB, "7603", "x");
  expect((await (await call(`/admin/v1/members/${aRef}/sign-out`, { key, method: "POST" })).json()).data.ended).toBe(1);
  expect((await call(`/admin/v1/members/${aRef}`, { key, method: "DELETE" })).status).toBe(200);
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = '7603'").bind(ORG).first()).toBe(null);
  // Recorded as the key, not as a person.
  const removed = JSON.parse((await env.DB.prepare("SELECT body FROM audit_events WHERE org_id = ?1 AND action = 'member.removed'").bind(ORG).first()).body);
  expect(removed.actor).toMatchObject({ type: "api_key", name: "Workday", via: { type: "org_key" } });
});

test("the API describes itself without a key", async () => {
  const spec = await (await call("/admin/v1/openapi.json")).json();
  expect(spec.openapi).toBe("3.0.3");
  expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/members", "/members/{ref}", "/invites", "/channels", "/audit/logs"]));
});

test("scopes are kept to: a key that reads channels cannot read people", async () => {
  const { key } = await makeKey({ scopes: ["channels:read"] });
  const res = await call("/admin/v1/members", { key });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe("insufficient_scope");
  expect((await call("/admin/v1/channels", { key })).status).toBe(200);
});

test("channels: made private with people by email, one taken out, archived — and an Idempotency-Key answers once", async () => {
  const { key } = await makeKey();
  const first = await call("/admin/v1/channels", { key, method: "POST", body: { name: "Payroll", private: true, members: ["mika@hr.jp", "aya@hr.jp"] }, headers: { "idempotency-key": "make-payroll" } });
  expect(first.status).toBe(201);
  const again = await call("/admin/v1/channels", { key, method: "POST", body: { name: "Payroll", private: true, members: ["mika@hr.jp"] }, headers: { "idempotency-key": "make-payroll" } });
  expect(again.status).toBe(201);
  expect(again.headers.get("idempotent-replayed")).toBe("true");
  expect(await again.json()).toEqual(await first.json());
  const out = await call("/admin/v1/channels/payroll/members", { key, method: "PUT", body: { remove: [await memberRef(ORG, "7603")] } });
  expect((await out.json()).data.removed).toHaveLength(1);
  expect((await call("/admin/v1/channels/payroll", { key, method: "PATCH", body: { archived: true } })).status).toBe(200);
  const { listBusinesses } = await import("../src/db.js");
  expect((await listBusinesses(env.DB, ORG, { viewer: "u:mika@hr.jp" })).map((b) => b.slug)).not.toContain("payroll");
});

test("invitations made and withdrawn; the audit log read by key", async () => {
  const { key } = await makeKey();
  const inv = await (await call("/admin/v1/invites", { key, method: "POST", body: { role: "member" } })).json();
  expect(inv.data.code).toMatch(/^[0-9a-f]{32}$/);
  expect((await call(`/admin/v1/invites/${inv.data.ref}`, { key, method: "DELETE" })).status).toBe(200);
  const log = await (await call("/admin/v1/audit/logs", { key })).json();
  expect(log.data.map((e) => e.action)).toEqual(expect.arrayContaining(["invite.created", "invite.revoked"]));
});

test("a key refuses addresses it was not given, and stops when revoked or expired", async () => {
  const { key, id } = await makeKey({ allowedIps: ["203.0.113.0/24"] });
  expect((await call("/admin/v1/members", { key, ip: "203.0.113.77" })).status).toBe(200);
  const far = await call("/admin/v1/members", { key, ip: "198.51.100.1" });
  expect(far.status).toBe(403);
  expect((await far.json()).error.code).toBe("ip_not_allowed");
  await env.DB.prepare("UPDATE org_keys SET expires_at = ?2 WHERE id = ?1").bind(id, new Date(Date.now() - 1000).toISOString()).run();
  expect((await (await call("/admin/v1/members", { key })).json()).error.code).toBe("key_expired");
  await env.DB.prepare("UPDATE org_keys SET expires_at = NULL WHERE id = ?1").bind(id).run();
  expect((await call(`/orgs/keys/${id}?orgId=${ORG}`, { token: owner, method: "DELETE" })).status).toBe(200);
  expect((await call("/admin/v1/members", { key })).status).toBe(401);
});

test("a key used from somewhere new is noted in the log", async () => {
  const { key } = await makeKey();
  await call("/admin/v1/channels", { key, ip: "203.0.113.5" });
  await env.DB.prepare("UPDATE org_keys SET last_used_at = ?1").bind(new Date(Date.now() - 600000).toISOString()).run();
  await call("/admin/v1/channels", { key, ip: "198.51.100.44" });
  const seen = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'org_key.used_from_new_ip'").bind(ORG).first();
  expect(seen?.severity).toBe("warning");
});

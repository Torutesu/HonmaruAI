import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// SCIM 2.0 (docs/sso-and-domain-join.md §11): the company's identity
// provider adds people and takes them out, and a person it stops loses every
// session at once. Only the workspace's verified domains, and never an owner.

const ORG = "team:acme";
let owner;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, { token, key, method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: {
      "content-type": "application/scim+json", "cf-connecting-ip": "203.0.113.5",
      ...(token ? { "x-session-token": token } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const makeKey = async (scopes = ["scim:write"]) => {
  const res = await call("/orgs/keys", { token: owner, method: "POST", body: { orgId: ORG, name: "Okta", scopes } });
  expect(res.status).toBe(201);
  return (await res.json()).key;
};
const provision = (key, userName, extra = {}) => call("/scim/v2/Users", {
  key, method: "POST",
  body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, name: { givenName: "Ken", familyName: "Sato" }, emails: [{ value: userName, primary: true }], active: true, ...extra },
});
const isMember = async (githubId) => Boolean(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(ORG, githubId).first());

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM org_keys; DELETE FROM org_key_ips; DELETE FROM org_domains; DELETE FROM users; DELETE FROM scim_users; DELETE FROM scim_groups; DELETE FROM user_groups; DELETE FROM user_group_members;");
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name, role, email] of [["8601", "u:toru@acme.jp", "Toru", "owner", "toru@acme.jp"], ["8602", "u:aya@acme.jp", "Aya", "member", "aya@acme.jp"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind(id, email).run();
    await upsertMembership(env.DB, ORG, id, role);
  }
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('acme.jp', ?1, 't', ?2, '8601', ?2)")
    .bind(ORG, new Date().toISOString()).run();
  owner = await createSession(env.DB, "8601", "x");
});

test("a key without scim:write, or no key, is refused; the provider config is served", async () => {
  expect((await call("/scim/v2/Users")).status).toBe(401);
  const readOnly = await makeKey(["members:read"]);
  expect((await call("/scim/v2/Users", { key: readOnly })).status).toBe(403);
  const key = await makeKey();
  const config = await (await call("/scim/v2/ServiceProviderConfig", { key })).json();
  expect(config.patch.supported).toBe(true);
  expect(config.bulk.supported).toBe(false);
  const list = await call("/scim/v2/Users", { key });
  expect(list.headers.get("content-type")).toBe("application/scim+json");
  expect((await list.json()).totalResults).toBe(0);
});

test("provisioning: a new person joins; the same address twice is a conflict; another company's domain is refused", async () => {
  const key = await makeKey();
  const made = await provision(key, "ken@acme.jp");
  expect(made.status).toBe(201);
  const user = await made.json();
  expect(user).toMatchObject({ userName: "ken@acme.jp", active: true, displayName: "Ken Sato" });
  const row = await env.DB.prepare("SELECT user_github_id FROM scim_users WHERE id = ?1").bind(user.id).first();
  expect(row.user_github_id).toMatch(/^scim:/);
  expect(await isMember(row.user_github_id)).toBe(true);
  const via = await env.DB.prepare("SELECT joined_via FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(ORG, row.user_github_id).first();
  expect(via.joined_via).toBe("scim");

  const again = await provision(key, "KEN@acme.jp");
  expect(again.status).toBe(409);
  expect((await again.json()).scimType).toBe("uniqueness");
  const outside = await provision(key, "someone@gmail.com");
  expect(outside.status).toBe(400);
  expect((await outside.json()).scimType).toBe("invalidValue");

  // The filter every provider sends before it creates someone.
  const found = await (await call(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "ken@acme.jp"')}`, { key })).json();
  expect(found.totalResults).toBe(1);
  expect(found.Resources[0].id).toBe(user.id);
  expect((await call(`/scim/v2/Users?filter=${encodeURIComponent('title co "x"')}`, { key })).status).toBe(400);
});

test("someone already here is linked, not duplicated", async () => {
  const key = await makeKey();
  const user = await (await provision(key, "aya@acme.jp")).json();
  const row = await env.DB.prepare("SELECT user_github_id FROM scim_users WHERE id = ?1").bind(user.id).first();
  expect(row.user_github_id).toBe("8602");
  const role = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = '8602'").bind(ORG).first();
  expect(role.role).toBe("member");
});

test("deactivated: out of the workspace and every session ended at once; active again brings them back", async () => {
  const key = await makeKey();
  const user = await (await provision(key, "aya@acme.jp")).json();
  const { createSession } = await import("../src/db.js");
  await createSession(env.DB, "8602", "x");
  await createSession(env.DB, "8602", "y");
  // Okta's way: {path: "active", value: false}.
  const off = await call(`/scim/v2/Users/${user.id}`, { key, method: "PATCH", body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] } });
  expect(off.status).toBe(200);
  expect((await off.json()).active).toBe(false);
  expect(await isMember("8602")).toBe(false);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE github_id = '8602'").first()).n).toBe(0);
  const logged = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'scim.user_deactivated'").bind(ORG).first();
  expect(logged.severity).toBe("warning");
  // Entra's way: {value: {active: true}}.
  const on = await call(`/scim/v2/Users/${user.id}`, { key, method: "PATCH", body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", value: { active: "True" } }] } });
  expect((await on.json()).active).toBe(true);
  expect(await isMember("8602")).toBe(true);
  // DELETE takes them out and forgets the SCIM id.
  expect((await call(`/scim/v2/Users/${user.id}`, { key, method: "DELETE" })).status).toBe(204);
  expect(await isMember("8602")).toBe(false);
  expect((await call(`/scim/v2/Users/${user.id}`, { key })).status).toBe(404);
});

test("an owner is never deactivated by provisioning", async () => {
  const key = await makeKey();
  const user = await (await provision(key, "toru@acme.jp")).json();
  const off = await call(`/scim/v2/Users/${user.id}`, { key, method: "PUT", body: { userName: "toru@acme.jp", active: false } });
  expect(off.status).toBe(403);
  expect(await isMember("8601")).toBe(true);
});

test("groups become user groups, and follow the provider's members", async () => {
  const key = await makeKey();
  const ken = await (await provision(key, "ken@acme.jp")).json();
  const aya = await (await provision(key, "aya@acme.jp")).json();
  const made = await call("/scim/v2/Groups", { key, method: "POST", body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Sales Team", members: [{ value: ken.id }] } });
  expect(made.status).toBe(201);
  const group = await made.json();
  expect(group.members.map((m) => m.value)).toEqual([ken.id]);
  const handle = await env.DB.prepare("SELECT handle, name FROM user_groups WHERE org_id = ?1").bind(ORG).first();
  expect(handle).toEqual({ handle: "sales-team", name: "Sales Team" });

  const patch = (Operations) => call(`/scim/v2/Groups/${group.id}`, { key, method: "PATCH", body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations } });
  await patch([{ op: "add", path: "members", value: [{ value: aya.id }] }]);
  const logins = async () => (await env.DB.prepare("SELECT login FROM user_group_members WHERE org_id = ?1 AND handle = 'sales-team' ORDER BY login").bind(ORG).all()).results.map((r) => r.login);
  expect(await logins()).toEqual(["u:aya@acme.jp", "u:ken@acme.jp"]);
  await patch([{ op: "remove", path: `members[value eq "${ken.id}"]` }, { op: "replace", path: "displayName", value: "Sales" }]);
  expect(await logins()).toEqual(["u:aya@acme.jp"]);
  // The handle people have been writing stays; the name follows.
  expect((await env.DB.prepare("SELECT handle, name FROM user_groups WHERE org_id = ?1").bind(ORG).first())).toEqual({ handle: "sales-team", name: "Sales" });

  const byName = await (await call(`/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "sales"')}&excludedAttributes=members`, { key })).json();
  expect(byName.totalResults).toBe(1);
  expect(byName.Resources[0].members).toBeUndefined();

  expect((await call(`/scim/v2/Groups/${group.id}`, { key, method: "DELETE" })).status).toBe(204);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM user_groups WHERE org_id = ?1").bind(ORG).first()).n).toBe(0);
});

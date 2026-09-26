import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { brokenRule, sessionDeadline, forgetPolicies } from "../src/policy.js";
import { memberRef } from "../src/team.js";

// A workspace's login rules (docs/admin-controls.md §3): how long a sign-in
// lasts in it, how long it may sit unused, and how recent a sign-in an
// admin action needs. Applied when the workspace is entered, so the same
// session still opens a workspace without rules.

const ORG = "team:strict";
const LOOSE = "team:loose";
let owner; let mika; let mikaOld;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const age = (token, h, { seen = h, reauth = null } = {}) => env.DB.prepare("UPDATE sessions SET created_at = ?2, last_seen_at = ?3, reauth_at = ?4 WHERE token = ?1").bind(token, hoursAgo(h), hoursAgo(seen), reauth).run();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM org_session_policy;");
  forgetPolicies();
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name] of [["7501", "toru", "Toru"], ["7502", "mika", "Mika"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
  }
  await upsertMembership(env.DB, ORG, "7501", "owner");
  await upsertMembership(env.DB, ORG, "7502", "member");
  await upsertMembership(env.DB, LOOSE, "7502", "owner");
  await env.DB.prepare("UPDATE users SET password_hash = NULL WHERE github_id = '7501'").run();
  owner = await createSession(env.DB, "7501", "x", { client: "web" });
  mika = await createSession(env.DB, "7502", "x", { client: "web" });
  mikaOld = await createSession(env.DB, "7502", "x", { client: "ios" });
});

test("the rules, read: longest for a browser or the app, and unused for too long", () => {
  const policy = { web_max_hours: 12, mobile_max_hours: 720, idle_hours: 8 };
  expect(brokenRule(policy, { client: "web", created_at: hoursAgo(13), last_seen_at: hoursAgo(1) })).toBe("web_max_hours");
  expect(brokenRule(policy, { client: "ios", created_at: hoursAgo(13), last_seen_at: hoursAgo(1) })).toBe(null);
  expect(brokenRule(policy, { client: "web", created_at: hoursAgo(10), last_seen_at: hoursAgo(9) })).toBe("idle_hours");
  // Used just now, after nine hours away: the gap still counts.
  expect(brokenRule(policy, { client: "web", created_at: hoursAgo(10), last_seen_at: hoursAgo(0), longest_idle_ms: 9 * 3_600_000 })).toBe("idle_hours");
  expect(brokenRule(null, { client: "web", created_at: hoursAgo(9999) })).toBe(null);
  const created = hoursAgo(2);
  expect(sessionDeadline(policy, { client: "web", created_at: created })).toBe(Date.parse(created) + 12 * 3_600_000);
});

test("only an owner sets them, the log keeps before and after, and bad numbers are refused", async () => {
  const bad = await call("/orgs/session-policy", owner, { method: "PUT", body: { orgId: ORG, webMaxHours: 0 } });
  expect(bad.status).toBe(400);
  expect((await call("/orgs/session-policy", mika, { method: "PUT", body: { orgId: ORG, webMaxHours: 12 } })).status).toBe(403);
  const ok = await call("/orgs/session-policy", owner, { method: "PUT", body: { orgId: ORG, webMaxHours: 12, mobileMaxHours: 720, idleHours: 8 } });
  expect(ok.status).toBe(200);
  expect((await ok.json()).policy).toEqual({ webMaxHours: 12, mobileMaxHours: 720, idleHours: 8, reauthForAdminMinutes: null });
  const row = await env.DB.prepare("SELECT body, severity FROM audit_events WHERE org_id = ?1 AND action = 'workspace.session_policy_changed'").bind(ORG).first();
  expect(row.severity).toBe("critical");
  expect(JSON.parse(row.body).details.after.webMaxHours).toBe(12);
  expect((await (await call(`/orgs/session-policy?orgId=${ORG}`, owner)).json()).policy.idleHours).toBe(8);
});

test("a session the rules have outgrown signs in again here — and still opens a workspace without rules", async () => {
  await call("/orgs/session-policy", owner, { method: "PUT", body: { orgId: ORG, webMaxHours: 12 } });
  forgetPolicies();
  await age(mika, 20, { seen: 0.1 });
  const refused = await call(`/members?orgId=${ORG}`, mika);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toMatchObject({ code: "session-policy", orgId: ORG, rule: "web_max_hours" });
  expect((await call(`/members?orgId=${LOOSE}`, mika)).status).toBe(200);
  // The app has its own limit, which this workspace did not set.
  await age(mikaOld, 20, { seen: 0.1 });
  expect((await call(`/members?orgId=${ORG}`, mikaOld)).status).toBe(200);
});

test("left unused past the idle limit, refused; used, fine", async () => {
  await call("/orgs/session-policy", owner, { method: "PUT", body: { orgId: ORG, idleHours: 8 } });
  forgetPolicies();
  await age(mika, 10, { seen: 9 });
  expect((await (await call(`/members?orgId=${ORG}`, mika)).json()).rule).toBe("idle_hours");
  // And again: being refused is not being used.
  expect((await (await call(`/members?orgId=${ORG}`, mika)).json()).rule).toBe("idle_hours");
  await age(mikaOld, 10, { seen: 1 });
  expect((await call(`/members?orgId=${ORG}`, mikaOld)).status).toBe(200);
});

test("'apply now' signs out, at once, every session the rules no longer allow", async () => {
  await call("/orgs/session-policy", owner, { method: "PUT", body: { orgId: ORG, webMaxHours: 12 } });
  await age(mika, 20, { seen: 0.1 });
  const res = await call("/orgs/session-policy/apply", owner, { method: "POST", body: { orgId: ORG } });
  expect(res.status).toBe(200);
  expect((await res.json()).ended).toBe(1);
  expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE token = ?1").bind(mika).first()).toBe(null);
  expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE token = ?1").bind(mikaOld).first()).toBeTruthy();
});

test("an owner's action wants a sign-in within the hour; a password proves it without signing out", async () => {
  await age(owner, 3, { seen: 0 });
  const mRef = await memberRef(ORG, "7502");
  const asked = await call("/members/role", owner, { method: "PUT", body: { orgId: ORG, ref: mRef, role: "admin" } });
  expect(asked.status).toBe(401);
  expect((await asked.json()).code).toBe("reauth-required");
  // No mail on this deployment, and no password: sign in again.
  expect((await (await call("/auth/reauth/start", owner, { method: "POST", body: {} })).json()).method).toBe("sign_in_again");
  // With a password, it is enough.
  const { hashPassword, newSaltHex } = await import("../src/auth.js");
  const salt = newSaltHex();
  await env.DB.prepare("UPDATE users SET password_hash = ?2, password_salt = ?3 WHERE github_id = ?1").bind("7501", await hashPassword("correct horse", salt), salt).run();
  expect((await (await call("/auth/reauth/start", owner, { method: "POST", body: {} })).json()).method).toBe("password");
  expect((await call("/auth/reauth", owner, { method: "POST", body: { password: "wrong" } })).status).toBe(400);
  expect((await call("/auth/reauth", owner, { method: "POST", body: { password: "correct horse" } })).status).toBe(200);
  expect((await call("/members/role", owner, { method: "PUT", body: { orgId: ORG, ref: mRef, role: "admin" } })).status).toBe(200);
});

test("a workspace can ask it of its admins too", async () => {
  const { upsertMembership } = await import("../src/db.js");
  await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE org_id = ?1 AND user_github_id = '7502'").bind(ORG).run();
  await call("/orgs/session-policy", owner, { method: "PUT", body: { orgId: ORG, reauthForAdminMinutes: 15 } });
  forgetPolicies();
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7503", login: "aya", name: "Aya", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7503", "member");
  await age(mika, 1, { seen: 0 });
  const r = await call("/members/role", mika, { method: "PUT", body: { orgId: ORG, ref: await memberRef(ORG, "7503"), role: "guest", channels: [] } });
  expect(r.status).toBe(401);
  expect((await r.json()).code).toBe("reauth-required");
  const fresh = await createSession(env.DB, "7502", "x", { client: "web" });
  const again = await call("/members/role", fresh, { method: "PUT", body: { orgId: ORG, ref: await memberRef(ORG, "7503"), role: "guest", channels: [] } });
  expect(again.status).not.toBe(401);
});

import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createApiToken } from "../src/mcp.js";

// An agent token never expired, and the workspace's rules for people did not
// apply to it: a token made before the workspace required SSO, or used from
// outside its allowed networks, still read and wrote everything.

const DAY = 86_400_000;
let n = 0;
let ORG;
const rpc = (bearer, ip = "203.0.113.7") => worker.fetch(new Request("https://example.com/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}`, "cf-connecting-ip": ip },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
}), env);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  ORG = `team:agent-policy-${++n}`;
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8801", login: "ken", name: "Ken", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = 'ken@acme.jp', email_verified_at = ?1 WHERE github_id = '8801'").bind(new Date().toISOString()).run();
  await upsertMembership(env.DB, ORG, "8801", "member");
});

test("a token lasts ninety days unless asked otherwise, and not a day more", async () => {
  const made = await createApiToken(env.DB, { orgId: ORG, githubId: "8801", name: "CI" });
  expect(Date.parse(made.expiresAt) - Date.now()).toBeGreaterThan(89 * DAY);
  expect(Date.parse(made.expiresAt) - Date.now()).toBeLessThanOrEqual(90 * DAY);
  expect((await rpc(made.token)).status).toBe(200);
  await env.DB.prepare("UPDATE api_tokens SET expires_at = ?1").bind(new Date(Date.now() - 1000).toISOString()).run();
  expect((await rpc(made.token)).status).toBe(401);
  expect((await createApiToken(env.DB, { orgId: ORG, githubId: "8801", name: "x", expiresInDays: 400 })).error).toBeTruthy();
});

test("a token from before expiry keeps working, and is given ninety days from its next use", async () => {
  const made = await createApiToken(env.DB, { orgId: ORG, githubId: "8801", name: "Old" });
  await env.DB.prepare("UPDATE api_tokens SET expires_at = NULL").run();
  expect((await rpc(made.token)).status).toBe(200);
  const row = await env.DB.prepare("SELECT expires_at FROM api_tokens").first();
  expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(89 * DAY);
});

test("the workspace's allowed networks apply to a token", async () => {
  const made = await createApiToken(env.DB, { orgId: ORG, githubId: "8801", name: "CI" });
  await env.DB.prepare("INSERT INTO org_governance (org_id, ip_enforce, ip_allowlist, updated_by, updated_at) VALUES (?1, 1, '[\"203.0.113.0/24\"]', '8801', ?2)")
    .bind(ORG, new Date().toISOString()).run();
  expect((await rpc(made.token, "203.0.113.50")).status).toBe(200);
  expect((await rpc(made.token, "192.0.2.9")).status).toBe(403);
});

test("once a workspace requires SSO, a token made without it stops; one made through it goes on", async () => {
  const plain = await createApiToken(env.DB, { orgId: ORG, githubId: "8801", name: "Before SSO" });
  const viaSso = await createApiToken(env.DB, { orgId: ORG, githubId: "8801", name: "After SSO", ssoBacked: true });
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('acme.jp', ?1, 't', ?2, '8801', ?2)").bind(ORG, now).run();
  await env.DB.prepare(
    "INSERT INTO sso_connections (id, org_id, provider, issuer, allowed_domains, status, created_by, created_at, updated_at) VALUES ('c1', ?1, 'okta', 'https://acme.okta.com', '[\"acme.jp\"]', 'active', '8801', ?2, ?2)"
  ).bind(ORG, now).run();
  await env.DB.prepare("INSERT INTO org_sso_policy (org_id, enforce, enforce_since, updated_at) VALUES (?1, 1, ?2, ?2)").bind(ORG, now).run();
  const refused = await rpc(plain.token);
  expect(refused.status).toBe(403);
  expect((await refused.json()).error.message).toContain("single sign-on");
  expect((await rpc(viaSso.token)).status).toBe(200);
});

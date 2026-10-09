import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { validateIncomingCard } from "../src/agui/validate.js";
import { forgetGovernance } from "../src/governance.js";

// An address is a person only once they have proved it. Typing one in — at a
// password sign-up, or into a profile — used to be enough to be handed what
// was meant for the address's real owner: their email-code sign-in, their
// company's SSO link, their SCIM provisioning, a way past an invite policy.

const MAIL = { RESEND_API_KEY: "re_test" };
let sent = [];
const realFetch = globalThis.fetch;
let ip = 0;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

// Each request from its own address, so the per-IP sign-in limit (10 in five
// minutes) never decides one of these tests.
const call = async (path, { token, key, method = "GET", body, e = env } = {}) => {
  ip += 1;
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: {
      "content-type": "application/json", "cf-connecting-ip": `203.0.113.${ip % 250}`,
      ...(token ? { "x-session-token": token } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), e, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const signUp = async (email, password = "attacker-password-1", extra = {}) =>
  (await call("/auth/signup", { method: "POST", body: { email, password, ...extra } })).json();
const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });
const signedIn = async (token) => (await call("/me", { token })).status === 200;

// The real owner of an address, signing in with the code mailed to it.
async function codeSignIn(email) {
  const { requestCode } = await import("../src/otp.js");
  sent = [];
  expect((await requestCode({ ...env, ...MAIL }, { email, locale: "en" })).ok).toBe(true);
  const code = sent[0].text.match(/\b\d{6}\b/)[0];
  const res = await call("/auth/otp/verify", { method: "POST", body: { email, code } });
  expect(res.status).toBe(200);
  return res.json();
}
const userOf = (githubId) => env.DB.prepare("SELECT * FROM users WHERE github_id = ?1").bind(githubId).first();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM login_codes; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM invites; DELETE FROM org_governance; DELETE FROM org_domains; DELETE FROM sso_connections; DELETE FROM org_sso_policy; DELETE FROM org_keys; DELETE FROM scim_users; DELETE FROM join_requests;");
  // Workspace rules are cached per isolate for 30 seconds; each test sets its own.
  forgetGovernance();
  sent = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.resend.com")) {
      const body = JSON.parse(init.body);
      sent.push({ ...body, to: body.to[0] });
      return new Response(JSON.stringify({ id: "queued" }), { status: 200 });
    }
    return realFetch(input, init);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("a password sign-up cannot ask for a password-less account", async () => {
  const res = await call("/auth/signup", { method: "POST", body: { email: "victim@example.com", passwordless: true, emailProved: true } });
  expect(res.status).toBe(400);
  expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = 'victim@example.com'").first()).toBeNull();
});

test("an address registered by someone else is the owner's once they prove it: the squatter's password and sessions end", async () => {
  const squatter = await signUp("victim@example.com", "squatter-password");
  expect(await signedIn(squatter.token)).toBe(true);

  const owner = await codeSignIn("victim@example.com");

  expect(owner.userId).toBe("email:victim@example.com");
  expect(await signedIn(owner.token)).toBe(true);
  expect(await signedIn(squatter.token)).toBe(false);
  expect((await login("victim@example.com", "squatter-password")).status).toBe(401);
  expect((await userOf("email:victim@example.com")).email_verified_at).toBeTruthy();
});

test("an account that only typed an address in loses it to the person who proves it", async () => {
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "gh-mallory", login: "mallory", name: "Mallory", avatarUrl: null, locale: "en" });
  const mallory = await createSession(env.DB, "gh-mallory", "x");
  expect((await call("/me", { token: mallory, method: "PUT", body: { email: "victim@example.com" } })).status).toBe(200);

  const owner = await codeSignIn("victim@example.com");

  expect(owner.userId).toBe("email:victim@example.com");
  expect((await userOf("gh-mallory")).email).toBeNull();
});

test("changing an address un-proves it, so a proved address cannot be swapped for someone else's", async () => {
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "gh-mallory", login: "mallory", name: "Mallory", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = 'mallory@example.com', email_verified_at = '2026-01-01T00:00:00Z' WHERE github_id = 'gh-mallory'").run();
  const mallory = await createSession(env.DB, "gh-mallory", "x");

  // Saving the profile with the same address keeps it proved.
  expect((await call("/me", { token: mallory, method: "PUT", body: { email: "mallory@example.com" } })).status).toBe(200);
  expect((await userOf("gh-mallory")).email_verified_at).toBeTruthy();

  expect((await call("/me", { token: mallory, method: "PUT", body: { email: "ceo@corp.example" } })).status).toBe(200);
  expect((await userOf("gh-mallory")).email_verified_at).toBeNull();
});

test("an address a workspace holds to its SSO cannot be moved out from under it", async () => {
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  const now = new Date().toISOString();
  await upsertUser(env.DB, { githubId: "gh-ken", login: "ken", name: "Ken", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = 'ken@acme.jp', email_verified_at = ?1 WHERE github_id = 'gh-ken'").bind(now).run();
  await upsertMembership(env.DB, "team:acme", "gh-ken", "member");
  await env.DB.prepare(
    "INSERT INTO sso_connections (id, org_id, provider, issuer, allowed_domains, status, created_by, created_at, updated_at) VALUES ('c1', 'team:acme', 'okta', 'https://acme.okta.com', '[\"acme.jp\"]', 'active', 'gh-ken', ?1, ?1)"
  ).bind(now).run();
  await env.DB.prepare("INSERT INTO org_sso_policy (org_id, enforce, enforce_since, updated_at) VALUES ('team:acme', 1, ?1, ?1)").bind(now).run();
  const ken = await createSession(env.DB, "gh-ken", "x");

  expect((await call("/me", { token: ken, method: "PUT", body: { email: "ken@gmail.com" } })).status).toBe(403);
  expect((await userOf("gh-ken")).email).toBe("ken@acme.jp");
  // The unchanged address, sent with the rest of a profile, is still fine.
  expect((await call("/me", { token: ken, method: "PUT", body: { email: "ken@acme.jp", name: "Ken S" } })).status).toBe(200);
});

test("SCIM provisioning does not hand the company's new hire to whoever registered the address first", async () => {
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  const now = new Date().toISOString();
  await upsertUser(env.DB, { githubId: "gh-owner", login: "owner", name: "Owner", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = 'owner@acme.jp', email_verified_at = ?1 WHERE github_id = 'gh-owner'").bind(now).run();
  await upsertMembership(env.DB, "team:acme", "gh-owner", "owner");
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('acme.jp', 'team:acme', 't', ?1, 'gh-owner', ?1)").bind(now).run();
  const owner = await createSession(env.DB, "gh-owner", "x");
  const made = await call("/orgs/keys", { token: owner, method: "POST", body: { orgId: "team:acme", name: "Okta", scopes: ["scim:write"] } });
  const key = (await made.json()).key;

  const squatter = await signUp("newhire@acme.jp", "squatter-password");
  const provisioned = await call("/scim/v2/Users", {
    key, method: "POST",
    body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "newhire@acme.jp", emails: [{ value: "newhire@acme.jp", primary: true }], active: true },
  });
  expect(provisioned.status).toBe(201);

  // The squatter is not in the workspace by any way back: no session, no password.
  expect(await signedIn(squatter.token)).toBe(false);
  expect((await login("newhire@acme.jp", "squatter-password")).status).toBe(401);
});

test("an invitation used at sign-up answers to the workspace's invite rule", async () => {
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  const now = new Date().toISOString();
  await upsertUser(env.DB, { githubId: "gh-owner", login: "owner", name: "Owner", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "team:acme", "gh-owner", "owner");
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('acme.jp', 'team:acme', 't', ?1, 'gh-owner', ?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO org_governance (org_id, invite_policy, updated_by, updated_at) VALUES ('team:acme', 'company', 'gh-owner', ?1)").bind(now).run();
  const owner = await createSession(env.DB, "gh-owner", "x");
  const invite = await (await call("/invites/create", { token: owner, method: "POST", body: { orgId: "team:acme" } })).json();
  expect(invite.code).toBeTruthy();

  const outsider = await signUp("anyone@gmail.com", "outsider-password", { inviteCode: invite.code });

  expect(outsider.token).toBeTruthy();
  expect(outsider.orgId).not.toBe("team:acme");
  expect(outsider.inviteError).toBeTruthy();
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = 'team:acme' AND user_github_id = ?1").bind(outsider.userId).first()).toBeNull();
});

test("a card's links are web addresses", () => {
  const card = { id: "c1", recipientUserID: "u:a" };
  expect(validateIncomingCard({ ...card, requestedBy: { sourceUrl: "javascript:alert(document.domain)" } })).toMatch(/sourceUrl/);
  expect(validateIncomingCard({ ...card, githubIssueURL: "javascript:alert(1)" })).toMatch(/githubIssueURL/);
  expect(validateIncomingCard({ ...card, requestedBy: { sourceUrl: "https://slack.com/archives/C1/p1" }, githubIssueURL: "https://github.com/o/r/issues/1" })).toBeNull();
});

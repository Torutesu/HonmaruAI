import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { forgetProviderDocs } from "../src/sso.js";
import { forgetPolicies } from "../src/policy.js";

// Single sign-on against a pretend identity provider that signs real ID
// tokens (docs/sso-and-domain-join.md §6–7, §10): the round trip, every
// check on the token, the one-time hand-off, and making SSO required.

const ORG = "team:acme";
const ISSUER = "https://idp.test";
let owner; let keyPair; let claims; let tokenAnswer; let refreshAnswer; let refreshSeen;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const realFetch = globalThis.fetch;
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = new TextEncoder();

async function sign(payload, { alg = "RS256", kid = "k1" } = {}) {
  const head = b64url(enc.encode(JSON.stringify({ alg, kid, typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  if (alg === "none") return `${head}.${body}.`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
    method, redirect: "manual", headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const where = (res) => new URL(res.headers.get("location"), "https://app.test");
const hashParams = (res) => new URLSearchParams((res.headers.get("location").split("?")[1] || ""));

/// Go to the provider and come back as `who`.
async function signIn(who, { client = "web", mutate = (c) => c } = {}) {
  const start = await call(`/sso/start?orgId=${encodeURIComponent(ORG)}&client=${client}`);
  expect(start.status).toBe(302);
  const at = where(start);
  expect(at.origin + at.pathname).toBe(`${ISSUER}/authorize`);
  expect(at.searchParams.get("code_challenge_method")).toBe("S256");
  const now = Math.floor(Date.now() / 1000);
  claims = mutate({ iss: ISSUER, aud: "client-1", sub: who.sub, email: who.email, email_verified: true, name: who.name, nonce: at.searchParams.get("nonce"), iat: now, exp: now + 300 });
  return call(`/sso/callback?code=abc&state=${at.searchParams.get("state")}`);
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM org_domains; DELETE FROM org_sso; DELETE FROM sso_connections; DELETE FROM org_sso_policy; DELETE FROM sso_identities; DELETE FROM sso_states; DELETE FROM sso_handoffs; DELETE FROM sso_logout_tokens;");
  forgetProviderDocs();
  forgetPolicies();
  keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  tokenAnswer = null; refreshAnswer = null; refreshSeen = [];
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.origin === ISSUER) {
      if (u.pathname === "/.well-known/openid-configuration") return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, scopes_supported: ["openid", "email", "profile", "offline_access"] });
      if (u.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (u.pathname === "/token") {
        const form = new URLSearchParams(await new Response(init.body).text());
        if (form.get("grant_type") === "refresh_token") {
          refreshSeen.push(form.get("refresh_token"));
          return refreshAnswer ? refreshAnswer() : Response.json({ access_token: "at2" });
        }
        if (!form.get("code_verifier") || form.get("client_secret") !== "s3cret") return Response.json({ error: "invalid_client" }, { status: 401 });
        return Response.json(tokenAnswer || { id_token: await sign(claims), access_token: "at" });
      }
    }
    return realFetch(input, init);
  };
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name, role, email] of [["7801", "u:toru@acme.co.jp", "Toru", "owner", "toru@acme.co.jp"], ["7802", "u:root@outside.jp", "Root", "owner", "root@outside.jp"], ["7803", "u:mika@acme.co.jp", "Mika", "member", "mika@acme.co.jp"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind(id, email, new Date().toISOString()).run();
    await upsertMembership(env.DB, ORG, id, role);
  }
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('acme.co.jp', ?1, 't', ?2, '7801', ?2)").bind(ORG, new Date().toISOString()).run();
  owner = await createSession(env.DB, "7801", "x");
  const put = await call("/orgs/sso", owner, { method: "PUT", body: { orgId: ORG, provider: "okta", issuer: ISSUER, clientId: "client-1", clientSecret: "s3cret", allowedDomains: ["acme.co.jp"] } });
  expect(put.status).toBe(200);
});
afterEach(() => { globalThis.fetch = realFetch; });

test("set up, tested by the owner, then turned on; the secret never comes back out", async () => {
  const shown = await (await call(`/orgs/sso?orgId=${ORG}`, owner)).json();
  expect(shown.sso).toMatchObject({ provider: "okta", clientSecret: "set", status: "draft", testedAt: null });
  expect(JSON.stringify(shown)).not.toContain("s3cret");
  expect((await call("/orgs/sso/activate", owner, { method: "POST", body: { orgId: ORG } })).status).toBe(400);
  const { url } = await (await call("/orgs/sso/test", owner, { method: "POST", body: { orgId: ORG } })).json();
  const at = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  claims = { iss: ISSUER, aud: "client-1", sub: "okta-toru", email: "toru@acme.co.jp", email_verified: true, name: "Toru", nonce: at.searchParams.get("nonce"), iat: now, exp: now + 300 };
  const back = await call(`/sso/callback?code=abc&state=${at.searchParams.get("state")}`);
  expect(back.headers.get("location")).toContain("/tools/sso?tested=1");
  const tested = (await (await call(`/orgs/sso?orgId=${ORG}`, owner)).json()).sso;
  expect(tested.test).toMatchObject({ email: "toru@acme.co.jp", subject: "okta-toru" });
  expect((await call("/orgs/sso/activate", owner, { method: "POST", body: { orgId: ORG } })).status).toBe(200);
  // A test signs nobody in.
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sso_handoffs").first()).n).toBe(0);
});

const activate = () => env.DB.prepare("UPDATE sso_connections SET status = 'active', tested_at = ?2 WHERE org_id = ?1").bind(ORG, new Date().toISOString()).run();

test("the round trip: a new person is made, joins by SSO, and trades a one-time code for a session", async () => {
  await activate();
  const discovered = await (await call("/auth/discover", null, { method: "POST", body: { email: "aya@acme.co.jp" } })).json();
  expect(discovered.sso).toMatchObject({ orgId: ORG, provider: "okta", enforced: false });
  expect(await (await call("/auth/discover", null, { method: "POST", body: { email: "aya@else.jp" } })).json()).toEqual({});
  const back = await signIn({ sub: "okta-aya", email: "aya@acme.co.jp", name: "Aya" });
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toContain("/sso/done?code=");
  expect(back.headers.get("location")).not.toMatch(/token=/);
  const code = hashParams(back).get("code");
  expect((await call("/sso/exchange", null, { method: "POST", body: { code, client: "ios" } })).status).toBe(400);
  const session = await (await call("/sso/exchange", null, { method: "POST", body: { code, client: "web" } })).json();
  expect(session.orgId).toBe(ORG);
  // Once.
  expect((await call("/sso/exchange", null, { method: "POST", body: { code, client: "web" } })).status).toBe(400);
  expect((await call(`/members?orgId=${ORG}`, session.token)).status).toBe(200);
  const joined = await env.DB.prepare("SELECT m.joined_via, s.auth_method, s.sso_org_id FROM memberships m JOIN sessions s ON s.github_id = m.user_github_id WHERE m.org_id = ?1 AND s.token = ?2").bind(ORG, session.token).first();
  expect(joined).toEqual({ joined_via: "sso", auth_method: "sso", sso_org_id: ORG });
  // An existing, proved account is the same person, not a second one.
  const mika = await signIn({ sub: "okta-mika", email: "mika@acme.co.jp", name: "Mika" });
  const mikaSession = await (await call("/sso/exchange", null, { method: "POST", body: { code: hashParams(mika).get("code"), client: "web" } })).json();
  expect(mikaSession.userId).toBe("7803");
});

test("every check on the token refuses: audience, nonce, unproved address, other domain, no signature, a replayed state", async () => {
  await activate();
  const refused = async (mutate, want) => {
    const back = await signIn({ sub: "okta-x", email: "x@acme.co.jp", name: "X" }, { mutate });
    const error = hashParams(back).get("error") || "";
    expect(error, want).toMatch(want);
  };
  await refused((c) => ({ ...c, aud: "someone-else" }), /different application/);
  await refused((c) => ({ ...c, nonce: "stale" }), /not for this sign-in/);
  await refused((c) => ({ ...c, email_verified: false }), /verified email/);
  await refused((c) => ({ ...c, email: "x@elsewhere.jp" }), /not registered for single sign-on/);
  await refused((c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/);
  await refused((c) => ({ ...c, iss: "https://evil.test" }), /different issuer/);
  // alg: none
  const start = await call(`/sso/start?orgId=${encodeURIComponent(ORG)}&client=web`);
  const at = where(start);
  const now = Math.floor(Date.now() / 1000);
  tokenAnswer = { id_token: await sign({ iss: ISSUER, aud: "client-1", sub: "s", email: "x@acme.co.jp", email_verified: true, nonce: at.searchParams.get("nonce"), iat: now, exp: now + 60 }, { alg: "none" }) };
  const none = await call(`/sso/callback?code=abc&state=${at.searchParams.get("state")}`);
  expect(hashParams(none).get("error")).toMatch(/not accepted/);
  // The same state twice.
  const again = await call(`/sso/callback?code=abc&state=${at.searchParams.get("state")}`);
  expect(hashParams(again).get("error")).toMatch(/expired/);
  const failures = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?1 AND action = 'auth.login_failed'").bind(ORG).first();
  expect(failures.n).toBeGreaterThanOrEqual(7);
});

test("required: only after the owner came through it; then an email-code sign-in at the domain is refused, the outside owner is not", async () => {
  await activate();
  const { createSession } = await import("../src/db.js");
  const tooEarly = await call("/orgs/sso/enforce", owner, { method: "PUT", body: { orgId: ORG, enforce: true } });
  expect((await tooEarly.json()).code).toBe("sso-recent-required");
  const back = await signIn({ sub: "okta-toru", email: "toru@acme.co.jp", name: "Toru" });
  const viaSso = (await (await call("/sso/exchange", null, { method: "POST", body: { code: hashParams(back).get("code"), client: "web" } })).json()).token;
  const mikaOld = await createSession(env.DB, "7803", "x");
  await env.DB.prepare("UPDATE sessions SET auth_method = 'email_code' WHERE token = ?1").bind(mikaOld).run();
  const on = await call("/orgs/sso/enforce", viaSso, { method: "PUT", body: { orgId: ORG, enforce: true } });
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({ breakGlass: 1 });
  // Mika's code-based session went when it was required.
  expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE token = ?1").bind(mikaOld).first()).toBe(null);
  const mikaNew = await createSession(env.DB, "7803", "x");
  const refused = await call(`/members?orgId=${ORG}`, mikaNew);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "sso-required" });
  // The owner at an outside address is the way in if the provider fails.
  const root = await createSession(env.DB, "7802", "x");
  expect((await call(`/members?orgId=${ORG}`, root)).status).toBe(200);
  expect((await call(`/members?orgId=${ORG}`, viaSso)).status).toBe(200);
  // And an SSO sign-in lasts only its hours.
  await env.DB.prepare("UPDATE sessions SET created_at = ?2 WHERE token = ?1").bind(viaSso, new Date(Date.now() - 25 * 3_600_000).toISOString()).run();
  const stale = await call(`/members?orgId=${ORG}`, viaSso);
  expect(stale.status).toBe(401);
  expect((await stale.json()).code).toBe("sso-reauth");
});

// ---- The provider ending sign-ins (back-channel logout, refresh check) ----

async function ssoSession(who) {
  const back = await signIn(who);
  const code = hashParams(back).get("code");
  return (await (await call("/sso/exchange", null, { method: "POST", body: { code, client: "web" } })).json()).token;
}
const logoutToken = (over = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return sign({ iss: ISSUER, aud: "client-1", iat: now, exp: now + 120, jti: crypto.randomUUID(), events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...over });
};
const connId = async () => (await env.DB.prepare("SELECT id FROM sso_connections WHERE org_id = ?1").bind(ORG).first()).id;
const postLogout = async (token, id) => worker.fetch(new Request(`https://api.example.com/sso/oidc/${id || await connId()}/backchannel-logout`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }),
}), env, ctx);

test("the provider signs one sign-in out (sid), once; a bad logout token ends nothing", async () => {
  await activate();
  // Sign in twice, as two sign-ins at the provider.
  const sessions = [];
  for (const sid of ["sid-A", "sid-B"]) {
    const start = await call(`/sso/start?orgId=${encodeURIComponent(ORG)}&client=web`);
    const at = where(start);
    expect(at.searchParams.get("scope")).toContain("offline_access");
    const now = Math.floor(Date.now() / 1000);
    claims = { iss: ISSUER, aud: "client-1", sub: "okta-aya", email: "aya@acme.co.jp", email_verified: true, name: "Aya", nonce: at.searchParams.get("nonce"), iat: now, exp: now + 300, sid };
    tokenAnswer = { id_token: await sign(claims), access_token: "at", refresh_token: "rt-aya" };
    const back = await call(`/sso/callback?code=abc&state=${at.searchParams.get("state")}`);
    sessions.push((await (await call("/sso/exchange", null, { method: "POST", body: { code: hashParams(back).get("code"), client: "web" } })).json()).token);
  }
  const stored = await env.DB.prepare("SELECT sso_sid, sso_subject, sso_refresh FROM sessions WHERE token = ?1").bind(sessions[0]).first();
  expect(stored).toMatchObject({ sso_sid: "sid-A", sso_subject: "okta-aya" });
  expect(stored.sso_refresh).toMatch(/^v1:/);
  expect(stored.sso_refresh).not.toContain("rt-aya");

  // Refused: another audience, a nonce, no event, too old, unsigned.
  const now = Math.floor(Date.now() / 1000);
  for (const bad of [
    await logoutToken({ sid: "sid-A", aud: "client-2" }),
    await logoutToken({ sid: "sid-A", nonce: "n" }),
    await logoutToken({ sid: "sid-A", events: {} }),
    await logoutToken({ sid: "sid-A", iat: now - 3600, exp: now + 60 }),
    await logoutToken({}),
    await sign({ iss: ISSUER, aud: "client-1", iat: now, jti: "x", sid: "sid-A", events: { "http://schemas.openid.net/event/backchannel-logout": {} } }, { alg: "none" }),
  ]) {
    const res = await postLogout(bad);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  expect((await call(`/members?orgId=${ORG}`, sessions[0])).status).toBe(200);
  expect((await postLogout(await logoutToken({ sid: "sid-A" }), "nope")).status).toBe(400);

  const token = await logoutToken({ sid: "sid-A", sub: "okta-aya" });
  expect((await postLogout(token)).status).toBe(200);
  expect((await call(`/members?orgId=${ORG}`, sessions[0])).status).toBe(401);
  // The other sign-in at the provider is still on.
  expect((await call(`/members?orgId=${ORG}`, sessions[1])).status).toBe(200);
  // The same token again is refused.
  expect((await postLogout(token)).status).toBe(400);
  const row = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 AND action = 'sso.idp_signed_out'").bind(ORG).first();
  expect(row).toBeTruthy();
});

test("the provider signs a person out everywhere (sub); others stay in", async () => {
  await activate();
  const aya = await ssoSession({ sub: "okta-aya", email: "aya@acme.co.jp", name: "Aya" });
  const aya2 = await ssoSession({ sub: "okta-aya", email: "aya@acme.co.jp", name: "Aya" });
  const mika = await ssoSession({ sub: "okta-mika", email: "mika@acme.co.jp", name: "Mika" });
  expect((await postLogout(await logoutToken({ sub: "okta-aya" }))).status).toBe(200);
  expect((await call(`/members?orgId=${ORG}`, aya)).status).toBe(401);
  expect((await call(`/members?orgId=${ORG}`, aya2)).status).toBe(401);
  expect((await call(`/members?orgId=${ORG}`, mika)).status).toBe(200);
  const shown = await (await call(`/orgs/sso?orgId=${ORG}`, owner)).json();
  expect(shown.connections[0].logoutUrl).toMatch(/\/sso\/oidc\/.+\/backchannel-logout$/);
});

test("now and then the provider is asked again: a refreshed token is kept, a refused one ends the session", async () => {
  await activate();
  const { checkSsoGrants } = await import("../src/sso.js");
  tokenAnswer = null;
  const start = await call(`/sso/start?orgId=${encodeURIComponent(ORG)}&client=web`);
  const at = where(start);
  const now = Math.floor(Date.now() / 1000);
  claims = { iss: ISSUER, aud: "client-1", sub: "okta-aya", email: "aya@acme.co.jp", email_verified: true, name: "Aya", nonce: at.searchParams.get("nonce"), iat: now, exp: now + 300 };
  tokenAnswer = { id_token: await sign(claims), access_token: "at", refresh_token: "rt-1" };
  const back = await call(`/sso/callback?code=abc&state=${at.searchParams.get("state")}`);
  const aya = (await (await call("/sso/exchange", null, { method: "POST", body: { code: hashParams(back).get("code"), client: "web" } })).json()).token;
  // Not due yet.
  expect((await checkSsoGrants(env)).checked).toBe(0);
  const later = Date.now() + 11 * 60_000;
  refreshAnswer = () => Response.json({ access_token: "at2", refresh_token: "rt-2" });
  expect(await checkSsoGrants(env, { now: later })).toEqual({ checked: 1, ended: 0 });
  expect(refreshSeen).toEqual(["rt-1"]);
  // A provider that cannot answer ends nothing.
  refreshAnswer = () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  expect(await checkSsoGrants(env, { now: later + 11 * 60_000 })).toEqual({ checked: 1, ended: 0 });
  expect(refreshSeen[1]).toBe("rt-2");
  expect((await call(`/members?orgId=${ORG}`, aya)).status).toBe(200);
  // Switched off at the provider.
  refreshAnswer = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  expect(await checkSsoGrants(env, { now: later + 22 * 60_000 })).toEqual({ checked: 1, ended: 1 });
  expect((await call(`/members?orgId=${ORG}`, aya)).status).toBe(401);
  const row = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 AND action = 'sso.session_revoked'").bind(ORG).first();
  expect(row).toBeTruthy();
});


import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/index.js";
import { forgetProviderDocs } from "../src/sso.js";
import { sha256Hex } from "../src/auth.js";
import { sessionKey } from "../src/db.js";
import { LIMITS } from "../src/ratelimit.js";

// Sign in with Apple (src/apple.js) against a pretend Apple that signs real
// identity tokens: every check on the token, the keys fetched once and again
// when Apple rotates, and which account the person lands in.

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const realFetch = globalThis.fetch;
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let keyPair; let jwks; let keyFetches;

async function sign(payload, { alg = "RS256", kid = "apple-1", key } = {}) {
  const head = b64url(enc.encode(JSON.stringify({ alg, kid })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  if (alg === "none") return `${head}.${body}.`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, (key || keyPair).privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const newKey = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publish = async (pair, kid) => ({ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" });

/// What Apple would hand the app for `nonce`, with `over` changing any claim.
async function appleToken(nonce, over = {}, opts) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: "https://appleid.apple.com", aud: "com.honmaru.ai.poc", sub: "001234.abcdef.0001",
    email: "new@privaterelay.appleid.com", email_verified: "true", is_private_email: "true",
    nonce: await sha256Hex(nonce), iat: now, exp: now + 600, ...over,
  }, opts);
}

const signIn = async (body, extraEnv = {}) => {
  const res = await worker.fetch(new Request("https://api.example.com/auth/apple", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ...extraEnv }, ctx);
  while (pending.length) await pending.shift();
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  forgetProviderDocs();
  keyPair = await newKey();
  jwks = [await publish(keyPair, "apple-1")];
  keyFetches = 0;
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.href === "https://appleid.apple.com/auth/keys") { keyFetches += 1; return Response.json({ keys: jwks }); }
    return realFetch(input, init);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("a new person gets an account, a workspace, and a proved address", async () => {
  const token = await appleToken("n-1");
  const r = await signIn({ identityToken: token, nonce: "n-1", name: "Hana Apple" });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ created: true, userId: "email:new@privaterelay.appleid.com", login: "u:new@privaterelay.appleid.com" });
  expect(r.body.token).toBeTruthy();
  expect(r.body.orgId).toMatch(/^personal:/);
  const user = await env.DB.prepare("SELECT name, email_verified_at, password_hash FROM users WHERE github_id = ?1").bind(r.body.userId).first();
  expect(user.name).toBe("Hana Apple");
  expect(user.email_verified_at).toBeTruthy();
  expect(user.password_hash).toBeNull();
  const linked = await env.DB.prepare("SELECT user_github_id FROM apple_identities WHERE subject = ?1").bind("001234.abcdef.0001").first();
  expect(linked.user_github_id).toBe(r.body.userId);
  const session = await env.DB.prepare("SELECT auth_method FROM sessions WHERE token = ?1").bind(await sessionKey(r.body.token)).first();
  expect(session.auth_method).toBe("apple");
  // The session works.
  const me = await worker.fetch(new Request("https://api.example.com/me", { headers: { "x-session-token": r.body.token } }), env, ctx);
  expect(me.status).toBe(200);
});

test("the second time it is the same account, by Apple's id, even without an address", async () => {
  const first = await signIn({ identityToken: await appleToken("a"), nonce: "a" });
  const again = await signIn({ identityToken: await appleToken("b", { email: undefined, email_verified: undefined }), nonce: "b" });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ created: false, userId: first.body.userId, orgId: first.body.orgId });
  // Apple's keys were fetched once for both.
  expect(keyFetches).toBe(1);
});

test("an account that proved the same address is the one signed in to", async () => {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@acme.co.jp", login: "u:toru@acme.co.jp", name: "Toru", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind("email:toru@acme.co.jp", "toru@acme.co.jp", new Date().toISOString()).run();
  await upsertMembership(env.DB, "team:acme", "email:toru@acme.co.jp", "owner");
  const r = await signIn({ identityToken: await appleToken("n", { email: "Toru@acme.co.jp", is_private_email: "false" }), nonce: "n" });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ created: false, userId: "email:toru@acme.co.jp", orgId: "team:acme" });
});

test("an address typed at a password sign-up and never proved is not enough", async () => {
  const { upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:squat@acme.co.jp", login: "u:squat@acme.co.jp", name: "?", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?2 WHERE github_id = ?1").bind("email:squat@acme.co.jp", "squat@acme.co.jp").run();
  const r = await signIn({ identityToken: await appleToken("n", { email: "squat@acme.co.jp" }), nonce: "n" });
  expect(r.status).toBe(409);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).toMatchObject({ n: 0 });
});

test("an address Apple does not vouch for is not used", async () => {
  const r = await signIn({ identityToken: await appleToken("n", { email_verified: "false" }), nonce: "n" });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/email/);
});

test("an invitation is spent on the way in", async () => {
  const code = "0123456789abcdef0123456789abcdef";
  const now = new Date();
  await env.DB.prepare("INSERT INTO invites (code, org_id, created_by, role, created_at, expires_at, max_uses) VALUES (?1, 'team:acme', 'x', 'member', ?2, ?3, 5)")
    .bind(code, now.toISOString(), new Date(now.getTime() + 86400000).toISOString()).run();
  const r = await signIn({ identityToken: await appleToken("n"), nonce: "n", inviteCode: code });
  expect(r.status).toBe(200);
  expect(r.body.orgId).toBe("team:acme");
});

test("every check on the token", async () => {
  const other = await newKey();
  const cases = [
    ["wrong nonce", await appleToken("right"), "wrong"],
    ["no nonce", await appleToken("right"), undefined],
    ["the hash sent instead of the string", await appleToken("right"), await sha256Hex("right")],
    ["another issuer", await appleToken("n", { iss: "https://evil.example" }), "n"],
    ["another app", await appleToken("n", { aud: "com.someone.else" }), "n"],
    ["expired", await appleToken("n", { exp: Math.floor(Date.now() / 1000) - 3600 }), "n"],
    ["unsigned", await appleToken("n", {}, { alg: "none" }), "n"],
    ["signed by someone else", await appleToken("n", {}, { key: other }), "n"],
    ["not a JWT", "abc", "n"],
  ];
  for (const [what, identityToken, nonce] of cases) {
    // A fresh budget for each: this is not the rate limit's test.
    await env.DB.exec("DELETE FROM rate_limits");
    const r = await signIn({ identityToken, nonce });
    expect(r.status, what).toBe(401);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toMatchObject({ n: 0 });
});

test("the app ids come from APPLE_CLIENT_IDS", async () => {
  const token = await appleToken("n", { aud: "com.honmaru.ai" });
  expect((await signIn({ identityToken: token, nonce: "n" }, { APPLE_CLIENT_IDS: "com.example.only" })).status).toBe(401);
  await env.DB.exec("DELETE FROM rate_limits");
  expect((await signIn({ identityToken: token, nonce: "n" }, { APPLE_CLIENT_IDS: "com.example.only, com.honmaru.ai" })).status).toBe(200);
});

test("a key Apple rotated in is fetched again", async () => {
  await signIn({ identityToken: await appleToken("a"), nonce: "a" });
  const rotated = await newKey();
  jwks = [await publish(rotated, "apple-2")];
  const r = await signIn({ identityToken: await appleToken("b", {}, { key: rotated, kid: "apple-2" }), nonce: "b" });
  expect(r.status).toBe(200);
  expect(keyFetches).toBe(2);
});

test("rate limited like the other ways in", async () => {
  // Keep all requests inside one fixed window, even on a slow CI runner.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-24T12:00:05.000Z"));
    expect(LIMITS["oauth/token"]).toEqual({ max: 10, windowSeconds: 300 });
    for (let i = 0; i < LIMITS["oauth/token"].max; i++) {
      expect((await signIn({ identityToken: "x", nonce: "n" })).status).toBe(401);
    }
    expect((await signIn({ identityToken: "x", nonce: "n" })).status).toBe(429);
  } finally { vi.useRealTimers(); }
});

test("Apple sign-in receives a fresh budget at the fixed-window boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-24T12:04:59.999Z"));
    const max = LIMITS["oauth/token"].max;
    for (let i = 0; i < max; i++) expect((await signIn({ identityToken: "x", nonce: "n" })).status).toBe(401);
    const blocked = await signIn({ identityToken: "x", nonce: "n" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBe(1);

    vi.setSystemTime(new Date("2026-09-24T12:05:00.000Z"));
    for (let i = 0; i < max; i++) expect((await signIn({ identityToken: "x", nonce: "n" })).status).toBe(401);
    expect((await signIn({ identityToken: "x", nonce: "n" })).status).toBe(429);
  } finally { vi.useRealTimers(); }
});

test("deleting the account forgets the Apple link", async () => {
  const r = await signIn({ identityToken: await appleToken("n"), nonce: "n" });
  const { deleteAccount } = await import("../src/account.js");
  await deleteAccount(env.DB, r.body.userId, r.body.login);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM apple_identities").first()).toMatchObject({ n: 0 });
});

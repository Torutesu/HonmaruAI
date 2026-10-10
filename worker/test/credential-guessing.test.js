import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// The sign-in budgets were per IP address: a guesser spread across many
// addresses was not slowed at all. And a sign-in code allowed five guesses,
// but a new code could be asked for every minute, each with five more. Wrong
// guesses are now counted per account, whichever address they come from.

const MAIL = { RESEND_API_KEY: "re_test" };
let ip = 0;
let sent = [];
const realFetch = globalThis.fetch;
// Every request from a different address, as a spread-out guesser's would be.
const call = (path, { token, body, method = "POST", e = env } = {}) => {
  ip += 1;
  return worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${ip % 250}`, ...(token ? { "x-session-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), e, { waitUntil() {} });
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM login_codes; DELETE FROM sessions; DELETE FROM users; DELETE FROM memberships;");
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  const { hashPassword, newSaltHex } = await import("../src/auth.js");
  await upsertUser(env.DB, { githubId: "email:ken@acme.jp", login: "u:ken@acme.jp", name: "Ken", avatarUrl: null, locale: "en" });
  const salt = newSaltHex();
  await env.DB.prepare("UPDATE users SET email = 'ken@acme.jp', password_hash = ?2, password_salt = ?3 WHERE github_id = ?1")
    .bind("email:ken@acme.jp", await hashPassword("correct horse", salt), salt).run();
  await upsertMembership(env.DB, "team:acme", "email:ken@acme.jp", "owner");
  sent = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.resend.com")) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "queued" }), { status: 200 });
    }
    return realFetch(input, init);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const login = (password) => call("/auth/login", { body: { email: "ken@acme.jp", password } });

test("wrong passwords from many addresses lock the account's password for a while, not its code", async () => {
  for (let i = 0; i < 10; i += 1) expect((await login(`guess-${i}`)).status).toBe(401);
  // The right password too, now: a guesser cannot tell which one it was.
  expect((await login("correct horse")).status).toBe(429);
  // A code to the address still signs its owner in.
  const { requestCode } = await import("../src/otp.js");
  expect((await requestCode({ ...env, ...MAIL }, { email: "ken@acme.jp", locale: "en" })).ok).toBe(true);
  const code = sent[0].text.match(/\b\d{6}\b/)[0];
  expect((await call("/auth/otp/verify", { body: { email: "ken@acme.jp", code } })).status).toBe(200);
});

test("the right password after a few typos signs in", async () => {
  for (let i = 0; i < 3; i += 1) expect((await login(`typo-${i}`)).status).toBe(401);
  expect((await login("correct horse")).status).toBe(200);
});

test("asking for a new code does not buy five more guesses without end", async () => {
  const { requestCode, consumeCode } = await import("../src/otp.js");
  const fresh = async () => {
    // Past the minute between codes.
    await env.DB.prepare("UPDATE login_codes SET created_at = '2000-01-01T00:00:00Z'").run();
    sent = [];
    expect((await requestCode({ ...env, ...MAIL }, { email: "ken@acme.jp", locale: "en" })).ok).toBe(true);
    return sent[0].text.match(/\b\d{6}\b/)[0];
  };
  const wrong = (code) => String((Number(code) + 1) % 1000000).padStart(6, "0");
  for (let round = 0; round < 2; round += 1) {
    const code = await fresh();
    for (let i = 0; i < 5; i += 1) await consumeCode(env, "ken@acme.jp", wrong(code));
  }
  // Ten wrong: the third code is refused even when it is right.
  const code = await fresh();
  expect((await consumeCode(env, "ken@acme.jp", code)).status).toBe(429);
});

test("a stolen session cannot guess its way past re-authentication", async () => {
  const { createSession } = await import("../src/db.js");
  const token = await createSession(env.DB, "email:ken@acme.jp", "x");
  for (let i = 0; i < 10; i += 1) expect((await call("/auth/reauth", { token, body: { password: `guess-${i}` } })).status).toBe(400);
  expect((await call("/auth/reauth", { token, body: { password: "correct horse" } })).status).toBe(429);
});

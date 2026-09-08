import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// A six-digit code is the whole credential. These tests pin the four things
// that keep that from being a bad idea: it is never stored, it expires, it is
// spent on first use, and it runs out of guesses.

const MAIL = { RESEND_API_KEY: "re_test" };

// Resend stands in for itself: the code we assert on is the one that was
// actually put in an email, not one the test was handed by the code under test.
let sent = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

beforeEach(() => {
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

function codeFrom(mail) {
  return (mail.text.match(/\b\d{6}\b/) || [])[0];
}

test("a code arrives by email and is never stored in the clear", async () => {
  const { requestCode } = await import("../src/otp.js");
  const result = await requestCode({ ...env, ...MAIL }, { email: "Pat@Example.com", locale: "en" });

  expect(result.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe("pat@example.com");
  const code = codeFrom(sent[0]);
  expect(code).toMatch(/^\d{6}$/);
  expect(sent[0].subject).toContain(code);

  const row = await env.DB.prepare("SELECT code_hash FROM login_codes WHERE email = ?1")
    .bind("pat@example.com").first();
  expect(row.code_hash).not.toContain(code);
  expect(row.code_hash).toHaveLength(64);
});

test("the code is written in the reader's language", async () => {
  const { requestCode } = await import("../src/otp.js");
  await requestCode({ ...env, ...MAIL }, { email: "yuki@example.com", locale: "ja-JP" });
  expect(sent[0].subject).toContain("ログインコード");
  expect(sent[0].text).toContain("有効期間");
});

test("a correct code creates the account, signs in, and cannot be used twice", async () => {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const withMail = { ...env, ...MAIL };
  await requestCode(withMail, { email: "new@example.com" });
  const code = codeFrom(sent[0]);

  const first = await verifyCode(withMail, { email: "new@example.com", code, name: "New Person" });
  expect(first.error).toBeUndefined();
  expect(first.token).toBeTruthy();
  expect(first.created).toBe(true);

  // No password hash: nothing was set, so nothing can be guessed against.
  const user = await env.DB.prepare("SELECT name, password_hash FROM users WHERE email = ?1")
    .bind("new@example.com").first();
  expect(user.name).toBe("New Person");
  expect(user.password_hash).toBeNull();

  const second = await verifyCode(withMail, { email: "new@example.com", code });
  expect(second.error).toBeTruthy();
});

test("a second sign-in with a fresh code reuses the same account", async () => {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const withMail = { ...env, ...MAIL };
  await requestCode(withMail, { email: "again@example.com" });
  const first = await verifyCode(withMail, { email: "again@example.com", code: codeFrom(sent[0]), name: "Original" });

  // Past the resend cooldown, without waiting a minute for it.
  await env.DB.prepare("UPDATE login_codes SET created_at = ?1 WHERE email = ?2")
    .bind(new Date(Date.now() - 120000).toISOString(), "again@example.com").run();
  sent = [];
  await requestCode(withMail, { email: "again@example.com" });
  const second = await verifyCode(withMail, { email: "again@example.com", code: codeFrom(sent[0]), name: "Impostor" });

  expect(second.created).toBe(false);
  expect(second.userId).toBe(first.userId);
  expect(second.orgId).toBe(first.orgId);
  // A later sign-in must not rewrite the account it is signing in to.
  const user = await env.DB.prepare("SELECT name FROM users WHERE email = ?1").bind("again@example.com").first();
  expect(user.name).toBe("Original");
});

test("concurrent correct-code verification spends one code and creates exactly one session", async () => {
  const { signup } = await import("../src/auth.js");
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const account = await signup(env, { email: "concurrent@example.test", password: "long-password" });
  await requestCode({ ...env, ...MAIL }, { email: "concurrent@example.test" });
  const code = codeFrom(sent[0]);
  const results = await Promise.all(Array.from({ length: 3 }, () => verifyCode(env, { email: "concurrent@example.test", code })));
  expect(results.filter((result) => result.token)).toHaveLength(1);
  expect(results.filter((result) => result.error)).toHaveLength(2);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE github_id = ?1").bind(account.userId).first();
  expect(row.n).toBe(2); // Signup session, plus the one successful OTP sign-in.
});

test.each(["correct", "incorrect"])("an in-flight %s guess cannot consume or penalize a replacement code", async (kind) => {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const { hashPassword, newSaltHex } = await import("../src/auth.js");
  const email = "replaced@example.test";
  await requestCode({ ...env, ...MAIL }, { email });
  const original = codeFrom(sent[0]);
  const replacement = original === "123456" ? "654321" : "123456";
  const replacementSalt = newSaltHex();
  const replacementHash = await hashPassword(replacement, replacementSalt);
  const racedDB = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT code_hash, code_salt")) return statement;
      return { bind(...args) { return { async first() {
        const row = await statement.bind(...args).first();
        // A resend replaces the credential after this verification read it.
        await env.DB.prepare("UPDATE login_codes SET code_hash = ?1, code_salt = ?2, attempts = 0 WHERE email = ?3")
          .bind(replacementHash, replacementSalt, email).run();
        return row;
      } }; } };
    },
  };
  const guess = kind === "correct" ? original : (original === "000000" ? "111111" : "000000");
  const stale = await verifyCode({ ...env, DB: racedDB }, { email, code: guess });
  expect(stale.error).toBeTruthy();
  const row = await env.DB.prepare("SELECT code_hash, attempts FROM login_codes WHERE email = ?1").bind(email).first();
  expect(row).toMatchObject({ code_hash: replacementHash, attempts: 0 });
  expect((await verifyCode(env, { email, code: replacement })).token).toBeTruthy();
});

test("OTP sign-in for a memberless account returns no invented workspace", async () => {
  const { signup } = await import("../src/auth.js");
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const account = await signup(env, { email: "removed@example.test", password: "long-password" });
  await env.DB.prepare("DELETE FROM memberships WHERE user_github_id = ?1").bind(account.userId).run();
  await requestCode({ ...env, ...MAIL }, { email: "removed@example.test" });
  const result = await verifyCode(env, { email: "removed@example.test", code: codeFrom(sent[0]), orgId: account.orgId });
  expect(result.token).toBeTruthy();
  expect(result.orgId).toBeNull();
});

test("public signup cannot opt into verified passwordless account creation", async () => {
  const res = await SELF.fetch("https://example.com/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "unverified@example.test", passwordless: true }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/password/i);
  expect(await env.DB.prepare("SELECT github_id FROM users WHERE email = 'unverified@example.test'").first()).toBeNull();
});

test("five wrong guesses burn the code", async () => {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const withMail = { ...env, ...MAIL };
  await requestCode(withMail, { email: "guess@example.com" });
  const code = codeFrom(sent[0]);
  const wrong = code === "000000" ? "111111" : "000000";

  for (let i = 0; i < 5; i++) {
    expect((await verifyCode(withMail, { email: "guess@example.com", code: wrong })).error).toBeTruthy();
  }
  // Even the right code is worthless now.
  expect((await verifyCode(withMail, { email: "guess@example.com", code })).error).toBeTruthy();
});

test("an expired code is not accepted", async () => {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const withMail = { ...env, ...MAIL };
  await requestCode(withMail, { email: "slow@example.com" });
  const code = codeFrom(sent[0]);
  await env.DB.prepare("UPDATE login_codes SET expires_at = ?1 WHERE email = ?2")
    .bind(new Date(Date.now() - 1000).toISOString(), "slow@example.com").run();

  expect((await verifyCode(withMail, { email: "slow@example.com", code })).error).toBeTruthy();
});

test("asking again straight away is refused, and does not replace the live code", async () => {
  const { requestCode, verifyCode } = await import("../src/otp.js");
  const withMail = { ...env, ...MAIL };
  await requestCode(withMail, { email: "eager@example.com" });
  const code = codeFrom(sent[0]);

  const again = await requestCode(withMail, { email: "eager@example.com" });
  expect(again.status).toBe(429);
  expect(sent).toHaveLength(1);
  expect((await verifyCode(withMail, { email: "eager@example.com", code })).token).toBeTruthy();
});

test("mail that does not send leaves nothing behind to block a retry", async () => {
  globalThis.fetch = async () => new Response("no", { status: 403 });
  const { requestCode } = await import("../src/otp.js");
  const result = await requestCode({ ...env, ...MAIL }, { email: "bounce@example.com" });

  expect(result.status).toBe(502);
  // The provider's status travels; its message does not. A number tells a bad
  // key from a permission from a malformed request, and names nobody.
  expect(result.providerStatus).toBe(403);
  const row = await env.DB.prepare("SELECT email FROM login_codes WHERE email = ?1")
    .bind("bounce@example.com").first();
  expect(row).toBeNull();
});

test("without mail configured the endpoint says so, rather than pretending", async () => {
  const res = await SELF.fetch("https://example.com/auth/otp/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.com" }),
  });
  expect(res.status).toBe(503);
  expect((await res.json()).message).toMatch(/not configured/i);
});

test("the verify route rejects a code that is not six digits before touching the database", async () => {
  const res = await SELF.fetch("https://example.com/auth/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.com", code: "12" }),
  });
  expect(res.status).toBe(400);
});

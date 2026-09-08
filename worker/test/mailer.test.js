import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";

// One key, no domain, no DNS. These pin that a deployment with nothing set
// sends nothing and breaks nothing, and that a refusal comes back with what
// Resend actually said — because the usual causes are indistinguishable from
// outside and the explanation is always in the body.

let calls = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: typeof input === "string" ? input : input.url, init });
    return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("with no key, nothing is sent and nothing throws", async () => {
  const { isMailConfigured, sendMail } = await import("../src/mailer.js");
  expect(isMailConfigured(env)).toBe(false);
  const result = await sendMail(env, { to: "a@b.com", subject: "s", text: "t" });
  expect(result.ok).toBe(false);
  expect(result.skipped).toBe("mail not configured");
  expect(calls).toHaveLength(0);
});

test("one key is the whole setup", async () => {
  const { isMailConfigured, sendMail, mailFrom } = await import("../src/mailer.js");
  const withKey = { ...env, RESEND_API_KEY: "re_test" };

  expect(isMailConfigured(withKey)).toBe(true);
  // The shared sender needs no domain. It only reaches the account's owner,
  // which is a real limit — and the one that works in two minutes.
  expect(mailFrom(withKey)).toContain("onboarding@resend.dev");

  const result = await sendMail(withKey, { to: "pat@example.com", subject: "Hello", text: "Body" });
  expect(result.ok).toBe(true);
  expect(calls[0].url).toBe("https://api.resend.com/emails");
  expect(calls[0].init.headers.authorization).toBe("Bearer re_test");
  const body = JSON.parse(calls[0].init.body);
  expect(body.to).toEqual(["pat@example.com"]);
  expect(body.subject).toBe("Hello");
  expect(body.text).toBe("Body");
});

test("a verified domain's From line wins over the shared sender", async () => {
  const { mailFrom } = await import("../src/mailer.js");
  const from = "Honmaru <hi@honmaru.jp>";
  expect(mailFrom({ ...env, RESEND_API_KEY: "re", NOTIFY_EMAIL_FROM: from })).toBe(from);
});

test("a refusal comes back with what Resend actually said", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "The gmail.com domain is not verified" }), { status: 403 });
  const { sendMail } = await import("../src/mailer.js");

  const result = await sendMail({ ...env, RESEND_API_KEY: "re_test" }, { to: "a@b.com", subject: "s", text: "t" });
  expect(result.ok).toBe(false);
  expect(result.status).toBe(403);
  // Without this, "no mail arrived" has no answer but a shrug.
  expect(result.detail).toContain("not verified");
});

test("a network failure is a failed send, not a thrown one", async () => {
  globalThis.fetch = async () => { throw new Error("dns"); };
  const { sendMail } = await import("../src/mailer.js");
  const result = await sendMail({ ...env, RESEND_API_KEY: "re_test" }, { to: "a@b.com", subject: "s", text: "t" });
  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
});

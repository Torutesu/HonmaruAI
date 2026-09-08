import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";

// Whoever runs this deployment has to get mail credentials from somewhere, and
// "somewhere" keeps changing its free tier. Two providers, one caller, and the
// caller cannot tell them apart — these pin that, and pin that a refusal comes
// back with the provider's own explanation rather than a shrug.

let calls = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("with nothing configured, nothing is sent and nothing throws", async () => {
  const { isMailConfigured, sendMail } = await import("../src/mailer.js");
  expect(isMailConfigured(env)).toBe(false);
  const result = await sendMail(env, { to: "a@b.com", subject: "s", text: "t" });
  expect(result.ok).toBe(false);
  expect(result.skipped).toBe("mail not configured");
  expect(calls).toHaveLength(0);
});

test("a Resend key alone is enough — no domain, no DNS", async () => {
  const { isMailConfigured, sendMail, mailFrom } = await import("../src/mailer.js");
  const withResend = { ...env, RESEND_API_KEY: "re_test" };

  expect(isMailConfigured(withResend)).toBe(true);
  // The shared sender needs no domain. It only reaches the account's owner,
  // which is a real limit — but it is the one that works in two minutes.
  expect(mailFrom(withResend)).toContain("onboarding@resend.dev");

  const result = await sendMail(withResend, { to: "pat@example.com", subject: "Hello", text: "Body" });
  expect(result.ok).toBe(true);
  expect(result.provider).toBe("resend");
  expect(calls[0].url).toBe("https://api.resend.com/emails");
  expect(calls[0].init.headers.authorization).toBe("Bearer re_test");
  const body = JSON.parse(calls[0].init.body);
  expect(body.to).toEqual(["pat@example.com"]);
  expect(body.subject).toBe("Hello");
  expect(body.text).toBe("Body");
});

test("Mailgun still works, as a form post", async () => {
  const { sendMail } = await import("../src/mailer.js");
  const withMailgun = { ...env, MAILGUN_API_KEY: "key-x", MAILGUN_DOMAIN: "mg.example.com" };

  const result = await sendMail(withMailgun, { to: "pat@example.com", subject: "Hello", text: "Body" });
  expect(result.ok).toBe(true);
  expect(result.provider).toBe("mailgun");
  expect(calls[0].url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
  const form = Object.fromEntries(new URLSearchParams(calls[0].init.body));
  expect(form.to).toBe("pat@example.com");
  expect(form.from).toContain("no-reply@mg.example.com");
});

test("the EU base is honoured", async () => {
  const { sendMail } = await import("../src/mailer.js");
  await sendMail(
    { ...env, MAILGUN_API_KEY: "key-x", MAILGUN_DOMAIN: "mg.example.com", MAILGUN_API_BASE: "https://api.eu.mailgun.net" },
    { to: "a@b.com", subject: "s", text: "t" }
  );
  expect(calls[0].url).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
});

test("an explicit From line wins over either provider's default", async () => {
  const { mailFrom } = await import("../src/mailer.js");
  const from = "Honmaru <hi@honmaru.jp>";
  expect(mailFrom({ ...env, RESEND_API_KEY: "re", NOTIFY_EMAIL_FROM: from })).toBe(from);
  expect(mailFrom({ ...env, MAILGUN_DOMAIN: "mg.x.com", NOTIFY_EMAIL_FROM: from })).toBe(from);
});

test("with both configured, Resend is the one used", async () => {
  const { sendMail } = await import("../src/mailer.js");
  await sendMail(
    { ...env, RESEND_API_KEY: "re_test", MAILGUN_API_KEY: "key-x", MAILGUN_DOMAIN: "mg.example.com" },
    { to: "a@b.com", subject: "s", text: "t" }
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain("resend.com");
});

test("a refusal comes back with what the provider actually said", async () => {
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

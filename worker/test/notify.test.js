import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { notifyCard } from "../src/notify.js";
import { composeAlert, composeEmail, t, actionLabel } from "../src/notifyCopy.js";
import { resetProviderToken } from "../src/apns.js";

// The hub's promise: whoever a card is waiting on is told, in their language,
// on something they actually have — and never about their own actions.

const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const apns = (over = {}) => ({
  ...env,
  APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.honmaru.ai",
  APNS_PRIVATE_KEY: TEST_P8, APNS_ENVIRONMENT: "sandbox",
  ...over,
});
const mail = (over = {}) => ({
  ...env, MAILGUN_API_KEY: "key-test", MAILGUN_DOMAIN: "mg.example.com", APP_WEB_URL: "https://app.example.com/",
  ...over,
});

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, registerDevice } = await import("../src/db.js");
  // Taro reads Japanese and has a phone. Alice reads English and has a phone.
  // Kenji reads Japanese and has nothing but an email address.
  await upsertUser(env.DB, { githubId: "8001", login: "taro", name: "Taro", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8002", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:kenji@example.com", login: "u:kenji@example.com", name: "Kenji", avatarUrl: null, locale: "ja" });
  await env.DB.prepare("UPDATE users SET email = 'kenji@example.com' WHERE github_id = 'email:kenji@example.com'").run();
  await registerDevice(env.DB, { deviceToken: "tok-taro", githubId: "8001", login: "taro" });
  await registerDevice(env.DB, { deviceToken: "tok-alice", githubId: "8002", login: "alice" });
});

beforeEach(() => { resetProviderToken(); fetchMock.activate(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

function interceptAPNs(token, sink) {
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: `/3/device/${token}`, method: "POST", body: (b) => { sink.push(JSON.parse(b)); return true; } })
    .reply(200, {});
}

test("the copy exists in every supported language and falls back to English", () => {
  expect(t("ja", "waiting")).toBe("決定待ちがあります");
  expect(t("en", "waiting")).toBe("A decision is waiting");
  expect(t("fr", "waiting")).toBe("A decision is waiting");
  expect(t("ja", "fromAI", { name: "alice" })).toBe("aliceのAI → あなた");
  expect(actionLabel("ja", "approve")).toBe("承認");
  expect(actionLabel("en", "revised")).toBe("asked for changes");
});

test("a Japanese reader gets a Japanese alert, in the words the relay translated", async () => {
  const bodies = [];
  interceptAPNs("tok-taro", bodies);
  const card = {
    id: "c-1", recipientUserID: "taro", senderUserID: "alice", status: "pending",
    title: "Approve the office lease",
    summary: "Marketing wants another 4M yen",
    localized: { ja: { title: "オフィス賃貸契約の承認", summary: "マーケティングが追加で400万円を希望" } },
  };
  const result = await notifyCard(apns(), { card, kind: "created", excludeLogin: "alice", badge: 1 });
  expect(result.sent).toBe(1);
  expect(result.locale).toBe("ja");
  expect(bodies[0].aps.alert).toEqual({ title: "オフィス賃貸契約の承認", subtitle: "aliceのAI → あなた" });
  // Still only the title and the routing line: the summary stays off the lock screen.
  expect(JSON.stringify(bodies[0])).not.toContain("400万円");
  expect(JSON.stringify(bodies[0])).not.toContain("4M yen");
});

test("the sender hears about the decision in their own language, with the action as a word", async () => {
  const bodies = [];
  interceptAPNs("tok-taro", bodies);
  const card = {
    id: "c-2", recipientUserID: "alice", senderUserID: "taro", status: "rejected",
    title: "オフィス賃貸契約の承認",
    localized: { en: { title: "Approve the office lease" } },
    decision: { action: "decline", actorUserID: "alice" },
  };
  await notifyCard(apns(), { card, kind: "decided", excludeLogin: "alice" });
  // The original was written for taro; the English version is alice's.
  expect(bodies[0].aps.alert).toEqual({ title: "オフィス賃貸契約の承認", subtitle: "alice · 却下" });
});

test("a nudge is a reminder, not a second decision", async () => {
  const bodies = [];
  interceptAPNs("tok-taro", bodies);
  const card = { id: "c-3", recipientUserID: "taro", senderUserID: "alice", status: "pending", title: "Sign off the deck" };
  await notifyCard(apns(), { card, kind: "nudged", excludeLogin: "alice" });
  expect(bodies[0].aps.alert.subtitle).toBe("aliceがあなたの決定を待っています");
  expect(bodies[0].kind).toBe("nudged");
});

test("a digest is a count in the reader's language, and names no card", async () => {
  const bodies = [];
  interceptAPNs("tok-taro", bodies);
  await notifyCard(apns(), {
    card: { id: "digest-taro", recipientUserID: "taro" }, kind: "digest", count: 3, badge: 3,
  });
  expect(bodies[0].aps.alert).toEqual({ title: "3件の決定があなたを待っています", subtitle: "あなたのAI → あなた" });
  expect(bodies[0].aps.badge).toBe(3);
});

test("someone with no device and no browser is emailed, in their language, once", async () => {
  let form;
  fetchMock.get("https://api.mailgun.net")
    .intercept({ path: "/v3/mg.example.com/messages", method: "POST", body: (b) => { form = new URLSearchParams(b); return true; } })
    .reply(200, { id: "<msg>" });

  const card = {
    id: "c-mail", recipientUserID: "u:kenji@example.com", senderUserID: "alice", status: "pending",
    title: "Approve the vendor contract", summary: "Three-year term, auto-renews.",
    localized: { ja: { title: "ベンダー契約の承認", summary: "3年契約、自動更新。" } },
  };
  const result = await notifyCard(mail(), { card, kind: "created", excludeLogin: "alice" });
  expect(result.channels).toEqual({ apns: 0, webpush: 0, email: 1 });
  expect(form.get("to")).toBe("kenji@example.com");
  expect(form.get("subject")).toBe("[Honmaru] ベンダー契約の承認");
  expect(form.get("text")).toContain("3年契約、自動更新。");
  expect(form.get("text")).toContain("https://app.example.com/?card=c-mail");
  expect(form.get("from")).toContain("@mg.example.com");
});

test("email is the floor, not a duplicate: a delivered push means no mail", async () => {
  const bodies = [];
  interceptAPNs("tok-alice", bodies);
  await env.DB.prepare("UPDATE users SET email = 'alice@example.com' WHERE github_id = '8002'").run();
  // No Mailgun interceptor: a mail here would fail the test.
  const result = await notifyCard(apns(mail()), {
    card: { id: "c-both", recipientUserID: "alice", senderUserID: "taro", status: "pending", title: "Ship it" },
    kind: "created", excludeLogin: "taro",
  });
  expect(result.channels).toEqual({ apns: 1, webpush: 0, email: 0 });
});

test("someone who turned email off is not emailed", async () => {
  await env.DB.prepare("UPDATE users SET notify_email = 0 WHERE github_id = 'email:kenji@example.com'").run();
  const result = await notifyCard(mail(), {
    card: { id: "c-off", recipientUserID: "u:kenji@example.com", senderUserID: "alice", status: "pending", title: "Anything" },
    kind: "created", excludeLogin: "alice",
  });
  expect(result.sent).toBe(0);
  await env.DB.prepare("UPDATE users SET notify_email = 1 WHERE github_id = 'email:kenji@example.com'").run();
});

test("you are never told about your own action, on any channel", async () => {
  const result = await notifyCard(apns(mail()), {
    card: { id: "c-self", recipientUserID: "taro", senderUserID: "alice", status: "pending", title: "X" },
    kind: "created", excludeLogin: "taro",
  });
  expect(result.skipped).toBe("no one to tell");
});

test("composeAlert and composeEmail agree on the words", () => {
  const card = { id: "c", recipientUserID: "taro", senderUserID: "alice", title: "Lease", summary: "Two floors" };
  const alert = composeAlert({ card, kind: "created", locale: "en" });
  const email = composeEmail({ card, kind: "created", locale: "en", url: "https://x.example/?card=c" });
  expect(alert).toEqual({ title: "Lease", subtitle: "alice's AI → you" });
  expect(email.subject).toBe("[Honmaru] Lease");
  expect(email.text).toContain("alice's AI → you");
  expect(email.text).toContain("Two floors");
  expect(email.text).toContain("https://x.example/?card=c");
});

test("a mistyped APP_WEB_URL costs the link, not the notification", async () => {
  // `new URL` throws on anything that is not absolute, and this is built into
  // the payload of every push — so a secret set to a pasted shell command
  // silently stopped every notification on every channel.
  const bodies = [];
  interceptAPNs("tok-taro", bodies);
  const result = await notifyCard(apns({ APP_WEB_URL: "cd ~/HonmaruAI" }), {
    card: { id: "c-badlink", recipientUserID: "taro", senderUserID: "alice", status: "pending", title: "Still arrives" },
    kind: "created", excludeLogin: "alice",
  });
  expect(result.sent).toBe(1);
  expect(bodies[0].aps.alert.title).toBe("Still arrives");

  // The email path builds the same link, and must survive it too.
  let form;
  fetchMock.get("https://api.mailgun.net")
    .intercept({ path: "/v3/mg.example.com/messages", method: "POST", body: (b) => { form = new URLSearchParams(b); return true; } })
    .reply(200, { id: "<msg>" });
  const mailed = await notifyCard(mail({ APP_WEB_URL: "not a url" }), {
    card: { id: "c-badlink-2", recipientUserID: "u:kenji@example.com", senderUserID: "alice", status: "pending", title: "Also arrives" },
    kind: "created", excludeLogin: "alice",
  });
  expect(mailed.channels.email).toBe(1);
  expect(form.get("text")).not.toContain("not a url");

  // A good one still produces the link.
  const good = [];
  interceptAPNs("tok-taro", good);
  await notifyCard(apns({ APP_WEB_URL: "https://honmaru-web.pages.dev" }), {
    card: { id: "c-goodlink", recipientUserID: "taro", senderUserID: "alice", status: "pending", title: "With a link" },
    kind: "created", excludeLogin: "alice",
  });
  expect(good[0].aps.alert.title).toBe("With a link");
});

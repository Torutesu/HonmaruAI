import { SELF, env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { accessToken, assertion, isDeadFcmToken, isFcmConfigured, isFcmToken, resetAccessToken, sendFcm } from "../src/fcm.js";
import { resetProviderToken } from "../src/apns.js";
import { sendDuePushes, clearDelivered, PUSH_DELAY_MS } from "../src/pushes.js";
import { notifyCard } from "../src/notify.js";

// Android phones, through Firebase Cloud Messaging (HTTP v1).
//
// The Worker authenticates as a Google service account: an RS256 JWT signed
// with the account's key, traded at Google's token endpoint for an hour-long
// access token. The key here is made fresh for each run by Web Crypto, so no
// private key — not even a test one — lives in the repository, and the token
// endpoint below checks the signature with the matching public key the way
// Google would.

const ORG = "personal:fcm";
const PROJECT = "honmaru-test";
const ANDROID = `fcm-token_${"x".repeat(40)}:APA91b${"y".repeat(100)}`;
const IPHONE = "c".repeat(64);

let keys;
let account;

async function makeAccount() {
  keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    type: "service_account",
    project_id: PROJECT,
    private_key_id: "key-1",
    private_key: pem,
    client_email: `push@${PROJECT}.iam.gserviceaccount.com`,
  };
}

const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const fcmEnv = (over = {}) => ({ ...env, FCM_SERVICE_ACCOUNT: JSON.stringify(account), ...over });
const bothEnv = () => fcmEnv({
  APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.honmaru.ai",
  APNS_PRIVATE_KEY: TEST_P8, APNS_ENVIRONMENT: "sandbox",
});

const decode = (part) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
const bytesOf = (part) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/// Google's token endpoint: checks the JWT's signature against the account's
/// public key, and answers with an access token.
function tokenEndpoint({ token = "ya29.test", times = 1 } = {}) {
  const seen = [];
  fetchMock.get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(async (opts) => {
      const form = new URLSearchParams(opts.body);
      const jwt = form.get("assertion");
      const [h, c, s] = jwt.split(".");
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, bytesOf(s), new TextEncoder().encode(`${h}.${c}`));
      seen.push({ grant: form.get("grant_type"), valid, claims: decode(c) });
      return valid ? { statusCode: 200, data: { access_token: token, expires_in: 3599, token_type: "Bearer" } } : { statusCode: 400, data: { error: "invalid_grant" } };
    })
    .times(times);
  return seen;
}

/// The FCM send endpoint, recording each message it is handed.
function fcmEndpoint(answer = () => ({ statusCode: 200, data: { name: `projects/${PROJECT}/messages/1` } }), times = 1) {
  const sent = [];
  fetchMock.get("https://fcm.googleapis.com")
    .intercept({ path: `/v1/projects/${PROJECT}/messages:send`, method: "POST" })
    .reply((opts) => { const body = JSON.parse(opts.body); sent.push({ auth: opts.headers.authorization, message: body.message }); return answer(body.message); })
    .times(times);
  return sent;
}

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "content-type": "application/json", "x-session-token": token }, body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  await settle();
  return res;
};

let toru; let mika;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name] of [["9901", "toru", "Toru"], ["9902", "mika", "Mika"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member");
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9901" });
  toru = await createSession(env.DB, "9901", "gho_t");
  mika = await createSession(env.DB, "9902", "gho_m");
  account ||= await makeAccount();
  resetAccessToken();
  resetProviderToken();
  fetchMock.activate();
});
afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });

/// Every address the code under test reached for, matched by the mock or
/// not. A request the mock does not know throws inside fetch, and sendPush
/// swallows that, so "no interceptor matched" alone would not fail a test.
function outbound() {
  const urls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (input, init) => { urls.push(new Request(input, init).url); return inner(input, init); };
  return { urls, stop: () => { globalThis.fetch = inner; } };
}

const register = (token, body) => SELF.fetch("https://example.com/devices", {
  method: "POST",
  headers: { "content-type": "application/json", "x-session-token": token },
  body: JSON.stringify(body),
});
const deviceRow = (deviceToken) => env.DB.prepare("SELECT login, platform FROM device_tokens WHERE device_token = ?1").bind(deviceToken).first();

test("the service account is read from the secret, and a broken one reads as not set", () => {
  expect(isFcmConfigured(fcmEnv())).toBe(true);
  expect(isFcmConfigured(fcmEnv({ FCM_SERVICE_ACCOUNT: btoa(JSON.stringify(account)) }))).toBe(true);
  expect(isFcmConfigured({ ...env })).toBe(false);
  expect(isFcmConfigured(fcmEnv({ FCM_SERVICE_ACCOUNT: "{not json" }))).toBe(false);
  expect(isFcmConfigured(fcmEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: PROJECT }) }))).toBe(false);
});

test("the assertion is an RS256 JWT for the messaging scope, signed by the service account", async () => {
  const jwt = await assertion(account, 1_700_000_000_000);
  const [h, c, s] = jwt.split(".");
  expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
  expect(decode(c)).toEqual({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_700_000_000, exp: 1_700_003_600,
  });
  expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, bytesOf(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
});

test("the access token is asked for once and reused until five minutes before it expires", async () => {
  const seen = tokenEndpoint({ token: "ya29.first" });
  const t0 = 1_700_000_000_000;
  expect(await accessToken(fcmEnv(), t0)).toBe("ya29.first");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ grant: "urn:ietf:params:oauth:grant-type:jwt-bearer", valid: true });
  // Fifty minutes on: still the same one, and Google is not asked again.
  expect(await accessToken(fcmEnv(), t0 + 50 * 60_000)).toBe("ya29.first");
  // Fifty-six minutes on, inside the margin: a fresh one.
  tokenEndpoint({ token: "ya29.second" });
  expect(await accessToken(fcmEnv(), t0 + 56 * 60_000)).toBe("ya29.second");
});

test("a message goes out data-only, grouped per conversation, every value a string", async () => {
  tokenEndpoint();
  const sent = fcmEndpoint();
  const result = await sendFcm(fcmEnv(), {
    token: ANDROID, title: "Toru · #Cafe", text: "@Mika the order?", tag: "o1|b:cafe",
    data: { kind: "message", orgId: "o1", channel: "b:cafe", messageId: "m1", parentId: null },
  });
  expect(result).toEqual({ ok: true, status: 200 });
  expect(sent[0].auth).toBe("Bearer ya29.test");
  expect(sent[0].message).toEqual({
    token: ANDROID,
    data: {
      kind: "message", orgId: "o1", channel: "b:cafe", messageId: "m1",
      title: "Toru · #Cafe", message: "@Mika the order?",
      // What the app reads on a tap (expo-notifications parses it into the
      // notification's data).
      body: JSON.stringify({ kind: "message", orgId: "o1", channel: "b:cafe", messageId: "m1", parentId: null }),
      channelId: "messages",
      tag: "o1|b:cafe",
    },
    android: { priority: "HIGH", ttl: "86400s", collapse_key: "o1|b:cafe" },
  });
  // No `notification` block: the app draws it, so a tap carries the data.
  expect(sent[0].message.notification).toBeUndefined();
});

test("a dead token is told apart from a bad day", async () => {
  tokenEndpoint();
  fcmEndpoint(() => ({ statusCode: 404, data: { error: { code: 404, status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } } }));
  const gone = await sendFcm(fcmEnv(), { token: ANDROID, title: "t", text: "b" });
  expect(gone).toEqual({ ok: false, status: 404, reason: "UNREGISTERED" });
  expect(isDeadFcmToken(gone)).toBe(true);
  expect(isDeadFcmToken({ status: 400, reason: "UNREGISTERED" })).toBe(true);
  expect(isDeadFcmToken({ status: 503, reason: "UNAVAILABLE" })).toBe(false);
  expect(isDeadFcmToken({ status: 429, reason: "QUOTA_EXCEEDED" })).toBe(false);
  expect(isDeadFcmToken({ status: 0, reason: "exception" })).toBe(false);
});

test("an access token Google stops honouring is replaced once, and the send retried", async () => {
  tokenEndpoint({ token: "ya29.old" });
  tokenEndpoint({ token: "ya29.new" });
  let calls = 0;
  const sent = fcmEndpoint(() => (++calls === 1 ? { statusCode: 401, data: { error: { status: "UNAUTHENTICATED" } } } : { statusCode: 200, data: {} }), 2);
  expect((await sendFcm(fcmEnv(), { token: ANDROID, title: "t", text: "b" })).ok).toBe(true);
  expect(sent.map((s) => s.auth)).toEqual(["Bearer ya29.old", "Bearer ya29.new"]);
});

test("without the secret nothing is sent and nothing throws", async () => {
  expect(await sendFcm({ ...env }, { token: ANDROID, title: "t", text: "b" })).toEqual({ ok: false, status: 0, reason: "not-configured" });
});

test("an Android phone registers with its platform; an iPhone still needs to say nothing", async () => {
  expect(isFcmToken(ANDROID)).toBe(true);
  expect(isFcmToken("../../x")).toBe(false);
  expect((await register(mika, { deviceToken: ANDROID, platform: "android" })).status).toBe(200);
  expect(await deviceRow(ANDROID)).toEqual({ login: "mika", platform: "android" });
  // The shipped iPhone app sends no platform: it is an iPhone.
  expect((await register(mika, { deviceToken: IPHONE })).status).toBe(200);
  expect(await deviceRow(IPHONE)).toEqual({ login: "mika", platform: "ios" });
  expect((await register(mika, { deviceToken: IPHONE, platform: "ios" })).status).toBe(200);
  // Neither, or a token that is not one.
  expect((await register(mika, { deviceToken: ANDROID, platform: "windows" })).status).toBe(400);
  expect((await register(mika, { deviceToken: "has spaces and / slashes", platform: "android" })).status).toBe(400);
  // An FCM token is not hex, so it cannot be filed as an iPhone.
  expect((await register(mika, { deviceToken: ANDROID, platform: "ios" })).status).toBe(400);
  // Signing out forgets it.
  const del = await SELF.fetch("https://example.com/devices", {
    method: "DELETE", headers: { "content-type": "application/json", "x-session-token": mika }, body: JSON.stringify({ deviceToken: ANDROID }),
  });
  expect(del.status).toBe(200);
  expect(await deviceRow(ANDROID)).toBeNull();
});

test("a mention reaches the Android phone through FCM and the iPhone through APNs", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: ANDROID, githubId: "9902", login: "mika", platform: "android" });
  await registerDevice(env.DB, { deviceToken: IPHONE, githubId: "9902", login: "mika", environment: "sandbox" });
  const res = await call("/channels/messages", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: "@Mika the order?" } });
  const { message } = await res.json();

  tokenEndpoint();
  const sent = fcmEndpoint();
  const apns = [];
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: `/3/device/${IPHONE}`, method: "POST" })
    .reply((opts) => { apns.push(JSON.parse(opts.body)); return { statusCode: 200, data: "" }; });

  expect(await sendDuePushes(bothEnv(), Date.now() + PUSH_DELAY_MS + 1000)).toEqual({ sent: 1, skipped: 0 });
  expect(sent).toHaveLength(1);
  expect(sent[0].message.data).toMatchObject({ kind: "message", orgId: ORG, channel: "b:cafe", messageId: message.id, tag: `${ORG}|b:cafe`, message: "@Mika the order?" });
  expect(sent[0].message.data.title).toContain("Toru");
  expect(JSON.parse(sent[0].message.data.body)).toMatchObject({ orgId: ORG, channel: "b:cafe", messageId: message.id });
  expect(sent[0].message.android.collapse_key).toBe(`${ORG}|b:cafe`);
  // The iPhone's grouping is unchanged.
  expect(apns[0].aps["thread-id"]).toBe(`${ORG}|b:cafe`);
});

test("with no FCM secret an Android phone is skipped silently, and never handed to Apple", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: ANDROID, githubId: "9902", login: "mika", platform: "android" });
  await call("/channels/messages", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: "@Mika the order?" } });
  // APNs is configured and FCM is not: nothing may leave the Worker at all.
  const apnsOnly = { ...bothEnv(), FCM_SERVICE_ACCOUNT: undefined };
  const seen = outbound();
  expect(await sendDuePushes(apnsOnly, Date.now() + PUSH_DELAY_MS + 1000)).toEqual({ sent: 0, skipped: 1 });
  seen.stop();
  expect(seen.urls).toEqual([]);
  // Still registered: skipped is not dead.
  expect(await deviceRow(ANDROID)).toEqual({ login: "mika", platform: "android" });
});

test("someone out of the workspace before a queued push is due is not sent it", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: ANDROID, githubId: "9902", login: "mika", platform: "android" });
  await call("/channels/messages", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: "@Mika the order?" } });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE login = 'mika'").first()).n).toBe(1);
  // Gone within the minute; the phone is still registered to her login.
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9902'").bind(ORG).run();
  const seen = outbound();
  expect(await sendDuePushes(fcmEnv(), Date.now() + PUSH_DELAY_MS + 1000)).toEqual({ sent: 0, skipped: 1 });
  seen.stop();
  expect(seen.urls).toEqual([]);
});

test("an uninstalled app's token is deleted after FCM says so", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: ANDROID, githubId: "9902", login: "mika", platform: "android" });
  await call("/channels/messages", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: "@Mika the order?" } });
  tokenEndpoint();
  fcmEndpoint(() => ({ statusCode: 404, data: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } }));
  expect(await sendDuePushes(fcmEnv(), Date.now() + PUSH_DELAY_MS + 1000)).toEqual({ sent: 0, skipped: 1 });
  expect(await deviceRow(ANDROID)).toBeNull();
});

test("the silent read-clearing push goes to iPhones only", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: ANDROID, githubId: "9902", login: "mika", platform: "android" });
  await registerDevice(env.DB, { deviceToken: IPHONE, githubId: "9902", login: "mika", environment: "sandbox" });
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES ('m-clear', ?1, 'b:cafe', 'toru', 'message', 'hi', ?2)").bind(ORG, now).run();
  await env.DB.prepare("INSERT INTO push_queue (org_id, login, message_id, reason, created_at, due_at, sent_at) VALUES (?1, 'mika', 'm-clear', 'mention', ?2, ?2, ?2)").bind(ORG, now).run();
  fetchMock.get("https://api.sandbox.push.apple.com").intercept({ path: `/3/device/${IPHONE}`, method: "POST" }).reply(200, "");
  const seen = outbound();
  expect(await clearDelivered(bothEnv(), ORG, "mika", { key: "b:cafe", view: "b:cafe", thread: null, lastReadAt: new Date(Date.now() + 1000).toISOString() })).toBe(1);
  seen.stop();
  expect(seen.urls).toEqual([`https://api.sandbox.push.apple.com/3/device/${IPHONE}`]);
  expect(await deviceRow(ANDROID)).toEqual({ login: "mika", platform: "android" });
});

test("a card reaches an Android phone too, one notification per card", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: ANDROID, githubId: "9902", login: "mika", platform: "android" });
  tokenEndpoint();
  const sent = fcmEndpoint();
  const card = { id: "c-fcm", recipientUserID: "mika", senderUserID: "toru", status: "pending", title: "Approve the Q3 budget", priority: "high", createdAt: "2026-08-15T00:00:00Z" };
  const result = await notifyCard(fcmEnv(), { card, kind: "created" });
  expect(result.channels).toEqual({ apns: 0, fcm: 1, webpush: 0, email: 0 });
  expect(sent[0].message.data).toMatchObject({ kind: "created", cardId: "c-fcm", tag: "c-fcm", title: "Approve the Q3 budget" });
  expect(sent[0].message.android).toMatchObject({ priority: "HIGH", collapse_key: "c-fcm" });
});

test("a deploy onto a database predating the platform column files every token as an iPhone", async () => {
  await env.DB.exec("DROP TABLE IF EXISTS device_tokens");
  await env.DB.exec("CREATE TABLE device_tokens (device_token TEXT PRIMARY KEY, user_github_id TEXT NOT NULL, login TEXT NOT NULL, environment TEXT NOT NULL DEFAULT 'production', updated_at TEXT NOT NULL)");
  await env.DB.prepare("INSERT INTO device_tokens VALUES (?1, '9902', 'mika', 'production', '2026-09-01T00:00:00Z')").bind(IPHONE).run();
  const migrations = (await import("../migrations.sql?raw")).default;
  const line = migrations.split("\n").find((l) => l.startsWith("ALTER TABLE device_tokens ADD COLUMN platform"));
  expect(line).toBeTruthy();
  await env.DB.exec(line);
  expect(await deviceRow(IPHONE)).toEqual({ login: "mika", platform: "ios" });
});

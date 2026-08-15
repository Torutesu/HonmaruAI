import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { notifyCard } from "../src/push.js";
import { providerToken, resetProviderToken, isDeadToken } from "../src/apns.js";

// A P-256 private key in PKCS#8 PEM, generated for this test only. It is not a
// credential — it signs nothing that exists — and it is here because the point
// of these tests is that we can produce a real ES256 JWT without a library.
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const pushEnv = () => ({
  ...env,
  APNS_KEY_ID: "ABC1234567",
  APNS_TEAM_ID: "TEAM123456",
  APNS_TOPIC: "com.honmaru.ai",
  APNS_PRIVATE_KEY: TEST_P8,
  APNS_ENVIRONMENT: "sandbox",
});

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, registerDevice, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "5001", login: "alice", name: null, avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "5002", login: "bob", name: null, avatarUrl: null, locale: "en" });
  await registerDevice(env.DB, { deviceToken: "tok-alice-phone", githubId: "5001", login: "alice" });
  await registerDevice(env.DB, { deviceToken: "tok-alice-ipad", githubId: "5001", login: "alice" });
  globalThis.__aliceSession = await createSession(env.DB, "5001", "gho_alice");
});

beforeEach(() => {
  resetProviderToken();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const card = (over = {}) => ({
  id: "c-push", recipientUserID: "alice", senderUserID: "bob",
  status: "pending", title: "Approve the Q3 budget",
  summary: "Marketing wants another 4M yen for the launch",
  priority: "high", createdAt: "2026-08-15T00:00:00Z", ...over,
});

test("the provider token is a real ES256 JWT and is reused", async () => {
  // Apple throttles a provider token refreshed more than once every 20 minutes,
  // so minting one per push is a way to get rate limited by Apple.
  const first = await providerToken(pushEnv(), 1_000_000);
  const [header, claims, signature] = first.split(".");
  expect(JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({
    alg: "ES256", kid: "ABC1234567",
  });
  expect(JSON.parse(atob(claims.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({
    iss: "TEAM123456",
  });
  expect(signature.length).toBeGreaterThan(80);

  expect(await providerToken(pushEnv(), 1_000_000 + 60_000)).toBe(first);
  // Apple refuses one older than an hour.
  expect(await providerToken(pushEnv(), 1_000_000 + 50 * 60 * 1000)).not.toBe(first);
});

test("every device the recipient has is told, and the body says nothing private", async () => {
  const bodies = [];
  for (const token of ["tok-alice-phone", "tok-alice-ipad"]) {
    fetchMock.get("https://api.sandbox.push.apple.com")
      .intercept({ path: `/3/device/${token}`, method: "POST", body: (b) => { bodies.push(JSON.parse(b)); return true; } })
      .reply(200, {});
  }

  const result = await notifyCard(pushEnv(), { card: card(), kind: "created", excludeLogin: "bob", badge: 3 });
  expect(result.sent).toBe(2);

  // The lock screen is a public surface. The title and who it came from are
  // enough to know it is worth opening; the summary can carry a number that
  // should not be readable over a shoulder.
  const body = bodies[0];
  expect(body.aps.alert.title).toBe("Approve the Q3 budget");
  expect(body.aps.alert.subtitle).toBe("bob's AI → you");
  expect(JSON.stringify(body)).not.toContain("4M yen");
  expect(body.aps.badge).toBe(3);
  expect(body.cardId).toBe("c-push");
});

test("you are not notified about your own decision", async () => {
  // The most common shape of a bad notification.
  const result = await notifyCard(pushEnv(), {
    card: card({ recipientUserID: "alice" }), kind: "created", excludeLogin: "alice",
  });
  expect(result.sent).toBe(0);
});

test("a decision notifies the person who asked for it", async () => {
  const bodies = [];
  for (const token of ["tok-alice-phone", "tok-alice-ipad"]) {
    fetchMock.get("https://api.sandbox.push.apple.com")
      .intercept({ path: `/3/device/${token}`, method: "POST", body: (b) => { bodies.push(JSON.parse(b)); return true; } })
      .reply(200, {});
  }

  const decided = card({
    recipientUserID: "bob", senderUserID: "alice", status: "approved",
    decision: { action: "approve", actorUserID: "bob" },
  });
  const result = await notifyCard(pushEnv(), { card: decided, kind: "decided", excludeLogin: "bob" });
  expect(result.sent).toBe(2);
  expect(bodies[0].aps.alert.subtitle).toContain("approve");
});

test("a dead token is dropped rather than retried forever", async () => {
  const { registerDevice, devicesForLogin } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: "tok-uninstalled", githubId: "5002", login: "bob" });

  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: "/3/device/tok-uninstalled", method: "POST" })
    .reply(410, { reason: "Unregistered" });

  await notifyCard(pushEnv(), { card: card({ recipientUserID: "bob" }), kind: "created", excludeLogin: "alice" });
  expect(await devicesForLogin(env.DB, "bob")).toHaveLength(0);
});

test("an APNs outage is not an error the caller has to handle", async () => {
  // A push is a courtesy on top of a decision already recorded and broadcast.
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: "/3/device/tok-alice-phone", method: "POST" })
    .reply(500, {});
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: "/3/device/tok-alice-ipad", method: "POST" })
    .reply(503, {});

  const result = await notifyCard(pushEnv(), { card: card(), kind: "created", excludeLogin: "bob" });
  expect(result.sent).toBe(0);

  // A 500 is Apple having a bad day, not a token that will never work again.
  const { devicesForLogin } = await import("../src/db.js");
  expect(await devicesForLogin(env.DB, "alice")).toHaveLength(2);
});

test("nothing is attempted when APNs is not configured", async () => {
  // No interceptors registered: a single request here would fail the test.
  const result = await notifyCard(env, { card: card(), kind: "created", excludeLogin: "bob" });
  expect(result.sent).toBe(0);
  expect(result.skipped).toBe("apns not configured");
});

test("registering a device needs a session", async () => {
  const anonymous = await SELF.fetch("https://example.com/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: "tok-new" }),
  });
  expect(anonymous.status).toBe(401);

  const res = await SELF.fetch("https://example.com/devices", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": globalThis.__aliceSession },
    body: JSON.stringify({ deviceToken: "tok-new" }),
  });
  expect(res.status).toBe(200);

  const row = await env.DB
    .prepare("SELECT login FROM device_tokens WHERE device_token = 'tok-new'")
    .first();
  // The login is taken from the session, never from the request.
  expect(row).toMatchObject({ login: "alice" });
});

test("a token reissued to a different account moves with it", async () => {
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: "tok-shared", githubId: "5001", login: "alice" });
  await registerDevice(env.DB, { deviceToken: "tok-shared", githubId: "5002", login: "bob" });

  const row = await env.DB
    .prepare("SELECT login FROM device_tokens WHERE device_token = 'tok-shared'")
    .first();
  // Otherwise the previous user of a shared phone keeps getting the new one's
  // decisions.
  expect(row).toMatchObject({ login: "bob" });
});

test("a dead token is told apart from a bad day", () => {
  expect(isDeadToken({ status: 410, reason: "Unregistered" })).toBe(true);
  expect(isDeadToken({ status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(isDeadToken({ status: 400, reason: "PayloadTooLarge" })).toBe(false);
  expect(isDeadToken({ status: 503, reason: "" })).toBe(false);
});

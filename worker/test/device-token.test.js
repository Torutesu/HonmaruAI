import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { sendPush, resetProviderToken } from "../src/apns.js";

// Two identifiers that came off a client and went straight into a request to
// Apple without ever being looked at.
//
// A device token is 64 hex characters. `POST /devices` checked only that the
// field was truthy, stored whatever arrived, and `sendPush` interpolated it
// into the URL path — so a token of `../../foo` becomes a request to a
// different Apple endpoint, signed with our provider JWT.
//
// A collapse id is the card's own id, which is length-capped and not
// charset-checked. In a header value a newline is not a character: the Headers
// constructor throws, `sendPush` catches it, and that card's push silently
// never goes out. webpush.js strips its equivalent field; this one did not.

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

const GOOD_TOKEN = "a".repeat(64);
let token;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "6600", login: "phoneowner", name: "Owner", avatarUrl: null, locale: "en" });
  token = await createSession(env.DB, "6600", "gho_phone");
});

beforeEach(() => { resetProviderToken(); fetchMock.activate(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

const register = (deviceToken) =>
  SELF.fetch("https://example.com/devices", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ deviceToken }),
  });

test("a device token that is not a device token is refused at the door", async () => {
  for (const bad of [
    "../../foo",
    "tok/with/slashes",
    "has spaces",
    "abc?query=1",
    "zz".repeat(32),
    "a".repeat(9),
    "a".repeat(400),
  ]) {
    const res = await register(bad);
    expect(res.status, bad.slice(0, 24)).toBe(400);
  }

  const { getDeviceTokens } = await import("../src/db.js").then((m) => ({
    getDeviceTokens: async () =>
      (await env.DB.prepare("SELECT device_token FROM device_tokens").all()).results || [],
  }));
  expect(await getDeviceTokens()).toHaveLength(0);
});

test("a real one is taken", async () => {
  expect((await register(GOOD_TOKEN)).status).toBe(200);
  const row = await env.DB
    .prepare("SELECT device_token FROM device_tokens WHERE device_token = ?1")
    .bind(GOOD_TOKEN).first();
  expect(row).toBeTruthy();
});

test("a collapse id with a newline in it does not silently lose the push", async () => {
  let sentHeaders = null;
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: `/3/device/${GOOD_TOKEN}`, method: "POST" })
    .reply((opts) => { sentHeaders = opts.headers; return { statusCode: 200, data: "" }; });

  const result = await sendPush(pushEnv(), {
    deviceToken: GOOD_TOKEN,
    payload: { aps: { alert: { title: "Hi" } } },
    // A card id is length-capped and not charset-checked, so this is a shape
    // a client can actually produce.
    collapseId: "card-1\r\nx-injected: yes",
  });

  expect(result.ok).toBe(true);
  const collapse = sentHeaders?.["apns-collapse-id"] ?? sentHeaders?.["Apns-Collapse-Id"];
  expect(collapse).toBeTruthy();
  expect(collapse).not.toContain("\n");
  expect(collapse).not.toContain("\r");
  expect(collapse).not.toContain(" ");
});

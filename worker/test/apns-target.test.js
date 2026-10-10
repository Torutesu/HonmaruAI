import { SELF, env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { sendPush, resetProviderToken, targetFor, allowedAppIds } from "../src/apns.js";
import { devicesForLogin } from "../src/db.js";

// Two iPhone apps, one server: the App Store app (com.honmaru.ai) and the
// Expo build beside it (com.honmaru.ai.poc). APNs delivers a notification
// only under the topic of the app the token belongs to, and a development
// build's token only through the sandbox. A phone now says which app it is and
// where its token is from; one that registered before it could say keeps
// exactly what it had.

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
  APNS_ENVIRONMENT: "production",
});

let session;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM device_tokens;");
  const { upsertUser, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "6700", login: "twoapps", name: "Two", avatarUrl: null, locale: "en" });
  session = await createSession(env.DB, "6700", "gho_two");
  resetProviderToken();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const register = (body) => SELF.fetch("https://example.com/devices", {
  method: "POST",
  headers: { "content-type": "application/json", "x-session-token": session },
  body: JSON.stringify(body),
});

test("each phone is sent under its own app's topic, through its own gateway", () => {
  const e = pushEnv();
  expect(targetFor(e, null)).toEqual({ topic: "com.honmaru.ai", host: "https://api.push.apple.com" });
  // The App Store app names no app: the deployment's topic, through the
  // gateway its token is from — an Xcode build's token is a sandbox token.
  expect(targetFor(e, { app_id: null, environment: "sandbox" })).toEqual({ topic: "com.honmaru.ai", host: "https://api.sandbox.push.apple.com" });
  expect(targetFor(e, { app_id: null, environment: "production" })).toEqual({ topic: "com.honmaru.ai", host: "https://api.push.apple.com" });
  expect(targetFor(e, { app_id: "com.honmaru.ai.poc", environment: "sandbox" })).toEqual({ topic: "com.honmaru.ai.poc", host: "https://api.sandbox.push.apple.com" });
  expect(targetFor(e, { app_id: "com.honmaru.ai.poc", environment: "production" })).toEqual({ topic: "com.honmaru.ai.poc", host: "https://api.push.apple.com" });
  // An app this deployment does not send for falls back rather than being used.
  expect(targetFor(e, { app_id: "com.evil.app", environment: "production" }).topic).toBe("com.honmaru.ai");
  expect(allowedAppIds({ APNS_APP_IDS: "a.b", APNS_TOPIC: "c.d" })).toEqual(["a.b", "c.d"]);
});

test("an App Store phone reaches production whatever the deployment's APNS_ENVIRONMENT says", () => {
  // Unset, the deployment's setting means the sandbox — where every App
  // Store token is refused as BadDeviceToken and the phone then forgotten.
  const unset = { ...pushEnv(), APNS_ENVIRONMENT: undefined };
  expect(targetFor(unset, { app_id: null, environment: "production" }).host).toBe("https://api.push.apple.com");
  expect(targetFor({ ...pushEnv(), APNS_ENVIRONMENT: "sandbox" }, { app_id: null, environment: "production" }).host).toBe("https://api.push.apple.com");
  // Only a device that cannot say falls back to the deployment's choice.
  expect(targetFor(unset, null).host).toBe("https://api.sandbox.push.apple.com");
});

test("a phone says which app and gateway it is; anything else is refused", async () => {
  const token = "b".repeat(64);
  expect((await register({ deviceToken: token, platform: "ios", appId: "com.honmaru.ai.poc", environment: "sandbox" })).status).toBe(200);
  expect(await devicesForLogin(env.DB, "twoapps")).toEqual([{ device_token: token, environment: "sandbox", platform: "ios", app_id: "com.honmaru.ai.poc" }]);
  expect((await register({ deviceToken: token, platform: "ios", appId: "com.other.app" })).status).toBe(400);
  expect((await register({ deviceToken: token, platform: "ios", environment: "development" })).status).toBe(400);
  // The App Store app as it ships today: no appId, and it keeps working.
  expect((await register({ deviceToken: "c".repeat(64), environment: "production" })).status).toBe(200);
});

test("the notification goes out under the Expo build's topic, to the sandbox", async () => {
  let headers;
  fetchMock.get("https://api.sandbox.push.apple.com")
    .intercept({ path: `/3/device/${"d".repeat(64)}`, method: "POST" })
    .reply((opts) => { headers = opts.headers; return { statusCode: 200, data: "" }; });
  const result = await sendPush(pushEnv(), {
    deviceToken: "d".repeat(64),
    device: { app_id: "com.honmaru.ai.poc", environment: "sandbox" },
    payload: { aps: { alert: "hi" } },
  });
  expect(result.ok).toBe(true);
  expect(headers["apns-topic"]).toBe("com.honmaru.ai.poc");
});

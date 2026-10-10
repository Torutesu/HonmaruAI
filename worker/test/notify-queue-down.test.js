import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { notifyCard } from "../src/notify.js";
import { queueMessagePushes } from "../src/pushes.js";
import { resetProviderToken } from "../src/apns.js";
import { listMembers } from "../src/team.js";

// Every notification is written to a queue first, so a failed delivery is
// tried again. When D1 refused writes (the free tier's daily row limit),
// the queue write threw, every caller only logged it, and the notification
// was gone: nothing reached a phone all day. Now it is sent there and then.

const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;
const LIMIT = "D1_ERROR: Your account has exceeded D1's free tier daily row write limit.";

// D1 as it is past its daily writes: every write refused, reads still answered.
const refusingWrites = () => {
  const writes = /^\s*(INSERT|UPDATE|DELETE)/i;
  const refused = (sql) => ({ bind: () => refused(sql), run: () => Promise.reject(new Error(LIMIT)), first: () => Promise.reject(new Error(LIMIT)), all: () => Promise.reject(new Error(LIMIT)), refused: true });
  return {
    prepare: (sql) => (writes.test(sql) ? refused(sql) : env.DB.prepare(sql)),
    batch: (statements) => (statements.some((s) => s.refused) ? Promise.reject(new Error(LIMIT)) : env.DB.batch(statements)),
  };
};
const settings = (DB = refusingWrites()) => ({
  ...env, DB,
  APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.honmaru.ai", APNS_PRIVATE_KEY: TEST_P8, APNS_ENVIRONMENT: "sandbox",
});
const delivered = (token) => fetchMock.get("https://api.sandbox.push.apple.com").intercept({ path: `/3/device/${token}`, method: "POST" }).reply(200, {});

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM notification_jobs; DELETE FROM push_queue; DELETE FROM device_tokens; DELETE FROM memberships; DELETE FROM users; DELETE FROM channel_messages;");
  const { upsertUser, upsertMembership, registerDevice } = await import("../src/db.js");
  for (const [id, login] of [["9001", "sender"], ["9002", "reader"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, "queue-down", id, "member");
  }
  await registerDevice(env.DB, { deviceToken: "tok-reader", githubId: "9002", login: "reader", environment: "sandbox" });
  resetProviderToken();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a direct message still reaches the phone when its push cannot be queued", async () => {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES ('m1', 'queue-down', 'dm:reader|sender', 'sender', 'Are you in?', 'message', ?1)").bind(at).run();
  const row = await env.DB.prepare("SELECT * FROM channel_messages WHERE id = 'm1'").first();
  const members = await listMembers(env.DB, "queue-down", null);
  delivered("tok-reader");

  expect(await queueMessagePushes(settings(), "queue-down", row, { members })).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_queue").first()).n).toBe(0);
});

test("a decision still reaches the phone when its notification cannot be queued", async () => {
  delivered("tok-reader");
  const card = { id: "c1", recipientUserID: "reader", senderUserID: "sender", status: "pending", title: "Sign off the deck" };

  const result = await notifyCard(settings(), { card, kind: "created", excludeLogin: "sender", orgId: "queue-down" });

  expect(result.sent).toBeGreaterThan(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_jobs").first()).n).toBe(0);
});

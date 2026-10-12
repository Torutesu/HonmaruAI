import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { readAlready, recipientsOf, sendDuePushes } from "../src/pushes.js";
import { runMinuteJobs } from "../src/later.js";
import { resetProviderToken } from "../src/apns.js";
import { listMembers } from "../src/team.js";

// Notifications that were never sent, by design gone wrong: a thread reply
// cancelled by reading the channel it hangs off, the AI's answer told to
// nobody, a reminder only shown to an app that was open.

const ORG = "team:gaps";
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;
const withApns = { ...env, APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.honmaru.ai", APNS_PRIVATE_KEY: TEST_P8, APNS_ENVIRONMENT: "sandbox" };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM channel_messages; DELETE FROM channel_reads; DELETE FROM push_queue; DELETE FROM saved_items; DELETE FROM device_tokens; DELETE FROM memberships; DELETE FROM users; DELETE FROM cards; DELETE FROM notification_jobs; DELETE FROM user_activity; DELETE FROM channel_prefs;");
  const { upsertUser, upsertMembership, registerDevice } = await import("../src/db.js");
  for (const [id, login] of [["9901", "ann"], ["9902", "ben"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member");
  }
  await registerDevice(env.DB, { deviceToken: "a".repeat(64), githubId: "9901", login: "ann" });
  resetProviderToken();
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const say = (id, { channel = "b:general", author = "ben", parent = null, also = 0, kind = "message", at = ago(90_000) } = {}) =>
  env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, parent_id, also_channel, created_at) VALUES (?1, ?2, ?3, ?4, 'hi', ?5, ?6, ?7, ?8)")
    .bind(id, ORG, channel, author, kind, parent, also, at).run();
const read = (login, channel, at = ago(0)) =>
  env.DB.prepare("INSERT OR REPLACE INTO channel_reads (org_id, login, channel, last_read_at) VALUES (?1, ?2, ?3, ?4)").bind(ORG, login, channel, at).run();

test("reading a channel does not count as reading a thread nobody opened", async () => {
  await say("root", { author: "ann" });
  await say("reply", { parent: "root" });
  const reply = await env.DB.prepare("SELECT * FROM channel_messages WHERE id = 'reply'").first();
  await read("ann", "b:general");
  expect(await readAlready(env.DB, ORG, "ann", reply)).toBe(false);
  await read("ann", "t:root");
  expect(await readAlready(env.DB, ORG, "ann", reply)).toBe(true);
});

test("the AI's answer is for whoever asked it", async () => {
  await say("answer", { author: null, kind: "ai" });
  const answer = await env.DB.prepare("SELECT * FROM channel_messages WHERE id = 'answer'").first();
  const members = await listMembers(env.DB, ORG, null);
  expect(await recipientsOf(env.DB, ORG, answer, members)).toEqual([]);
  expect(await recipientsOf(env.DB, ORG, answer, members, { askedBy: "ann" })).toEqual([{ login: "ann", reason: "reply" }]);
});

test("a push not sent is not marked as sent", async () => {
  await say("dm1", { channel: "dm:ann|ben" });
  await env.DB.prepare("INSERT INTO push_queue (org_id, login, message_id, reason, created_at, due_at) VALUES (?1, 'ann', 'dm1', 'direct', ?2, ?2)").bind(ORG, ago(60_000)).run();
  await read("ann", "dm:ann|ben");
  expect(await sendDuePushes(env)).toEqual({ sent: 0, skipped: 1 });
  expect(await env.DB.prepare("SELECT last_error FROM push_queue").first()).toEqual({ last_error: "skipped" });
});

test("a reminder reaches the phone, not only an open app", async () => {
  await say("saved", { author: "ben" });
  await env.DB.prepare("INSERT INTO saved_items (id, org_id, login, message_id, channel, remind_at, created_at) VALUES ('s1', ?1, 'ann', 'saved', 'b:general', ?2, ?2)").bind(ORG, ago(60_000)).run();
  fetchMock.get("https://api.push.apple.com").intercept({ path: `/3/device/${"a".repeat(64)}`, method: "POST" }).reply(200, {});
  const out = await runMinuteJobs(withApns);
  expect(out.reminded).toBe(1);
});

// "All new posts" was stored as no setting at all, so choosing it changed
// nothing the phone could notice: a plain post in the channel reached nobody.
test("every post reaches whoever asked for every post, and nobody else; a reply in its thread does not", async () => {
  const { setChannelPref } = await import("../src/people.js");
  const members = await listMembers(env.DB, ORG, null);
  await say("plain", { author: "ben" });
  const plain = await env.DB.prepare("SELECT * FROM channel_messages WHERE id = 'plain'").first();
  expect(await recipientsOf(env.DB, ORG, plain, members)).toEqual([]);
  await setChannelPref(env.DB, { orgId: ORG, login: "ann", key: "b:general", level: "all" });
  expect(await recipientsOf(env.DB, ORG, plain, members)).toEqual([{ login: "ann", reason: "channel" }]);
  await say("inthread", { author: "ben", parent: "plain" });
  const reply = await env.DB.prepare("SELECT * FROM channel_messages WHERE id = 'inthread'").first();
  expect((await recipientsOf(env.DB, ORG, reply, members)).filter((r) => r.reason === "channel")).toEqual([]);
  // Back to no setting.
  await setChannelPref(env.DB, { orgId: ORG, login: "ann", key: "b:general", level: "default" });
  expect(await recipientsOf(env.DB, ORG, plain, members)).toEqual([]);
});

// A message said during quiet time was dropped for good: it never reached
// the phone, not even once the hours it waited for had come.
test("a push held by a pause goes when the pause ends, and only the latest few of a pile", async () => {
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  await env.DB.prepare("UPDATE users SET notify_paused_until = ?1 WHERE login = 'ann'").bind(until).run();
  for (const id of ["q1", "q2", "q3", "q4"]) {
    await say(id, { channel: "dm:ann|ben" });
    await env.DB.prepare("INSERT INTO push_queue (org_id, login, message_id, reason, created_at, due_at) VALUES (?1, 'ann', ?2, 'direct', ?3, ?3)").bind(ORG, id, ago(60_000)).run();
  }
  expect(await sendDuePushes(withApns)).toEqual({ sent: 0, skipped: 0 });
  const rows = (await env.DB.prepare("SELECT due_at, last_error, attempts, sent_at FROM push_queue ORDER BY id").all()).results;
  expect(rows.every((r) => r.last_error === "held" && r.due_at === until && r.attempts === 0 && r.sent_at === null)).toBe(true);

  // The pause over: the three latest go, the first is let go.
  const later = Date.parse(until) + 60_000;
  fetchMock.get("https://api.push.apple.com").intercept({ path: `/3/device/${"a".repeat(64)}`, method: "POST" }).reply(200, {}).times(3);
  expect(await sendDuePushes(withApns, later)).toEqual({ sent: 3, skipped: 1 });
});

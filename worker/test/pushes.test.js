import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { recipientsOf, queueMessagePushes, sendDuePushes, noteActivity, isActive, PUSH_DELAY_MS, pushPreview, pushWords } from "../src/pushes.js";
import { listMembers } from "../src/team.js";
import { fetchMock } from "./helpers/fetch-mock.js";

// A message reaches a phone after a minute, unless its person read it in
// that time — being at the app somewhere else is not having seen it.

const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const ORG = "personal:push";
let toru; let refs;
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
const queued = async () => (await env.DB.prepare("SELECT login, reason, sent_at FROM push_queue ORDER BY login").all()).results;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name] of [["8801", "toru", "Toru"], ["8802", "mika", "Mika"], ["8803", "kenji", "Kenji"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member");
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "8801" });
  toru = await createSession(env.DB, "8801", "gho_t");
  const people = await (await call(`/channels?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  refs = Object.fromEntries(people.members.map((m) => [m.name, m.ref]));
});

test("a DM, a mention, a thread: each person once, never the author", async () => {
  const members = await listMembers(env.DB, ORG, null);
  expect(await recipientsOf(env.DB, ORG, { id: "x1", kind: "message", channel: "dm:mika|toru", author_login: "toru", body: "hi" }, members))
    .toEqual([{ login: "mika", reason: "direct" }]);
  expect(await recipientsOf(env.DB, ORG, { id: "x2", kind: "message", channel: "b:cafe", author_login: "toru", body: "@Kenji look" }, members))
    .toEqual([{ login: "kenji", reason: "mention" }]);
  // A plain channel message is for nobody's phone.
  expect(await recipientsOf(env.DB, ORG, { id: "x3", kind: "message", channel: "b:cafe", author_login: "toru", body: "morning" }, members)).toEqual([]);
});

test("@channel reaches everyone who can read the conversation; @here only who is at the app", async () => {
  const members = await listMembers(env.DB, ORG, null);
  const all = await recipientsOf(env.DB, ORG, { id: "h1", kind: "message", channel: "b:cafe", author_login: "toru", body: "@channel standup in 5" }, members);
  expect(all.map((r) => r.login).sort()).toEqual(["kenji", "mika"]);
  expect(all.every((r) => r.reason === "mention")).toBe(true);
  await noteActivity(env.DB, ORG, "mika");
  const here = await recipientsOf(env.DB, ORG, { id: "h2", kind: "message", channel: "b:cafe", author_login: "toru", body: "@here standup in 5" }, members);
  expect(here.map((r) => r.login)).toEqual(["mika"]);
});

test("the member list carries a presence key that matches the relay's login, and no login", async () => {
  const res = await (await call(`/members?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  const mika = res.members.find((m) => m.name === "Mika");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mika")));
  expect(mika.presence).toBe([...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16));
  expect(JSON.stringify(res.members)).not.toContain('"login"');
});

test("a mention through the API is queued, and sent after a minute", async () => {
  const res = await call("/channels/messages", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: "@Mika the order?" } });
  expect(res.status).toBe(201);
  expect(await queued()).toEqual([{ login: "mika", reason: "mention", sent_at: null }]);
  // Not due yet.
  expect(await sendDuePushes(env, Date.now())).toEqual({ sent: 0, skipped: 0 });
  // Due; nothing configured to deliver through, so it counts as skipped but is claimed once.
  const later = Date.now() + PUSH_DELAY_MS + 1000;
  expect(await sendDuePushes(env, later)).toEqual({ sent: 0, skipped: 1 });
  expect(await sendDuePushes(env, later)).toEqual({ sent: 0, skipped: 0 });
});

test("at the app but not read: the phone is told; read: it stays still", async () => {
  const members = await listMembers(env.DB, ORG, null);
  const { registerDevice } = await import("../src/db.js");
  await registerDevice(env.DB, { deviceToken: "a".repeat(64), githubId: "8802", login: "mika", environment: "production", platform: "ios" });
  const pushed = [];
  fetchMock.activate();
  fetchMock.get("https://api.push.apple.com")
    .intercept({ path: `/3/device/${"a".repeat(64)}`, method: "POST" })
    .reply((opts) => { pushed.push(JSON.parse(opts.body)); return { statusCode: 200, data: "" }; })
    .persist();
  const penv = { ...env, APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.honmaru.ai", APNS_PRIVATE_KEY: TEST_P8 };
  const say = async (id, body, t) => {
    const at = new Date(t).toISOString();
    const row = { id, kind: "message", channel: "dm:mika|toru", author_login: "toru", body, created_at: at };
    await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'message', ?6)")
      .bind(row.id, ORG, row.channel, row.author_login, row.body, at).run();
    await queueMessagePushes(penv, ORG, row, { members, now: t });
  };
  try {
    // Mika is at the app on her laptop, somewhere else, the whole minute.
    const t0 = Date.now();
    await say("m1", "lunch?", t0);
    await noteActivity(env.DB, ORG, "mika", "web", t0 + 5000);
    await noteActivity(env.DB, ORG, "mika", "web", t0 + 50_000);
    expect(await isActive(env.DB, ORG, "mika", t0 + 55_000)).toBe(true);
    expect(await sendDuePushes(penv, t0 + PUSH_DELAY_MS + 1000)).toEqual({ sent: 1, skipped: 0 });
    expect(pushed).toHaveLength(1);

    // Read where it was said, at the laptop: the phone is not told.
    const t1 = t0 + 2 * PUSH_DELAY_MS;
    await say("m2", "1pm?", t1);
    await env.DB.prepare("INSERT INTO channel_reads (org_id, login, channel, last_read_at) VALUES (?1, 'mika', 'dm:mika|toru', ?2)")
      .bind(ORG, new Date(t1 + 3000).toISOString()).run();
    expect(await sendDuePushes(penv, t1 + PUSH_DELAY_MS + 1000)).toEqual({ sent: 0, skipped: 1 });
    expect(pushed).toHaveLength(1);
  } finally {
    fetchMock.deactivate();
  }

  // "At the app" still means something for cards, and asking for pushes anyway turns it off.
  const t2 = Date.now();
  await noteActivity(env.DB, "team:elsewhere", "mika", "web", t2);
  expect(await isActive(env.DB, "team:elsewhere", "mika", t2 + 10_000)).toBe(true);
  expect(await isActive(env.DB, "team:another", "mika", t2 + 10_000)).toBe(false);
  await env.DB.prepare("UPDATE users SET push_while_active = 1 WHERE login = 'mika'").run();
  expect(await isActive(env.DB, "team:elsewhere", "mika", t2 + 10_000)).toBe(false);
});

test("each person a message is for hears it at once in their open apps, with why", async () => {
  const members = await listMembers(env.DB, ORG, null);
  const told = [];
  const relay = { idFromName: (n) => n, get: () => ({ fetch: async (_url, init) => { told.push(...JSON.parse(init.body).deliveries); return new Response("{}"); } }) };
  const fenv = { ...env, ORG_RELAY: relay };
  const at = new Date().toISOString();
  // A group message is for everyone in it but its author.
  for (const login of ["toru", "mika", "kenji"]) {
    await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_at) VALUES (?1, 'g:abc', ?2, ?3)").bind(ORG, login, at).run();
  }
  await queueMessagePushes(fenv, ORG, { id: "g1", kind: "message", channel: "g:abc", author_login: "toru", body: "lunch?", created_at: at }, { members });
  // An @mention in a channel is for the person named.
  await queueMessagePushes(fenv, ORG, { id: "c1", kind: "message", channel: "b:cafe", author_login: "toru", body: "@Kenji look", created_at: at }, { members });
  const byMessage = (id) => told.filter((d) => d.event.value.id === id).map((d) => [d.to, d.event.value.reason]).sort();
  expect(told.every((d) => d.event.name === "message_for_you")).toBe(true);
  expect(byMessage("g1")).toEqual([["kenji", "direct"], ["mika", "direct"]]);
  expect(byMessage("c1")).toEqual([["kenji", "mention"]]);
  expect(told.some((d) => d.to === "toru")).toBe(false);
  // Nobody it is for: nothing said to anyone.
  told.length = 0;
  await queueMessagePushes(fenv, ORG, { id: "c2", kind: "message", channel: "b:cafe", author_login: "toru", body: "morning all", created_at: at }, { members });
  expect(told).toEqual([]);
});

test("a muted conversation is nobody's push", async () => {
  const members = await listMembers(env.DB, ORG, null);
  await env.DB.prepare("INSERT INTO channel_prefs (org_id, login, channel, level) VALUES (?1, 'kenji', 'b:cafe', 'mute')").bind(ORG).run();
  expect(await recipientsOf(env.DB, ORG, { id: "x4", kind: "message", channel: "b:cafe", author_login: "toru", body: "@Kenji @Mika" }, members))
    .toEqual([{ login: "mika", reason: "mention" }]);
});

test("a lock screen never gives a spoiler away, and a push stays one short line", () => {
  expect(pushPreview("the killer is ||the butler|| and ||his twin||")).toBe("the killer is ▇▇▇ and ▇▇▇");
  expect(pushPreview("line one\n\nline two")).toBe("line one line two");
  expect(pushPreview("a || b || c")).toBe("a ▇▇▇ c");
  expect(pushPreview("x".repeat(400))).toHaveLength(180);
  expect(pushPreview("")).toBe("");
});

test("the || of inline code never pairs with a real spoiler's bars", () => {
  expect(pushPreview("use `a || b` to check; the answer is ||42||")).toBe("use `a || b` to check; the answer is ▇▇▇");
  expect(pushPreview("||x `a || b` y||")).toBe("▇▇▇");
  // A translation that moved the code in front of the spoiler keeps it hidden.
  const written = "the answer is ||42|| — use `a || b` to check";
  const moved = "`a || b` で確認して、答えは ||42|| です";
  expect(pushPreview(pushWords(written, moved))).toBe("`a || b` で確認して、答えは ▇▇▇ です");
});

test("a translation that lost a spoiler's bars is not what a lock screen shows", () => {
  const written = "the killer is ||the butler||";
  // Kept the marks: the reader's language.
  expect(pushWords(written, "犯人は||執事||")).toBe("犯人は||執事||");
  // Dropped them, or wrote them full-width: the words as written, masked.
  expect(pushWords(written, "犯人は執事")).toBe(written);
  expect(pushWords(written, "犯人は｜｜執事｜｜")).toBe(written);
  expect(pushPreview(pushWords(written, "犯人は執事"))).toBe("the killer is ▇▇▇");
  // No spoiler, or nothing translated: as before.
  expect(pushWords("lunch?", "お昼？")).toBe("お昼？");
  expect(pushWords("lunch?", "")).toBe("lunch?");
});

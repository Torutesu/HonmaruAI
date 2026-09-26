import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { recipientsOf, queueMessagePushes, sendDuePushes, noteActivity, isActive, PUSH_DELAY_MS } from "../src/pushes.js";
import { listMembers } from "../src/team.js";

// A message reaches a phone only when its person is not already at the
// app: after a minute, unless they read it or were using HonmaruAI.

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

test("read it, or at the app since, and the phone stays still", async () => {
  const members = await listMembers(env.DB, ORG, null);
  const t0 = Date.now();
  const at = new Date(t0).toISOString();
  const row = { id: "m1", kind: "message", channel: "dm:mika|toru", author_login: "toru", body: "lunch?", created_at: at };
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'message', ?6)")
    .bind(row.id, ORG, row.channel, row.author_login, row.body, at).run();
  await queueMessagePushes(env, ORG, row, { members, now: t0 });
  await noteActivity(env.DB, "mika", "web", t0 + 5000);
  expect(await isActive(env.DB, "mika", t0 + 10_000)).toBe(true);
  expect(await isActive(env.DB, "mika", t0 + 10 * 60_000)).toBe(false);
  expect(await sendDuePushes(env, t0 + PUSH_DELAY_MS + 1000)).toEqual({ sent: 0, skipped: 1 });

  // Asking for pushes anyway turns "at the app" off.
  await env.DB.prepare("UPDATE users SET push_while_active = 1 WHERE login = 'mika'").run();
  expect(await isActive(env.DB, "mika", t0 + 10_000)).toBe(false);
});

test("a muted conversation is nobody's push", async () => {
  const members = await listMembers(env.DB, ORG, null);
  await env.DB.prepare("INSERT INTO channel_prefs (org_id, login, channel, level) VALUES (?1, 'kenji', 'b:cafe', 'mute')").bind(ORG).run();
  expect(await recipientsOf(env.DB, ORG, { id: "x4", kind: "message", channel: "b:cafe", author_login: "toru", body: "@Kenji @Mika" }, members))
    .toEqual([{ login: "mika", reason: "mention" }]);
});

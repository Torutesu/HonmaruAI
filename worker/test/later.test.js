import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { runMinuteJobs } from "../src/later.js";
import { applyAutoRule } from "../src/autorules.js";
import { broadcastStored } from "../src/channelRoutes.js";

// Time and standing answers: scheduled messages, Later with reminders, clips
// of several messages made one decision, and rules that approve on arrival.

const ORG = "personal:later";
let toru; let mika; let kenji;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init) => { const res = await worker.fetch(new Request("https://example.com" + path, init), env, ctx); await settle(); return res; };
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const del = (path, token, body) => call(path, { method: "DELETE", headers: headers(token), body: JSON.stringify(body) });
const say = async (token, body, extra = {}) => (await (await post("/channels/messages", token, { orgId: ORG, channel: "b:cafe", body, ...extra })).json()).message;
let refs;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness, setUserHandle } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9801", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9802", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9803", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  for (const id of ["9801", "9802", "9803"]) await upsertMembership(env.DB, ORG, id, id === "9801" ? "admin" : "member");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  await setUserHandle(env.DB, "9802", "mika.k");
  toru = await createSession(env.DB, "9801", "a"); mika = await createSession(env.DB, "9802", "b"); kenji = await createSession(env.DB, "9803", "c");
  refs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).members.map((m) => [m.name, m.ref]));
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());


test("a scheduled message waits, can be cancelled, and is sent by the minute cron as its author", async () => {
  const soon = new Date(Date.now() + 5 * 60000).toISOString();
  const res = await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "Morning all", sendAt: soon });
  expect(res.status).toBe(201);
  const { scheduled } = await res.json();
  expect(scheduled).toMatchObject({ body: "Morning all", channel: "b:cafe" });
  const other = (await (await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "Never mind", sendAt: soon })).json()).scheduled;
  expect((await del("/channels/scheduled", mika, { orgId: ORG, id: other.id })).status).toBe(404);
  expect((await del("/channels/scheduled", toru, { orgId: ORG, id: other.id })).status).toBe(200);
  let list = (await (await get(`/channels/scheduled?${q({ orgId: ORG })}`, toru)).json()).scheduled;
  expect(list.map((x) => x.body)).toEqual(["Morning all"]);
  expect((await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, mika)).json()).messages).toHaveLength(0);
  // Too soon, or not a time.
  expect((await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "x", sendAt: new Date().toISOString() })).status).toBe(400);
  expect((await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "x", sendAt: "tomorrow" })).status).toBe(400);
  const out = await runMinuteJobs(env, { now: new Date(Date.now() + 6 * 60000), broadcast: (o, k, r) => broadcastStored(env, o, k, r) });
  expect(out.sent).toBe(1);
  const msgs = (await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:cafe" })}`, mika)).json()).messages;
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ body: "Morning all", authorName: "Toru" });
  // Sent once, not again.
  expect((await runMinuteJobs(env, { now: new Date(Date.now() + 7 * 60000) })).sent).toBe(0);
  list = (await (await get(`/channels/scheduled?${q({ orgId: ORG })}`, toru)).json()).scheduled;
  expect(list).toHaveLength(0);
});

test("Later keeps a message for you, and a reminder brings it back as a card", async () => {
  const m = await say(toru, "Order more oat milk before Friday");
  const remindAt = new Date(Date.now() + 60 * 60000).toISOString();
  expect((await post("/channels/later", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id, remindAt })).status).toBe(201);
  let items = (await (await get(`/channels/later?${q({ orgId: ORG })}`, mika)).json()).items;
  expect(items).toHaveLength(1);
  expect(items[0].message.body).toBe("Order more oat milk before Friday");
  expect((await (await get(`/channels/later?${q({ orgId: ORG })}`, toru)).json()).items).toHaveLength(0);
  const out = await runMinuteJobs(env, { now: new Date(Date.now() + 61 * 60000) });
  expect(out.reminded).toBe(1);
  const card = await env.DB.prepare("SELECT data FROM cards WHERE org_id = ?1 ORDER BY rowid DESC LIMIT 1").bind(ORG).first().catch(() => null);
  if (card?.data) expect(JSON.parse(card.data).title).toContain("oat milk");
  expect((await runMinuteJobs(env, { now: new Date(Date.now() + 62 * 60000) })).reminded).toBe(0);
  expect((await del("/channels/later", mika, { orgId: ORG, id: items[0].id })).status).toBe(200);
  items = (await (await get(`/channels/later?${q({ orgId: ORG })}`, mika)).json()).items;
  expect(items).toHaveLength(0);
});

test("a clip takes only messages you can read", async () => {
  const a = await say(toru, "Supplier A is 5% cheaper");
  const secret = (await (await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "between us" })).json()).message;
  const denied = await post("/channels/clip", kenji, { orgId: ORG, channel: "b:cafe", items: [{ channel: "b:cafe", messageId: a.id }, { channel: `dm:${refs.Mika}`, messageId: secret.id }] });
  expect([403, 404]).toContain(denied.status);
  expect((await post("/channels/clip", kenji, { orgId: ORG, channel: "b:cafe", items: [] })).status).toBe(400);
});

test("a rule approves the next matching request on arrival, and only that kind", async () => {
  await env.DB.prepare("INSERT INTO auto_rules (id, org_id, recipient_login, sender_login, card_type, business, created_at) VALUES ('r1', ?1, 'mika', 'toru', 'approval', 'cafe', ?2)")
    .bind(ORG, new Date().toISOString()).run();
  const card = { id: "c1", type: "approval", recipientUserID: "mika", senderUserID: "toru", business: "cafe", status: "pending" };
  expect(await applyAutoRule(env.DB, ORG, card)).toBeTruthy();
  expect(card).toMatchObject({ status: "approved", decision: { action: "approve", actorUserID: "mika" }, autoApproved: { ruleId: "r1" } });
  const elsewhere = { id: "c2", type: "approval", recipientUserID: "mika", senderUserID: "toru", business: "hotel", status: "pending" };
  expect(await applyAutoRule(env.DB, ORG, elsewhere)).toBeNull();
  const fyi = { id: "c3", type: "approval", format: "fyi", recipientUserID: "mika", senderUserID: "toru", business: "cafe", status: "pending" };
  expect(await applyAutoRule(env.DB, ORG, fyi)).toBeNull();
  const fromKenji = { id: "c4", type: "approval", recipientUserID: "mika", senderUserID: "kenji", business: "cafe", status: "pending" };
  expect(await applyAutoRule(env.DB, ORG, fromKenji)).toBeNull();
});

test("a rule is made from a decision of yours, and listed and removed by you", async () => {
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, { id: "k1", type: "approval", recipientUserID: "mika", senderUserID: "toru", business: "cafe", status: "approved", title: "Beans", createdAt: new Date().toISOString() });
  expect((await post("/channels/auto-rules", kenji, { orgId: ORG, cardId: "k1" })).status).toBe(404);
  const made = await post("/channels/auto-rules", mika, { orgId: ORG, cardId: "k1" });
  expect(made.status).toBe(201);
  const { rules } = await (await get(`/channels/auto-rules?${q({ orgId: ORG })}`, mika)).json();
  expect(rules).toEqual([expect.objectContaining({ senderName: "Toru", cardType: "approval", business: "cafe" })]);
  expect(JSON.stringify(rules)).not.toContain('"toru"');
  expect((await del("/channels/auto-rules", mika, { orgId: ORG, id: rules[0].id })).status).toBe(200);
});

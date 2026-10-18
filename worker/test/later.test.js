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

test("a scheduled message whose send fails stays waiting and is sent, once, on a later minute", async () => {
  const soon = new Date(Date.now() + 5 * 60000).toISOString();
  await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "Deliveries at ten", sendAt: soon });
  // A database that refuses the matching statement once.
  const failing = (pattern) => {
    const realPrepare = env.DB.prepare.bind(env.DB);
    let failed = false;
    return { ...env, DB: new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql) => { if (!failed && pattern.test(sql)) { failed = true; throw new Error("D1 hiccup"); } return realPrepare(sql); };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) };
  };
  const minute = (m) => new Date(Date.now() + m * 60000);
  const listed = async () => (await (await get(`/channels/scheduled?${q({ orgId: ORG })}`, toru)).json()).scheduled.map((x) => x.body);
  const said = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id = ?1 AND body = 'Deliveries at ten'").bind(ORG).first()).n;

  // The insert fails: nothing said, still on its author's list.
  expect((await runMinuteJobs(failing(/INSERT INTO channel_messages/), { now: minute(6) })).sent).toBe(0);
  expect(await said()).toBe(0);
  expect(await listed()).toEqual(["Deliveries at ten"]);
  // Held a few minutes by the run that failed, then tried again.
  expect((await runMinuteJobs(env, { now: minute(7) })).sent).toBe(0);
  expect((await runMinuteJobs(env, { now: minute(12) })).sent).toBe(1);
  expect(await said()).toBe(1);
  expect(await listed()).toEqual([]);

  // Said, but not marked sent: tried again, it finds what it said.
  await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "Deliveries at eleven", sendAt: soon });
  await runMinuteJobs(failing(/^UPDATE scheduled_messages SET sent_at/), { now: minute(6) });
  await runMinuteJobs(env, { now: minute(12) });
  const eleven = await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id = ?1 AND body = 'Deliveries at eleven'").bind(ORG).first();
  expect(eleven.n).toBe(1);
  expect(await listed()).toEqual([]);
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

test("a reminder brings a message back only to someone who may still read it", async () => {
  const { postMessage } = await import("../src/channels.js");
  const { addMembers, removeMember } = await import("../src/access.js");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, private, created_at) VALUES (?1, 'board', 'Board', 1, ?2)").bind(ORG, now).run();
  await addMembers(env.DB, { orgId: ORG, key: "b:board", logins: ["toru", "mika", "kenji"], addedBy: "toru" });
  const said = async (body) => (await postMessage(env.DB, { orgId: ORG, key: "b:board", authorLogin: "toru", body })).row;
  const remindAt = new Date(Date.now() + 60 * 60000).toISOString();
  const save = async (token, m) => expect((await post("/channels/later", token, { orgId: ORG, channel: "b:board", messageId: m.id, remindAt })).status).toBe(201);
  const left = await said("Board: the plan before");
  const gone = await said("Board: a message about to go");
  const kept = await said("Board: still yours");
  await save(mika, left);
  await save(toru, gone);
  await save(kenji, kept);
  // Mika is taken out of the board, and the message says more after.
  await removeMember(env.DB, { orgId: ORG, key: "b:board", login: "mika" });
  await env.DB.prepare("UPDATE channel_messages SET body = 'Board: the plan after, with the price' WHERE id = ?1").bind(left.id).run();
  await env.DB.prepare("UPDATE channel_messages SET deleted_at = ?2 WHERE id = ?1").bind(gone.id, now).run();

  const out = await runMinuteJobs(env, { now: new Date(Date.now() + 61 * 60000) });
  expect(out.reminded).toBe(1);
  const cards = (await env.DB.prepare("SELECT recipient_user_id, data FROM cards WHERE org_id = ?1").bind(ORG).all()).results;
  expect(cards.map((c) => c.recipient_user_id)).toEqual(["kenji"]);
  expect(JSON.stringify(cards)).not.toContain("with the price");
  expect(JSON.stringify(cards)).not.toContain("about to go");
});

test("a reminder is not brought back to someone who left the workspace", async () => {
  const m = await say(toru, "Order more oat milk before Friday");
  expect((await post("/channels/later", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id, remindAt: new Date(Date.now() + 60 * 60000).toISOString() })).status).toBe(201);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9802'").bind(ORG).run();
  expect((await runMinuteJobs(env, { now: new Date(Date.now() + 61 * 60000) })).reminded).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1").bind(ORG).first()).n).toBe(0);
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

test("Sent lists what you said, newest first, only where you can still read it", async () => {
  const first = await say(toru, "Menu is up");
  await say(mika, "Thanks");
  const dm = (await (await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "Call me later" })).json()).message;
  const gone = await say(toru, "Oops, wrong channel");
  expect((await del("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", messageId: gone.id })).status).toBe(200);
  const sent = (await (await get(`/channels/sent?${q({ orgId: ORG })}`, toru)).json()).items;
  expect(sent.map((m) => m.body)).toEqual(["Call me later", "Menu is up"]);
  expect(sent[0]).toMatchObject({ id: dm.id, channel: `dm:${refs.Mika}` });
  expect(sent[1]).toMatchObject({ id: first.id, channel: "b:cafe" });
  // Another person's list is their own.
  expect((await (await get(`/channels/sent?${q({ orgId: ORG })}`, mika)).json()).items.map((m) => m.body)).toEqual(["Thanks"]);
  expect((await get(`/channels/sent?${q({ orgId: ORG })}`, "nope")).status).toBe(401);
});

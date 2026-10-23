import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { parseQuery } from "../src/channels.js";

// Where each person is up to, kept on the server so devices agree; the
// Activity inbox of what named you; and search over what was said.

const ORG = "personal:reading";
let toru; let mika; let kenji;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init) => { const res = await worker.fetch(new Request("https://example.com" + path, init), env, ctx); await settle(); return res; };
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
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

test("a read position is the person's, on every device, and never goes backwards", async () => {
  await say(toru, "hello");
  const at = new Date().toISOString();
  expect((await post("/channels/read", mika, { orgId: ORG, channel: "b:cafe", at })).status).toBe(200);
  await post("/channels/read", mika, { orgId: ORG, channel: "b:cafe", at: "2020-01-01T00:00:00Z" });
  const { reads } = await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json();
  expect(reads["b:cafe"]).toBe(at);
  // Toru said it, so Toru has read it.
  const mine = (await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).reads;
  expect(mine["b:cafe"]).toBeTruthy();
  // A DM is read under the name the reader gives it.
  await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "psst" });
  const mikaRefs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).members.map((m) => [m.name, m.ref]));
  await post("/channels/read", mika, { orgId: ORG, channel: `dm:${mikaRefs.Toru}` });
  const r2 = (await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).reads;
  expect(r2[`dm:${mikaRefs.Toru}`]).toBeTruthy();
  expect(JSON.stringify(r2)).not.toContain("toru|");
});

test("Activity holds what named you and replies in your threads, and nothing else", async () => {
  const mine = await say(mika, "Which roaster should we use?");
  await say(toru, "Answering", { parentId: mine.id });
  await say(kenji, "@mika.k can you check the invoice?");
  await say(kenji, "@Mika also the lease");
  await say(kenji, "unrelated chatter");
  const feed = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  expect(feed.items.map((i) => [i.type, i.message.body])).toEqual([
    ["mention", "@Mika also the lease"],
    ["mention", "@mika.k can you check the invoice?"],
    ["reply", "Answering"],
  ]);
  expect(feed.items.every((i) => i.unread)).toBe(true);
  await post("/channels/read", mika, { orgId: ORG, channel: "activity" });
  const after = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  expect(after.items.some((i) => i.unread)).toBe(false);
  // Toru sees none of Mika's.
  expect((await (await get(`/channels/activity?${q({ orgId: ORG })}`, toru)).json()).items).toHaveLength(0);
});

test("Activity tells you who reacted to what you wrote — not your own reactions, not others' messages", async () => {
  const mine = await say(mika, "Roaster moved to Friday");
  const theirs = await say(toru, "Noted");
  await post("/channels/reactions", toru, { orgId: ORG, channel: "b:cafe", messageId: mine.id, emoji: "👍" });
  await post("/channels/reactions", mika, { orgId: ORG, channel: "b:cafe", messageId: mine.id, emoji: "🎉" });
  await post("/channels/reactions", kenji, { orgId: ORG, channel: "b:cafe", messageId: theirs.id, emoji: "👀" });
  const feed = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  const reactions = feed.items.filter((i) => i.type === "reaction");
  expect(reactions).toHaveLength(1);
  expect(reactions[0]).toMatchObject({ emoji: "👍", by: "Toru", unread: true, message: { body: "Roaster moved to Friday" } });
  expect(reactions[0].at).toBeTruthy();
});

test("search finds what was said, with from:, in:, before:, and never across a DM you are not in", async () => {
  await say(toru, "The roaster wants +8%");
  await say(mika, "Roaster invoice attached");
  await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "secret roaster plan" });
  const s = async (token, query) => (await (await get(`/channels/search?${q({ orgId: ORG, q: query })}`, token)).json()).messages.map((m) => m.body);
  expect(await s(toru, "roaster")).toEqual(["secret roaster plan", "Roaster invoice attached", "The roaster wants +8%"]);
  expect(await s(kenji, "roaster")).toEqual(["Roaster invoice attached", "The roaster wants +8%"]);
  expect(await s(toru, "roaster from:@mika.k")).toEqual(["Roaster invoice attached"]);
  expect(await s(toru, "roaster in:#cafe")).toHaveLength(2);
  expect(await s(toru, "roaster before:2000-01-01")).toHaveLength(0);
  expect(await s(toru, "100%_")).toHaveLength(0);
  expect(parseQuery("price from:@mika in:#cafe is:pinned")).toMatchObject({ text: "price", from: "mika", in: "cafe", is: "pinned" });
});

test("what you read where it was said is no longer new in Activity: the conversation for a message, the thread for a reply", async () => {
  const mine = await say(mika, "Which roaster should we use?");
  await say(toru, "Answering", { parentId: mine.id });
  await say(kenji, "@Mika the lease, please");
  const unread = async () => (await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json()).items.filter((i) => i.unread).map((i) => i.message.body);
  expect((await unread()).sort()).toEqual(["@Mika the lease, please", "Answering"]);
  // Reading the channel clears the mention; the reply waits for its thread.
  await post("/channels/read", mika, { orgId: ORG, channel: "b:cafe", at: new Date(Date.now() + 1000).toISOString() });
  expect(await unread()).toEqual(["Answering"]);
  await post("/channels/read", mika, { orgId: ORG, channel: "b:cafe", thread: mine.id, at: new Date(Date.now() + 1000).toISOString() });
  expect(await unread()).toEqual([]);
});

test("an Activity item looked at on one device is no longer new on any, one at a time", async () => {
  const mine = await say(mika, "Roaster moved to Friday");
  await say(kenji, "@Mika the lease, please");
  await say(kenji, "@Mika and the invoice");
  await post("/channels/reactions", toru, { orgId: ORG, channel: "b:cafe", messageId: mine.id, emoji: "👍" });
  const { createSession } = await import("../src/db.js");
  const phone = await createSession(env.DB, "9802", "phone");
  const feed = async (token) => (await (await get(`/channels/activity?${q({ orgId: ORG })}`, token)).json()).items;
  const items = await feed(mika);
  expect(items.every((i) => /^(m|r):/.test(i.key))).toBe(true);
  const lease = items.find((i) => i.message.body.includes("lease"));
  const reaction = items.find((i) => i.type === "reaction");
  const res = await (await post("/channels/read", mika, { orgId: ORG, channel: "activity", items: [lease.key, reaction.key, "x:../etc", 42] })).json();
  expect(res.items).toEqual([lease.key, reaction.key]);
  // The phone agrees; the one not looked at is still new.
  const there = await feed(phone);
  expect(there.filter((i) => i.unread).map((i) => i.message.body)).toEqual(["@Mika and the invoice"]);
  // Not somebody else's to clear.
  await post("/channels/read", kenji, { orgId: ORG, channel: "activity", items: [lease.key] });
  expect((await feed(mika)).filter((i) => i.unread)).toHaveLength(1);
});

test("a message looked at in Activity, or read in its thread, is not pushed to the phone a minute later", async () => {
  const { readAlready } = await import("../src/pushes.js");
  const mine = await say(mika, "Which roaster?");
  const reply = await say(toru, "This one", { parentId: mine.id });
  const lease = await say(kenji, "@Mika the lease");
  const row = async (id) => env.DB.prepare("SELECT * FROM channel_messages WHERE id = ?1").bind(id).first();
  expect(await readAlready(env.DB, ORG, "mika", await row(lease.id))).toBe(false);
  expect(await readAlready(env.DB, ORG, "mika", await row(reply.id))).toBe(false);
  await post("/channels/read", mika, { orgId: ORG, channel: "activity", items: [`m:${lease.id}`] });
  await post("/channels/read", mika, { orgId: ORG, channel: "b:cafe", thread: mine.id, at: new Date(Date.now() + 1000).toISOString() });
  expect(await readAlready(env.DB, ORG, "mika", await row(lease.id))).toBe(true);
  expect(await readAlready(env.DB, ORG, "mika", await row(reply.id))).toBe(true);
});

test("an app looked at on one device is read on all of them, and only for the one who looked", async () => {
  const at = new Date().toISOString();
  const res = await post("/channels/read", mika, { orgId: ORG, channel: "app:routine", at });
  expect(res.status).toBe(200);
  expect((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).reads["app:routine"]).toBe(at);
  expect((await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json()).reads["app:routine"]).toBeUndefined();
  // Not a way to write any key it likes.
  expect((await post("/channels/read", mika, { orgId: ORG, channel: "app:../x" })).status).not.toBe(200);
});

test('read/unread acknowledgments and snapshots carry the same monotonic revision', async()=>{
 const message=await say(toru,'Read revision verification');
 const first=await (await post('/channels/read',mika,{orgId:ORG,channel:'b:cafe'})).json();
 const unread=await (await post('/channels/unread',mika,{orgId:ORG,channel:'b:cafe',messageId:message.id})).json();
 expect(first.readVersion).toBe(1);expect(unread.readVersion).toBe(2);
 expect(unread.lastReadAt<message.createdAt).toBe(true);
 const snapshot=await (await get(`/channels?${q({orgId:ORG})}`,mika)).json();
 expect(snapshot.reads['b:cafe']).toBe(unread.lastReadAt);expect(snapshot.readVersions['b:cafe']).toBe(2);
 const later=await (await post('/channels/read',mika,{orgId:ORG,channel:'b:cafe'})).json();
 expect(later.readVersion).toBe(3);
 expect(first.readVersion).toBe(1);
});

test('concurrent read mutations return their own atomic revision and the snapshot matches the last committed one',async()=>{
 const {markRead,markUnreadFrom,readsFor}=await import('../src/channels.js');
 const at='2020-01-01T00:00:00.000Z';
 const states=await Promise.all([
  markRead(env.DB,ORG,'mika','b:cafe',at,true),
  markUnreadFrom(env.DB,ORG,'mika','b:cafe',at,true),
  markRead(env.DB,ORG,'mika','b:cafe',at,true),
 ]);
 expect(states.map(s=>s.readVersion).sort()).toEqual([1,2,3]);
 const last=states.find(s=>s.readVersion===3);
 const snapshot=await readsFor(env.DB,ORG,'mika',[],true);
 expect(snapshot['b:cafe']).toEqual(last);
 const other=await markRead(env.DB,ORG,'kenji','b:cafe',at,true);
 expect(other.readVersion).toBe(1);
});

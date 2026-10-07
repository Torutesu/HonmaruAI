import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// "Also send to #channel", as Slack has: a thread reply that is read in the
// conversation as well, saying which thread it answers. One message, so an
// edit, an unsend or a reaction is the same in both places.

const ORG = "personal:alsochannel";
let toru; let mika; let kenji;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), env, ctx);
  await settle();
  return res;
};
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const get = (path, token) => call(path, { headers: headers(token) });
const del = (path, token, body) => call(path, { method: "DELETE", headers: headers(token), body: JSON.stringify(body) });
const q = (o) => new URLSearchParams(o).toString();
const list = async (token, channel = "b:cafe") => (await (await get(`/channels/messages?${q({ orgId: ORG, channel })}`, token)).json()).messages;
const send = (token, body, extra = {}) => post("/channels/messages", token, { orgId: ORG, channel: "b:cafe", body, ...extra });
const say = async (token, body, extra = {}) => (await (await send(token, body, extra)).json()).message;
let refs;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9801", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:mika@example.com", login: "u:mika@example.com", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9803", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9801", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@example.com", "member");
  await upsertMembership(env.DB, ORG, "9803", "member");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  await upsertBusiness(env.DB, ORG, { name: "Kitchen", createdBy: "9801" });
  toru = await createSession(env.DB, "9801", "gho_t");
  mika = await createSession(env.DB, "email:mika@example.com", "gho_m");
  kenji = await createSession(env.DB, "9803", "gho_k");
  const people = await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json();
  refs = Object.fromEntries(people.members.map((m) => [m.name, m.ref]));
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const thread = async (token, parentId) => (await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: parentId })}`, token)).json());

test("a thread reply sent to the conversation too is read in both, with the thread it answers", async () => {
  const parent = await say(mika, "Roaster wants +8% from Friday");
  const res = await send(toru, "Agreed, +5% it is", { parentId: parent.id, alsoChannel: true });
  expect(res.status).toBe(201);
  const { message, parent: after } = await res.json();
  expect(message.parentId).toBe(parent.id);
  expect(message.alsoChannel).toBe(true);
  expect(message.threadParent).toEqual({ id: parent.id, kind: "message", authorName: "Mika", authorRef: refs.Mika, excerpt: "Roaster wants +8% from Friday", deleted: false });
  expect(after.replyCount).toBe(1);
  // In the conversation, after the message it answers.
  const main = await list(kenji);
  expect(main.map((m) => m.body)).toEqual(["Roaster wants +8% from Friday", "Agreed, +5% it is"]);
  expect(main[1].alsoChannel).toBe(true);
  expect(main[1].threadParent.excerpt).toBe("Roaster wants +8% from Friday");
  // And in its thread, as any reply.
  const t = await thread(kenji, parent.id);
  expect((t.replies || t.messages || []).map((m) => m.body)).toContain("Agreed, +5% it is");
  // The sidebar's latest is it.
  const channels = await (await get(`/channels?${q({ orgId: ORG })}`, kenji)).json();
  expect(channels.activity.find((a) => a.channel === "b:cafe").preview).toBe("Agreed, +5% it is");
});

test("a thread reply stays in its thread unless asked, and only a thread reply can be sent to both", async () => {
  const parent = await say(mika, "Menu for Monday?");
  const reply = await say(toru, "Soup", { parentId: parent.id });
  expect(reply.alsoChannel).toBeUndefined();
  const plain = await say(toru, "Hello", { alsoChannel: true });
  expect(plain.alsoChannel).toBeUndefined();
  expect((await list(kenji)).map((m) => m.body)).toEqual(["Menu for Monday?", "Hello"]);
});

test("unsent, it goes from both places; edited, both show the new words", async () => {
  const parent = await say(mika, "Who opens tomorrow?");
  const reply = await say(toru, "I will", { parentId: parent.id, alsoChannel: true });
  const put = await call("/channels/messages", { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, channel: "b:cafe", messageId: reply.id, body: "I will, at 7" }) });
  expect(put.status).toBe(200);
  expect((await list(kenji)).at(-1).body).toBe("I will, at 7");
  const gone = await del("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", messageId: reply.id });
  expect(gone.status).toBe(200);
  expect((await list(kenji)).map((m) => m.body)).toEqual(["Who opens tomorrow?"]);
  const t = await thread(kenji, parent.id);
  expect((t.replies || t.messages || []).length).toBe(0);
});

test("the thread it answers, once unsent, is said to be gone", async () => {
  const parent = await say(toru, "Draft rota");
  await say(mika, "Looks fine", { parentId: parent.id, alsoChannel: true });
  // Its author unsends the parent; the reply by somebody else needs the thread to go too.
  const res = await del("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", messageId: parent.id, withThread: true });
  expect(res.status).toBe(200);
  expect((await list(kenji)).map((m) => m.body)).toEqual([]);
});

test("a scheduled thread reply can be sent to the conversation too", async () => {
  const parent = await say(mika, "Stock check");
  const res = await send(toru, "Done", { parentId: parent.id, alsoChannel: true, sendAt: new Date(Date.now() + 3600000).toISOString() });
  expect(res.status).toBe(201);
  expect((await res.json()).scheduled.alsoChannel).toBe(true);
  const { runMinuteJobs } = await import("../src/later.js");
  await runMinuteJobs(env, { now: new Date(Date.now() + 3700000) });
  const main = await list(kenji);
  expect(main.at(-1)).toMatchObject({ body: "Done", parentId: parent.id, alsoChannel: true });
});

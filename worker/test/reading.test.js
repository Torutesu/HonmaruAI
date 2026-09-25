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

import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { cleanEmoji, transcriptUpTo, channelActivity } from "../src/channels.js";

// What Slack lets you do to a message, here too: edit it, unsend it, react
// to it, reply under it in a thread, pin it.

const ORG = "personal:channels";
let toru; let mika; let kenji; let outsider;
const ENV = (over = {}) => ({ ...env, ...over });
// Work the Worker hands to waitUntil, awaited before a test looks at it.
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, over) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), ENV(over), ctx);
  await settle();
  return res;
};
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body, over) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, over);
const get = (path, token) => call(path, { headers: headers(token) });
const put = (path, token, body) => call(path, { method: "PUT", headers: headers(token), body: JSON.stringify(body) });
const del = (path, token, body) => call(path, { method: "DELETE", headers: headers(token), body: JSON.stringify(body) });
const list = async (token, channel = "b:cafe") => (await (await get(`/channels/messages?${q({ orgId: ORG, channel })}`, token)).json()).messages;
const say = async (token, body, extra = {}) => (await (await post("/channels/messages", token, { orgId: ORG, channel: "b:cafe", body, ...extra })).json()).message;
const q = (o) => new URLSearchParams(o).toString();
let refs;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9701", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:mika@example.com", login: "u:mika@example.com", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9703", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9704", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9701", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@example.com", "member");
  await upsertMembership(env.DB, ORG, "9703", "member");
  await upsertMembership(env.DB, "personal:else", "9704", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9701" });
  toru = await createSession(env.DB, "9701", "gho_t");
  mika = await createSession(env.DB, "email:mika@example.com", "gho_m");
  kenji = await createSession(env.DB, "9703", "gho_k");
  outsider = await createSession(env.DB, "9704", "gho_n");
  const list = await (await get(`/channels?${q({ orgId: ORG })}`, toru)).json();
  refs = Object.fromEntries(list.members.map((m) => [m.name, m.ref]));
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());


test("the author edits their words, and the message says it was edited", async () => {
  const m = await say(mika, "Roaster wants +8%");
  const res = await put("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id, body: "Roaster wants +6%" });
  expect(res.status).toBe(200);
  const [seen] = await list(toru);
  expect(seen.body).toBe("Roaster wants +6%");
  expect(seen.editedAt).toBeTruthy();
  // Nobody else may put words in Mika's mouth.
  expect((await put("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", messageId: m.id, body: "hijacked" })).status).toBe(403);
  expect((await put("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id, body: "  " })).status).toBe(400);
  // The edit is what the AI reads.
  const lines = await transcriptUpTo(env.DB, ORG, "b:cafe", new Date().toISOString());
  expect(lines.join("\n")).toContain("+6%");
});

test("unsend: the message goes, for everyone, and only its author can", async () => {
  const m = await say(mika, "wrong channel, sorry");
  expect((await del("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", messageId: m.id })).status).toBe(403);
  expect((await del("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id })).status).toBe(200);
  expect(await list(toru)).toHaveLength(0);
  // Gone from what the AI reads and from the sidebar's preview too.
  expect(await transcriptUpTo(env.DB, ORG, "b:cafe", new Date().toISOString())).toHaveLength(0);
  expect(await channelActivity(env.DB, ORG, "toru", [])).toHaveLength(0);
  expect((await del("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id })).status).toBe(404);
});

test("a deleted message with a thread under it stays as a tombstone, without its words", async () => {
  const m = await say(mika, "Which roaster?");
  await say(toru, "The one on 3rd", { parentId: m.id });
  await del("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id });
  const [seen] = await list(toru);
  expect(seen).toMatchObject({ id: m.id, deleted: true, body: "", replyCount: 1 });
});

test("replies go in a thread: off the main log, counted on the parent, readable together", async () => {
  const m = await say(mika, "Friday price change?");
  const r1 = await say(toru, "Yes, from Friday", { parentId: m.id });
  expect(r1.parentId).toBe(m.id);
  await say(kenji, "Agreed", { parentId: m.id });
  const main = await list(toru);
  expect(main).toHaveLength(1);
  expect(main[0]).toMatchObject({ replyCount: 2 });
  expect(main[0].replyRefs).toEqual([refs.Toru, refs.Kenji]);
  const thread = await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId: m.id })}`, mika)).json();
  expect(thread.parent.id).toBe(m.id);
  expect(thread.replies.map((x) => x.body)).toEqual(["Yes, from Friday", "Agreed"]);
  // One level deep, and only in the channel it belongs to.
  expect((await post("/channels/messages", toru, { orgId: ORG, channel: "b:cafe", body: "x", parentId: r1.id })).status).toBe(400);
  expect((await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "x", parentId: m.id })).status).toBe(400);
  // A reply does not make the channel look newly talked in.
  const act = await channelActivity(env.DB, ORG, "toru", []);
  expect(act[0].preview).toBe("Friday price change?");
});

test("reactions toggle, count per person, and name nobody by login", async () => {
  const m = await say(mika, "Shipped!");
  const react = (token, emoji) => post("/channels/reactions", token, { orgId: ORG, channel: "b:cafe", messageId: m.id, emoji });
  expect((await react(toru, "🎉")).status).toBe(200);
  await react(kenji, "🎉");
  await react(kenji, "👍");
  let [seen] = await list(toru);
  expect(seen.reactions).toEqual([
    { emoji: "🎉", count: 2, refs: [refs.Toru, refs.Kenji], mine: true },
    { emoji: "👍", count: 1, refs: [refs.Kenji], mine: false },
  ]);
  expect(JSON.stringify(seen)).not.toContain("kenji\"");
  await react(toru, "🎉");
  [seen] = await list(toru);
  expect(seen.reactions[0]).toMatchObject({ emoji: "🎉", count: 1, mine: false });
  expect((await react(toru, "not an emoji")).status).toBe(400);
  expect((await react(outsider, "👍")).status).toBe(403);
});

test("an emoji is an emoji, not a message", () => {
  expect(cleanEmoji("👍")).toBe("👍");
  expect(cleanEmoji("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  expect(cleanEmoji(":tada:")).toBe(":tada:");
  expect(cleanEmoji("hello")).toBeNull();
  expect(cleanEmoji("1")).toBeNull();
});

test("pins: anyone in the channel pins and unpins, and the channel lists them", async () => {
  const m = await say(mika, "Wi-Fi password is on the fridge");
  expect((await post("/channels/pins", kenji, { orgId: ORG, channel: "b:cafe", messageId: m.id })).status).toBe(200);
  let pins = (await (await get(`/channels/pins?${q({ orgId: ORG, channel: "b:cafe" })}`, toru)).json()).messages;
  expect(pins.map((p) => p.id)).toEqual([m.id]);
  expect((await list(toru))[0].pinned).toBe(true);
  await post("/channels/pins", toru, { orgId: ORG, channel: "b:cafe", messageId: m.id, pinned: false });
  pins = (await (await get(`/channels/pins?${q({ orgId: ORG, channel: "b:cafe" })}`, toru)).json()).messages;
  expect(pins).toHaveLength(0);
});

test("a direct conversation's messages cannot be touched from outside it", async () => {
  const m = (await (await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "private" })).json()).message;
  // Kenji can name the message but not reach it: his dm:<Mika> is a different conversation.
  expect((await post("/channels/reactions", kenji, { orgId: ORG, channel: `dm:${refs.Mika}`, messageId: m.id, emoji: "👍" })).status).toBe(404);
  expect((await post("/channels/reactions", kenji, { orgId: ORG, channel: "b:cafe", messageId: m.id, emoji: "👍" })).status).toBe(404);
});

test("a link to a message opens it for whoever can read it, and for nobody else", async () => {
  const m = await say(mika, "Friday price change?");
  const r = await say(toru, "Yes", { parentId: m.id });
  const where = async (token, id) => get(`/channels/locate?${q({ orgId: ORG, messageId: id })}`, token);
  expect(await (await where(kenji, m.id)).json()).toEqual({ view: "b:cafe", id: m.id, parentId: null });
  expect(await (await where(kenji, r.id)).json()).toEqual({ view: "b:cafe", id: r.id, parentId: m.id });
  // A direct message: each side names it by the other, and a third person
  // learns nothing — not even that it exists.
  const dm = (await (await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "between us" })).json()).message;
  expect((await (await where(mika, dm.id)).json()).view).toBe(`dm:${refs.Toru}`);
  expect((await (await where(toru, dm.id)).json()).view).toBe(`dm:${refs.Mika}`);
  expect((await where(kenji, dm.id)).status).toBe(404);
  expect((await where(outsider, dm.id)).status).toBe(403);
  expect((await where(kenji, "nope")).status).toBe(404);
});

import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { replyExcerpt, transcriptUpTo, SPOILER_MASK } from "../src/channels.js";

// Discord's inline reply: a message that answers another one right in the
// conversation, with a line quoting who said what — not a thread. Only a
// message in the same conversation can be answered, and the quote is read
// from the original as it is now.

const ORG = "personal:replies";
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

test("a reply in the same channel says who it answers and how that began", async () => {
  const m = await say(mika, "Roaster wants +8% from Friday");
  const res = await send(toru, "Let's push back to +5%", { replyTo: m.id });
  expect(res.status).toBe(201);
  const { message } = await res.json();
  const quote = { id: m.id, kind: "message", authorName: "Mika", authorRef: refs.Mika, excerpt: "Roaster wants +8% from Friday", source: { channel: "b:cafe", body: m.body, lang: m.lang, fileName: null }, deleted: false };
  expect(message.replyTo).toEqual(quote);
  // In the conversation, not in a thread: the main log has both, and the
  // original gains no thread for it.
  const shown = await list(kenji);
  expect(shown.map((x) => x.id)).toEqual([m.id, message.id]);
  expect(shown[1]).toMatchObject({ parentId: null, replyTo: quote });
  expect(shown[0].replyTo).toBeUndefined();
  expect(shown[0].replyCount).toBe(0);
  // Never a login.
  expect(JSON.stringify(shown)).not.toContain("mika@example.com");
});

test("every reply on a page is quoted, the originals read in one go", async () => {
  const a = await say(mika, "first");
  const b = await say(kenji, "second");
  await say(toru, "to a", { replyTo: a.id });
  await say(toru, "to b", { replyTo: b.id });
  await say(mika, "to a again", { replyTo: a.id });
  const shown = await list(toru);
  expect(shown.filter((x) => x.replyTo).map((x) => [x.body, x.replyTo.authorName, x.replyTo.excerpt]))
    .toEqual([["to a", "Mika", "first"], ["to b", "Kenji", "second"], ["to a again", "Mika", "first"]]);
});

test("a message in another conversation cannot be answered, and saying so gives nothing away", async () => {
  const kitchen = (await (await post("/channels/messages", mika, { orgId: ORG, channel: "b:kitchen", body: "oven is out" })).json()).message;
  const dm = (await (await post("/channels/messages", toru, { orgId: ORG, channel: `dm:${refs.Mika}`, body: "between us" })).json()).message;
  const refused = async (res) => {
    expect(res.status).toBe(400);
    return res.json();
  };
  // Another channel, one Toru can read too.
  const other = await refused(await send(toru, "same here", { replyTo: kitchen.id }));
  // A DM Kenji is not in, and an id that names nothing: the same answer.
  const hidden = await refused(await send(kenji, "what's this?", { replyTo: dm.id }));
  const nothing = await refused(await send(kenji, "and this?", { replyTo: "no-such-message" }));
  expect(hidden).toEqual(nothing);
  expect(other).toEqual(nothing);
  expect(nothing.code).toBe("reply_gone");
  expect(JSON.stringify(hidden)).not.toContain("between us");
  // Nothing was said.
  expect(await list(toru)).toHaveLength(0);
});

test("a reply is answered where it is read: in the conversation, or in its own thread", async () => {
  const m = await say(mika, "Friday price change?");
  const inThread = await say(kenji, "Yes, from Friday", { parentId: m.id });
  // A thread's reply is not in the main log, so nothing there quotes it.
  expect((await send(toru, "agreed", { replyTo: inThread.id })).status).toBe(400);
  // In the thread, its parent and its replies can be answered.
  const r1 = await say(toru, "Agreed", { parentId: m.id, replyTo: inThread.id });
  expect(r1.replyTo).toMatchObject({ id: inThread.id, authorName: "Kenji", excerpt: "Yes, from Friday" });
  const r2 = await say(toru, "And the parent", { parentId: m.id, replyTo: m.id });
  expect(r2.replyTo).toMatchObject({ id: m.id, authorName: "Mika" });
  // Another thread's message is not this thread's.
  const other = await say(kenji, "Staff party?");
  expect((await send(toru, "x", { parentId: other.id, replyTo: inThread.id })).status).toBe(400);
});

test("the quote hides a spoiler, even one the cut would have halved", async () => {
  const m = await say(mika, "The winner is ||Kenji|| — don't tell");
  const r = await say(toru, "no way", { replyTo: m.id });
  expect(r.replyTo.excerpt).toBe(`The winner is ${SPOILER_MASK} — don't tell`);
  expect(JSON.stringify(r)).not.toContain("Kenji||");
  expect(r.replyTo).not.toHaveProperty("source");
  const long = `${"a".repeat(110)} ||the secret that runs past the cut||`;
  const r2 = await say(toru, "hm", { replyTo: (await say(mika, long)).id });
  expect(r2.replyTo.excerpt).not.toContain("secret");
  expect(JSON.stringify(r2.replyTo)).not.toContain("secret");
  expect(Array.from(r2.replyTo.excerpt).length).toBeLessThanOrEqual(120);
});

test("an excerpt: one line, cut with an ellipsis, spoilers masked but code's bars left alone", () => {
  expect(replyExcerpt("one\n\ntwo   three")).toBe("one two three");
  expect(replyExcerpt("a ||b|| c ||d|| f")).toBe(`a ${SPOILER_MASK} c ${SPOILER_MASK} f`);
  // A spoiler is what the renderer hides: within one line, never across
  // two. Bars on two lines hide nothing there, so they hide nothing here —
  // and must not pair up and leave the real one after them showing.
  expect(replyExcerpt("a ||b\nc|| d")).toBe("a ||b c|| d");
  expect(replyExcerpt("a || b\n||the secret|| c")).toBe(`a || b ${SPOILER_MASK} c`);
  // `x || y` is code: it opens no spoiler, and the real one after it is still hidden.
  expect(replyExcerpt("run `a || b` then ||c||")).toBe(`run \`a || b\` then ${SPOILER_MASK}`);
  expect(replyExcerpt("```if (a || b) {}``` ok")).toBe("```if (a || b) {}``` ok");
  expect(replyExcerpt("```\nif (a || b) {}\nx || y\n``` ok")).toBe("``` if (a || b) {} x || y ``` ok");
  // Code is read before the lines are joined: two stray backticks on
  // different lines are not code, and protect nothing between them.
  expect(replyExcerpt("use the ` key\n||the butler did it|| not the ` one")).toBe(`use the \` key ${SPOILER_MASK} not the \` one`);
  // A backtick inside a link opens no code either.
  expect(replyExcerpt("see https://x.test/`a ||b|| c`")).toBe(`see https://x.test/\`a ${SPOILER_MASK} c\``);
  // Unmatched bars are just bars.
  expect(replyExcerpt("a || b")).toBe("a || b");
  const cut = replyExcerpt("x".repeat(200));
  expect(cut).toBe(`${"x".repeat(119)}…`);
  // An emoji is not split in two by the cut.
  expect(Array.from(replyExcerpt("😀".repeat(130)))).toHaveLength(120);
  // Only a file: it is named.
  expect(replyExcerpt("", "plan.pdf")).toBe("📎 plan.pdf");
  expect(replyExcerpt("", null)).toBe("");
});

test("an unsent original is flagged, not quoted, and cannot be answered again", async () => {
  const m = await say(mika, "wrong channel, sorry");
  const r = await say(toru, "no worries", { replyTo: m.id });
  expect((await del("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: m.id })).status).toBe(200);
  const shown = await list(kenji);
  expect(shown.map((x) => x.id)).toEqual([r.id]);
  expect(shown[0].replyTo).toEqual({ id: m.id, kind: null, authorName: null, authorRef: null, excerpt: "", deleted: true });
  const again = await send(kenji, "what was it?", { replyTo: m.id });
  expect(again.status).toBe(400);
  expect((await again.json()).code).toBe("reply_gone");
});

test("an edit to the original shows in the quote", async () => {
  const m = await say(mika, "Roaster wants +8%");
  const r = await say(toru, "hm", { replyTo: m.id });
  await call("/channels/messages", { method: "PUT", headers: headers(mika), body: JSON.stringify({ orgId: ORG, channel: "b:cafe", messageId: m.id, body: "Roaster wants +6%" }) });
  const shown = (await list(kenji)).find((x) => x.id === r.id);
  expect(shown.replyTo.excerpt).toBe("Roaster wants +6%");
});

test("a scheduled message cannot be a reply yet", async () => {
  const m = await say(mika, "Doors at 8?");
  const res = await send(toru, "yes", { replyTo: m.id, sendAt: new Date(Date.now() + 3600000).toISOString() });
  expect(res.status).toBe(400);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_messages").first()).n).toBe(0);
});

test("whoever is answered hears of it: a push, and a line in Activity", async () => {
  const m = await say(mika, "Can someone cover Saturday?");
  const r = await say(toru, "I can", { replyTo: m.id });
  const queued = (await env.DB.prepare("SELECT login, reason FROM push_queue WHERE message_id = ?1").bind(r.id).all()).results;
  expect(queued).toEqual([{ login: "u:mika@example.com", reason: "reply" }]);
  const activity = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  expect(activity.items.find((i) => i.message.id === r.id)).toMatchObject({ type: "reply", unread: true });
  // Nobody else: Kenji was not answered.
  const theirs = await (await get(`/channels/activity?${q({ orgId: ORG })}`, kenji)).json();
  expect(theirs.items.some((i) => i.message.id === r.id)).toBe(false);
  // Answering yourself is nobody's push.
  const own = await say(mika, "Or I can, actually", { replyTo: m.id });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE message_id = ?1").bind(own.id).first()).n).toBe(0);
});

test("a muted conversation's replies stay quiet; one set to mentions still hears a reply", async () => {
  const m = await say(mika, "Inventory tonight?");
  await env.DB.prepare("INSERT INTO channel_prefs (org_id, login, channel, level) VALUES (?1, 'u:mika@example.com', 'b:cafe', 'mute')").bind(ORG).run();
  const muted = await say(toru, "sure", { replyTo: m.id });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE message_id = ?1").bind(muted.id).first()).n).toBe(0);
  await env.DB.prepare("UPDATE channel_prefs SET level = 'mentions' WHERE org_id = ?1 AND login = 'u:mika@example.com'").bind(ORG).run();
  const heard = await say(kenji, "me too", { replyTo: m.id });
  expect((await env.DB.prepare("SELECT reason FROM push_queue WHERE message_id = ?1").bind(heard.id).first())?.reason).toBe("reply");
});

test("someone who left is told nothing of what is said after: not an answer to their old message, not its thread", async () => {
  const m = await say(mika, "Supplier list is in the drive");
  await say(toru, "which folder?", { parentId: m.id });
  // Mika leaves the workspace; what she wrote stays.
  expect((await del("/members", mika, { orgId: ORG, ref: refs.Mika })).status).toBe(200);
  const queuedFor = async (id) => (await env.DB.prepare("SELECT login, reason FROM push_queue WHERE message_id = ?1 ORDER BY login").bind(id).all()).results;
  // Answered inline: still quoted by name, and nobody's phone is told.
  const r = await say(toru, "Found it, thanks", { replyTo: m.id });
  expect(r.replyTo).toMatchObject({ id: m.id, authorName: "Mika", excerpt: "Supplier list is in the drive", deleted: false });
  expect(await queuedFor(r.id)).toEqual([]);
  // Her thread carried on: Toru, who is in it and still here, hears; she does not.
  const t = await say(kenji, "the shared one", { parentId: m.id });
  expect(await queuedFor(t.id)).toEqual([{ login: "toru", reason: "thread" }]);
});

test("the AI is told what a reply answers, even one said long before what it reads", async () => {
  const m = await say(mika, "Roaster wants +8% from Friday");
  for (const n of [1, 2, 3]) await say(kenji, `unrelated ${n}`);
  const r = await say(toru, "what does this mean for margins?", { replyTo: m.id });
  // Three lines back does not reach the original; the asking line carries it.
  const lines = await transcriptUpTo(env.DB, ORG, "b:cafe", r.createdAt, { limit: 3 });
  expect(lines).toHaveLength(3);
  expect(lines[2]).toMatch(/ Toru \(replying to Mika: "Roaster wants \+8% from Friday"\): what does this mean for margins\?$/);
  expect(lines.slice(0, 2).join("\n")).not.toContain("Roaster");
  // A line that answers nothing reads as it always did.
  expect(lines[1]).toMatch(/ Kenji: unrelated 3$/);
});

test("the asking line carries its original whole; earlier replies the short quote; nothing unsent or left out", async () => {
  const long = await say(mika, "y".repeat(300));
  await say(kenji, "noted", { replyTo: long.id });
  const ask = await say(toru, "and this?", { replyTo: long.id });
  const lines = await transcriptUpTo(env.DB, ORG, "b:cafe", ask.createdAt);
  expect(lines[1]).toContain(`Kenji (replying to Mika: "${"y".repeat(120)}…"): noted`);
  expect(lines[2]).toContain(`Toru (replying to Mika: "${"y".repeat(300)}"): and this?`);
  // What the caller leaves out of the lines is not brought back in a quote.
  const without = await transcriptUpTo(env.DB, ORG, "b:cafe", ask.createdAt, { skip: (x) => /^y+$/.test(x.body) });
  expect(without.join("\n")).not.toContain("yyy");
  expect(without[1]).toMatch(/ Toru: and this\?$/);
  // Unsent: gone from the lines and from every quote of it.
  expect((await del("/channels/messages", mika, { orgId: ORG, channel: "b:cafe", messageId: long.id })).status).toBe(200);
  const after = await transcriptUpTo(env.DB, ORG, "b:cafe", ask.createdAt);
  expect(after).toHaveLength(2);
  expect(after.join("\n")).not.toContain("replying to");
});


test('reference source uses the reader channel handle, and never leaks another conversation source', async () => {
  const { toMessage } = await import('../src/channels.js');
  const original = { id: 'source', channel: 'dm:toru|mika', kind: 'message', body: '明日から始めます', author_login: 'mika' };
  const reply = { id: 'reply', channel: original.channel, reply_to_id: original.id, kind: 'message', body: 'Reply', author_login: 'toru' };
  const message = toMessage(reply, 'toru', 'dm:opaque-mika', [], { original });
  expect(message.replyTo.source).toMatchObject({ channel: 'dm:opaque-mika', body: original.body, lang: 'ja' });
  const inaccessible = toMessage(reply, 'toru', 'dm:opaque-mika', [], { original: { ...original, channel: 'b:private' } });
  expect(inaccessible.replyTo).toMatchObject({ deleted: true });
  expect(inaccessible.replyTo.source).toBeUndefined();
});

test('reference revalidation returns current same-channel sources and authoritative deletion only', async () => {
  const source = await say(mika, 'Version A');
  const elsewhere = await say(mika, 'Other conversation text', { channel: 'b:kitchen' });
  const { editMessage } = await import('../src/channels.js');
  // Resolve the writer of the fixture's email-backed account.
  const actual = await env.DB.prepare('SELECT author_login FROM channel_messages WHERE id = ?1').bind(source.id).first();
  await editMessage(env.DB, { orgId: ORG, id: source.id, authorLogin: actual.author_login, body: 'Version B' });
  const read = () => get(`/channels/messages?${q({ orgId: ORG, channel: 'b:cafe', sourceIds: JSON.stringify([source.id, elsewhere.id, 'absent']) })}`, kenji);
  const current = await (await read()).json();
  expect(current.messages.map(m => [m.id, m.body])).toEqual([[source.id, 'Version B']]);
  expect(current.missingIds).toEqual([elsewhere.id, 'absent']);
  expect(JSON.stringify(current)).not.toContain('Other conversation text');
  await del('/channels/messages', mika, { orgId: ORG, channel: 'b:cafe', messageId: source.id });
  const removed = await (await read()).json();
  expect(removed.messages[0]).toMatchObject({ id: source.id, deleted: true, body: '' });
  expect((await get(`/channels/messages?${q({ orgId: ORG, channel: 'b:cafe', sourceIds: JSON.stringify([source.id]) })}`, 'invalid')).status).toBe(401);
  expect((await get(`/channels/messages?${q({ orgId: ORG, channel: 'b:cafe', sourceIds: JSON.stringify(Array.from({ length: 61 }, (_, i) => String(i))) })}`, kenji)).status).toBe(400);
});

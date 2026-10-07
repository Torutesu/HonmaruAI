import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { uuidv7 } from "../src/workspace/do.js";

// PoC-A: a workspace's conversations from a SQLite Durable Object of its own
// (docs/architecture/discord-model-platform-plan.md §12). Who may read and
// post is decided as for the D1 routes; the object keeps a sequence per
// channel, read positions, a search index, and can be filled from D1 and
// compared with it.

const ORG = "team:v2";
let owner; let member; let outsider;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, { method = "GET", token, body, over = {} } = {}) => {
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, ...over }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const W = `/v2/w/${encodeURIComponent(ORG)}`;
const chan = (key) => `${W}/channels/${encodeURIComponent(key)}`;
const say = (token, key, text) => call(`${chan(key)}/messages`, { method: "POST", token, body: { body: text } });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM businesses; DELETE FROM channel_messages; DELETE FROM conversation_members;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, role] of [["8801", "aya", "owner"], ["8802", "ben", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertUser(env.DB, { githubId: "8803", login: "cy", name: "cy", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "team:other", "8803", "owner");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "8801" });
  await upsertBusiness(env.DB, ORG, { name: "Board", createdBy: "8801" });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'board'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:board', 'aya', 'aya', ?2)").bind(ORG, new Date().toISOString()).run();
  owner = await createSession(env.DB, "8801", "gho_a");
  member = await createSession(env.DB, "8802", "gho_b");
  outsider = await createSession(env.DB, "8803", "gho_c");
});

test("off unless the workspace is named", async () => {
  const res = await call(`${chan("b:cafe")}/messages`, { token: owner, over: { WORKSPACE_V2: "team:someone-else" } });
  expect(res.status).toBe(404);
});

test("posting and reading follow the same rules as the D1 routes", async () => {
  const posted = await say(owner, "b:cafe", "hello from the object");
  expect(posted.status).toBe(201);
  const { message } = await posted.json();
  expect(message).toMatchObject({ channel: "b:cafe", seq: 1, author: "aya", body: "hello from the object" });
  // The cost model assumes at most six rows written per message, search
  // index included (plan §5.1, §12).
  const written = Number(posted.headers.get("x-rows-written"));
  expect(written).toBeGreaterThan(0);
  expect(written).toBeLessThanOrEqual(6);

  // Someone from another workspace, and nobody at all: turned away.
  expect((await say(outsider, "b:cafe", "hi")).status).toBe(403);
  expect((await say(null, "b:cafe", "hi")).status).toBe(401);
  // A private channel: only its members; to anybody else it is not there.
  expect((await say(member, "b:board", "let me in")).status).toBe(404);
  expect((await say(owner, "b:board", "board only")).status).toBe(201);

  const page = await (await call(`${chan("b:cafe")}/messages`, { token: member })).json();
  expect(page.messages.map((m) => m.body)).toEqual(["hello from the object"]);
  expect(page.lastSeq).toBe(1);
});

test("a thread reply can go to the conversation too; only a thread reply can", async () => {
  const { message: parent } = await (await say(owner, "b:cafe", "menu for Monday?")).json();
  const both = await (await call(`${chan("b:cafe")}/messages`, { method: "POST", token: member, body: { body: "soup", parentId: parent.id, alsoChannel: true } })).json();
  expect(both.message).toMatchObject({ parentId: parent.id, alsoChannel: true });
  const only = await (await call(`${chan("b:cafe")}/messages`, { method: "POST", token: member, body: { body: "bread", parentId: parent.id } })).json();
  expect(only.message.alsoChannel).toBeUndefined();
  const plain = await (await call(`${chan("b:cafe")}/messages`, { method: "POST", token: member, body: { body: "hi", alsoChannel: true } })).json();
  expect(plain.message.alsoChannel).toBeUndefined();
  // Read back as it was sent: the client decides where each one shows.
  const page = await (await call(`${chan("b:cafe")}/messages`, { token: owner })).json();
  expect(page.messages.map((m) => [m.body, m.parentId ? "reply" : "top", Boolean(m.alsoChannel)]))
    .toEqual([["menu for Monday?", "top", false], ["soup", "reply", true], ["bread", "reply", false], ["hi", "top", false]]);
});

test("the same send again — a retry after a lost answer — is the message already posted (#212)", async () => {
  const post = (body) => call(`${chan("b:cafe")}/messages`, { method: "POST", token: member, body });
  const first = await (await post({ body: "on a slow train", clientId: "tmp-abc-1" })).json();
  const again = await (await post({ body: "on a slow train", clientId: "tmp-abc-1" })).json();
  expect(again.message.id).toBe(first.message.id);
  expect(again.message.seq).toBe(first.message.seq);
  // Another send, or one without an id, is another message.
  const other = await (await post({ body: "on a slow train", clientId: "tmp-abc-2" })).json();
  expect(other.message.id).not.toBe(first.message.id);
  // An id that is not a send's own is ignored, not trusted.
  const odd = await (await post({ body: "x", clientId: "DROP TABLE" })).json();
  expect(odd.message.body).toBe("x");
  const page = await (await call(`${chan("b:cafe")}/messages`, { token: owner })).json();
  expect(page.messages.map((m) => m.body)).toEqual(["on a slow train", "on a slow train", "x"]);
});

test("a client catching up asks for what came after the last seq it saw", async () => {
  for (const t of ["one", "two", "three", "four"]) await say(owner, "b:cafe", t);
  const after = await (await call(`${chan("b:cafe")}/messages?after=2`, { token: member })).json();
  expect(after.messages.map((m) => [m.seq, m.body])).toEqual([[3, "three"], [4, "four"]]);
  const before = await (await call(`${chan("b:cafe")}/messages?before=3&limit=1`, { token: member })).json();
  expect(before.messages.map((m) => m.body)).toEqual(["two"]);
});

test("read positions: counted at once, written together shortly after", async () => {
  for (const t of ["a", "b", "c"]) await say(owner, "b:cafe", t);
  await say(owner, "b:board", "private");
  const unread = async (token, channels) => (await (await call(`${W}/unread`, { method: "POST", token, body: { channels } })).json()).channels;

  expect(await unread(member, ["b:cafe", "b:board"])).toEqual([{ channel: "b:cafe", lastSeq: 3, readSeq: 0, unread: 3 }]);
  await call(`${chan("b:cafe")}/read`, { method: "POST", token: member, body: { seq: 2 } });
  expect((await unread(member, ["b:cafe"]))[0]).toMatchObject({ readSeq: 2, unread: 1 });

  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ORG));
  await runInDurableObject(stub, async (instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM reads").one().n).toBe(0);
    expect(await state.storage.getAlarm()).not.toBeNull();
    await instance.alarm();
    expect(state.storage.sql.exec("SELECT login, channel_id, seq FROM reads").toArray()).toEqual([{ login: "ben", channel_id: "b:cafe", seq: 2 }]);
  });
  // An older position never moves it back.
  await call(`${chan("b:cafe")}/read`, { method: "POST", token: member, body: { seq: 1 } });
  expect((await unread(member, ["b:cafe"]))[0].readSeq).toBe(2);
});

test("search finds words in English and Japanese, only where the person can read", async () => {
  await say(owner, "b:cafe", "The espresso machine is fixed");
  await say(owner, "b:cafe", "来週の売上をまとめてください");
  await say(owner, "b:board", "espresso budget is secret");
  const find = async (token, text) => (await (await call(`${W}/search?q=${encodeURIComponent(text)}&channels=b:cafe,b:board`, { token })).json()).hits.map((h) => h.body);

  expect(await find(member, "espresso")).toEqual(["The espresso machine is fixed"]);
  expect((await find(owner, "espresso")).sort()).toEqual(["The espresso machine is fixed", "espresso budget is secret"]);
  expect(await find(member, "売上を")).toEqual(["来週の売上をまとめてください"]);
});

test("a workspace copied from D1 matches it, page by page, and copying twice changes nothing", { timeout: 60_000 }, async () => {
  const at = (i) => new Date(Date.parse("2026-09-01T00:00:00Z") + i * 1000).toISOString();
  const stmts = [];
  for (let i = 0; i < 1203; i += 1) {
    stmts.push(env.DB.prepare(
      "INSERT INTO channel_messages (id, org_id, channel, author_login, body, created_at, edited_at, deleted_at) VALUES (?1, ?2, ?3, 'aya', ?4, ?5, ?6, ?7)"
    ).bind(uuidv7(Date.parse(at(i))), ORG, i % 3 ? "b:cafe" : "b:board", `message ${i}`, at(i), i % 50 ? null : at(i + 5), i === 7 ? at(9) : null));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));

  // Only the people who run the workspace.
  expect((await call(`${W}/backfill`, { method: "POST", token: member, body: {} })).status).toBe(403);

  const run = async () => {
    let next = {}; let copied = 0; let pages = 0;
    for (;;) {
      const r = await (await call(`${W}/backfill`, { method: "POST", token: owner, body: next })).json();
      copied += r.copied; pages += 1;
      if (r.done) return { copied, pages };
      next = r.next;
    }
  };
  expect(await run()).toEqual({ copied: 1203, pages: 3 });
  expect((await run()).copied).toBe(0);

  const until = "2026-10-01T00:00:00Z";
  expect(await (await call(`${W}/checksum?until=${until}`, { token: owner })).json()).toEqual({ match: true, until, checked: 1203 });

  // Seq per channel in the order things were said.
  const board = await (await call(`${chan("b:board")}/messages?after=0&limit=3`, { token: owner })).json();
  expect(board.messages.map((m) => [m.seq, m.body])).toEqual([[1, "message 0"], [2, "message 3"], [3, "message 6"]]);

  // An edit on the D1 side is found, and where.
  await env.DB.prepare("UPDATE channel_messages SET body = 'changed' WHERE org_id = ?1 AND body = 'message 1100'").bind(ORG).run();
  const diff = await (await call(`${W}/checksum?until=${until}`, { token: owner })).json();
  expect(diff.match).toBe(false);
  expect(diff.checked).toBe(1000);

  const stats = await (await call(`${W}/stats`, { token: owner })).json();
  expect(stats).toMatchObject({ messages: 1203, channels: 2 });
});

test("ids are time-ordered UUIDv7", () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_000_001);
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
});

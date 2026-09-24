import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { groupByDay, dayDigest, localDay, dayStart } from "../src/journal.js";
import { linksIn } from "../src/channelDetails.js";
import { recordingMessage } from "../src/jam.js";
import { validateRoutineInput, postsToChannel, runRoutine, getRoutine } from "../src/routines.js";

// What a channel's header opens: the journal (a few lines a day, each citing
// its messages), the details panel (members, what was shared, what runs into
// it), and a Jam's recording, turned into notes in the channel.

const ORG = "personal:panel";
let toru; let mika; let outsider;
const ENV = (over = {}) => ({ ...env, ...over });
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
const put = (path, token, body, over) => call(path, { method: "PUT", headers: headers(token), body: JSON.stringify(body) }, over);
const get = (path, token, over) => call(path, { headers: headers(token) }, over);
const q = (o) => new URLSearchParams(o).toString();
const QUIET = { OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined };

async function say(channel, login, body, createdAt, extra = {}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at, parent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
  ).bind(id, ORG, channel, login, extra.kind || "message", body, createdAt, extra.parentId || null).run();
  return id;
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM channel_messages; DELETE FROM channel_journal; DELETE FROM routines; DELETE FROM rate_limits;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9801", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "9802", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9803", login: "stranger", name: "Stranger", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9801", "admin");
  await upsertMembership(env.DB, ORG, "9802", "member");
  await upsertMembership(env.DB, "personal:other", "9803", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  toru = await createSession(env.DB, "9801", "gho_t");
  mika = await createSession(env.DB, "9802", "gho_m");
  outsider = await createSession(env.DB, "9803", "gho_s");
});
afterEach(() => fetchMock.deactivate?.());

test("days are the reader's days: a message at 23:30 UTC is tomorrow in Tokyo", () => {
  expect(localDay("2026-09-23T23:30:00Z", "UTC")).toBe("2026-09-23");
  expect(localDay("2026-09-23T23:30:00Z", "Asia/Tokyo")).toBe("2026-09-24");
  expect(dayStart("2026-09-24", "Asia/Tokyo").toISOString()).toBe("2026-09-23T15:00:00.000Z");
  const rows = [
    { id: "c", created_at: "2026-09-24T02:00:00Z" },
    { id: "b", created_at: "2026-09-23T23:30:00Z" },
    { id: "a", created_at: "2026-09-23T10:00:00Z" },
  ];
  expect(groupByDay(rows, "Asia/Tokyo").map((d) => [d.day, d.rows.map((r) => r.id)])).toEqual([
    ["2026-09-24", ["b", "c"]],
    ["2026-09-23", ["a"]],
  ]);
});

test("without a model a day is its busiest conversations, in the order they happened", () => {
  const members = [{ login: "toru", name: "Toru" }, { login: "mika", name: "Mika" }];
  const rows = [
    { id: "1", author_login: "toru", body: "morning", created_at: "t1" },
    { id: "2", author_login: "mika", body: "The roaster wants +8% from Friday", created_at: "t2" },
    { id: "3", author_login: "toru", body: "ok", created_at: "t3", parent_id: "2" },
    { id: "4", author_login: "toru", body: "Let's see", created_at: "t4", parent_id: "2" },
  ];
  expect(dayDigest(rows, members, "en")).toEqual([
    { text: "Toru: morning", messageIds: ["1"] },
    { text: "Mika: The roaster wants +8% from Friday", messageIds: ["2"] },
  ]);
});

test("the links shared in a channel, once each, with who shared them", () => {
  const members = [{ login: "mika", name: "Mika" }];
  const links = linksIn([
    { id: "m2", author_login: "mika", body: "again https://example.com/a.", created_at: "2" },
    { id: "m1", author_login: "mika", body: "see https://www.example.com/a and (https://docs.test/x)", created_at: "1" },
  ], members);
  expect(links).toEqual([
    { url: "https://example.com/a", host: "example.com", messageId: "m2", authorName: "Mika", at: "2" },
    { url: "https://www.example.com/a", host: "example.com", messageId: "m1", authorName: "Mika", at: "1" },
    { url: "https://docs.test/x", host: "docs.test", messageId: "m1", authorName: "Mika", at: "1" },
  ]);
});

test("the details panel: what the channel is, who is in it, what was shared, what runs into it", async () => {
  await say("b:cafe", "mika", "Menu draft: https://docs.test/menu", "2026-09-20T01:00:00Z");
  const described = await put("/channels/description", mika, { orgId: ORG, channel: "b:cafe", description: "  Everything about   the cafe  " });
  expect(described.status).toBe(200);
  expect(await described.json()).toEqual({ description: "Everything about the cafe" });
  expect((await put("/channels/description", mika, { orgId: ORG, channel: "b:cafe", description: "x".repeat(501) })).status).toBe(400);
  expect((await put("/channels/description", outsider, { orgId: ORG, channel: "b:cafe", description: "mine" })).status).toBe(403);

  const made = await post("/routines", toru, {
    orgId: ORG, kind: "report", instruction: "Weekly sales", cadence: "weekly", weekday: 1, hour: 9, timezone: "Asia/Tokyo", channel: "b:cafe",
  });
  expect(made.status).toBe(201);
  await post("/routines", toru, { orgId: ORG, kind: "report", instruction: "Just for me", cadence: "daily", hour: 9 });

  const res = await get(`/channels/details?${q({ orgId: ORG, channel: "b:cafe" })}`, mika);
  expect(res.status).toBe(200);
  const d = await res.json();
  expect(d.channel).toMatchObject({ key: "b:cafe", view: "b:cafe", kind: "channel", name: "Cafe", description: "Everything about the cafe", createdBy: "Toru" });
  expect(d.members.people.map((p) => [p.name, p.you])).toEqual(expect.arrayContaining([["Toru", false], ["Mika", true]]));
  expect(d.members.agents[0]).toMatchObject({ name: "Your AI", kind: "ai" });
  expect(d.attachments).toEqual([expect.objectContaining({ url: "https://docs.test/menu", authorName: "Mika" })]);
  // Only what runs into this channel; mika sees toru's but it is not hers.
  expect(d.automations).toHaveLength(1);
  expect(d.automations[0]).toMatchObject({ kind: "report", enabled: true, ownerName: "Toru", mine: false });
  expect(d.counts).toEqual({ members: 3, automations: 1, attachments: 1 });
  expect(JSON.stringify(d)).not.toContain("mika@");

  // In toru's language: "Your AI" is "あなたのAI".
  const ja = await (await get(`/channels/details?${q({ orgId: ORG, channel: "b:cafe" })}`, toru)).json();
  expect(ja.members.agents[0].name).toBe("あなたのAI");
  expect(ja.automations[0].mine).toBe(true);
  expect((await get(`/channels/details?${q({ orgId: ORG, channel: "b:cafe" })}`, outsider)).status).toBe(403);
});

test("a report can be posted into a channel as well as the feed; a daily report still has to name one", () => {
  expect(postsToChannel("report")).toBe(true);
  expect(postsToChannel("brief")).toBe(false);
  expect(validateRoutineInput({ kind: "report", instruction: "x", cadence: "daily", hour: 9, channel: "b:cafe" }).value.channel).toBe("b:cafe");
  expect(validateRoutineInput({ kind: "report", instruction: "x", cadence: "daily", hour: 9, channel: "" }).value.channel).toBe(null);
  expect(validateRoutineInput({ kind: "report", instruction: "x", cadence: "daily", hour: 9, channel: "b:Not A Slug" }).error).toBe("No such channel.");
  expect(validateRoutineInput({ kind: "daily_report", cadence: "daily", hour: 22, channel: "" }).error).toMatch(/daily report/);
});

test("a report with a channel is said there by the AI when it runs", async () => {
  const made = await (await post("/routines", toru, {
    orgId: ORG, kind: "report", instruction: "Weekly sales", cadence: "daily", hour: 9, channel: "b:cafe",
  })).json();
  const routine = await getRoutine(env.DB, ORG, made.routine.id);
  const out = await runRoutine(ENV(QUIET), routine, { now: new Date("2026-09-24T00:00:00Z"), manual: true });
  expect(out.card).toBeTruthy();
  const row = await env.DB.prepare("SELECT kind, body, card_id FROM channel_messages WHERE org_id = ?1 AND channel = 'b:cafe'").bind(ORG).first();
  expect(row).toMatchObject({ kind: "ai", card_id: out.card.id });
  expect(row.body.startsWith(`*${out.card.title}*`)).toBe(true);
});

test("the journal: a page of days, newest first, each citing its messages, to the start", async () => {
  await say("b:cafe", "mika", "Kickoff for the autumn menu", "2026-09-20T01:00:00Z");
  const roaster = await say("b:cafe", "mika", "The roaster wants +8% from Friday https://docs.test/quote", "2026-09-23T23:30:00Z");
  await say("b:cafe", "toru", "Let's take it", "2026-09-24T00:10:00Z", { parentId: roaster });
  const res = await get(`/channels/journal?${q({ orgId: ORG, channel: "b:cafe", tz: "Asia/Tokyo" })}`, mika, QUIET);
  expect(res.status).toBe(200);
  const page = await res.json();
  expect(page).toMatchObject({ channel: "b:cafe", tz: "Asia/Tokyo", more: false, next: null });
  expect(page.days.map((d) => [d.day, d.count])).toEqual([["2026-09-24", 2], ["2026-09-20", 1]]);
  expect(page.days[0].byModel).toBe(false);
  expect(page.days[0].items[0]).toEqual({
    text: "Mika: The roaster wants +8% from Friday https://docs.test/quote",
    messageIds: [roaster],
    links: [{ url: "https://docs.test/quote", host: "docs.test" }],
  });

  // Paged: before a day, the days before it.
  const older = await (await get(`/channels/journal?${q({ orgId: ORG, channel: "b:cafe", tz: "Asia/Tokyo", before: "2026-09-24" })}`, mika, QUIET)).json();
  expect(older.days.map((d) => d.day)).toEqual(["2026-09-20"]);
  expect((await get(`/channels/journal?${q({ orgId: ORG, channel: "b:cafe", before: "yesterday" })}`, mika, QUIET)).status).toBe(400);
  expect((await get(`/channels/journal?${q({ orgId: ORG, channel: "b:cafe" })}`, outsider, QUIET)).status).toBe(403);
});

test("with a model the journal is written in the reader's language, cited, and kept until the day changes", async () => {
  const a = await say("b:cafe", "mika", "The roaster wants +8% from Friday", "2026-09-24T01:00:00Z");
  const b = await say("b:cafe", "toru", "OK, take it", "2026-09-24T02:00:00Z");
  let prompt;
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (x) => { prompt = JSON.parse(x); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ items: [{ text: "焙煎所の8%値上げを受け入れることにした。", cites: [1, 2, 9] }] }) } }] });
  const over = { OPENAI_API_KEY: "sk-test" };
  const page = await (await get(`/channels/journal?${q({ orgId: ORG, channel: "b:cafe", tz: "UTC" })}`, toru, over)).json();
  fetchMock.assertNoPendingInterceptors();
  expect(prompt.messages[1].content).toContain("Reader language: ja");
  expect(prompt.messages[1].content).toContain("#cafe");
  expect(page.days[0]).toMatchObject({ day: "2026-09-24", count: 2, byModel: true });
  // A citation past the end is dropped, not invented.
  expect(page.days[0].items).toEqual([{ text: "焙煎所の8%値上げを受け入れることにした。", messageIds: [a, b], links: [] }]);

  // The same day, unchanged: from what was kept, no second call.
  const again = await (await get(`/channels/journal?${q({ orgId: ORG, channel: "b:cafe", tz: "UTC" })}`, toru, over)).json();
  expect(again.days[0].items[0].text).toBe("焙煎所の8%値上げを受け入れることにした。");
  fetchMock.assertNoPendingInterceptors();

  // A message deleted: that day is forgotten and written again.
  const del = await call("/channels/messages", { method: "DELETE", headers: headers(toru), body: JSON.stringify({ orgId: ORG, channel: "b:cafe", messageId: b }) }, QUIET);
  expect(del.status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_journal").first()).toEqual({ n: 0 });
});

test("a Jam's recording becomes notes in the channel; a full recording is kept and played back", async () => {
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/audio/transcriptions", method: "POST" })
    .reply(200, { text: "We agreed to take the roaster's price. Mika sends the menu Friday." });
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (x) => { prompt = JSON.parse(x); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ notes: "- Take the roaster's price\n- Mika: menu by Friday" }) } }] });
  const refs = Object.fromEntries((await (await get(`/channels?${q({ orgId: ORG })}`, mika)).json()).members.map((m) => [m.name, m.ref]));
  const audio = new Uint8Array(4096).fill(7);
  const res = await call(`/channels/jam/recording?${q({
    orgId: ORG, channel: "b:cafe", mode: "full", startedAt: "2026-09-24T01:00:00Z", endedAt: "2026-09-24T01:12:00Z", people: `${refs.Mika},${refs.Toru}`,
  })}`, { method: "POST", headers: { "x-session-token": mika, "content-type": "audio/webm;codecs=opus" }, body: audio }, { OPENAI_API_KEY: "sk-test" });
  expect(res.status).toBe(202);
  const { id, url } = await res.json();
  expect(url).toBe(`https://example.com/channels/jam/audio/${id}`);
  fetchMock.assertNoPendingInterceptors();
  expect(prompt.messages[1].content).toContain("roaster's price");
  const row = await env.DB.prepare("SELECT kind, body FROM channel_messages WHERE org_id = ?1 AND channel = 'b:cafe'").bind(ORG).first();
  expect(row.kind).toBe("ai");
  expect(row.body).toBe(`*Notes from the Jam · 12 min · Mika, Toru*\n- Take the roaster's price\n- Mika: menu by Friday\n\nRecording: ${url}`);

  const played = await call(`/channels/jam/audio/${id}`, {});
  expect(played.status).toBe(200);
  expect(played.headers.get("content-type")).toBe("audio/webm");
  expect(new Uint8Array(await played.arrayBuffer()).length).toBe(4096);
  expect((await call("/channels/jam/audio/not-an-id", {})).status).toBe(404);
});

test("a recording is audio, from someone in the channel", async () => {
  const body = new Uint8Array(4096);
  const up = (token, type, channel = "b:cafe") => call(`/channels/jam/recording?${q({ orgId: ORG, channel, mode: "notes" })}`,
    { method: "POST", headers: { "x-session-token": token, "content-type": type }, body }, QUIET);
  expect((await up(mika, "text/html")).status).toBe(415);
  expect((await up(outsider, "audio/webm")).status).toBe(403);
  // Notes only, and no model: nothing to say, nothing kept.
  const quiet = await up(mika, "audio/webm");
  expect(quiet.status).toBe(202);
  expect(await quiet.json()).toMatchObject({ id: null, url: null });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages").first()).toEqual({ n: 0 });
});

test("the message a recording leaves stays within a message, link and all", () => {
  const long = recordingMessage("en", { minutes: 90, people: "A", notes: "- x".repeat(3000), url: "https://example.com/channels/jam/audio/abc" });
  expect(long.length).toBeLessThanOrEqual(4000);
  expect(long.endsWith("Recording: https://example.com/channels/jam/audio/abc")).toBe(true);
  expect(recordingMessage("ja", { minutes: 3, people: "A", notes: null, url: null })).toBe("*Jamのメモ · 3分 · A*\nJamを録音しましたが、メモにできるほど声を聞き取れませんでした。");
});

import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { runRoutine, getRoutine } from "../src/routines.js";
import { gatherDay, dailyDigest, dayOf, linesUnder, remindDailyDrafts } from "../src/dailyReport.js";
import { composeAlert, composeEmail } from "../src/notifyCopy.js";
import { joined, message } from "./helpers.js";

// The daily report: at the hour its owner chose, their own day — what they
// said, the tasks they were given and how far each got, what they did —
// drafted in their voice with what went well, what to improve and tomorrow,
// delivered to them to read, change and post to a channel under their name.

const ORG = "personal:daily";
let toru;
let mika;
const ENV = (over = {}) => ({ ...env, ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over), { waitUntil() {} });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body, over) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, over);

// A fixed evening in Tokyo, so "today" does not depend on when the suite runs.
const NOW = new Date("2026-09-24T09:30:00Z"); // 18:30 in Tokyo
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600000).toISOString();

async function say(channel, author, body, created) {
  await env.DB.prepare(
    "INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'message', ?5, ?6)"
  ).bind(crypto.randomUUID(), ORG, channel, author, body, created).run();
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8601", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8602", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8601", "admin");
  await upsertMembership(env.DB, ORG, "8602", "member");
  toru = await createSession(env.DB, "8601", "gho_toru");
  mika = await createSession(env.DB, "8602", "gho_mika");

  // Given to Toru by Mika two days ago, still open.
  await saveCard(env.DB, ORG, {
    id: "t-open", recipientUserID: "toru", senderUserID: "mika", type: "task", title: "秋メニューの原価表を作る",
    status: "pending", priority: "high", createdAt: at(50),
  });
  // Given to Toru and decided by him today.
  await saveCard(env.DB, ORG, {
    id: "t-done", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "週末バイトの採用",
    status: "approved", priority: "medium", createdAt: at(30),
    decision: { action: "approve", actorUserID: "toru", decidedAt: at(3), note: "週20時間まで" },
  });
  // Asked of Mika by Toru today.
  await saveCard(env.DB, ORG, {
    id: "t-asked", recipientUserID: "mika", senderUserID: "toru", type: "task", title: "仕入先の見積もりを3社分",
    status: "pending", priority: "medium", createdAt: at(4),
  });
  // Yesterday: not today's work.
  await saveCard(env.DB, ORG, {
    id: "t-old", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "先月の備品購入",
    status: "approved", createdAt: at(80), decision: { action: "approve", actorUserID: "toru", decidedAt: at(40) },
  });
  await say("b:general", "toru", "原価表は明日の昼までに出します", at(2));
  await say("dm:mika|toru", "toru", "個人的な相談の件、了解です", at(1));
  await say("b:general", "toru", "昨日の発言", at(30));
  await say("b:general", "mika", "Mika's own message", at(1));
  await env.DB.prepare(
    "INSERT INTO card_comments (id, org_id, card_id, author_login, body, mentions, created_at) VALUES ('c1', ?1, 't-open', 'toru', '仕入れ値を確認中', '[]', ?2)"
  ).bind(ORG, at(2)).run();
  // Yesterday's report, as posted: its plan was for today.
  await saveCard(env.DB, ORG, {
    id: "daily-yesterday", recipientUserID: "toru", senderUserID: "toru", type: "notification", format: "fyi",
    title: "日報 2026-09-23", status: "completed", createdAt: at(24),
    report: { markdown: "…" },
    dailyReport: { routineId: "r", part: "evening", channel: "b:general", date: "2026-09-23", status: "posted", text: "*明日やること*\n- 原価表を完成させる\n- 見積もり依頼を出す" },
  });
});
afterEach(() => fetchMock.deactivate?.());

async function makeDaily(over = {}) {
  const res = await post("/routines", toru, {
    orgId: ORG, kind: "daily_report", channel: "b:general", cadence: "weekdays", hour: 18, minute: 30, timezone: "Asia/Tokyo", ...over,
  });
  return { res, data: await res.json() };
}

test("a daily report is made for a time and a channel, comes only to its owner, and must name a channel", async () => {
  const { res, data } = await makeDaily({ recipient: "member:someone-else" });
  expect(res.status).toBe(201);
  expect(data.routine).toMatchObject({ kind: "daily_report", channel: "b:general", hour: 18, minute: 30, timezone: "Asia/Tokyo", title: "日報" });
  expect(data.routine.recipient.self).toBe(true);
  expect(data.routine.schedule).toBe("平日 18:30");

  const missing = await post("/routines", toru, { orgId: ORG, kind: "daily_report", cadence: "daily", hour: 18, timezone: "UTC" });
  expect(missing.status).toBe(400);
  const bad = await post("/routines", toru, { orgId: ORG, kind: "daily_report", channel: "general", cadence: "daily", hour: 18, timezone: "UTC" });
  expect(bad.status).toBe(400);
});

test("the day is the owner's own, in their time zone: what they said, were given, did, asked and wrote — and yesterday's plan", async () => {
  const { start, date } = dayOf(NOW, "Asia/Tokyo");
  expect(date).toBe("2026-09-24");
  expect(start.toISOString()).toBe("2026-09-23T15:00:00.000Z");

  const day = await gatherDay(env.DB, ORG, { owner_login: "toru", timezone: "Asia/Tokyo" }, { now: NOW, locale: "ja" });
  expect(day.messages.map((m) => m.text)).toEqual(["原価表は明日の昼までに出します", "個人的な相談の件、了解です"]);
  expect(day.messages[0]).toMatchObject({ where: "#general" });
  // A direct message is marked private and names nobody.
  expect(day.messages[1]).toMatchObject({ where: "direct message", private: true });
  expect(JSON.stringify(day.messages[1])).not.toContain("mika");
  expect(day.tasks.map((t) => t.title).sort()).toEqual(["秋メニューの原価表を作る", "週末バイトの採用"].sort());
  expect(day.tasks.find((t) => t.title === "秋メニューの原価表を作る")).toMatchObject({ from: "Mika", status: "pending", daysOpen: 2, movedToday: false });
  expect(day.tasks.find((t) => t.title === "週末バイトの採用")).toMatchObject({ action: "approve", movedToday: true, note: "週20時間まで" });
  expect(day.sent).toEqual([{ title: "仕入先の見積もりを3社分", to: "Mika", status: "pending", daysOpen: 0 }]);
  expect(day.comments).toEqual([{ on: "秋メニューの原価表を作る", text: "仕入れ値を確認中" }]);
  expect(day.lastReport).toMatchObject({ date: "2026-09-23" });
  expect(day.lastReport.text).toContain("原価表を完成させる");
});

test("with no model the draft states the facts and leaves the reflection to its owner", async () => {
  const day = await gatherDay(env.DB, ORG, { owner_login: "toru", timezone: "Asia/Tokyo" }, { now: NOW, locale: "ja" });
  const text = dailyDigest(day, "ja");
  for (const heading of ["*今日やったこと*", "*タスクの進捗*", "*良かった点*", "*反省点*", "*明日やること*"]) expect(text).toContain(heading);
  expect(text).toContain("週末バイトの採用: 承認");
  expect(text).toContain("Mikaさんに依頼: 仕入先の見積もりを3社分");
  expect(text).toContain("秋メニューの原価表を作る（Mikaさんから）— 対応中、2日目");
  expect(text).toContain("（自分の言葉で書いてください）");
  // Private conversations are not counted into what gets posted.
  expect(text).toContain("#generalで1件発言");
});

test("the model writes it in the owner's voice from the day, never from a private conversation's other side", async () => {
  const { data } = await makeDaily();
  const routine = await getRoutine(env.DB, ORG, data.routine.id);
  let prompt;
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { prompt = JSON.parse(b); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ text: "*今日やったこと*\n- 週末バイトの採用を承認（週20時間まで）\n*明日やること*\n- 原価表を昼までに提出" }) } }] });
  const out = await runRoutine(ENV({ OPENAI_API_KEY: "sk-test" }), routine, { now: NOW, manual: true });
  fetchMock.assertNoPendingInterceptors();
  const system = prompt.messages[0].content;
  const user = prompt.messages[1].content;
  expect(system).toContain("first person");
  expect(user).toContain("Reader language: ja");
  expect(user).toContain("*今日やったこと* · *タスクの進捗* · *良かった点* · *反省点* · *明日やること*");
  expect(user).toContain("原価表を完成させる"); // yesterday's plan, to be checked against
  expect(user).not.toContain("Mika's own message");

  expect(out.card).toMatchObject({
    recipientUserID: "toru", title: "日報 2026-09-24", format: "fyi",
    dailyReport: { channel: "b:general", date: "2026-09-24", status: "draft", text: "*今日やったこと*\n- 週末バイトの採用を承認（週20時間まで）\n*明日やること*\n- 原価表を昼までに提出" },
  });
  expect(out.card.summary).toContain("#general");
});

test("the owner posts the draft — as they changed it — to the channel under their name, once", async () => {
  const { data } = await makeDaily();
  const routine = await getRoutine(env.DB, ORG, data.routine.id);
  const { card } = await runRoutine(ENV({ OPENAI_API_KEY: undefined }), routine, { now: NOW, manual: true });
  // The line left for the owner's own words is named on the card, so the
  // page can say what is still unwritten.
  expect(card.dailyReport.fillIn).toBe("（自分の言葉で書いてください）");
  expect(card.dailyReport.text).toContain(card.dailyReport.fillIn);
  const edited = `${card.dailyReport.text.replace("（自分の言葉で書いてください）", "採用を即決できた")}`;

  // Nobody else may post it.
  expect((await post("/channels/daily-report/post", mika, { orgId: ORG, cardId: card.id, text: "hijack" })).status).toBe(404);

  const res = await post("/channels/daily-report/post", toru, { orgId: ORG, cardId: card.id, text: edited });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.card).toMatchObject({ status: "completed", decision: { action: "acknowledge", actorUserID: "toru" }, dailyReport: { status: "posted", text: edited } });
  const row = await env.DB.prepare("SELECT author_login, body FROM channel_messages WHERE id = ?1").bind(body.card.dailyReport.messageId).first();
  expect(row).toEqual({ author_login: "toru", body: edited });

  // Once.
  expect((await post("/channels/daily-report/post", toru, { orgId: ORG, cardId: card.id, text: edited })).status).toBe(409);
  // And tomorrow's report reads it as the plan it made.
  const tomorrow = await gatherDay(env.DB, ORG, { owner_login: "toru", timezone: "Asia/Tokyo" }, { now: new Date(NOW.getTime() + 86400000), locale: "ja" });
  expect(tomorrow.lastReport.text).toContain("採用を即決できた");
});

test("an empty or overlong report is refused and stays a draft", async () => {
  const { data } = await makeDaily();
  const routine = await getRoutine(env.DB, ORG, data.routine.id);
  const { card } = await runRoutine(ENV({ OPENAI_API_KEY: undefined }), routine, { now: NOW, manual: true });
  expect((await post("/channels/daily-report/post", toru, { orgId: ORG, cardId: card.id, text: "   " })).status).toBe(400);
  expect((await post("/channels/daily-report/post", toru, { orgId: ORG, cardId: card.id, text: "x".repeat(4001) })).status).toBe(400);
  const { getCard } = await import("../src/db.js");
  expect((await getCard(env.DB, ORG, card.id)).dailyReport.status).toBe("draft");
});

async function makePlan(over = {}) {
  const res = await post("/routines", toru, {
    orgId: ORG, kind: "daily_plan", channel: "b:general", cadence: "weekdays", hour: 8, minute: 0, timezone: "Asia/Tokyo", ...over,
  });
  return { res, data: await res.json() };
}

test("the morning plan is its own routine, at its own time, and names its channel", async () => {
  const { res, data } = await makePlan();
  expect(res.status).toBe(201);
  expect(data.routine).toMatchObject({ kind: "daily_plan", channel: "b:general", hour: 8, title: "朝の予定" });
  expect(data.routine.schedule).toBe("平日 08:00");
  // Each person moves theirs: the same routine, another hour.
  const moved = await call(`/routines/${data.routine.id}`, { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, hour: 7, minute: 30 }) });
  expect((await moved.json()).routine).toMatchObject({ hour: 7, minute: 30, kind: "daily_plan", channel: "b:general" });
  expect((await post("/routines", toru, { orgId: ORG, kind: "daily_plan", cadence: "daily", hour: 8, timezone: "UTC" })).status).toBe(400);
});

test("with no time zone given, a daily report runs in the person's own", async () => {
  await env.DB.prepare("UPDATE users SET timezone = 'Asia/Tokyo' WHERE github_id = '8601'").run();
  const { data } = await makePlan({ timezone: undefined });
  expect(data.routine.timezone).toBe("Asia/Tokyo");
});

test("the morning carries last night's tomorrow into today, says where tasks stand and who it waits on, and leaves help to its owner", async () => {
  const morning = new Date("2026-09-24T23:00:00Z"); // 08:00 in Tokyo, the next day
  const day = await gatherDay(env.DB, ORG, { owner_login: "toru", timezone: "Asia/Tokyo" }, { now: morning, locale: "ja", part: "morning" });
  expect(day.part).toBe("morning");
  expect(day.date).toBe("2026-09-25");
  expect(day.sent).toEqual([expect.objectContaining({ title: "仕入先の見積もりを3社分", to: "Mika", status: "pending" })]);
  const text = dailyDigest(day, "ja");
  expect(text).toMatch(/^\*今日やること\*\n- 原価表を完成させる\n- 見積もり依頼を出す\n- 秋メニューの原価表を作る/);
  expect(text).toContain("*タスクの状況*");
  expect(text).toContain("秋メニューの原価表を作る（Mikaさんから）— 対応中、2日目");
  expect(text).toContain("Mikaさんの返事待ち: 仕入先の見積もりを3社分");
  expect(text).toContain("*相談したいこと*\n- （自分の言葉で書いてください）");
  expect(linesUnder("*明日やること*\n- a\n- b\n\n*X*\n- c", "明日やること")).toEqual(["a", "b"]);
});

test("the morning is written by the model as a plan, from the open work and last night's report", async () => {
  const { data } = await makePlan();
  const routine = await getRoutine(env.DB, ORG, data.routine.id);
  let prompt;
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { prompt = JSON.parse(b); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ text: "*今日やること*\n- 原価表を昼までに提出" }) } }] });
  const out = await runRoutine(ENV({ OPENAI_API_KEY: "sk-test" }), routine, { now: new Date("2026-09-24T23:00:00Z"), manual: true });
  fetchMock.assertNoPendingInterceptors();
  expect(prompt.messages[0].content).toContain("morning plan");
  expect(prompt.messages[1].content).toContain("*今日やること* · *タスクの状況* · *相談したいこと*");
  expect(prompt.messages[1].content).toContain("requestsStillWaiting");
  expect(out.card).toMatchObject({ title: "今日の予定 2026-09-25", priority: "high", dailyReport: { part: "morning", status: "draft" } });
});

test("a new draft closes its routine's older one nobody posted, and leaves posted ones and other routines alone", async () => {
  const plan = await getRoutine(env.DB, ORG, (await makePlan()).data.routine.id);
  const report = await getRoutine(env.DB, ORG, (await makeDaily()).data.routine.id);
  const quiet = ENV({ OPENAI_API_KEY: undefined });
  const first = (await runRoutine(quiet, plan, { now: new Date("2026-09-23T23:00:00Z"), manual: true })).card;
  const evening = (await runRoutine(quiet, report, { now: new Date("2026-09-24T13:00:00Z"), manual: true })).card;
  const second = (await runRoutine(quiet, plan, { now: new Date("2026-09-24T23:00:00Z"), manual: true })).card;
  const { getCard } = await import("../src/db.js");
  expect(await getCard(env.DB, ORG, first.id)).toMatchObject({ status: "completed", dailyReport: { status: "expired" } });
  expect(await getCard(env.DB, ORG, second.id)).toMatchObject({ status: "pending", dailyReport: { status: "draft" } });
  expect(await getCard(env.DB, ORG, evening.id)).toMatchObject({ status: "pending", dailyReport: { status: "draft" } });
  // An expired draft cannot be posted.
  expect((await post("/channels/daily-report/post", toru, { orgId: ORG, cardId: first.id, text: "late" })).status).toBe(409);
});

test("the notification says it is yours to check and where it goes; an unposted one is asked about once more after two hours", async () => {
  const card = { id: "d", recipientUserID: "toru", senderUserID: "toru", title: "日報 2026-09-24", summary: "…", dailyReport: { channel: "b:general", status: "draft" } };
  expect(composeAlert({ card, kind: "created", locale: "ja" })).toEqual({ title: "日報 2026-09-24", subtitle: "下書きができました。確認して #general に投稿してください。" });
  expect(composeAlert({ card, kind: "nudged", locale: "en" }).subtitle).toBe("Your draft is still not posted. Check it and post it to #general.");
  expect(composeEmail({ card, kind: "created", locale: "ja" }).text.startsWith("下書きができました。確認して #general に投稿してください。")).toBe(true);

  const { data } = await makeDaily();
  const routine = await getRoutine(env.DB, ORG, data.routine.id);
  const { card: draft } = await runRoutine(ENV({ OPENAI_API_KEY: undefined }), routine, { now: NOW, manual: true });
  expect((await remindDailyDrafts(env, { now: new Date(NOW.getTime() + 3600000) })).reminded).toBe(0);
  expect((await remindDailyDrafts(env, { now: new Date(NOW.getTime() + 2 * 3600000 + 1000) })).reminded).toBe(1);
  // Once.
  expect((await remindDailyDrafts(env, { now: new Date(NOW.getTime() + 5 * 3600000) })).reminded).toBe(0);
  const { getCard } = await import("../src/db.js");
  expect((await getCard(env.DB, ORG, draft.id)).dailyReport.remindedAt).toBeTruthy();
});

test("an unposted draft cannot be put away by any client, and a client cannot forge one", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  const draft = {
    id: "daily-x", recipientUserID: "toru", senderUserID: "toru", type: "notification", format: "fyi", status: "pending",
    priority: "high", title: "日報 2026-09-24", summary: "…", createdAt: NOW.toISOString(),
    report: { markdown: "x" }, dailyReport: { routineId: "r", part: "evening", channel: "b:general", date: "2026-09-24", status: "draft", text: "x" },
  };
  await saveCard(env.DB, ORG, draft);
  const room = await joined(ORG, toru);

  // An older app republishing it acknowledged.
  room.ws.send(JSON.stringify({ type: "card_updated", payload: { card: {
    ...draft, status: "completed", decision: { action: "acknowledge", actorUserID: "toru", decidedAt: new Date().toISOString() },
  } } }));
  const refused = await message(room.messages, (m) => m.type === "RUN_ERROR");
  expect(refused.message).toContain("post it");
  // And one answering the tool call instead.
  room.messages.length = 0;
  room.ws.send(JSON.stringify({ type: "tool_result", payload: { toolCallId: "t", content: { cardId: "daily-x", action: "acknowledge", actorUserID: "toru" } } }));
  expect((await message(room.messages, (m) => m.type === "RUN_ERROR")).message).toContain("post it");
  expect(await getCard(env.DB, ORG, "daily-x")).toMatchObject({ status: "pending", dailyReport: { status: "draft" } });

  // A "draft" sent over the socket is not one.
  room.messages.length = 0;
  room.ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "forged", type: "notification", status: "pending", recipientUserID: "toru", priority: "low", title: "x", createdAt: new Date().toISOString(),
    dailyReport: { routineId: "r", channel: "b:general", status: "draft", text: "posted as Toru" },
  } } }));
  await message(room.messages, (m) => JSON.stringify(m).includes("forged"));
  expect((await getCard(env.DB, ORG, "forged")).dailyReport).toBeUndefined();
});

import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { runDueRoutines, digestReport } from "../src/routines.js";
import { runAutomations } from "../src/scheduled.js";

// Routines: the AI does work on a schedule and the result arrives in the
// feed as a report card. Made from a sentence, owned by one person, run by
// the cron in the owner's time zone.

const ORG = "personal:routines";
let toru;
let mika;
let outsider;
const ENV = (over = {}) => ({ ...env, ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over));
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const post = (path, token, body, over) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, over);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8401", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8402", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8403", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8401", "admin");
  await upsertMembership(env.DB, ORG, "8402", "member");
  await upsertMembership(env.DB, "personal:other", "8403", "admin");
  toru = await createSession(env.DB, "8401", "gho_toru");
  mika = await createSession(env.DB, "8402", "gho_mika");
  outsider = await createSession(env.DB, "8403", "gho_nobody");
  const now = Date.now();
  await saveCard(env.DB, ORG, {
    id: "w-1", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "Approve the autumn menu",
    status: "pending", priority: "urgent", createdAt: new Date(now - 3 * 86400000).toISOString(),
  });
  await saveCard(env.DB, ORG, {
    id: "d-1", recipientUserID: "mika", senderUserID: "toru", type: "approval", title: "Hire a part-timer for weekends",
    status: "approved", priority: "high", createdAt: new Date(now - 2 * 86400000).toISOString(),
    decision: { action: "approve", actorUserID: "mika", decidedAt: new Date(now - 12 * 3600000).toISOString(), note: "Up to 20 hours a week" },
  });
});
afterEach(() => fetchMock.deactivate?.());

test("one sentence is read into a schedule without a model", async () => {
  const res = await post("/routines/parse", toru, { text: "毎週月曜9時に先週の決定をまとめて", locale: "ja" });
  const { parsed } = await res.json();
  expect(parsed).toMatchObject({ cadence: "weekly", weekday: 1, hour: 9, instruction: "先週の決定をまとめて", schedule: "毎週月曜 09:00" });
});

test("a routine is made, listed only to its owner, changed and deleted", async () => {
  const made = await post("/routines", toru, {
    orgId: ORG, instruction: "先週の決定と滞留をまとめて", cadence: "weekly", weekday: 1, hour: 9, timezone: "Asia/Tokyo",
  });
  expect(made.status).toBe(201);
  const { routine } = await made.json();
  expect(routine).toMatchObject({ cadence: "weekly", weekday: 1, hour: 9, enabled: true, schedule: "毎週月曜 09:00", title: "先週の決定と滞留をまとめて" });
  expect(Date.parse(routine.nextRunAt)).toBeGreaterThan(Date.now());
  expect(routine.recipient).toMatchObject({ self: true, name: "Toru" });

  // Mika is on the team and still does not see Toru's routines.
  const theirs = await call(`/routines?orgId=${encodeURIComponent(ORG)}`, { headers: headers(mika) });
  expect((await theirs.json()).routines).toEqual([]);
  // Nor change or delete one.
  const hijack = await call(`/routines/${routine.id}`, { method: "PUT", headers: headers(mika), body: JSON.stringify({ orgId: ORG, enabled: false }) });
  expect(hijack.status).toBe(404);
  // Nobody outside the workspace reaches it at all.
  const outside = await call(`/routines?orgId=${encodeURIComponent(ORG)}`, { headers: headers(outsider) });
  expect(outside.status).toBe(403);

  const paused = await call(`/routines/${routine.id}`, { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, enabled: false, cadence: "daily" }) });
  const pausedBody = await paused.json();
  expect(pausedBody.routine).toMatchObject({ enabled: false, nextRunAt: null, cadence: "daily", weekday: null });

  const gone = await call(`/routines/${routine.id}?orgId=${encodeURIComponent(ORG)}`, { method: "DELETE", headers: headers(toru) });
  expect(gone.status).toBe(200);
  const list = await call(`/routines?orgId=${encodeURIComponent(ORG)}`, { headers: headers(toru) });
  expect((await list.json()).routines).toEqual([]);
});

test("bad input is refused with the reason", async () => {
  expect((await post("/routines", toru, { orgId: ORG, instruction: "x", cadence: "hourly", hour: 9 })).status).toBe(400);
  expect((await post("/routines", toru, { orgId: ORG, instruction: "x", cadence: "daily", hour: 24 })).status).toBe(400);
  expect((await post("/routines", toru, { orgId: ORG, instruction: "", cadence: "daily", hour: 9 })).status).toBe(400);
  const stranger = await post("/routines", toru, { orgId: ORG, instruction: "x", cadence: "daily", hour: 9, recipient: "member:ffffffffffffffff" });
  expect(stranger.status).toBe(400);
});

test("a brief needs no instruction, and a teammate can be the recipient", async () => {
  const members = await (await call(`/members?orgId=${encodeURIComponent(ORG)}`, { headers: headers(toru) })).json();
  const mikaRef = members.members.find((m) => m.name === "Mika").ref;
  const res = await post("/routines", toru, { orgId: ORG, kind: "brief", cadence: "weekdays", hour: 8, recipient: `member:${mikaRef}` });
  expect(res.status).toBe(201);
  const { routine } = await res.json();
  expect(routine.title).toBe("朝のブリーフ");
  expect(routine.instruction).toContain("自分待ち");
  expect(routine.recipient).toMatchObject({ self: false, name: "Mika", ref: `member:${mikaRef}` });
});

test("run now, with no model, delivers a digest report card to the recipient", async () => {
  const { routine } = await (await post("/routines", toru, { orgId: ORG, kind: "brief", cadence: "daily", hour: 9, timezone: "Asia/Tokyo" })).json();
  const before = routine.nextRunAt;
  const res = await post(`/routines/${routine.id}/run`, toru, { orgId: ORG }, { OPENAI_API_KEY: undefined });
  expect(res.status).toBe(200);
  const body = await res.json();
  const { getCard } = await import("../src/db.js");
  const card = await getCard(env.DB, ORG, body.cardId);
  expect(card).toMatchObject({ recipientUserID: "toru", senderUserID: "toru", type: "notification", format: "fyi", sourceApp: "Routine", status: "pending" });
  expect(card.report.by).toBe("digest");
  expect(card.report.markdown).toContain("Approve the autumn menu");
  expect(card.report.markdown).toContain("Hire a part-timer for weekends");
  expect(card.summary).toContain("1件");
  // Run now does not move the schedule.
  expect(body.routine.nextRunAt).toBe(before);
  expect(body.routine.runs).toBe(1);
  expect(body.routine.lastCardId).toBe(body.cardId);
});

test("with a model, the report is written from the team's material and its cost recorded", async () => {
  const { routine } = await (await post("/routines", toru, { orgId: ORG, instruction: "Summarise what we decided", cadence: "daily", hour: 9 })).json();
  fetchMock.activate();
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      prompt = JSON.parse(opts.body);
      return {
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
        choices: [{ message: { content: JSON.stringify({ title: "This week", summary: "One hire approved.", markdown: "## Decided\n- **Hire a part-timer** — Mika" }) } }],
      };
    });
  const res = await post(`/routines/${routine.id}/run`, toru, { orgId: ORG }, { OPENAI_API_KEY: "sk-test" });
  const body = await res.json();
  const { getCard } = await import("../src/db.js");
  const card = await getCard(env.DB, ORG, body.cardId);
  expect(card.report).toMatchObject({ by: "model", markdown: "## Decided\n- **Hire a part-timer** — Mika" });
  expect(card.title).toBe("This week");
  const user = prompt.messages[1].content;
  expect(user).toContain("Summarise what we decided");
  expect(user).toContain("Hire a part-timer for weekends");
  expect(user).toContain("Reader language: ja");
  expect(body.routine.lastUsd).toBeGreaterThan(0);
  const ledger = await env.DB.prepare("SELECT purpose FROM ai_calls WHERE org_id = ?1").bind(ORG).all();
  expect(ledger.results.map((r) => r.purpose)).toContain("routine");
});

test("the cron runs what is due, advances it, and leaves the rest", async () => {
  const due = (await (await post("/routines", toru, { orgId: ORG, kind: "brief", cadence: "daily", hour: 9 })).json()).routine;
  const later = (await (await post("/routines", toru, { orgId: ORG, instruction: "later", cadence: "daily", hour: 9 })).json()).routine;
  await env.DB.prepare("UPDATE routines SET next_run_at = ?2 WHERE id = ?1").bind(due.id, "2026-01-01T00:00:00.000Z").run();
  // A tick at a quarter past one, before today's nine o'clock.
  const tickAt = new Date(Date.parse(later.nextRunAt) - 60000);
  const out = await runDueRoutines(ENV({ OPENAI_API_KEY: undefined }), { now: tickAt });
  expect(out).toEqual({ due: 1, delivered: 1 });
  const row = await env.DB.prepare("SELECT runs, next_run_at, last_run_at FROM routines WHERE id = ?1").bind(due.id).first();
  expect(row.runs).toBe(1);
  // Moved to its next nine o'clock, which is the one the other is waiting for.
  expect(row.next_run_at).toBe(later.nextRunAt);
  const untouched = await env.DB.prepare("SELECT runs FROM routines WHERE id = ?1").bind(later.id).first();
  expect(untouched.runs).toBe(0);
  // And the scheduled handler reaches them, at nine, off the proposal tick.
  const nine = new Date(later.nextRunAt);
  const tick = await runAutomations(ENV({ OPENAI_API_KEY: undefined }), null, nine);
  expect(tick.routines).toEqual({ due: 2, delivered: 2 });
  expect(tick.proposals).toBeNull();
});

test("a routine whose recipient left the workspace pauses instead of reporting into it", async () => {
  const members = await (await call(`/members?orgId=${encodeURIComponent(ORG)}`, { headers: headers(toru) })).json();
  const mikaRef = members.members.find((m) => m.name === "Mika").ref;
  const { routine } = await (await post("/routines", toru, { orgId: ORG, kind: "brief", cadence: "daily", hour: 9, recipient: `member:${mikaRef}` })).json();
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '8402'").bind(ORG).run();
  await env.DB.prepare("UPDATE routines SET next_run_at = ?2 WHERE id = ?1").bind(routine.id, "2026-01-01T00:00:00.000Z").run();
  const out = await runDueRoutines(ENV({ OPENAI_API_KEY: undefined }), { now: new Date("2026-09-24T09:05:00Z") });
  expect(out.delivered).toBe(0);
  const row = await env.DB.prepare("SELECT enabled, next_run_at, last_error FROM routines WHERE id = ?1").bind(routine.id).first();
  expect(row).toMatchObject({ enabled: 0, next_run_at: null });
  expect(row.last_error).toContain("no longer");
  const cards = await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE recipient_user_id = 'mika' AND card_id LIKE 'routine-%'").first();
  expect(cards.n).toBe(0);
});

test("the digest is honest when there is nothing", () => {
  const out = digestReport({ title: "Brief" }, { since: "2026-09-23T00:00:00Z", until: "2026-09-24T00:00:00Z", decided: [], waiting: [], stuck: [], created: 0 }, "en");
  expect(out.summary).toBe("Nothing is waiting on you · 0 decided · 0 stuck");
  expect(out.markdown).toContain("## Waiting on you (0)\n\n- Nothing.");
});

test("a report names people, never their logins, and says what was done in words", async () => {
  const { upsertUser, upsertMembership, saveCard, getCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:aya@example.com", login: "u:aya@example.com", name: "Aya", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "email:aya@example.com", "member");
  await saveCard(env.DB, ORG, {
    id: "d-aya", recipientUserID: "u:aya@example.com", senderUserID: "toru", type: "approval", title: "Order the new cups",
    status: "approved", createdAt: new Date(Date.now() - 3600000).toISOString(),
    decision: { action: "approve", actorUserID: "u:aya@example.com", decidedAt: new Date().toISOString() },
  });
  const { routine } = await (await post("/routines", toru, { orgId: ORG, instruction: "summarise the week", cadence: "daily", hour: 9 })).json();
  expect(routine.title).toBe("Summarise the week");
  const { cardId } = await (await post(`/routines/${routine.id}/run`, toru, { orgId: ORG }, { OPENAI_API_KEY: undefined })).json();
  const card = await getCard(env.DB, ORG, cardId);
  expect(card.report.markdown).toContain("Order the new cups — Aya · 承認");
  expect(JSON.stringify(card)).not.toContain("aya@example.com");
  expect(card.requestedBy).toEqual({ login: "toru", name: "Toru" });
});

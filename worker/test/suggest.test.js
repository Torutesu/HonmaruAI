import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { ruleSuggestions } from "../src/suggest.js";

// What the empty "Your AI" conversation offers: drawn from the person's own
// work — their teammates, channels, what is waiting — not the same three
// examples for everyone.

const ORG = "personal:suggest";
let toru; let outsider;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, over = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, { headers: { "x-session-token": token } }), { ...env, ...over }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const QUIET = { OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined };

async function card(id, from, to, title, status, createdAt) {
  await env.DB.prepare(
    "INSERT INTO cards (org_id, card_id, recipient_user_id, sender_user_id, created_at, data, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
  ).bind(ORG, id, to, from, createdAt, JSON.stringify({ id, title, status }), status).run();
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM ai_suggestions; DELETE FROM cards; DELETE FROM routines; DELETE FROM rate_limits;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9901", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "9902", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9903", login: "stranger", name: "Stranger", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9901", "admin");
  await upsertMembership(env.DB, ORG, "9902", "member");
  await upsertMembership(env.DB, "personal:other", "9903", "admin");
  await env.DB.prepare("UPDATE memberships SET title = 'Head of purchasing' WHERE org_id = ?1 AND user_github_id = '9902'").bind(ORG).run();
  await upsertBusiness(env.DB, ORG, { name: "Kitchen", createdBy: "9901" });
  toru = await createSession(env.DB, "9901", "gho_t");
  outsider = await createSession(env.DB, "9903", "gho_s");
});
afterEach(() => fetchMock.deactivate?.());

test("without a model the suggestions are made from real teammates, channels and what is waiting", async () => {
  await card("c1", "toru", "mika", "Roaster price +8%", "pending", new Date(Date.now() - 3 * 86400000).toISOString());
  const res = await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}`, toru, QUIET);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.byModel).toBe(false);
  expect(body.suggestions).toHaveLength(3);
  const texts = body.suggestions.map((s) => s.text);
  // In toru's language, naming who is really there and what is really waiting.
  expect(texts).toContain("Mikaさんに「Roaster price +8%」の返事を催促して");
  expect(texts).toContain("#Kitchenの今週の計画をMikaさんに承認してもらって");
  expect(texts).toContain("毎週月曜9時に#Kitchenの先週の決定をまとめて");
  expect(JSON.stringify(body)).not.toMatch(/Kenji|supplier price/);
});

test("with a model it is asked with the person's material, and its answer is kept for a while", async () => {
  await card("c1", "toru", "mika", "Roaster price +8%", "pending", new Date(Date.now() - 2 * 86400000).toISOString());
  let prompt;
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { prompt = JSON.parse(b); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ suggestions: [
      { text: "焙煎所の値上げについてMikaさんの判断を仰いで", kind: "decision" },
      { text: "Mikaさんに「Roaster price +8%」の返事を催促して", kind: "follow_up" },
      { text: "毎週月曜9時に#Kitchenの決定をまとめて", kind: "automation" },
      { text: "毎週月曜9時に#Kitchenの決定をまとめて", kind: "automation" },
    ] }) } }] });
  const over = { OPENAI_API_KEY: "sk-test" };
  const first = await (await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}`, toru, over)).json();
  fetchMock.assertNoPendingInterceptors();
  const user = prompt.messages[1].content;
  expect(user).toContain("Reader language: ja");
  expect(user).toContain("Head of purchasing");
  expect(user).toContain("Roaster price +8%");
  expect(user).toContain("Kitchen");
  expect(user).not.toContain("mika@");
  expect(first).toMatchObject({ byModel: true, cached: false });
  // A repeated line is said once.
  expect(first.suggestions.map((s) => s.text)).toEqual([
    "焙煎所の値上げについてMikaさんの判断を仰いで",
    "Mikaさんに「Roaster price +8%」の返事を催促して",
    "毎週月曜9時に#Kitchenの決定をまとめて",
  ]);

  // Opened again: from what was kept, no second call.
  const again = await (await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}`, toru, over)).json();
  expect(again).toMatchObject({ cached: true, suggestions: first.suggestions });
  fetchMock.assertNoPendingInterceptors();
});

test("asking for others writes them again", async () => {
  await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}`, toru, QUIET);
  const again = await (await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}&refresh=1`, toru, QUIET)).json();
  expect(again.cached).toBe(false);
});

test("only a member of the workspace gets suggestions from it", async () => {
  expect((await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}`, outsider, QUIET)).status).toBe(403);
  expect((await call(`/ai/suggestions?orgId=${encodeURIComponent(ORG)}`, "nope", QUIET)).status).toBe(401);
});

test("someone on their own, with nothing yet, still gets three useful first steps", () => {
  const empty = { me: { name: "A", title: null }, howIWork: null, teammates: [], channels: [], waitingOnOthers: [], waitingOnMe: [], recentDecisions: [], automations: [], iSaid: [] };
  const out = ruleSuggestions(empty, "en");
  expect(out).toHaveLength(3);
  expect(out.map((s) => s.text)).toEqual([
    "Every Monday at 9, summarise last week’s decisions",
    "Every Friday at 17:00, tell me what is still waiting on others",
    "Remind me tomorrow at 9 to review what is waiting on me",
  ]);
  // A weekly report already running is not suggested again.
  const busy = ruleSuggestions({ ...empty, automations: [{ kind: "report", title: "x", cadence: "weekly" }] }, "en");
  expect(busy.map((s) => s.text)).not.toContain("Every Monday at 9, summarise last week’s decisions");
  expect(busy).toHaveLength(3);
});

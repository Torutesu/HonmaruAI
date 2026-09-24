import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { learnFromDecision, relevantMemories, termsOf, addMemory, MAX_MEMORIES_PER_ORG } from "../src/memory.js";

// The playbook: rules the AI learns from decisions with a reason, or is
// told. Every one is a row a person can read, change or delete, and every
// model call that writes for the team reads the ones that bear on it.

const ORG = "personal:playbook";
let toru;
let mika;
let outsider;
const ENV = (over = {}) => ({ ...env, ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over));
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const q = `orgId=${encodeURIComponent(ORG)}`;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8501", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8502", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8503", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8501", "admin");
  await upsertMembership(env.DB, ORG, "8502", "member");
  await upsertMembership(env.DB, "personal:elsewhere", "8503", "admin");
  toru = await createSession(env.DB, "8501", "gho_toru");
  mika = await createSession(env.DB, "8502", "gho_mika");
  outsider = await createSession(env.DB, "8503", "gho_nobody");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a member writes a rule; only its author or an admin changes it; an admin clears the lot", async () => {
  const made = await call("/memories", { method: "POST", headers: headers(mika), body: JSON.stringify({ orgId: ORG, text: "  Anything touching the brand goes to Yui first.  " }) });
  expect(made.status).toBe(201);
  const { memory } = await made.json();
  expect(memory).toMatchObject({ text: "Anything touching the brand goes to Yui first.", origin: "told", createdBy: "mika" });

  const byToru = await call("/memories", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, text: "Refunds over ¥50,000 need Toru." }) });
  const toruRule = (await byToru.json()).memory;
  // Mika cannot rewrite Toru's rule.
  const refused = await call(`/memories/${toruRule.id}`, { method: "PUT", headers: headers(mika), body: JSON.stringify({ orgId: ORG, text: "Refunds need nobody." }) });
  expect(refused.status).toBe(403);
  // Toru, an admin, can change Mika's.
  const fixed = await call(`/memories/${memory.id}`, { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, text: "Anything touching the brand goes to Yui." }) });
  expect((await fixed.json()).memory.text).toBe("Anything touching the brand goes to Yui.");

  const list = await (await call(`/memories?${q}`, { headers: headers(mika) })).json();
  expect(list.memories).toHaveLength(2);
  expect(list.canForget).toBe(false);
  expect(list.memories.find((m) => m.createdBy === "mika").canEdit).toBe(true);
  expect(list.memories.find((m) => m.createdBy === "toru").canEdit).toBe(false);

  expect((await call(`/memories?${q}`, { headers: headers(outsider) })).status).toBe(403);
  expect((await call(`/memories?${q}`, { method: "DELETE", headers: headers(mika) })).status).toBe(403);
  const cleared = await call(`/memories?${q}`, { method: "DELETE", headers: headers(toru) });
  expect((await cleared.json()).removed).toBe(2);
});

test("a decision with a reason teaches a rule; a reason about one case teaches nothing", async () => {
  let asked;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => { asked = JSON.parse(opts.body); return { choices: [{ message: { content: JSON.stringify({ rule: "Supplier price rises wait until the lease is settled." }) } }] }; });
  const card = {
    id: "c-sup", title: "Supplier price +8%", summary: "Kenji wants to switch", type: "approval",
    decision: { action: "decline", actorUserID: "toru", note: "Not until the lease is settled" },
  };
  const learned = await learnFromDecision(ENV({ OPENAI_API_KEY: "sk-test" }), { orgId: ORG, card, actorLogin: "toru", actorGithubId: "8501" });
  expect(learned).toMatchObject({ text: "Supplier price rises wait until the lease is settled.", origin: "learned", cardId: "c-sup", createdBy: "toru" });
  expect(asked.messages[1].content).toContain("Not until the lease is settled");

  // "ok" is not a reason; no model call is made for it.
  const none = await learnFromDecision(ENV({ OPENAI_API_KEY: "sk-test" }), {
    orgId: ORG, card: { ...card, id: "c-2", decision: { action: "approve", note: "ok" } }, actorLogin: "toru", actorGithubId: "8501",
  });
  expect(none).toBeNull();

  // The model saying null stores nothing.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ rule: null }) } }] });
  const nothing = await learnFromDecision(ENV({ OPENAI_API_KEY: "sk-test" }), {
    orgId: ORG, card: { ...card, id: "c-3", decision: { action: "revised", note: "Typo in the second line, fix it" } }, actorLogin: "toru", actorGithubId: "8501",
  });
  expect(nothing).toBeNull();
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM memories WHERE org_id = ?1").bind(ORG).first();
  expect(rows.n).toBe(1);
});

test("the AI's own cards, and a free tier with billing on, teach nothing", async () => {
  const report = { id: "r", title: "Weekly", report: { markdown: "x" }, decision: { action: "acknowledge", note: "thanks, very useful report" } };
  expect(await learnFromDecision(ENV({ OPENAI_API_KEY: "sk-test" }), { orgId: ORG, card: report, actorLogin: "toru", actorGithubId: "8501" })).toBeNull();
  const card = { id: "c", title: "Budget", decision: { action: "decline", note: "Never above the quarterly cap" } };
  expect(await learnFromDecision(ENV({ OPENAI_API_KEY: "sk-test", REVENUECAT_SECRET_KEY: "rc" }), { orgId: ORG, card, actorLogin: "toru", actorGithubId: "8501" })).toBeNull();
});

test("the router is handed the rules that bear on the instruction", async () => {
  await addMemory(env.DB, ORG, { text: "Supplier price rises wait until the lease is settled." });
  await addMemory(env.DB, ORG, { text: "Brand work goes to Mika." });
  let prompt;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      prompt = JSON.parse(opts.body);
      return { choices: [{ message: { content: null, tool_calls: [] } }] };
    });
  await call("/ai/route", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ text: "Ask Mika to approve the new supplier price", orgId: ORG, sender: { id: "toru", name: "Toru", role: "admin" }, readerLanguage: "en" }),
  }, { OPENAI_API_KEY: "sk-test" });
  const user = prompt.messages.find((m) => m.role === "user").content;
  expect(user).toContain("Team playbook");
  expect(user).toContain("Supplier price rises wait until the lease is settled.");
});

test("relevance: the rule about the subject first, then the newest", async () => {
  await addMemory(env.DB, ORG, { text: "仕入れ価格の値上げはリース契約が決まるまで保留" });
  await addMemory(env.DB, ORG, { text: "Brand work goes to Mika." });
  const hits = await relevantMemories(env.DB, ORG, "新しい仕入れ価格を承認して", { limit: 2 });
  expect(hits[0].text).toContain("仕入れ価格");
  expect(termsOf("仕入れ").has("仕入")).toBe(true);
});

test("a full playbook drops its oldest learned rule, never a written one", async () => {
  await addMemory(env.DB, ORG, { text: "Written by hand, keep me." });
  await addMemory(env.DB, ORG, { text: "oldest learned", origin: "learned" });
  const stmt = env.DB.prepare("INSERT INTO memories (id, org_id, text, origin, created_at, updated_at) VALUES (?1, ?2, ?3, 'learned', ?4, ?4)");
  await env.DB.batch(Array.from({ length: MAX_MEMORIES_PER_ORG - 2 }, (_, i) => stmt.bind(`m${i}`, ORG, `rule ${i}`, new Date(Date.now() + i + 10).toISOString())));
  await addMemory(env.DB, ORG, { text: "one more", origin: "learned" });
  const texts = (await env.DB.prepare("SELECT text FROM memories WHERE org_id = ?1").bind(ORG).all()).results.map((r) => r.text);
  expect(texts).toHaveLength(MAX_MEMORIES_PER_ORG);
  expect(texts).toContain("Written by hand, keep me.");
  expect(texts).not.toContain("oldest learned");
});

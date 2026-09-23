import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { costOf, noteUsage, jevEntry, settleUsage, aiSpend } from "../src/ledger.js";
import { providerConfig } from "../src/provider.js";

// What the AI costs, call by call — the number Insights shows and the one
// the allowance never knew.

const ORG = "personal:ledger";
const TEAM = { nodes: [
  { id: "toru", kind: "person", label: "toru · Admin" },
  { id: "kenji", kind: "person", label: "kenji · Engineer" }], edges: [] };
let toru;
const ENV = (over = {}) => ({ ...env, OPENAI_API_KEY: "sk-server", ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over), { waitUntil() {} });
const route = (headers, over) => call("/ai/route", {
  method: "POST",
  headers: { "content-type": "application/json", "x-session-token": toru, ...headers },
  body: JSON.stringify({ text: "Ask kenji to review the deploy", sender: { id: "toru", name: "Toru" }, orgId: ORG, organization: { ...TEAM, orgId: ORG } }),
}, over);
const written = (tool) => ({ choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: { name: "create_decision_card",
  arguments: JSON.stringify({ recipientUserID: "kenji", cardType: "task", title: "Review the deploy", summary: "x", context: "scope: deploy", priority: "medium", routingReason: "y" }) } }] } }],
  model: "gpt-4o-mini-2024-07-18", usage: { prompt_tokens: 1200, completion_tokens: 90 } });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8801", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8802", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8801", "admin");
  await upsertMembership(env.DB, ORG, "8802", "member");
  toru = await createSession(env.DB, "8801", "gho_toru");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("list prices: a known model, a dated variant of it, a free-output one, and an unknown one", () => {
  expect(costOf("gpt-4o-mini", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(0.75, 6);
  expect(costOf("gpt-4o-mini-2024-07-18", { input: 1_000_000 })).toBeCloseTo(0.15, 6);
  expect(costOf("jev-latest", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(0.042, 6);
  expect(costOf("something-new", { input: 1_000_000 })).toBeCloseTo(0.15, 6);
});

test("a note lands on a provider from providerConfig and is ignored on a bare one", () => {
  const provider = providerConfig(ENV(), undefined);
  noteUsage(provider, "ask", { model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 10 } });
  expect(provider.usage).toHaveLength(1);
  expect(provider.usage[0]).toMatchObject({ purpose: "ask", provider: "OpenAI", model: "gpt-4o-mini", input: 100, output: 10 });
  const bare = { endpoint: "x", apiKey: "y", model: "gpt-4o-mini" };
  noteUsage(bare, "ask", { usage: { prompt_tokens: 100 } });
  expect(bare.usage).toBeUndefined();
  expect(jevEntry("route", { input_tokens: 640 })).toMatchObject({ provider: "jev", model: "jev-latest", input: 640, output: 0 });
});

test("a routed instruction writes the model's tokens to the team's ledger, and Insights adds them up", async () => {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, written());
  const res = await route();
  expect(res.status).toBe(200);
  expect((await res.json()).routedBy).toBe("OpenAI");

  const { results } = await env.DB.prepare("SELECT * FROM ai_calls WHERE org_id = ?1").bind(ORG).all();
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ purpose: "route", provider: "OpenAI", model: "gpt-4o-mini-2024-07-18", input_tokens: 1200, output_tokens: 90, byok: 0, user_github_id: "8801" });
  expect(results[0].usd).toBeCloseTo(1200 * 0.15 / 1e6 + 90 * 0.6 / 1e6, 9);

  const m = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": toru } })).json();
  expect(m.ai).toMatchObject({ calls: 1, inputTokens: 1200, outputTokens: 90, byokCalls: 0, jevShare: 0 });
  expect(m.ai.usd).toBeGreaterThan(0);
  expect(m.ai.ourUsd).toBe(m.ai.usd);
  expect(m.ai.byPurpose).toEqual([{ purpose: "route", calls: 1, usd: m.ai.usd }]);
});

test("a call on the person's own key is theirs on the bill; System One's decision counts as its own provider", async () => {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, written());
  expect((await route({ "x-ai-key": "sk-user" })).status).toBe(200);
  await settleUsage(env.DB, undefined, { orgId: ORG, githubId: "8801" }, [jevEntry("route", { input_tokens: 640 })]);
  const spend = await aiSpend(env.DB, ORG, "2000-01-01");
  expect(spend.calls).toBe(2);
  expect(spend.byokCalls).toBe(1);
  expect(spend.ourUsd).toBeCloseTo(640 * 0.042 / 1e6, 8);
  expect(spend.jevShare).toBe(0.5);
  expect(spend.byProvider.map((p) => p.provider).sort()).toEqual(["OpenAI", "jev"]);
});

test("a ledger that cannot be written never fails the decision", async () => {
  const provider = providerConfig(ENV(), undefined);
  noteUsage(provider, "ask", { usage: { prompt_tokens: 5 } });
  const broken = { prepare() { throw new Error("no table"); } };
  await expect(settleUsage(broken, provider, { orgId: ORG })).resolves.toBe(1);
  expect(provider.usage).toHaveLength(0);
});

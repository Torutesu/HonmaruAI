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
let kenji;
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
  kenji = await createSession(env.DB, "8802", "gho_kenji");
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

  const m = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}&days=14&aiDays=30`, { headers: { "x-session-token": toru } })).json();
  expect(m.ai).toMatchObject({ calls: 1, inputTokens: 1200, outputTokens: 90, byokCalls: 0, jevShare: 0 });
  expect(m.ai.usd).toBeGreaterThan(0);
  expect(m.ai.ourUsd).toBe(m.ai.usd);
  expect(m.ai.byPurpose).toEqual([{ purpose: "route", calls: 1, usd: m.ai.usd }]);
  expect(m.days).toBe(14);
  expect(m.ai.days).toBe(30);
  expect(m.ai.daily).toHaveLength(30);
  expect(m.ai.daily.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), calls: 1, ourUsd: m.ai.ourUsd, byokUsd: 0 });
  expect(m.ai.daily.reduce((sum, day) => sum + day.ourUsd, 0)).toBeCloseTo(m.ai.ourUsd, 8);
  expect(m.ai.byMember).toEqual([{ userId: "8801", login: "toru", name: "Toru", calls: 1, inputTokens: 1200, outputTokens: 90, usd: m.ai.ourUsd }]);
  const memberMetrics = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}&aiDays=30`, { headers: { "x-session-token": kenji } })).json();
  expect(memberMetrics.ai.byMember).toBeUndefined();
});

test("workspace admins can review workflow model usage without including personal keys", async () => {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at)
    VALUES('wf-report',?1,'Monthly report',1,'{}','[]','8801',?2,?2)`).bind(ORG, now).run();
  await env.DB.prepare(`INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at)
    VALUES('run-report',?1,'wf-report','schedule','succeeded','[]',?2)`).bind(ORG, now).run();
  await env.DB.prepare(`INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros)
    VALUES('usage-priced',?1,'wf-report','run-report',1,'OpenAI','gpt-4o-mini',100,20,0,?2,1250),
          ('usage-unknown',?1,'wf-report','run-report',1,'OpenAI','future-model',NULL,NULL,0,?2,NULL),
          ('usage-personal',?1,'wf-report','run-report',1,'OpenAI','gpt-4o-mini',100,20,1,?2,9000)`)
    .bind(ORG, now).run();

  const admin = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}&aiDays=30`, { headers: { "x-session-token": toru } })).json();
  expect(admin.ai.byAutomation).toEqual([{ workflowId: 'wf-report', name: 'Monthly report', calls: 2, inputTokens: 100, outputTokens: 20, unpricedCalls: 1, usd: 0.00125 }]);
  const member = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}&aiDays=30`, { headers: { "x-session-token": kenji } })).json();
  expect(member.ai.byAutomation).toBeUndefined();
});

test("admin usage breakdowns include explicitly attributed rooms and agents only", async () => {
  const { upsertBusiness } = await import("../src/db.js");
  await upsertBusiness(env.DB, ORG, { name: "Sales", createdBy: "8801" });
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,owner_login,created_at,updated_at)
    VALUES(?1,'agent-research','researcher','Researcher','Research carefully.','toru',?2,?2)`).bind(ORG, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at)
    VALUES('app-crm',?1,'CRM','table-crm','{}','8801',?2,?2)`).bind(ORG, new Date().toISOString()).run();
  const provider = providerConfig(ENV(), undefined);
  noteUsage(provider, "agent", { model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 20 } }, { roomSlug: "sales", agentId: "agent-research", appId: "app-crm" });
  await settleUsage(env.DB, provider, { orgId: ORG, githubId: "8801" });
  const personal = providerConfig(ENV(), undefined);
  noteUsage(personal, "agent", { model: "gpt-4o-mini", usage: { prompt_tokens: 300, completion_tokens: 40 } }, { roomSlug: "sales", agentId: "agent-research" });
  await settleUsage(env.DB, personal, { orgId: ORG, githubId: "8801", byok: true });

  const admin = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}&aiDays=30`, { headers: { "x-session-token": toru } })).json();
  expect(admin.ai.byRoom).toEqual([{ roomSlug: "sales", name: "Sales", calls: 1, inputTokens: 100, outputTokens: 20, usd: expect.any(Number) }]);
  expect(admin.ai.byAgent).toEqual([{ agentId: "agent-research", name: "Researcher", calls: 1, inputTokens: 100, outputTokens: 20, usd: expect.any(Number) }]);
  expect(admin.ai.byApp).toEqual([{ appId: "app-crm", name: "CRM", calls: 1, inputTokens: 100, outputTokens: 20, usd: expect.any(Number) }]);
  const member = await (await call(`/metrics?orgId=${encodeURIComponent(ORG)}&aiDays=30`, { headers: { "x-session-token": kenji } })).json();
  expect(member.ai.byRoom).toBeUndefined();
  expect(member.ai.byAgent).toBeUndefined();
  expect(member.ai.byApp).toBeUndefined();
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

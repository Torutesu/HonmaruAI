import {env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, countAIUse, writeEntitlement } from "../src/db.js";
import { FREE_DAILY_ROUTES } from "../src/gate.js";
import worker from "../src/index.js";

let token;
const ENV = () => ({ ...env, REVENUECAT_SECRET_KEY: "sk-rc", OPENAI_API_KEY: "sk-server" });
const ORG = { nodes: [
  { id: "octocat", kind: "person", label: "octocat · Admin" },
  { id: "hubot", kind: "person", label: "hubot · Engineer" }], edges: [] };

const route = (headers) => worker.fetch(new Request("https://example.com/ai/route", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ text: "Ask hubot to review the deploy",
                         sender: { id: "octocat", name: "octocat" }, organization: ORG }),
}), ENV());

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "700", "gho_gate");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function freeSubscriber() {
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/700") })
    .reply(200, { subscriber: { entitlements: {} } }).persist();
}

test("a free user over the limit is degraded, not refused", async () => {
  freeSubscriber();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FREE_DAILY_ROUTES; i += 1) await countAIUse(env.DB, "700", day);

  // No OpenAI interceptor: reaching the model here would fail the test.
  const res = await route({ "x-session-token": token });
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.quotaExceeded).toBe(true);
  expect(card.routedBy).toBe("fallback");
  expect(card.recipientUserID).toBe("hubot");
});

test("a caller-supplied key skips the meter entirely", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
      name: "create_decision_card",
      arguments: JSON.stringify({ recipientUserID: "hubot", cardType: "task",
        title: "Review the deploy", summary: "x", context: "scope: deploy",
        priority: "medium", routingReason: "y" }) } }] } }] });

  const res = await route({ "x-session-token": token, "x-ai-key": "sk-user" });
  const card = await res.json();
  expect(card.routedBy).toBe("OpenAI");
  expect(card.quotaExceeded).toBeFalsy();
});

// These two seed the entitlement cache instead of calling freeSubscriber()
// again: that interceptor is persisted, so a second one would sit unmatched
// behind it and fail assertNoPendingInterceptors.
const usedByUser700 = async () => {
  const row = await env.DB
    .prepare("SELECT used FROM ai_usage WHERE user_github_id = '700' AND day = ?1")
    .bind(new Date().toISOString().slice(0, 10))
    .first();
  return row ? Number(row.used) : 0;
};

test("a routing call that fails does not burn the allowance", async () => {
  await writeEntitlement(env.DB, "700", false);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(500, "openai is down");

  const res = await route({ "x-session-token": token });
  const card = await res.json();
  // The user still gets a card, from the keyword router.
  expect(card.routedBy).toBe("fallback");
  expect(card.recipientUserID).toBe("hubot");
  expect(card.quotaExceeded).toBeFalsy();

  // Our outage is not their three.
  expect(await usedByUser700()).toBe(0);
});

test("a routing call that lands is metered once", async () => {
  await writeEntitlement(env.DB, "700", false);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
      name: "create_decision_card",
      arguments: JSON.stringify({ recipientUserID: "hubot", cardType: "task",
        title: "Review the deploy", summary: "x", context: "scope: deploy",
        priority: "medium", routingReason: "y" }) } }] } }] });

  const res = await route({ "x-session-token": token });
  const card = await res.json();
  expect(card.routedBy).toBe("OpenAI");
  expect(await usedByUser700()).toBe(1);
  // aiCalled is the meter's business, not the client's.
  expect("aiCalled" in card).toBe(false);
});

// The path routedBy could not describe: OpenAI answered and billed us, we
// rejected the answer because that recipient does not exist, and the user got a
// keyword-routed card anyway. The call still has to be metered.
test("an answer we reject is still an answer we paid for", async () => {
  await writeEntitlement(env.DB, "700", false);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
      name: "create_decision_card",
      arguments: JSON.stringify({ recipientUserID: "user-nobody", cardType: "task",
        title: "Review the deploy", summary: "x", context: "scope: deploy",
        priority: "medium", routingReason: "y" }) } }] } }] });

  const res = await route({ "x-session-token": token });
  const card = await res.json();
  expect(card.routedBy).toBe("fallback");
  expect(card.recipientUserID).toBe("hubot");
  expect(await usedByUser700()).toBe(1);
  expect("aiCalled" in card).toBe(false);
});

test("a guest never reaches System One: unmetered means spending nothing", async () => {
  // A Jev interceptor that must stay unused. It persists, so an unused one
  // is not "pending"; the flag is what the test reads.
  let asked = false;
  fetchMock.get("https://api.typesafe.ai")
    .intercept({ path: "/v1/systemone", method: "POST" })
    .reply(200, () => { asked = true; return { answers: {} }; }).persist();
  const res = await worker.fetch(new Request("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Ask hubot to review the deploy",
                           sender: { id: "octocat", name: "octocat" }, organization: ORG }),
  }), { ...ENV(), TYPESAFE_API_KEY: "ts_test" });
  expect(res.status).toBe(200);
  expect((await res.json()).routedBy).toBe("fallback");
  expect(asked).toBe(false);
});

test("a workspace on its own key is never metered, and the plan says so", async () => {
  freeSubscriber();
  const { upsertMembership, upsertUser } = await import("../src/db.js");
  const { saveAISettings } = await import("../src/orgAI.js");
  await upsertUser(env.DB, { githubId: "700", login: "octocat", name: "Octo", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "team:keyed", "700", "admin");
  await saveAISettings(env.DB, "team:keyed", { openaiKey: "sk-workspace-abcdefghijkl1234" }, "700");
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FREE_DAILY_ROUTES + 2; i += 1) await countAIUse(env.DB, "700", day);

  let calls = 0;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => { calls += 1; return {
      choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
        name: "create_decision_card",
        arguments: JSON.stringify({ recipientUserID: "octocat", cardType: "task", title: "Review",
          summary: "Review the deploy.", context: "deploy", priority: "medium", routingReason: "Only member." }),
      } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }; })
    .times(1);
  const res = await worker.fetch(new Request("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ text: "Ask octocat to review the deploy", orgId: "team:keyed" }),
  }), ENV());
  expect(res.status).toBe(200);
  expect(calls).toBe(1);

  const status = await (await worker.fetch(new Request("https://example.com/billing/status?orgId=team%3Akeyed", {
    headers: { "x-session-token": token },
  }), ENV())).json();
  expect(status).toMatchObject({ workspaceKey: true, accessSource: "workspace", remainingToday: null });
});

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, countAIUse } from "../src/db.js";
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

beforeAll(async () => {
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

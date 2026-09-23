import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { routeInstruction } from "../src/routing.js";
import { triageMessage } from "../src/triage.js";
import { fileCardUnderBusiness } from "../src/classify.js";
import { routeQuestions, jevConfig, jevCost } from "../src/jev.js";

// Jev decides, the local router writes, the language model is the second
// opinion. What is pinned here: what Jev is asked, what its answer becomes,
// when the language model is still called, and what happens when Jev is
// down — which must be nothing new.

const JEV = { apiKey: "ts_test", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", providerName: "jev" };
const OPENAI = { apiKey: "sk-test", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", providerName: "OpenAI" };
const TEAM = {
  orgId: "eval:cafe",
  nodes: [
    { id: "toru", kind: "person", role: "founder", label: "Toru · founder" },
    { id: "kenji", kind: "person", role: "operator", label: "Kenji · operator", aliases: ["健二"] },
    { id: "aya", kind: "person", role: "designer", label: "Aya · designer" },
  ],
  edges: [],
  businesses: [{ slug: "cafe", name: "Cafe Honmaru" }, { slug: "hotel", name: "Hotel Honmaru" }],
};
const SENDER = { id: "toru", name: "Toru", role: "founder" };

const jevAnswer = (answers, usage = { input_tokens: 640, output_tokens: 0 }) => ({ model: "jev-1.13.0", answers, usage });
const choice = (value, confidence) => ({ type: "choice", choice: value, confidence, probabilities: { [value]: confidence } });

let asked;
function interceptJev(reply, times = 1) {
  fetchMock.get("https://api.typesafe.ai")
    .intercept({ path: "/v1/systemone", method: "POST" })
    .reply(200, (opts) => { asked = JSON.parse(opts.body); return typeof reply === "function" ? reply(asked) : reply; })
    .times(times);
}

beforeEach(() => { asked = null; fetchMock.activate(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("what Jev is asked: the people with their other names, the kinds, the priorities, the businesses", () => {
  const q = routeQuestions({ sender: SENDER, organization: TEAM });
  expect(Object.keys(q).sort()).toEqual(["business", "kind", "priority", "recipient"]);
  expect(q.recipient.criteria.kenji).toContain("also called 健二");
  expect(q.recipient.criteria.toru).toContain("the sender themself");
  expect(Object.keys(q.kind.criteria).sort()).toEqual(["approval", "delegation", "notification", "revision", "task"]);
  expect(Object.keys(q.business.criteria)).toEqual(["none", "cafe", "hotel"]);
  // One person: nobody to choose between, so the question is not asked.
  expect(routeQuestions({ sender: SENDER, organization: { nodes: [TEAM.nodes[0]] } }).recipient).toBeUndefined();
});

test("a confident Jev routes the card, the words come from the instruction, and no language model is called", async () => {
  interceptJev(jevAnswer({
    recipient: choice("kenji", 0.93), kind: choice("approval", 0.88), priority: choice("high", 0.7), business: choice("cafe", 0.81),
  }));
  const res = await routeInstruction({
    text: "Ask Kenji to approve the new supplier price for the cafe by Friday",
    sender: SENDER, organization: TEAM, openRouter: OPENAI, readerLanguage: "en", systemOne: JEV,
    senderContext: "I run the cafe and the hotel.",
  });
  expect(res.routedBy).toBe("jev");
  expect(res.aiCalled).toBe(false);
  expect(res).toMatchObject({ recipientUserID: "kenji", cardType: "approval", priority: "high", business: "cafe" });
  expect(res.title).toBe("Approval needed");
  expect(res.summary).toContain("supplier price");
  expect(res.routingReason).toContain("93%");
  expect(res.toolCalls[0]).toMatchObject({ name: "system_one", label: "Decided by Jev" });
  expect(res.systemOneUsage.input_tokens).toBe(640);
  // The state Jev read: the instruction, the sender, how they work.
  expect(asked.model).toBe("jev-latest");
  expect(asked.state.instruction).toContain("supplier price");
  expect(asked.state.howTheSenderWorks).toBe("I run the cafe and the hotel.");
});

test("an unsure Jev hands the recipient to the language model when there is one", async () => {
  interceptJev(jevAnswer({ recipient: choice("aya", 0.41), kind: choice("task", 0.6), priority: choice("medium", 0.5) }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "create_decision_card", arguments: JSON.stringify({
        recipientUserID: "aya", cardType: "revision", title: "Review the menu photos", summary: "Aya, the new menu photos need a look.",
        context: "deadline: Friday", priority: "high", routingReason: "Aya owns design",
      }) } },
    ] } }] });
  const res = await routeInstruction({
    text: "someone should look at the menu photos before Friday",
    sender: SENDER, organization: TEAM, openRouter: OPENAI, readerLanguage: "en", systemOne: JEV,
  });
  expect(res.routedBy).toBe("OpenAI");
  expect(res.aiCalled).toBe(true);
  expect(res.recipientUserID).toBe("aya");
});

test("an unsure Jev with no language model still beats keywords, and says it was unsure", async () => {
  interceptJev(jevAnswer({ recipient: choice("aya", 0.41), kind: choice("revision", 0.6), priority: choice("medium", 0.5) }));
  const res = await routeInstruction({
    text: "someone should look at the menu photos before Friday",
    sender: SENDER, organization: TEAM, readerLanguage: "en", systemOne: JEV,
  });
  expect(res.routedBy).toBe("jev-unsure");
  expect(res).toMatchObject({ recipientUserID: "aya", cardType: "revision" });
});

test("a name in the instruction still wins over Jev's pick", async () => {
  interceptJev(jevAnswer({ recipient: choice("aya", 0.9), kind: choice("approval", 0.9), priority: choice("high", 0.9) }));
  const res = await routeInstruction({
    text: "健二に来週の仕入価格の承認をお願いして",
    sender: SENDER, organization: TEAM, readerLanguage: "ja", systemOne: JEV,
  });
  expect(res.recipientUserID).toBe("kenji");
  expect(res.toolCalls.map((c) => c.name)).toEqual(["system_one", "route_correction"]);
});

test("Jev down is nothing new: the path is the one there was before", async () => {
  fetchMock.get("https://api.typesafe.ai")
    .intercept({ path: "/v1/systemone", method: "POST" })
    .reply(529, { message: "overloaded" });
  const res = await routeInstruction({
    text: "Ask Kenji to approve the supplier price",
    sender: SENDER, organization: TEAM, readerLanguage: "en", systemOne: JEV,
  });
  expect(res.routedBy).toBe("fallback");
  expect(res.recipientUserID).toBe("kenji");
});

test("triage: a message that needs nothing costs no language model; one that does gets the words from the model", async () => {
  const message = { id: "m1", from: "shop@example.com", subject: "Your receipt", snippet: "Thanks for your order", date: "2026-09-20" };
  interceptJev(jevAnswer({ needsDecision: { type: "noul", noul: 0.04 }, kind: choice("notification", 0.9), priority: choice("low", 0.9) }));
  const no = await triageMessage(message, { provider: OPENAI, systemOne: JEV, readerLanguage: "en", sourceLabel: "Gmail" });
  expect(no).toEqual({ called: false, card: null, systemOne: true });

  interceptJev(jevAnswer({ needsDecision: { type: "noul", noul: 0.91 }, kind: choice("approval", 0.8), priority: choice("high", 0.7) }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve the supplier's new price", summary: "Mika asks for +8%.", context: "amount: +8%", priority: "high",
    }) } }] });
  const yes = await triageMessage({ ...message, subject: "Supplier price +8%", snippet: "Can we go to +8%?" },
    { provider: OPENAI, systemOne: JEV, readerLanguage: "en", sourceLabel: "Gmail" });
  expect(yes.called).toBe(true);
  expect(yes.card.title).toBe("Approve the supplier's new price");

  // No language model at all: the subject line is the title, Jev's kind and priority stand.
  interceptJev(jevAnswer({ needsDecision: { type: "noul", noul: 0.91 }, kind: choice("approval", 0.8), priority: choice("high", 0.7) }));
  const bare = await triageMessage({ ...message, subject: "Supplier price +8%", snippet: "Can we go to +8%?" },
    { provider: null, systemOne: JEV, readerLanguage: "en", sourceLabel: "Gmail" });
  expect(bare).toMatchObject({ called: false, systemOne: true, card: { cardType: "approval", priority: "high", title: "Supplier price +8%" } });
});

test("filing: an existing business is a choice Jev makes; 'none' goes on to the language model", async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertBusiness } = await import("../src/db.js");
  await upsertBusiness(env.DB, "personal:jev", { name: "Cafe Honmaru", createdBy: null });
  const filingEnv = { ...env, TYPESAFE_API_KEY: "ts_test" };

  interceptJev(jevAnswer({ business: choice("cafe-honmaru", 0.86) }));
  const slug = await fileCardUnderBusiness(filingEnv, {
    orgId: "personal:jev", card: { title: "Supplier price", summary: "for the cafe" }, provider: OPENAI, githubId: "1",
    allowance: { allowed: true, metered: false, consume: async () => {} },
  });
  expect(slug).toBe("cafe-honmaru");

  // "none": the language model may name a new business.
  interceptJev(jevAnswer({ business: choice("none", 0.9) }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ business: "Hotel Honmaru", isNew: true }) } }] });
  const fresh = await fileCardUnderBusiness(filingEnv, {
    orgId: "personal:jev", card: { title: "Lobby signage", summary: "for the hotel" }, provider: OPENAI, githubId: "1",
    allowance: { allowed: true, metered: false, consume: async () => {} },
  });
  expect(fresh).toBe("hotel-honmaru");
});

test("POST /ai/route with a Jev key routes without spending the language-model allowance", async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8801", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8802", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:jevroute", "8801", "admin");
  await upsertMembership(env.DB, "personal:jevroute", "8802", "member");
  const token = await createSession(env.DB, "8801", "gho_toru");
  interceptJev(jevAnswer({ recipient: choice("kenji", 0.9), kind: choice("approval", 0.9), priority: choice("high", 0.8) }));
  const res = await worker.fetch(new Request("https://example.com/ai/route", {
    method: "POST", headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ text: "Ask Kenji to approve the supplier price", orgId: "personal:jevroute", sender: { id: "toru", role: "founder" } }),
  }), { ...env, TYPESAFE_API_KEY: "ts_test", OPENAI_API_KEY: "sk-test" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routedBy).toBe("jev");
  expect(body.recipientUserID).toBe("kenji");
  expect(body.systemOneUsage).toBeUndefined();
  const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_usage").all().catch(() => ({ results: [{ n: 0 }] }));
  expect(Number(results?.[0]?.n || 0)).toBe(0);

  const health = await (await worker.fetch(new Request("https://example.com/health"), { ...env, TYPESAFE_API_KEY: "ts_test" })).json();
  expect(health.systemOne).toBe(true);
  expect(jevConfig({ TYPESAFE_API_KEY: "k" }).endpoint).toBe("https://api.typesafe.ai/v1/systemone");
  expect(jevCost({ input_tokens: 1_000_000 })).toBeCloseTo(0.042);
});

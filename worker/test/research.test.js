import { env, SELF, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { routeInstruction, formatDecisionsForModel, SEARCH_DECISIONS_TOOL } from "../src/routing.js";

// Two things the router learned to do: look something up before it writes,
// and know a person by the other names they go by.

const ORG = "personal:research";
let toru;

const OPENAI = { apiKey: "sk-test", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", providerName: "OpenAI" };
const TEAM = {
  orgId: ORG,
  nodes: [
    { id: "toru", kind: "person", role: "founder", label: "Toru · founder" },
    { id: "kenji", kind: "person", role: "operator", label: "Kenji · operator", aliases: ["健二"] },
  ],
  edges: [],
};

const searchReply = (query) => ({
  choices: [{ message: { content: null, tool_calls: [
    { id: "call-s", type: "function", function: { name: "search_decisions", arguments: JSON.stringify({ query }) } },
  ] } }],
});
const cardReply = (recipient, summary) => ({
  choices: [{ message: { content: null, tool_calls: [
    { id: "call-c", type: "function", function: { name: "create_decision_card", arguments: JSON.stringify({
      recipientUserID: recipient, cardType: "approval", title: "Approve the supplier price",
      summary, context: "deadline: Friday · amount: +8%", priority: "high", routingReason: "Kenji owns suppliers",
    }) } },
  ] } }],
});

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8201", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8202", login: "kenji", name: "Kenji", avatarUrl: null, locale: "ja" });
  await upsertMembership(env.DB, ORG, "8201", "admin");
  await upsertMembership(env.DB, ORG, "8202", "member");
  toru = await createSession(env.DB, "8201", "gho_toru");
  await saveCard(env.DB, ORG, {
    id: "r-1", recipientUserID: "kenji", senderUserID: "toru", type: "approval", title: "Supplier price +5% for the cafe",
    status: "rejected", priority: "high", createdAt: "2026-08-01T00:00:00Z",
    decision: { action: "decline", actorUserID: "kenji", decidedAt: "2026-08-02T00:00:00Z", replyText: "Not until the lease is settled" },
  });
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("the model may look up past decisions once, and then must write the card", async () => {
  // Captured in the reply, not the matcher: a body matcher runs once per
  // interceptor per attempt, so counting there counts the matching, not
  // the calls.
  const bodies = [];
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => { bodies.push(JSON.parse(opts.body)); return searchReply("supplier price"); })
    .times(1);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => { bodies.push(JSON.parse(opts.body)); return cardReply("kenji", "Kenji declined +5% in August; this is +8%."); })
    .times(1);

  const seen = [];
  const res = await routeInstruction({
    text: "Ask Kenji to approve the supplier price going up 8%",
    sender: { id: "toru", name: "Toru", role: "founder" },
    organization: TEAM,
    openRouter: OPENAI,
    readerLanguage: "en",
    lookups: {
      searchDecisions: async (query) => {
        seen.push(query);
        return [{ title: "Supplier price +5% for the cafe", recipient: "kenji", status: "decline", decidedAt: "2026-08-02T00:00:00Z", note: "Not until the lease is settled", business: "cafe" }];
      },
    },
  });

  expect(seen).toEqual(["supplier price"]);
  expect(bodies).toHaveLength(2);
  // First call: research on offer, the model's choice.
  expect(bodies[0].tools.map((t) => t.function.name)).toContain("search_decisions");
  expect(bodies[0].tool_choice).toBe("auto");
  // Second call: the tool's answer is in the conversation, and the model is
  // told to write.
  const toolMessage = bodies[1].messages.find((m) => m.role === "tool");
  expect(toolMessage.tool_call_id).toBe("call-s");
  expect(toolMessage.content).toContain("2026-08-02 kenji decline: Supplier price +5% for the cafe [cafe]");
  expect(toolMessage.content).toContain("Not until the lease is settled");
  expect(bodies[1].tools.map((t) => t.function.name)).not.toContain("search_decisions");
  expect(bodies[1].tool_choice).toMatchObject({ function: { name: "create_decision_card" } });

  expect(res.recipientUserID).toBe("kenji");
  expect(res.summary).toContain("declined +5%");
  expect(res.toolCalls.map((s) => s.name)).toEqual(["search_decisions", "create_decision_card"]);
  expect(res.toolCalls[0].detail).toBe('"supplier price" · 1 found');
  expect(res.aiCalled).toBe(true);
});

test("without a way to look things up, the model is asked to write straight away", async () => {
  let body;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => { body = JSON.parse(opts.body); return cardReply("kenji", "Approve +8%."); });
  const res = await routeInstruction({
    text: "Ask Kenji to approve the supplier price",
    sender: { id: "toru", name: "Toru", role: "founder" },
    organization: TEAM,
    openRouter: OPENAI,
    readerLanguage: "en",
  });
  expect(body.tools.map((t) => t.function.name)).not.toContain("search_decisions");
  expect(body.tool_choice).toMatchObject({ function: { name: "create_decision_card" } });
  expect(res.toolCalls.map((s) => s.name)).toEqual(["create_decision_card"]);
});

test("a lookup that fails is an empty one; the card is still written", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, searchReply("lease"))
    .times(1);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, cardReply("kenji", "Decide on the lease."))
    .times(1);
  const res = await routeInstruction({
    text: "Kenji, decide on the lease",
    sender: { id: "toru", name: "Toru", role: "founder" },
    organization: TEAM,
    openRouter: OPENAI,
    readerLanguage: "en",
    lookups: { searchDecisions: async () => { throw new Error("D1 is having a day"); } },
  });
  expect(res.recipientUserID).toBe("kenji");
  expect(res.toolCalls[0].detail).toBe('"lease" · 0 found');
});

test("searchDecisions finds the team's decisions by keyword, in either language", async () => {
  const { searchDecisions } = await import("../src/insights.js");
  const hits = await searchDecisions(env.DB, ORG, "supplier price");
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ title: "Supplier price +5% for the cafe", recipient: "kenji", status: "decline", note: "Not until the lease is settled" });
  expect(await searchDecisions(env.DB, ORG, "hotel signage")).toEqual([]);
  expect(await searchDecisions(env.DB, ORG, "a")).toEqual([]);
  expect(formatDecisionsForModel([])).toBe("No earlier decision matches.");
  expect(SEARCH_DECISIONS_TOOL.function.name).toBe("search_decisions");
});

test("a person can say what else they are called, and an instruction using it reaches them", async () => {
  const headers = { "content-type": "application/json", "x-session-token": toru };
  const { createSession } = await import("../src/db.js");
  const kenji = await createSession(env.DB, "8202", "gho_kenji");
  let res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: { ...headers, "x-session-token": kenji },
    body: JSON.stringify({ aliases: ["健二", " Ken ", "健二", "", 42].slice(0, 4) }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).aliases).toEqual(["健二", "Ken"]);
  res = await SELF.fetch("https://example.com/me", { headers: { "x-session-token": kenji } });
  expect((await res.json()).aliases).toEqual(["健二", "Ken"]);

  // Not a list: refused.
  res = await SELF.fetch("https://example.com/me", {
    method: "PUT", headers: { ...headers, "x-session-token": kenji }, body: JSON.stringify({ aliases: "健二" }),
  });
  expect(res.status).toBe(400);

  // The org the router builds carries them, and the local router reads them.
  const { listOrgNodes } = await import("../src/db.js");
  const nodes = await listOrgNodes(env.DB, ORG);
  expect(nodes.find((n) => n.id === "kenji").aliases).toEqual(["健二", "Ken"]);

  res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST", headers,
    body: JSON.stringify({ text: "健二に来週の仕入価格の承認をお願いして", orgId: ORG, sender: { id: "toru", role: "founder" } }),
  });
  expect(res.status).toBe(200);
  const routed = await res.json();
  expect(routed.recipientUserID).toBe("kenji");
  expect(routed.routingReason).toContain("健二");
  expect(routed.cardType).toBe("approval");
});

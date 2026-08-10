import { SELF, fetchMock } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { routeInstruction, buildAgentTools } from "../src/routing.js";

const REAL_ORG = {
  nodes: [
    { id: "octocat", kind: "person", label: "octocat · Admin" },
    { id: "hubot", kind: "person", label: "hubot · Engineer" },
    { id: "team-web", kind: "team", label: "acme/web" },
  ],
  edges: [{ id: "e1", fromID: "octocat", toID: "team-web", kind: "canApprove" }],
};

const OPENAI = {
  providerName: "OpenAI",
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

function toolCallReply(recipientUserID) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: {
                name: "create_decision_card",
                arguments: JSON.stringify({
                  recipientUserID,
                  cardType: "task",
                  title: "Review the deploy",
                  summary: "Someone needs to review the deploy.",
                  context: "scope: deploy",
                  priority: "medium",
                  routingReason: "Best fit for the deploy review.",
                }),
              },
            },
          ],
        },
      },
    ],
  };
}

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("OpenAI path routes to a real member and sends the dynamic enum", async () => {
  let capturedBody;
  fetchMock.get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions",
      method: "POST",
      body: (b) => {
        capturedBody = JSON.parse(b);
        return true;
      },
    })
    .reply(200, toolCallReply("hubot"));

  const res = await routeInstruction({
    text: "Ask someone to review the deploy",
    sender: { id: "octocat", name: "octocat", role: "Admin" },
    organization: REAL_ORG,
    openRouter: OPENAI,
    readerLanguage: "en",
  });

  expect(res.routedBy).toBe("OpenAI");
  expect(res.recipientUserID).toBe("hubot");
  const enumIds = capturedBody.tools[0].function.parameters.properties.recipientUserID.enum;
  expect(enumIds).toEqual(["octocat", "hubot"]);
});

test("an invalid OpenAI recipient is rejected and falls back to a real member", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, toolCallReply("user-alex")); // not in REAL_ORG

  const res = await routeInstruction({
    text: "Please decide on the release",
    sender: { id: "octocat", name: "octocat", role: "Admin" },
    organization: REAL_ORG,
    openRouter: OPENAI,
    readerLanguage: "en",
  });

  expect(res.routedBy).toBe("fallback");
  expect(res.routingError).toBeTruthy();
  expect(["octocat", "hubot"]).toContain(res.recipientUserID);
  // The model answered and billed us; we only rejected what it said. routedBy
  // reads "fallback" here, which is precisely why the meter cannot use it.
  expect(res.aiCalled).toBe(true);
});

test("a call that never lands is not counted as a model call", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(500, { error: { message: "openai is down" } });

  const res = await routeInstruction({
    text: "Please decide on the release",
    sender: { id: "octocat", name: "octocat", role: "Admin" },
    organization: REAL_ORG,
    openRouter: OPENAI,
    readerLanguage: "en",
  });

  expect(res.routedBy).toBe("fallback");
  expect(res.aiCalled).toBe(false);
});

test("a caller-supplied key is used for routing", async () => {
  let seenAuth;
  fetchMock.get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions",
      method: "POST",
      headers: (h) => {
        seenAuth = h.authorization;
        return true;
      },
    })
    .reply(200, toolCallReply("hubot"));

  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ai-key": "sk-user-key" },
    body: JSON.stringify({
      text: "Ask hubot to review the deploy",
      sender: { id: "octocat", name: "octocat" },
      organization: REAL_ORG,
    }),
  });

  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.routedBy).toBe("OpenAI");
  expect(seenAuth).toBe("Bearer sk-user-key");
});

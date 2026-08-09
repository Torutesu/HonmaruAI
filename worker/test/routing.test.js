import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { buildAgentTools, SYSTEM_PROMPT, buildUserPrompt } from "../src/routing.js";

const ORG = {
  nodes: [
    { id: "user-yui", label: "Yui", kind: "person" },
    { id: "user-toru", label: "Toru", kind: "person" },
  ],
  edges: [],
};

test("/ai/route falls back to keyword routing without an API key", async () => {
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "Ask Yui to approve the release",
      sender: { id: "user-toru", name: "Toru" },
      organization: ORG,
    }),
  });
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.routedBy).toBe("fallback");
  expect(typeof card.recipientUserID).toBe("string");
  expect(typeof card.title).toBe("string");
});

test("/agui/tools returns the manifest", async () => {
  const res = await SELF.fetch("https://example.com/agui/tools");
  const body = await res.json();
  expect(body.protocol).toBe("agui/1");
});

const REAL_ORG = {
  nodes: [
    { id: "octocat", kind: "person", label: "octocat · Admin" },
    { id: "hubot", kind: "person", label: "hubot · Engineer" },
    { id: "team-web", kind: "team", label: "acme/web" },
    { id: "agent-octocat", kind: "agent", label: "octocat's AI" },
    { id: "agent-hubot", kind: "agent", label: "hubot's AI" },
  ],
  edges: [{ id: "e1", fromID: "octocat", toID: "team-web", kind: "canApprove" }],
};

test("routes to a real member by name mention (no API key → fallback)", async () => {
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "Ask hubot to review the deploy",
      sender: { id: "octocat", name: "octocat" },
      organization: REAL_ORG,
    }),
  });
  const card = await res.json();
  expect(card.recipientUserID).toBe("hubot");
  expect(card.routedBy).toBe("fallback");
});

test("a real member recipient is never rejected as invalid", async () => {
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "Please decide on the release",
      sender: { id: "octocat", name: "octocat" },
      organization: REAL_ORG,
    }),
  });
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.recipientUserID).toBe("hubot");
});

test("buildAgentTools sets recipient enum to the org members, demo ids when empty", () => {
  const org = { nodes: [
    { id: "octocat", kind: "person", label: "octocat · Admin" },
    { id: "hubot", kind: "person", label: "hubot · Engineer" },
    { id: "team-web", kind: "team", label: "acme/web" },
  ], edges: [] };
  const tools = buildAgentTools(org);
  const enumIds = tools[0].function.parameters.properties.recipientUserID.enum;
  expect(enumIds).toEqual(["octocat", "hubot"]);
  expect(tools.map((t) => t.function.name)).toEqual(["create_decision_card", "set_priority", "add_context"]);
  const demoEnum = buildAgentTools({ nodes: [], edges: [] })[0].function.parameters.properties.recipientUserID.enum;
  expect(demoEnum).toEqual(["user-toru", "user-tanaka", "user-yui", "user-alex"]);
});

test("SYSTEM_PROMPT no longer hardcodes demo recipient ids", () => {
  expect(SYSTEM_PROMPT).not.toContain("user-toru");
  expect(SYSTEM_PROMPT).not.toContain("user-yui");
  expect(SYSTEM_PROMPT).not.toContain("user-tanaka");
});

test("buildUserPrompt lists the org members so the model can pick one", () => {
  const org = { nodes: [{ id: "octocat", kind: "person", label: "octocat · Admin" }], edges: [] };
  const prompt = buildUserPrompt({ text: "ship it", sender: { name: "octocat", id: "octocat", role: "Admin" }, organization: org, readerLanguage: "en" });
  expect(prompt).toContain("octocat");
});

test("buildUserPrompt carries the sender's context when supplied", () => {
  const org = { nodes: [{ id: "octocat", kind: "person", label: "octocat · Admin" }], edges: [] };
  const prompt = buildUserPrompt({
    text: "ship it",
    sender: { name: "octocat", id: "octocat", role: "Admin" },
    organization: org,
    readerLanguage: "en",
    senderContext: "I own billing decisions and hate meetings.",
  });
  expect(prompt).toContain("Sender context:");
  expect(prompt).toContain("I own billing decisions");
});

test("buildUserPrompt omits the context heading when there is none", () => {
  const org = { nodes: [{ id: "octocat", kind: "person", label: "octocat · Admin" }], edges: [] };
  const prompt = buildUserPrompt({
    text: "ship it",
    sender: { name: "octocat", id: "octocat", role: "Admin" },
    organization: org,
    readerLanguage: "en",
  });
  expect(prompt).not.toContain("Sender context:");
});

import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  buildAgentTools, SYSTEM_PROMPT, buildUserPrompt,
  resolveRecipientTarget, namesPerson, NoOrganizationError,
} from "../src/routing.js";

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

test("buildAgentTools sets the recipient enum to the org members", () => {
  const org = { nodes: [
    { id: "octocat", kind: "person", label: "octocat · Admin" },
    { id: "hubot", kind: "person", label: "hubot · Engineer" },
    { id: "team-web", kind: "team", label: "acme/web" },
  ], edges: [] };
  const tools = buildAgentTools(org);
  const enumIds = tools[0].function.parameters.properties.recipientUserID.enum;
  expect(enumIds).toEqual(["octocat", "hubot"]);
  expect(tools.map((t) => t.function.name)).toEqual(["create_decision_card", "set_priority", "add_context"]);
});

test("an empty org offers the model no one to invent", () => {
  // The enum used to fall back to four demo ids, which is how a real
  // instruction sent before the org graph loaded produced a card addressed to a
  // person who does not exist.
  const empty = buildAgentTools({ nodes: [], edges: [] })[0].function.parameters.properties.recipientUserID;
  expect(empty.enum).toBeUndefined();
});

test("routing refuses an organization it has no members for", () => {
  // Better than a card nobody can decide, stored forever, reported as sent.
  expect(() => resolveRecipientTarget("ship it", "octocat", { nodes: [], edges: [] }))
    .toThrow(NoOrganizationError);
});

test("a name is matched on a boundary, not as a substring", () => {
  // `al` inside "already" used to match a member called al — and the match
  // overrode the model's answer, so the better reading lost to an accident.
  expect(namesPerson("ask hubot to review", "hubot")).toBe(true);
  expect(namesPerson("ask @hubot to review", "hubot")).toBe(true);
  expect(namesPerson("this is already done", "al")).toBe(false);
  expect(namesPerson("the same thing", "sam")).toBe(false);
  // A script with no word boundaries is matched directly, which is what it allows.
  expect(namesPerson("結衣にお願いして", "結衣")).toBe(true);
});

test("SYSTEM_PROMPT no longer hardcodes demo recipient ids", () => {
  expect(SYSTEM_PROMPT).not.toContain("user-toru");
  expect(SYSTEM_PROMPT).not.toContain("user-yui");
  expect(SYSTEM_PROMPT).not.toContain("user-tanaka");
});

test("/ai/route refuses what it cannot route rather than inventing a recipient", async () => {
  const post = (body) => SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const noOrg = await post({ text: "ship it", sender: { id: "octocat", name: "octocat" }, organization: { nodes: [], edges: [] } });
  expect(noOrg.status).toBe(400);
  expect((await noOrg.json()).message).toMatch(/organization/i);

  const noText = await post({ sender: { id: "octocat", name: "octocat" }, organization: ORG });
  expect(noText.status).toBe(400);

  const noSender = await post({ text: "ship it", organization: ORG });
  expect(noSender.status).toBe(400);

  const tooLong = await post({ text: "x".repeat(4001), sender: { id: "octocat", name: "octocat" }, organization: ORG });
  expect(tooLong.status).toBe(400);
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

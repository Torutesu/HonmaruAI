# Phase 3: OpenAI Routing on the Real Org Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenAI routing path pick a real organization member directly, instead of guessing a hardcoded demo id that the Phase-2 validator then has to reject and correct via fallback.

**Architecture:** The OpenAI tool schema currently pins `recipientUserID` to `enum: DEMO_USER_IDS`, and `SYSTEM_PROMPT` hardcodes a one-person-business demo routing table. Phase 3 makes the tool `enum` dynamic (the passed org's member ids, demo ids only as an empty-org fallback), generalizes `SYSTEM_PROMPT` to route from the org graph in the user message, and adds fetch-mocked tests that exercise the OpenAI path (the existing suite only ran the no-key fallback path).

**Tech Stack:** Cloudflare Workers, `worker/src/routing.js`, Vitest + `@cloudflare/vitest-pool-workers` (`fetchMock` intercepting `https://api.openai.com`).

## Key facts (verified against `worker/src/routing.js`)

- `memberIdsOf(organization)` (Phase 2) returns the person-node ids of the passed org; `displayNameOf(organization, userID)` returns the label name. Both already exported near the top of the file.
- `AGENT_TOOLS` (line ~167) is a module-level constant; its `create_decision_card` tool sets `recipientUserID.enum = DEMO_USER_IDS` and a demo-specific `description`. It also contains two static tools, `set_priority` and `add_context`, that must stay unchanged.
- `routeInstructionWithOpenRouter` (line ~633) builds the request with `messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:buildUserPrompt(...)}]` and `tools: AGENT_TOOLS`, calling `fetch(endpoint, ...)`. `endpoint` for OpenAI is `https://api.openai.com/v1/chat/completions`.
- On a tool call it runs `validateRouting(card, sender, text, steps, organization)`, which (Phase 2) rejects a recipient not in the org's members, throwing `"AI picked an invalid recipient."`; `routeInstruction` catches it and returns the local fallback with `routedBy:"fallback"` and `routingError`.
- `routeInstruction` takes `openRouter` as a parameter, so tests can drive the OpenAI path directly by passing an `openRouter` config and mocking `fetch` — no env var needed.
- `buildUserPrompt`/`organizationContext` already list the org nodes+edges in the user message, so the model has the member ids; the missing pieces are the dynamic `enum` and a non-demo system prompt.

---

## File Structure

```
worker/
  src/routing.js         # AGENT_TOOLS → buildAgentTools(organization); generalize SYSTEM_PROMPT; use buildAgentTools + displayNameOf on the OpenAI path
  test/openai-route.test.js  # NEW: fetch-mocked OpenAI path — real member routed, dynamic enum, invalid-id fallback
  test/routing.test.js       # (extend) buildAgentTools enum unit test
```

---

## Task 1: Dynamic tool schema — `buildAgentTools(organization)`

**Files:**
- Modify: `worker/src/routing.js`
- Test: `worker/test/routing.test.js` (extend)

- [ ] **Step 1: Add the failing unit test to `worker/test/routing.test.js`** (append)

```js
import { buildAgentTools } from "../src/routing.js";

test("buildAgentTools sets recipient enum to the org members, demo ids when empty", () => {
  const org = { nodes: [
    { id: "octocat", kind: "person", label: "octocat · Admin" },
    { id: "hubot", kind: "person", label: "hubot · Engineer" },
    { id: "team-web", kind: "team", label: "acme/web" },
  ], edges: [] };
  const tools = buildAgentTools(org);
  const enumIds = tools[0].function.parameters.properties.recipientUserID.enum;
  expect(enumIds).toEqual(["octocat", "hubot"]);
  // still carries the two static tools
  expect(tools.map((t) => t.function.name)).toEqual(["create_decision_card", "set_priority", "add_context"]);
  // empty org falls back to demo ids
  const demoEnum = buildAgentTools({ nodes: [], edges: [] })[0].function.parameters.properties.recipientUserID.enum;
  expect(demoEnum).toEqual(["user-toru", "user-tanaka", "user-yui", "user-alex"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- routing.test.js`
Expected: FAIL — `buildAgentTools` is not exported.

- [ ] **Step 3: Convert `AGENT_TOOLS` into `buildAgentTools(organization)`**

In `worker/src/routing.js`, replace the whole `export const AGENT_TOOLS = [ ... ];` block (the array that starts at line ~167 and ends at line ~260) with a factory function. Keep the `set_priority` and `add_context` tool objects EXACTLY as they are today — only the `create_decision_card` tool becomes org-aware:

```js
export function buildAgentTools(organization) {
  const members = memberIdsOf(organization);
  const recipientEnum = members.length ? members : DEMO_USER_IDS;
  return [
    {
      type: "function",
      function: {
        name: "create_decision_card",
        description:
          "Turn a messy workplace instruction into a structured decision card routed to the right teammate. Rewrite the sender's words — never echo them.",
        parameters: {
          type: "object",
          properties: {
            recipientUserID: {
              type: "string",
              enum: recipientEnum,
              description:
                "Who should receive and act on this decision. Pick an id from the members listed under Organization in the user message. Route by the org graph: a named person → that person; an approval → a member with a canApprove edge; an escalation → the sender's manager. Never pick an id that is not in the list.",
            },
            cardType: {
              type: "string",
              enum: ["approval", "delegation", "notification", "task", "revision"],
            },
            title: {
              type: "string",
              description: "3-8 words, action-oriented, no filler like 'tell Bob'",
            },
            summary: {
              type: "string",
              description: "1-2 sentences, third person, what the recipient must decide or do",
            },
            context: {
              type: "string",
              description:
                "2-4 structured facts as 'label: detail' segments separated by · e.g. 'deadline: Friday demo · metric: p95 +18% · scope: auth endpoint · action: hotfix branch'",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
            },
            routingReason: {
              type: "string",
              description: "One sentence: why this person owns the decision",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Optional GitHub-style labels e.g. bug, infra, blocked",
            },
          },
          required: [
            "recipientUserID",
            "cardType",
            "title",
            "summary",
            "context",
            "priority",
            "routingReason",
          ],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_priority",
        description:
          "Override urgency when the instruction clearly signals time sensitivity or low importance",
        parameters: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            reason: { type: "string" },
          },
          required: ["level", "reason"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_context",
        description: "Attach extra structured context extracted from the instruction",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "string" },
          },
          required: ["key", "value"],
          additionalProperties: false,
        },
      },
    },
  ];
}

// Back-compat: any importer of the old constant gets the demo-id variant.
export const AGENT_TOOLS = buildAgentTools(null);
```

- [ ] **Step 4: Use the dynamic tools on the OpenAI request**

In `routeInstructionWithOpenRouter` (line ~659, inside the `fetch` body), change `tools: AGENT_TOOLS,` to:

```js
      tools: buildAgentTools(organization),
```

- [ ] **Step 5: Run the routing tests, then the full suite**

Run: `cd worker && npm test -- routing.test.js`
Expected: PASS — new `buildAgentTools` test plus all existing routing tests.
Run: `cd worker && npm test`
Expected: PASS (all). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routing.js worker/test/routing.test.js
git commit -m "feat(worker): dynamic OpenAI tool enum from the org members"
```

---

## Task 2: Generalize the system prompt (drop demo routing)

**Files:**
- Modify: `worker/src/routing.js`
- Test: `worker/test/routing.test.js` (extend)

- [ ] **Step 1: Add the failing test to `worker/test/routing.test.js`** (append)

```js
import { SYSTEM_PROMPT, buildUserPrompt } from "../src/routing.js";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- routing.test.js`
Expected: FAIL — `SYSTEM_PROMPT` still contains `user-toru`/`user-yui`/`user-tanaka`.

- [ ] **Step 3: Replace the `SYSTEM_PROMPT` constant**

Replace the entire `const SYSTEM_PROMPT = \`...\`;` block (line ~262 to ~284) with a generic, org-driven prompt:

```js
const SYSTEM_PROMPT = `You route workplace instructions to the right teammate as structured Decision Cards.

Call create_decision_card once with all fields filled:
- Write title, summary, context and routingReason in the READER's language,
  given as "Reader language" below. The sender's language is irrelevant: an
  English instruction read by a Japanese user must produce a Japanese card.
  Deciding is the reader's job, so the card is written for them.
- Never echo the sender's exact wording in title or summary
- title: 3-8 words, action-oriented
- summary: third person, what the recipient must decide or do
- context: deadlines, metrics, amounts, blockers — always 2-4 segments as
  'label: detail' joined by ·. The app reads the label to choose an icon, so use
  only: deadline / scope / metric / amount / action — or in Japanese
  期限 / 範囲 / 指標 / 金額 / 対応.
- priority: infer from urgency cues in the instruction

Routing (critical):
- recipientUserID MUST be one of the member ids listed under Organization in the
  user message. Never invent an id or pick one that is not listed.
- A person named in the instruction → that person.
- Something that needs sign-off or approval → a member with a canApprove edge.
- An escalation → the sender's manager (a "manages" edge pointing at the sender).
- Otherwise pick the member whose role best fits the instruction.`;
```

- [ ] **Step 4: Use a real display name in the OpenAI JSON-path step detail**

In `routeInstructionWithOpenRouter`, the JSON (non-tool-call) branch builds a step `detail` with `userNameFor(routingJSON.recipientUserID)` (line ~722). Change it to the org-aware name:

```js
        detail: `${displayNameOf(organization, routingJSON.recipientUserID)} · ${routingJSON.cardType}`,
```

(`displayNameOf` is already defined/exported near the top of the file. Leave `materializeFromToolCalls`'s internal `userNameFor` usage as-is — it is a cosmetic label and does not affect routing.)

- [ ] **Step 5: Run the routing tests, then the full suite**

Run: `cd worker && npm test -- routing.test.js`
Expected: PASS.
Run: `cd worker && npm test`
Expected: PASS (all). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routing.js worker/test/routing.test.js
git commit -m "feat(worker): generalize routing system prompt to the org graph"
```

---

## Task 3: Fetch-mocked OpenAI-path tests

**Files:**
- Create: `worker/test/openai-route.test.js`

These are the first tests that actually exercise the OpenAI branch (the rest of the suite runs the no-key fallback). They drive `routeInstruction` with an `openRouter` config and intercept the OpenAI endpoint.

- [ ] **Step 1: Write the test `worker/test/openai-route.test.js`**

```js
import { fetchMock } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { routeInstruction } from "../src/routing.js";

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
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      capturedBody = JSON.parse(opts.body);
      return toolCallReply("hubot");
    });

  const res = await routeInstruction({
    text: "Ask someone to review the deploy",
    sender: { id: "octocat", name: "octocat", role: "Admin" },
    organization: REAL_ORG,
    openRouter: OPENAI,
    readerLanguage: "en",
  });

  expect(res.routedBy).toBe("OpenAI");
  expect(res.recipientUserID).toBe("hubot");
  // the request carried the org members as the tool enum, not demo ids
  const enumIds = capturedBody.tools[0].function.parameters.properties.recipientUserID.enum;
  expect(enumIds).toEqual(["octocat", "hubot"]);
});

test("an invalid OpenAI recipient is rejected and falls back to a real member", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => toolCallReply("user-alex")); // not in REAL_ORG

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
});
```

- [ ] **Step 2: Run to verify behavior**

Run: `cd worker && npm test -- openai-route.test.js`
Expected: PASS (2 tests). If `fetchMock`'s `.reply(200, callback)` signature differs in the installed version, adapt to the supported form (e.g. capture via `.reply((opts) => ({ statusCode: 200, data: toolCallReply("hubot") }))`) — the intent is: intercept the OpenAI POST, capture its JSON body, and return a tool-call response. Do NOT weaken the two assertions (real-member routing + dynamic enum; invalid-id fallback).

- [ ] **Step 3: Run the full suite**

Run: `cd worker && npm test`
Expected: PASS (all prior + 2 new). Paste output.

- [ ] **Step 4: Commit**

```bash
git add worker/test/openai-route.test.js
git commit -m "test(worker): exercise the OpenAI routing path with fetchMock"
```

---

## Task 4: Deploy & live smoke

**Files:** none (operational)

- [ ] **Step 1: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: redeploys, prints a new Version ID.

- [ ] **Step 2: Verify the OpenAI path now picks a real member directly**

Wait ~15s for propagation, then run:

```bash
curl -s -X POST https://tiktokforwork.torubj0904.workers.dev/ai/route \
  -H 'content-type: application/json' \
  -d '{"text":"Ask hubot to review the deploy","sender":{"id":"octocat","name":"octocat"},"organization":{"nodes":[{"id":"octocat","kind":"person","label":"octocat · Admin"},{"id":"hubot","kind":"person","label":"hubot · Engineer"}],"edges":[]}}'
```

Expected: `recipientUserID` is `octocat` or `hubot`, `routedBy` is `"OpenAI"`, and there is **no** `routingError` (the model now picks a valid member directly instead of a demo id). If the model still occasionally returns `routedBy:"fallback"` with a real recipient, that is acceptable (the validator safety net), but the common case should be `"OpenAI"`.

- [ ] **Step 3: Confirm no regression on health**

Run: `curl https://tiktokforwork.torubj0904.workers.dev/health`
Expected: `{"ok":true,...,"aiRouting":true,"aiModel":"gpt-4o-mini"}`.

---

## Self-Review Notes (addressed)

- **Spec coverage (Phase 3):** the OpenAI tool `enum` is now the real org members (Task 1), the system prompt no longer hardcodes demo ids and routes from the org graph (Task 2), and the OpenAI path is genuinely tested for the first time incl. the dynamic enum and the invalid-id safety net (Task 3), verified live (Task 4).
- **No regression to the fallback path:** `buildAgentTools(null)`/empty-org still yields the demo enum, and `SYSTEM_PROMPT` changes only affect the OpenAI branch (the fallback path never sends a prompt). All existing fallback tests stay green.
- **Type/shape consistency:** `buildAgentTools(organization)` returns the same 3-tool array shape as the old `AGENT_TOOLS`; `tools[0].function.parameters.properties.recipientUserID.enum` is the assertion surface used in tests and matches the OpenAI request body. `memberIdsOf`/`displayNameOf` are the Phase-2 helpers, unchanged.
- **Deferred/known:** live end-to-end still uses a client-supplied `organization` payload; wiring the iOS app to fetch `/orgs/:owner/:repo/graph` and pass it is Phase 4. GitHub OAuth secrets remain deferred (do not affect this plan).
```

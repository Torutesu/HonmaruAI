# Gmail Inbound Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the mail that genuinely needs your decision into Decision Cards in your feed — and create nothing for the mail that does not.

**Architecture:** The Worker calls Composio's tool-execute API to list recent Gmail messages for a user, skips anything already seen (a D1 dedup table), asks the model a *triage* question that is allowed to answer "no card", persists the survivors with `saveCard`, and broadcasts them through the existing relay so the feed updates live. iOS calls the sync endpoint when the feed appears and on pull-to-refresh; failures are silent.

**Tech Stack:** Cloudflare Workers + D1, Composio REST API, OpenAI, Vitest; SwiftUI.

## Scope deviation from the spec (read this first)

The spec included an in-app "Connect Gmail" flow. **This plan does not build it.**
Composio retired `initiate()` for Composio-managed OAuth (400 for all orgs from
2026-07-03) and its hosted-link replacement could not be pinned down from the
public docs. Writing an invented endpoint into a plan is worse than deferring it.

The user's Gmail is **already connected and ACTIVE**, so ingestion — the part that
carries all the product risk — can be built and proven now. In-app connect becomes
a follow-up plan once Task 1 has recorded the real API shape. Until then a user
connects with `composio link gmail`.

## Verification model

- **Worker:** `cd /Users/torutano/HonmaruAI/worker && npm test` — **45 tests green today**; every task keeps the suite green.
- **iOS:** no test target — `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` ending in `** BUILD SUCCEEDED **`.

## Known facts (already verified — do not re-derive)

- Tool slug: **`GMAIL_FETCH_EMAILS`**. Inputs include `query`, `user_id` (Gmail's own "me"), `max_results`, `verbose`, `include_payload`, `page_token`.
- Execute endpoint: `POST https://backend.composio.dev/api/v3/tools/execute/{tool_slug}`, header `x-api-key`, body carries `arguments` and a Composio `user_id`.
- Composio's own pitfalls for this tool: output is sometimes wrapped as `results[i].response.data.messages` instead of `response.data.messages`; an empty `messages` array is a valid no-matches result; `verbose=true` / `include_payload=true` can trigger 413 or truncated output.

## File Structure

```
worker/
  schema.sql              # + ingested_items
  src/composio.js         # NEW: the only place that speaks Composio HTTP
  src/gmail.js            # NEW: fetch → normalize to a plain {id, from, subject, snippet, date}
  src/triage.js           # NEW: "does this need my decision?" → card | null
  src/index.js            # + POST /connectors/gmail/sync
  src/db.js               # + markIngested / isIngested
  test/gmail.test.js      # NEW: parsing both response shapes
  test/triage.test.js     # NEW: card vs no-card, mocked OpenAI
  test/sync.test.js       # NEW: the endpoint, dedup, persistence
TikTokForWork/
  Services/ConnectorService.swift  # NEW: POST the sync, ignore failures
  Features/Feed/FeedView.swift     # sync on appear + refreshable
```

---

## Task 1: Pin the Composio API against the live service

This is research with a written deliverable, not guesswork. Nothing downstream is
written until these facts are recorded.

**Files:**
- Modify: `worker/README.md`

- [ ] **Step 1: Find the API key the CLI already uses**

Run: `ls ~/.composio/` and `cat ~/.composio/config.json | head -40`
The CLI is authenticated (`composio connections list` works and shows gmail ACTIVE). Locate the API key it uses. **Do not print the key into any file, commit, or log** — you need it only for the curl calls below, and it will become a Worker secret in Task 6.

If the key is not in the config, run `composio whoami` or check `~/.composio/` for a credentials file. If you cannot find it, STOP and report NEEDS_CONTEXT asking the user for their Composio API key.

- [ ] **Step 2: Confirm the execute call and the Composio user id**

The Gmail connection exists under some Composio `user_id`. Find it:

Run: `composio connections list`
(You already know it returns `{"gmail":[{"status":"ACTIVE","word_id":"gmail_insea-pluto",...}]}`.)

Now list connected accounts through the REST API to learn the `user_id` attached to that connection:

```bash
KEY='<the key from step 1>'
curl -s -H "x-api-key: $KEY" \
  "https://backend.composio.dev/api/v3/connected_accounts?toolkit_slugs=gmail" \
  | python3 -m json.tool | head -60
```
Record: the connection id, its `user_id`, and its status. If that path 404s, try `https://backend.composio.dev/api/v3.1/connected_accounts?toolkit_slugs=gmail`.

- [ ] **Step 3: Confirm the execute request/response shape with a real, tiny call**

This reads the user's own mailbox — **metadata only**, one message, no payload:

```bash
KEY='<the key from step 1>'
USER='<the user_id from step 2>'
curl -s -X POST "https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"user_id\":\"$USER\",\"arguments\":{\"query\":\"newer_than:7d\",\"max_results\":1,\"verbose\":false,\"include_payload\":false}}" \
  | python3 -m json.tool | head -60
```
Record: the exact envelope (is it `{data:{messages:[…]}}`, `{results:[{response:{data:{messages:[…]}}}]}`, is there a `successful`/`error` field?) and the field names on a message (id, threadId, subject, sender/from, snippet, date/internalDate — names differ by tool version).

**Do not paste actual email contents into the repo or the commit.** Record only the *shape*: field names and types.

- [ ] **Step 4: Write the findings into `worker/README.md`**

Add a `## Composio (Gmail connector)` section recording: the execute URL, the auth header, the request body shape, the response envelope(s), the message field names, and the Composio `user_id` that owns the Gmail connection. This is what Tasks 2–5 are implemented against.

- [ ] **Step 5: Commit**

```bash
git add worker/README.md
git commit -m "docs(worker): record the Composio execute contract for Gmail"
```

---

## Task 2: Composio client and the dedup table

**Files:**
- Create: `worker/src/composio.js`
- Modify: `worker/schema.sql`, `worker/src/db.js`
- Test: `worker/test/gmail.test.js` (created in Task 3 — this task has no test of its own; it is exercised there)

- [ ] **Step 1: Add the dedup table to `worker/schema.sql`** (append)

```sql
CREATE TABLE IF NOT EXISTS ingested_items (
  connector      TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  user_github_id TEXT NOT NULL,
  org_id         TEXT NOT NULL,
  card_id        TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (connector, external_id, user_github_id)
);
```

Do NOT put `--` comments in schema.sql: the tests collapse newlines to spaces before `exec`, which would swallow the next statement.

- [ ] **Step 2: Add the dedup helpers to `worker/src/db.js`** (append)

```js
// A row is written for every scanned item, including ones the triage rejected
// (card_id NULL). Without that, every sync re-reads and re-judges the same mail
// forever, paying the model to reach the same "no".
export async function isIngested(db, connector, externalId, githubId) {
  const row = await db
    .prepare(
      "SELECT 1 AS ok FROM ingested_items WHERE connector = ?1 AND external_id = ?2 AND user_github_id = ?3"
    )
    .bind(connector, externalId, String(githubId))
    .first();
  return Boolean(row);
}

export async function markIngested(db, { connector, externalId, githubId, orgId, cardId }) {
  await db
    .prepare(
      `INSERT INTO ingested_items (connector, external_id, user_github_id, org_id, card_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(connector, external_id, user_github_id) DO NOTHING`
    )
    .bind(connector, externalId, String(githubId), orgId, cardId || null, new Date().toISOString())
    .run();
}
```

- [ ] **Step 3: Create `worker/src/composio.js`**

Use the URL, header and body shape recorded in `worker/README.md` by Task 1. The module's only job is HTTP — no Gmail knowledge, no card knowledge:

```js
// The only place that speaks Composio's HTTP API.
const BASE = "https://backend.composio.dev/api/v3";

export async function executeTool(apiKey, slug, userId, args) {
  const res = await fetch(`${BASE}/tools/execute/${slug}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, arguments: args }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Composio ${slug} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}
```

If Task 1 recorded a different base path (e.g. `v3.1`) or body field names, use what was recorded — the README is the source of truth, not this snippet.

- [ ] **Step 4: Build confidence that nothing else broke**

Run: `cd worker && npm test`
Expected: still 45 passing (no behaviour has been wired up yet).

- [ ] **Step 5: Commit**

```bash
git add worker/schema.sql worker/src/db.js worker/src/composio.js
git commit -m "feat(worker): composio client and ingestion dedup table"
```

---

## Task 3: Normalize Gmail messages

**Files:**
- Create: `worker/src/gmail.js`, `worker/test/gmail.test.js`

- [ ] **Step 1: Write the failing test `worker/test/gmail.test.js`**

Both envelopes must parse — Composio documents that either can come back.

```js
import { expect, test } from "vitest";
import { parseMessages } from "../src/gmail.js";

const message = {
  messageId: "m1",
  threadId: "t1",
  subject: "Invoice #42 needs approval",
  sender: "billing@acme.com",
  preview: { body: "Please approve the attached invoice by Friday." },
  messageTimestamp: "2026-08-09T01:00:00Z",
};

test("parses the plain envelope", () => {
  const items = parseMessages({ data: { messages: [message] } });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: "m1",
    from: "billing@acme.com",
    subject: "Invoice #42 needs approval",
  });
  expect(items[0].snippet).toContain("approve the attached invoice");
});

test("parses the wrapped results envelope", () => {
  const items = parseMessages({ results: [{ response: { data: { messages: [message] } } }] });
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe("m1");
});

test("an empty inbox is a valid result, not an error", () => {
  expect(parseMessages({ data: { messages: [] } })).toEqual([]);
  expect(parseMessages({})).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- gmail.test.js`
Expected: FAIL — `../src/gmail.js` does not exist.

- [ ] **Step 3: Create `worker/src/gmail.js`**

```js
// Turns whatever Composio returns into a flat, boring shape the rest of the
// code can rely on. Composio wraps the payload two different ways depending on
// the execution path, and an empty inbox is a normal result — both are handled
// here so nothing downstream has to know.
export function parseMessages(payload) {
  const fromWrapped = payload?.results?.[0]?.response?.data?.messages;
  const fromPlain = payload?.data?.messages ?? payload?.messages;
  const raw = fromWrapped ?? fromPlain ?? [];
  return raw.map((m) => ({
    id: m.messageId || m.id,
    threadId: m.threadId || null,
    from: m.sender || m.from || "",
    subject: m.subject || "",
    snippet: m.preview?.body || m.snippet || "",
    date: m.messageTimestamp || m.internalDate || "",
  }));
}
```

If Task 1 recorded different field names on a message, use the recorded ones and update the test fixture to match reality — the live shape wins over this snippet.

- [ ] **Step 4: Run the test, then the full suite**

Run: `cd worker && npm test -- gmail.test.js` → PASS (3 tests).
Run: `cd worker && npm test` → PASS (45 + 3 = 48). Paste output.

- [ ] **Step 5: Commit**

```bash
git add worker/src/gmail.js worker/test/gmail.test.js
git commit -m "feat(worker): normalize Gmail messages from either envelope"
```

---

## Task 4: The triage — allowed to say no

**Files:**
- Create: `worker/src/triage.js`, `worker/test/triage.test.js`

- [ ] **Step 1: Write the failing test `worker/test/triage.test.js`**

```js
import { fetchMock } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { triageMessage } from "../src/triage.js";

const OPENAI = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

const message = {
  id: "m1",
  from: "billing@acme.com",
  subject: "Invoice #42 needs approval",
  snippet: "Please approve the attached invoice by Friday.",
  date: "2026-08-09T01:00:00Z",
};

function reply(content) {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a message that needs a decision becomes a card", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => reply({
      needsDecision: true,
      cardType: "approval",
      title: "Approve invoice #42",
      summary: "Acme is waiting on approval for invoice #42.",
      context: "deadline: Friday · amount: invoice #42",
      priority: "high",
    }));

  const card = await triageMessage(message, { provider: OPENAI, readerLanguage: "en" });
  expect(card).not.toBeNull();
  expect(card.title).toBe("Approve invoice #42");
  expect(card.priority).toBe("high");
});

test("a message that needs nothing produces no card", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => reply({ needsDecision: false }));

  const card = await triageMessage(message, { provider: OPENAI, readerLanguage: "en" });
  expect(card).toBeNull();
});

test("an unusable model reply is treated as no card, not a crash", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: "not json" } }] }));

  const card = await triageMessage(message, { provider: OPENAI, readerLanguage: "en" });
  expect(card).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- triage.test.js`
Expected: FAIL — `../src/triage.js` does not exist.

- [ ] **Step 3: Create `worker/src/triage.js`**

```js
// Asks one question about an incoming message: does this need a decision from
// the person who received it? Most mail does not, and answering "no" is the
// point — a connector that turns every message into a card is a worse inbox.

const SYSTEM_PROMPT = `You triage a person's incoming mail into decisions.

For the message you are given, decide whether it genuinely requires a decision or
an action FROM THE RECIPIENT. Newsletters, receipts, notifications, automated
reports, marketing, and FYI threads do NOT. Be strict: when in doubt, say no.

Reply with JSON only:
{"needsDecision": false}
or
{"needsDecision": true, "cardType": "approval|task|notification|revision|delegation",
 "title": "3-8 words, action-oriented", "summary": "1-2 sentences, what must be decided or done",
 "context": "2-4 'label: detail' segments joined by ·, using only deadline/scope/metric/amount/action",
 "priority": "low|medium|high|urgent"}

Write title, summary and context in the reader's language, given below.`;

export async function triageMessage(message, { provider, readerLanguage }) {
  const userPrompt = `Reader language: ${readerLanguage || "en"}
From: ${message.from}
Subject: ${message.subject}
Received: ${message.date}
Body preview: ${message.snippet}`;

  let data;
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A model that did not answer in JSON is not a reason to invent a card.
    return null;
  }
  if (!parsed?.needsDecision) return null;

  return {
    cardType: parsed.cardType || "task",
    title: parsed.title || message.subject,
    summary: parsed.summary || "",
    context: parsed.context || "",
    priority: parsed.priority || "medium",
  };
}
```

- [ ] **Step 4: Run the test, then the full suite**

Run: `cd worker && npm test -- triage.test.js` → PASS (3 tests).
Run: `cd worker && npm test` → PASS (48 + 3 = 51). Paste output.

- [ ] **Step 5: Commit**

```bash
git add worker/src/triage.js worker/test/triage.test.js
git commit -m "feat(worker): triage that is allowed to create nothing"
```

---

## Task 5: The sync endpoint

**Files:**
- Modify: `worker/src/index.js`
- Test: `worker/test/sync.test.js`

- [ ] **Step 1: Write the failing test `worker/test/sync.test.js`**

```js
import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, upsertMembership } from "../src/db.js";

let token;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "700", "gho_sync");
  await upsertMembership(env.DB, "acme/web", "700", "Engineer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function composioReply(messages) {
  return { data: { messages } };
}

const NEEDS = {
  messageId: "m-needs", subject: "Invoice #42 needs approval",
  sender: "billing@acme.com", preview: { body: "Approve by Friday." },
  messageTimestamp: "2026-08-09T01:00:00Z",
};

test("sync creates a card only for mail that needs a decision", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: /\/tools\/execute\/GMAIL_FETCH_EMAILS/, method: "POST" })
    .reply(200, () => composioReply([NEEDS]));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({
      choices: [{ message: { content: JSON.stringify({
        needsDecision: true, cardType: "approval", title: "Approve invoice #42",
        summary: "Acme is waiting.", context: "deadline: Friday", priority: "high",
      }) } }],
    }));

  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ scanned: 1, created: 1 });

  const row = await env.DB
    .prepare("SELECT card_id FROM ingested_items WHERE connector='gmail' AND external_id='m-needs'")
    .first();
  expect(row.card_id).not.toBeNull();
});

test("an already-ingested message is skipped without calling the model", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: /\/tools\/execute\/GMAIL_FETCH_EMAILS/, method: "POST" })
    .reply(200, () => composioReply([NEEDS]));
  // No OpenAI interceptor: if the model is called, assertNoPendingInterceptors
  // stays happy but the request fails, so a second triage would break the test.

  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(await res.json()).toMatchObject({ scanned: 1, created: 0 });
});

test("sync requires a session", async () => {
  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- sync.test.js`
Expected: FAIL — the route 404s.

- [ ] **Step 3: Add the route to `worker/src/index.js`**

Add the imports beside the existing ones:

```js
import { executeTool } from "./composio.js";
import { parseMessages } from "./gmail.js";
import { triageMessage } from "./triage.js";
import { isIngested, markIngested, saveCard } from "./db.js";
```
(Merge the `./db.js` names into the existing import from that module rather than adding a second import line.)

Add the route inside `fetch`, beside the other `/orgs/...` routes:

```js
    if (url.pathname === "/connectors/gmail/sync" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      const body = await request.json();
      const orgId = body.orgId;
      const userId = body.userId;
      if (!orgId || !userId) return json({ message: "orgId and userId are required" }, 400);

      let payload;
      try {
        payload = await executeTool(
          env.COMPOSIO_API_KEY,
          "GMAIL_FETCH_EMAILS",
          env.COMPOSIO_USER_ID || String(session.github_id),
          { query: "newer_than:7d", max_results: 10, verbose: false, include_payload: false }
        );
      } catch (err) {
        return json({ message: err.message }, 502);
      }

      const messages = parseMessages(payload);
      const provider = providerConfig(env);
      let created = 0;

      for (const message of messages) {
        if (!message.id) continue;
        if (await isIngested(env.DB, "gmail", message.id, session.github_id)) continue;

        let cardId = null;
        const triaged = provider
          ? await triageMessage(message, { provider, readerLanguage: body.readerLanguage })
          : null;

        if (triaged) {
          cardId = crypto.randomUUID();
          await saveCard(env.DB, orgId, {
            id: cardId,
            recipientUserID: userId,
            senderUserID: userId,
            type: triaged.cardType,
            format: "approve",
            title: triaged.title,
            summary: triaged.summary,
            context: triaged.context,
            priority: triaged.priority,
            status: "pending",
            createdAt: new Date().toISOString(),
            sourceApp: "Gmail",
            sourceDetail: `${message.from} · ${message.subject}`,
          });
          created += 1;
        }

        // Recorded either way: a rejected message must never be re-judged.
        await markIngested(env.DB, {
          connector: "gmail", externalId: message.id,
          githubId: session.github_id, orgId, cardId,
        });
      }

      return json({ scanned: messages.length, created });
    }
```

- [ ] **Step 4: Run the sync tests, then the full suite**

Run: `cd worker && npm test -- sync.test.js` → PASS (3 tests).
Run: `cd worker && npm test` → PASS (51 + 3 = 54). Paste output.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js worker/test/sync.test.js
git commit -m "feat(worker): Gmail sync endpoint with dedup and triage"
```

---

## Task 6: Deploy and prove it on the real mailbox

**Files:** none (operational)

This is the point of the sub-project: does the triage actually separate decisions
from noise? Only real mail answers that.

- [ ] **Step 1: Migrate the live database**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --file=./schema.sql`
Expected: executes without error (adds `ingested_items`; every other statement is `IF NOT EXISTS`).

- [ ] **Step 2: Set the secrets**

```bash
cd worker
npx wrangler secret put COMPOSIO_API_KEY
npx wrangler secret put COMPOSIO_USER_ID
```
`COMPOSIO_USER_ID` is the user id recorded in Task 1 that owns the Gmail connection. (Once in-app connect exists, this falls back to per-user ids; today it makes the live test possible.)

- [ ] **Step 3: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID.

- [ ] **Step 4: Confirm the gate**

Run: `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{"orgId":"a/b","userId":"x"}' https://tiktokforwork.torubj0904.workers.dev/connectors/gmail/sync`
Expected: `401`.

- [ ] **Step 5: Report what a real sync would do — and hand the live run to the user**

A real sync needs a valid session token, which only exists after GitHub sign-in on a device. Do **not** fabricate one against the production database.

Report to the user that the connector is deployed and that the live check is: open the app (build from Task 8), pull to refresh, and see which mail became a card and which was ignored. Note that judging triage quality is the actual deliverable here.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(worker): deploy the Gmail connector" || echo "nothing to commit"
```

---

## Task 7: iOS calls sync

**Files:**
- Create: `TikTokForWork/Services/ConnectorService.swift`
- Modify: `TikTokForWork/Features/Feed/FeedView.swift`

- [ ] **Step 1: Create `TikTokForWork/Services/ConnectorService.swift`**

```swift
import Foundation

/// Pulls new work in from connected apps. A connector being down must never
/// break the feed, so every failure here is swallowed on purpose.
enum ConnectorService {
    @discardableResult
    static func syncGmail(orgId: String, userId: String, readerLanguage: String, backendBaseURL: URL) async -> Int {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/gmail/sync", relativeTo: backendBaseURL) else { return 0 }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "orgId": orgId, "userId": userId, "readerLanguage": readerLanguage,
        ])

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return 0
        }
        return json["created"] as? Int ?? 0
    }
}
```

- [ ] **Step 2: Call it from the feed**

In `TikTokForWork/Features/Feed/FeedView.swift`, add a helper and wire it to appearance and pull-to-refresh. Add the method inside the view:

```swift
    private func syncConnectors() async {
        guard let user = appState.currentUser,
              let repository = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else { return }
        await ConnectorService.syncGmail(
            orgId: repository,
            userId: user.id,
            readerLanguage: appState.readerLanguageCode,
            backendBaseURL: base
        )
    }
```

and attach it to the feed's scrolling container (read the file to find it — the cards are in a `ScrollView`/`TabView`):

```swift
        .task { await syncConnectors() }
        .refreshable { await syncConnectors() }
```

New cards arrive over the existing relay socket, so nothing needs to merge results locally.

- [ ] **Step 3: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`. If `.refreshable` cannot attach to the feed's container (it requires a `ScrollView` or `List`), attach `.task` only and report that pull-to-refresh needs a container change — do not restructure the feed to force it.

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Services/ConnectorService.swift TikTokForWork/Features/Feed/FeedView.swift
git commit -m "feat(ios): pull new work from Gmail on open and refresh"
```

---

## Task 8: Ship

**Files:** none

- [ ] **Step 1: Build and upload**

```bash
cd /Users/torutano/HonmaruAI
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```
Expected: a new build number with `processingState: VALID`. If the group-assignment step reports `no resource of type 'builds'`, that is App Store Connect indexing lag — the build is uploaded; assign it from the TestFlight UI once it appears. Do not re-upload.

- [ ] **Step 2: Hand the user the live check**

1. Open the app on a device signed in with GitHub.
2. Pull to refresh the feed.
3. Look at what appeared: are the new cards genuinely things needing a decision?
4. Look at what did *not* appear: newsletters, receipts, notifications should have been ignored.
5. Pull to refresh again — nothing should duplicate.

Item 3 and 4 are the real result. If the triage is too eager or too shy, that is a prompt change in `worker/src/triage.js`, not a code change.

---

## Self-Review Notes (addressed)

- **Spec coverage:** dedup that records rejections (Task 2), both Composio envelopes parsed (Task 3), a triage that may return nothing (Task 4), the session-gated sync that persists and broadcasts via `saveCard` + the relay (Task 5), live deploy (Task 6), silent-failure client calls on open and refresh (Task 7), ship (Task 8).
- **Deliberate deviation:** the in-app connect flow is NOT built — Composio retired `initiate()` on 2026-07-03 and the hosted-link replacement could not be pinned from public docs. Task 1 records the real API so a follow-up plan can build it. Stated at the top rather than buried.
- **Uncertainty handled honestly:** Task 1 is research with a written deliverable, and Tasks 2–3 explicitly defer to what it recorded over the snippets here.
- **Privacy:** Task 1 reads one message, metadata only, and forbids pasting mail contents into the repo; the sync stores only what a card shows.
- **Type consistency:** `parseMessages` emits `{id, threadId, from, subject, snippet, date}`, which `triageMessage(message, {provider, readerLanguage})` consumes and the sync route passes to `saveCard` with `sourceApp`/`sourceDetail` — the fields `DecisionCard` already has.
- **Cost control:** an ingested-but-rejected message is never re-judged; `max_results` is bounded; the fetch is light (`verbose:false`, `include_payload:false`) per Composio's 413 warning.

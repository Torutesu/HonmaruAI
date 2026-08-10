# Connector Registry + Slack Inbound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make inbound connectors plural and per-user — a registry any source can join, Slack as the second source, and every user reading only their own messages.

**Architecture:** Each connector becomes a small module (`id`, `label`, `toolSlug`, `buildArgs`, `parse`) in a registry; a connector-agnostic loop in `worker/src/sync.js` does fetch → dedup → triage → card for each one. `POST /connectors/sync` runs them all and reports per-connector results, with one connector's failure isolated from the others. The Composio identity becomes the caller's numeric GitHub id instead of a single shared secret, and the app gains a Connectors screen that creates each user's own connection.

**Tech Stack:** Cloudflare Workers + D1, Composio REST, OpenAI, Vitest; SwiftUI + ASWebAuthenticationSession.

## Verification model

- **Worker:** `cd /Users/torutano/HonmaruAI/worker && npm test` — **55 tests green today**; every task keeps the suite green.
- **iOS:** no test target — `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` ending in `** BUILD SUCCEEDED **`.

## Verified contracts (already pinned live — see `worker/README.md`, do not re-derive)

**Gmail** — `GMAIL_FETCH_EMAILS`, args `{query:"newer_than:7d", max_results, verbose:false, include_payload:false}`. Response `{successful, data:{messages:[…]}}`; a message has `messageId, threadId, sender, subject, messageTimestamp, preview:{body}`.

**Slack** — `SLACK_SEARCH_MESSAGES`, args `{query:"to:me after:YYYY-MM-DD", count, sort:"timestamp", sort_dir:"desc"}`. `to:me` means addressed-to-or-mentioning me (confirmed by calling it; it is not in the tool's own docs). Response `{successful, data:{ok, query, messages:{matches:[…]}}}` — **matches nest under `messages.matches`**. A match has `text, username, user, channel, ts, permalink, iid`. **Use `permalink` as the dedup id**; `iid` is a per-search id and is not stable.

**Composio** — base `https://backend.composio.dev/api/v3`, header `x-api-key`. Connect: `POST /v3/connected_accounts/link {user_id, auth_config_id}` → `{redirect_url}`. List: `GET /v3/connected_accounts?user_ids=<id>`. Auth configs (project-level, shared by all users): Gmail `ac_XcSzdgFl91Ds`, Slack `ac_qv8jozIjt29D`.

## The defect this fixes

The deployed Worker resolves the Composio identity as `env.COMPOSIO_USER_ID || String(session.github_id)`, and `COMPOSIO_USER_ID=honmaru-default` is set — so **every signed-in user's sync reads the developer's mailbox**. Task 3 removes that fallback and Task 5 deletes the secret. Until both land, do not add anyone to the TestFlight group.

## File Structure

```
worker/src/
  connectors/index.js   # NEW registry: CONNECTORS, byId()
  connectors/gmail.js   # NEW (absorbs the old src/gmail.js parser)
  connectors/slack.js   # NEW
  sync.js               # NEW connector-agnostic loop, lifted out of index.js
  composio.js           # + listConnectedAccounts, createConnectLink
  triage.js             # prompt becomes source-aware
  index.js              # /connectors/sync, /connectors, /connectors/:id/connect, legacy route
  gmail.js              # DELETED (moved under connectors/)
worker/test/
  slack.test.js         # NEW
  connectors.test.js    # NEW registry + isolation
  connect-api.test.js   # NEW connect/list endpoints
  sync.test.js          # extended
  gmail.test.js         # import path updated
TikTokForWork/
  Services/ConnectorService.swift   # list / connect / sync
  Features/Settings/ConnectorsView.swift  # NEW
  Features/Shell/YouView.swift      # + Connectors row
```

---

## Task 1: The connector registry

**Files:**
- Create: `worker/src/connectors/gmail.js`, `worker/src/connectors/slack.js`, `worker/src/connectors/index.js`
- Delete: `worker/src/gmail.js`
- Modify: `worker/test/gmail.test.js`
- Test: `worker/test/slack.test.js`, `worker/test/connectors.test.js`

- [ ] **Step 1: Write the failing Slack test `worker/test/slack.test.js`**

```js
import { expect, test } from "vitest";
import { slack } from "../src/connectors/slack.js";

const match = {
  text: "Can you approve the deploy tonight?",
  username: "hubot",
  user: "U123",
  channel: { id: "C1", name: "release" },
  ts: "1754800000.123456",
  permalink: "https://acme.slack.com/archives/C1/p1754800000123456",
  iid: "search-result-id",
};

test("parses matches nested under messages.matches", () => {
  const items = slack.parse({ successful: true, data: { messages: { matches: [match] } } });
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe(match.permalink);
  expect(items[0].from).toBe("hubot");
  expect(items[0].subject).toBe("#release");
  expect(items[0].snippet).toContain("approve the deploy");
  expect(items[0].date).toBe(new Date(1754800000123).toISOString());
});

test("falls back to channel and ts when there is no permalink", () => {
  const { permalink, ...noLink } = match;
  const items = slack.parse({ data: { messages: { matches: [noLink] } } });
  expect(items[0].id).toBe("C1-1754800000.123456");
});

test("no matches is a valid result", () => {
  expect(slack.parse({ data: { messages: { matches: [] } } })).toEqual([]);
  expect(slack.parse({})).toEqual([]);
});

test("buildArgs asks Slack for what is addressed to me", () => {
  const args = slack.buildArgs();
  expect(args.query).toMatch(/^to:me after:\d{4}-\d{2}-\d{2}$/);
  expect(args.sort).toBe("timestamp");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- slack.test.js`
Expected: FAIL — `../src/connectors/slack.js` does not exist.

- [ ] **Step 3: Create `worker/src/connectors/slack.js`**

```js
// Slack messages addressed to you. `to:me` is the modifier that means
// "addressed to or mentioning me" — it is absent from the tool's own docs and
// was confirmed by calling the live API.

function daysAgo(n) {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

export const slack = {
  id: "slack",
  label: "Slack",
  authConfigId: "ac_qv8jozIjt29D",
  toolSlug: "SLACK_SEARCH_MESSAGES",

  buildArgs() {
    return { query: `to:me after:${daysAgo(7)}`, count: 10, sort: "timestamp", sort_dir: "desc" };
  },

  parse(payload) {
    const wrapped = payload?.results?.[0]?.response?.data?.messages?.matches;
    const plain = payload?.data?.messages?.matches;
    const matches = wrapped ?? plain ?? [];
    return matches.map((m) => ({
      // permalink encodes channel + timestamp and is stable across searches;
      // iid is a per-search id and would re-ingest the same message forever.
      id: m.permalink || `${m.channel?.id || ""}-${m.ts}`,
      from: m.username || m.user || "",
      subject: m.channel?.name ? `#${m.channel.name}` : "Slack",
      snippet: m.text || "",
      date: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : "",
    }));
  },
};
```

- [ ] **Step 4: Create `worker/src/connectors/gmail.js`**

Move the existing parser in as a connector module. Read `worker/src/gmail.js` and reuse its `parseMessages` body verbatim as `parse`:

```js
// Mail addressed to you in the last week.
export const gmail = {
  id: "gmail",
  label: "Gmail",
  authConfigId: "ac_XcSzdgFl91Ds",
  toolSlug: "GMAIL_FETCH_EMAILS",

  buildArgs() {
    return { query: "newer_than:7d", max_results: 10, verbose: false, include_payload: false };
  },

  // Composio wraps the payload two different ways depending on the execution
  // path, and an empty inbox is a normal result — both are handled here.
  parse(payload) {
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
  },
};
```

- [ ] **Step 5: Create `worker/src/connectors/index.js`**

```js
import { gmail } from "./gmail.js";
import { slack } from "./slack.js";

// Adding a source means writing one module and adding it here. Nothing in the
// sync loop, the API or the client knows which connectors exist.
export const CONNECTORS = [gmail, slack];

export function connectorById(id) {
  return CONNECTORS.find((c) => c.id === id) || null;
}
```

- [ ] **Step 6: Write `worker/test/connectors.test.js`**

```js
import { expect, test } from "vitest";
import { CONNECTORS, connectorById } from "../src/connectors/index.js";

test("every connector satisfies the contract", () => {
  expect(CONNECTORS.length).toBeGreaterThanOrEqual(2);
  for (const c of CONNECTORS) {
    expect(typeof c.id).toBe("string");
    expect(typeof c.label).toBe("string");
    expect(typeof c.toolSlug).toBe("string");
    expect(typeof c.authConfigId).toBe("string");
    expect(typeof c.buildArgs).toBe("function");
    expect(typeof c.parse).toBe("function");
    expect(c.parse({})).toEqual([]);
  }
});

test("connectors are addressable by id", () => {
  expect(connectorById("gmail").label).toBe("Gmail");
  expect(connectorById("slack").label).toBe("Slack");
  expect(connectorById("nope")).toBeNull();
});
```

- [ ] **Step 7: Repoint `worker/test/gmail.test.js` and delete the old module**

Change its import to `import { gmail } from "../src/connectors/gmail.js";` and its calls from `parseMessages(x)` to `gmail.parse(x)`. Then `git rm worker/src/gmail.js`.
(The old `parseMessages` import in `worker/src/index.js` is replaced in Task 3; if the suite is red between here and there because of it, that is expected — but prefer to just do Task 3's import swap now if it is the only breakage.)

- [ ] **Step 8: Run the suite**

Run: `cd worker && npm test`
Expected: PASS. Paste output.

- [ ] **Step 9: Commit**

```bash
git add worker/src/connectors worker/test/slack.test.js worker/test/connectors.test.js worker/test/gmail.test.js worker/src/gmail.js worker/src/index.js
git commit -m "feat(worker): connector registry with Gmail and Slack"
```

---

## Task 2: Source-aware triage

**Files:**
- Modify: `worker/src/triage.js`, `worker/test/triage.test.js`

- [ ] **Step 1: Add the failing test to `worker/test/triage.test.js`** (append)

```js
test("the prompt names the source so a Slack DM is judged as one", async () => {
  let sent;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ needsDecision: false }) } }] });

  await triageMessage(
    { id: "s1", from: "hubot", subject: "#release", snippet: "approve?", date: "2026-08-10T00:00:00Z" },
    { provider: OPENAI, readerLanguage: "en", sourceLabel: "Slack" }
  );

  const text = JSON.stringify(sent.messages);
  expect(text).toContain("Slack");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- triage.test.js`
Expected: FAIL — nothing mentions Slack.

- [ ] **Step 3: Generalize the prompt in `worker/src/triage.js`**

Replace the first line of `SYSTEM_PROMPT` — currently `You triage a person's incoming mail into decisions.` — with:

```
You triage the messages that reach a person into decisions.
```

and in the same prompt replace the sentence listing what does not qualify so it is not mail-specific:

```
Newsletters, receipts, notifications, automated reports, marketing, chit-chat and
FYI threads do NOT. Be strict: when in doubt, say no.
```

Change the signature to accept the source and put it in the user prompt:

```js
export async function triageMessage(message, { provider, readerLanguage, sourceLabel }) {
  const userPrompt = `Reader language: ${readerLanguage || "en"}
Source: ${sourceLabel || "Inbox"}
From: ${message.from}
Subject: ${message.subject}
Received: ${message.date}
Body preview: ${message.snippet}`;
```

Everything else in the file is unchanged — in particular the rule that an
unparseable reply returns `null` rather than inventing a card.

- [ ] **Step 4: Run the suite**

Run: `cd worker && npm test`
Expected: PASS. Paste output.

- [ ] **Step 5: Commit**

```bash
git add worker/src/triage.js worker/test/triage.test.js
git commit -m "feat(worker): triage knows which source a message came from"
```

---

## Task 3: One sync across every connector, per user

**Files:**
- Create: `worker/src/sync.js`
- Modify: `worker/src/index.js`, `worker/test/sync.test.js`

- [ ] **Step 1: Add the failing tests to `worker/test/sync.test.js`** (append)

```js
test("one sync runs every connector and reports each", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [
      { messageId: "g-1", subject: "Invoice", sender: "billing@acme.com",
        preview: { body: "approve" }, messageTimestamp: "2026-08-10T00:00:00Z" }] } }));
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEARCH_MESSAGES", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: { matches: [
      { text: "ship it?", username: "hubot", channel: { id: "C1", name: "release" },
        ts: "1754800000.000000", permalink: "https://acme.slack.com/archives/C1/p1" }] } } }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({ needsDecision: false }) } }] }))
    .persist();

  const res = await SELF.fetch("https://example.com/connectors/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  const { results } = await res.json();
  expect(results.map((r) => r.connector).sort()).toEqual(["gmail", "slack"]);
  expect(results.every((r) => r.scanned === 1)).toBe(true);
});

test("one connector failing does not silence the other", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(500, "composio exploded");
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEARCH_MESSAGES", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: { matches: [
      { text: "please approve the release", username: "hubot",
        channel: { id: "C2", name: "ops" }, ts: "1754800001.000000",
        permalink: "https://acme.slack.com/archives/C2/p2" }] } } }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve the release",
      summary: "Ops is waiting.", context: "action: approve", priority: "high" }) } }] }));

  const res = await SELF.fetch("https://example.com/connectors/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  const { results } = await res.json();
  const gmailResult = results.find((r) => r.connector === "gmail");
  const slackResult = results.find((r) => r.connector === "slack");
  expect(gmailResult.error).toBeTruthy();
  expect(slackResult.created).toBe(1);
});

test("the legacy gmail route still answers for build 28", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [] } }));

  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ scanned: 0, created: 0 });
});
```

Note the existing tests in this file call the exported handler with an env carrying the secrets (aliased as `SELF`) — keep using whatever that file already does.

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- sync.test.js`
Expected: FAIL — `/connectors/sync` 404s.

- [ ] **Step 3: Create `worker/src/sync.js`**

```js
import { executeTool } from "./composio.js";
import { triageMessage } from "./triage.js";
import { isIngested, markIngested, saveCard } from "./db.js";

// The loop is deliberately ignorant of which connector it is running: fetch,
// skip what we have seen, ask whether it needs a decision, and record the answer
// either way.
export async function syncConnector(connector, { env, session, orgId, userId, readerLanguage, provider }) {
  const payload = await executeTool(
    env.COMPOSIO_API_KEY,
    connector.toolSlug,
    // Always the caller's own Composio identity. A shared id here would mean
    // every user reading one person's messages.
    String(session.github_id),
    connector.buildArgs()
  );

  const messages = connector.parse(payload);
  let created = 0;

  for (const message of messages) {
    if (!message.id) continue;
    if (await isIngested(env.DB, connector.id, message.id, session.github_id)) continue;

    let cardId = null;
    const triaged = provider
      ? await triageMessage(message, { provider, readerLanguage, sourceLabel: connector.label })
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
        sourceApp: connector.label,
        sourceDetail: `${message.from} · ${message.subject}`,
      });
      created += 1;
    }

    // Recorded even when rejected, so the model never re-judges the same item.
    await markIngested(env.DB, {
      connector: connector.id, externalId: message.id,
      githubId: session.github_id, orgId, cardId,
    });
  }

  return { connector: connector.id, scanned: messages.length, created };
}

// One connector's outage must not silence the others.
export async function syncAll(connectors, context) {
  const results = [];
  for (const connector of connectors) {
    try {
      results.push(await syncConnector(connector, context));
    } catch (err) {
      results.push({ connector: connector.id, scanned: 0, created: 0, error: String(err.message).slice(0, 200) });
    }
  }
  return results;
}
```

- [ ] **Step 4: Replace the route in `worker/src/index.js`**

Remove the whole `if (url.pathname === "/connectors/gmail/sync" …) { … }` block and the now-unused `executeTool` / `parseMessages` / `triageMessage` imports from it. Add:

```js
import { CONNECTORS, connectorById } from "./connectors/index.js";
import { syncAll } from "./sync.js";
```

and the two routes:

```js
    const syncMatch = url.pathname === "/connectors/sync"
      || url.pathname.match(/^\/connectors\/([^/]+)\/sync$/);
    if (syncMatch && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      const body = await request.json();
      if (!body.orgId || !body.userId) return json({ message: "orgId and userId are required" }, 400);

      // A single-connector path keeps TestFlight build 28 working; it shipped
      // calling /connectors/gmail/sync and returns the flat shape.
      const only = typeof syncMatch === "object" ? connectorById(syncMatch[1]) : null;
      if (typeof syncMatch === "object" && !only) return json({ message: "unknown connector" }, 404);

      const results = await syncAll(only ? [only] : CONNECTORS, {
        env, session,
        orgId: body.orgId, userId: body.userId,
        readerLanguage: body.readerLanguage,
        provider: providerConfig(env),
      });

      if (only) {
        const r = results[0];
        return r.error ? json({ message: r.error }, 502) : json({ scanned: r.scanned, created: r.created });
      }
      return json({ results });
    }
```

- [ ] **Step 5: Run the suite**

Run: `cd worker && npm test`
Expected: PASS. Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/sync.js worker/src/index.js worker/test/sync.test.js
git commit -m "feat(worker): sync every connector for the calling user"
```

---

## Task 4: Per-user connect and status

**Files:**
- Modify: `worker/src/composio.js`, `worker/src/index.js`
- Test: `worker/test/connect-api.test.js`

- [ ] **Step 1: Write the failing test `worker/test/connect-api.test.js`**

```js
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession } from "../src/db.js";
import worker from "../src/index.js";

let token;
const ENV = () => ({ ...env, COMPOSIO_API_KEY: "ak-test" });
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), ENV());

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "900", "gho_conn");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("connect returns a redirect url for this user", async () => {
  let sentBody;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/connected_accounts/link", method: "POST",
      body: (b) => { sentBody = JSON.parse(b); return true; } })
    .reply(200, { redirect_url: "https://connect.composio.dev/link/lk_x",
                  connected_account_id: "ca_x" });

  const res = await call("/connectors/slack/connect", {
    method: "POST", headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ redirectUrl: "https://connect.composio.dev/link/lk_x" });
  // The link must be minted for the caller, never a shared identity.
  expect(sentBody.user_id).toBe("900");
  expect(sentBody.auth_config_id).toBe("ac_qv8jozIjt29D");
});

test("status reports which connectors this user has", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.startsWith("/api/v3/connected_accounts") })
    .reply(200, { items: [{ id: "ca_1", user_id: "900", status: "ACTIVE", toolkit: { slug: "gmail" } }] });

  const res = await call("/connectors", { headers: { "x-session-token": token } });
  expect(res.status).toBe(200);
  const { connectors } = await res.json();
  expect(connectors.find((c) => c.id === "gmail").status).toBe("active");
  expect(connectors.find((c) => c.id === "slack").status).toBe("none");
});

test("both endpoints need a session", async () => {
  expect((await call("/connectors", {})).status).toBe(401);
  expect((await call("/connectors/slack/connect", { method: "POST" })).status).toBe(401);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- connect-api.test.js`
Expected: FAIL — routes 404.

- [ ] **Step 3: Add the two Composio calls to `worker/src/composio.js`** (append)

```js
export async function createConnectLink(apiKey, userId, authConfigId) {
  const res = await fetch(`${BASE}/connected_accounts/link`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, auth_config_id: authConfigId }),
  });
  if (!res.ok) throw new Error(`Composio link ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function listConnectedAccounts(apiKey, userId) {
  const res = await fetch(`${BASE}/connected_accounts?user_ids=${encodeURIComponent(userId)}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Composio accounts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.items || body.data || [];
}
```

- [ ] **Step 4: Add the routes to `worker/src/index.js`**

Extend the connectors import and add `createConnectLink, listConnectedAccounts` to the `./composio.js` import. Then, beside the sync route:

```js
    if (url.pathname === "/connectors" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      let accounts = [];
      try {
        accounts = await listConnectedAccounts(env.COMPOSIO_API_KEY, String(session.github_id));
      } catch (err) {
        return json({ message: err.message }, 502);
      }
      const active = new Set(
        accounts
          .filter((a) => String(a.status).toUpperCase() === "ACTIVE")
          .map((a) => (typeof a.toolkit === "string" ? a.toolkit : a.toolkit?.slug))
      );
      return json({
        connectors: CONNECTORS.map((c) => ({
          id: c.id, label: c.label, status: active.has(c.id) ? "active" : "none",
        })),
      });
    }

    const connectMatch = url.pathname.match(/^\/connectors\/([^/]+)\/connect$/);
    if (connectMatch && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);

      const connector = connectorById(connectMatch[1]);
      if (!connector) return json({ message: "unknown connector" }, 404);

      try {
        const link = await createConnectLink(
          env.COMPOSIO_API_KEY, String(session.github_id), connector.authConfigId
        );
        return json({ redirectUrl: link.redirect_url, connectedAccountId: link.connected_account_id });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }
```

Place these **before** the sync route so `/connectors/slack/connect` is not swallowed by the `/connectors/:id/sync` pattern (the patterns differ, but ordering makes the intent obvious).

- [ ] **Step 5: Run the suite**

Run: `cd worker && npm test`
Expected: PASS. Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/composio.js worker/src/index.js worker/test/connect-api.test.js
git commit -m "feat(worker): per-user connector connect and status"
```

---

## Task 5: Deploy and retire the shared identity

**Files:** none (operational)

- [ ] **Step 1: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID.

- [ ] **Step 2: Delete the shared Composio identity**

Run: `cd worker && npx wrangler secret delete COMPOSIO_USER_ID`
Confirm when prompted. This is the fix for the defect: with it gone, `syncConnector` can only ever use the caller's own GitHub id.

The existing `honmaru-default` connections in Composio become orphaned — that is expected. Reconnect through the app's Connectors screen (Task 6) to get a connection under your real id.

- [ ] **Step 3: Smoke the gates**

```bash
BASE=https://tiktokforwork.torubj0904.workers.dev
curl -s -o /dev/null -w "connectors      %{http_code}\n" $BASE/connectors
curl -s -o /dev/null -w "connect         %{http_code}\n" -X POST $BASE/connectors/slack/connect
curl -s -o /dev/null -w "sync            %{http_code}\n" -X POST -H 'content-type: application/json' -d '{"orgId":"a/b","userId":"x"}' $BASE/connectors/sync
curl -s -o /dev/null -w "legacy sync     %{http_code}\n" -X POST -H 'content-type: application/json' -d '{"orgId":"a/b","userId":"x"}' $BASE/connectors/gmail/sync
curl -s $BASE/health
```
Expected: `401` for the first four (all session-gated), and the usual health JSON.

- [ ] **Step 4: Commit any drift**

```bash
git add -A && git commit -m "chore(worker): retire the shared Composio identity" || echo "nothing to commit"
```

---

## Task 6: Connectors screen and the sync call

**Files:**
- Modify: `TikTokForWork/Services/ConnectorService.swift`, `TikTokForWork/Features/Shell/YouView.swift`, `TikTokForWork/Features/Feed/FeedView.swift`
- Create: `TikTokForWork/Features/Settings/ConnectorsView.swift`
- Modify: `TikTokForWork/Localizable.xcstrings`

- [ ] **Step 1: Extend `TikTokForWork/Services/ConnectorService.swift`**

Replace the file with list / connect / sync. The sync now hits `/connectors/sync` and stays silent on failure:

```swift
import Foundation

struct Connector: Identifiable, Decodable, Equatable {
    let id: String
    let label: String
    let status: String

    var isConnected: Bool { status == "active" }
}

/// Pulls new work in from connected apps. A connector being down must never
/// break the feed, so sync failures are swallowed on purpose. Connect and list
/// surface their errors, because the user is looking right at them.
enum ConnectorService {
    private struct ConnectorList: Decodable { let connectors: [Connector] }
    private struct ConnectLink: Decodable { let redirectUrl: String }

    static func list(backendBaseURL: URL) async throws -> [Connector] {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors", relativeTo: backendBaseURL) else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(ConnectorList.self, from: data).connectors
    }

    static func connectURL(for id: String, backendBaseURL: URL) async throws -> URL {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/\(id)/connect", relativeTo: backendBaseURL) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, _) = try await URLSession.shared.data(for: request)
        let link = try JSONDecoder().decode(ConnectLink.self, from: data)
        guard let redirect = URL(string: link.redirectUrl) else { throw URLError(.badServerResponse) }
        return redirect
    }

    @discardableResult
    static func syncAll(orgId: String, userId: String, readerLanguage: String, backendBaseURL: URL) async -> Int {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/sync", relativeTo: backendBaseURL) else { return 0 }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "orgId": orgId, "userId": userId, "readerLanguage": readerLanguage,
        ])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let results = json["results"] as? [[String: Any]] else { return 0 }
        return results.reduce(0) { $0 + (($1["created"] as? Int) ?? 0) }
    }
}
```

- [ ] **Step 2: Point the feed at the new call**

In `TikTokForWork/Features/Feed/FeedView.swift`, the `syncConnectors()` helper calls `ConnectorService.syncGmail(...)`. Change that one call to:

```swift
        await ConnectorService.syncAll(
            orgId: repository,
            userId: user.id,
            readerLanguage: appState.readerLanguageCode,
            backendBaseURL: base
        )
```

- [ ] **Step 3: Create `TikTokForWork/Features/Settings/ConnectorsView.swift`**

```swift
import SwiftUI
import AuthenticationServices

/// Each person connects their own accounts. The app never sees a credential —
/// it opens a Composio-hosted authorization page and the backend holds the
/// connection against this user.
struct ConnectorsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var connectors: [Connector] = []
    @State private var message: String?
    @State private var busy: String?
    private let webAuth = WebAuthContextProvider()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(String(localized: "Connect the places your work arrives. Your AI reads them and shows you only what needs a decision."))
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)

                ForEach(connectors) { connector in
                    row(connector)
                }

                if let message {
                    Text(message)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("Connectors"))
        .task { await load() }
    }

    private func row(_ connector: Connector) -> some View {
        HStack {
            Text(connector.label)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            if busy == connector.id {
                ProgressView()
            } else if connector.isConnected {
                Text(String(localized: "Connected"))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            } else {
                Button(String(localized: "Connect")) {
                    Task { await connect(connector) }
                }
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.Colors.interactive)
            }
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func load() async {
        guard let base = appState.backendBaseURL else { return }
        do {
            connectors = try await ConnectorService.list(backendBaseURL: base)
            message = nil
        } catch {
            message = String(localized: "Could not load your connectors.")
        }
    }

    private func connect(_ connector: Connector) async {
        guard let base = appState.backendBaseURL else { return }
        busy = connector.id
        defer { busy = nil }
        do {
            let url = try await ConnectorService.connectURL(for: connector.id, backendBaseURL: base)
            _ = try await authorize(url)
            await load()
        } catch {
            message = String(localized: "Could not start the connection.")
        }
    }

    /// The authorization page finishes on a Composio-hosted URL, so there is no
    /// custom scheme to wait for — the session ends when the user closes it, and
    /// the real answer comes from re-reading the status afterwards.
    private func authorize(_ url: URL) async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: "tiktokforwork"
            ) { _, _ in
                continuation.resume(returning: true)
            }
            session.presentationContextProvider = webAuth
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }
}
```

- [ ] **Step 4: Add the row to `TikTokForWork/Features/Shell/YouView.swift`**

`YouView` already has a `navRow(_:destination:)` helper and a group holding `API key` and `Context`. Add to that group:

```swift
                    navRow(String(localized: "Connectors")) { ConnectorsView() }
```

- [ ] **Step 5: Japanese strings in `TikTokForWork/Localizable.xcstrings`**

Add `ja` for each new key that lacks one — SEARCH each first, a duplicate key breaks the JSON:
`Connectors`→`連携`, `Connect`→`接続`, `Could not load your connectors.`→`連携先を読み込めませんでした。`, `Could not start the connection.`→`接続を開始できませんでした。`, `Connect the places your work arrives. Your AI reads them and shows you only what needs a decision.`→`仕事が届く場所を接続してください。AI が読み取り、決定が必要なものだけを表示します。`
(`Connected` already exists — verify before adding.)
Validate: `python3 -c "import json;json.load(open('TikTokForWork/Localizable.xcstrings'));print('valid json')"` → must print `valid json`.

- [ ] **Step 6: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`. `WebAuthContextProvider` already exists in `TikTokForWork/Services/` (GitHub sign-in uses it) — reuse it, do not write a second one.

- [ ] **Step 7: Commit**

```bash
git add TikTokForWork/Services/ConnectorService.swift TikTokForWork/Features/Settings/ConnectorsView.swift TikTokForWork/Features/Shell/YouView.swift TikTokForWork/Features/Feed/FeedView.swift TikTokForWork/Localizable.xcstrings
git commit -m "feat(ios): connect your own Gmail and Slack"
```

- [ ] **Step 8: Ship**

```bash
cd /Users/torutano/HonmaruAI
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```
Expected: a new build number with `processingState: VALID`. If group assignment reports `no resource of type 'builds'`, that is App Store Connect indexing lag — the build is uploaded; assign it from the TestFlight UI. Do not re-upload.

- [ ] **Step 9: Device checklist (run by the user)**

1. Settings → **Connectors**: Gmail and Slack both show **Connect** (the old `honmaru-default` connections do not belong to your account any more — this is the fix working).
2. Connect Gmail, then Slack. Each opens an authorization page; after finishing, the row reads **Connected**.
3. Pull to refresh the feed. Cards appear from both sources, each showing where it came from.
4. Pull again — nothing duplicates.
5. Anything obviously not a decision (newsletters, chit-chat) should be absent. That judgement is the product; if it is off, it is a prompt change in `worker/src/triage.js`.

---

## Self-Review Notes (addressed)

- **Spec coverage:** registry with a three-thing connector contract (Task 1), source-aware triage (Task 2), one sync across all connectors with per-connector results and failure isolation plus the legacy route for build 28 (Task 3), per-user connect + status endpoints (Task 4), deploy and deletion of the shared identity (Task 5), Connectors screen and the client switch (Task 6).
- **The defect is actually fixed:** `syncConnector` takes the id from `session.github_id` with no env fallback, Task 4's test asserts the connect link is minted for the caller (`user_id === "900"`), and Task 5 deletes the secret. Three independent places, because this one silently reading the wrong mailbox is the worst failure mode here.
- **Type consistency:** every connector's `parse` returns `{id, from, subject, snippet, date}`, which `triageMessage(message, {provider, readerLanguage, sourceLabel})` consumes and `syncConnector` maps onto `saveCard` with `sourceApp = connector.label`. `Connector` in Swift decodes the `{id, label, status}` that `GET /connectors` emits.
- **Known orphan:** the `honmaru-default` Gmail and Slack connections stop being reachable once the shared id is gone. Called out in Task 5 Step 2 and Task 6's checklist rather than left to surprise anyone.

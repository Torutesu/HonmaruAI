# Phase 1: Cloudflare Backend Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the existing localhost Node relay (`server/`) onto Cloudflare Workers + Durable Objects + D1, so a real device can reach it over HTTPS/WSS with persistent state.

**Architecture:** A single Worker `fetch` handler serves the HTTP/JSON API (health, GitHub OAuth token swap, `/ai/route`, `/agui/tools`) and forwards WebSocket upgrades to a per-org Durable Object. The Durable Object holds live WebSocket connections (hibernation API) and reads/writes card + context state through D1. The AG-UI event constructors and the AI routing logic are reused **verbatim** from `server/` — only the storage layer (in-memory maps → D1) and the runtime layer (`node:http`/`ws` → Worker fetch + `WebSocketPair`) are replaced.

**Tech Stack:** Cloudflare Workers (ESM JavaScript), Durable Objects (hibernatable WebSockets), D1 (SQLite), Wrangler, Vitest + `@cloudflare/vitest-pool-workers`.

**Key reuse fact:** `server/agui/{tools,events,adapter}.js` and `server/agentTools.js` are pure w.r.t. runtime — `adapter.js` functions operate on a plain store object `{ [recipientUserID]: card[] }` passed in as an argument, and `routeInstruction` takes its provider config as a parameter. So they copy over unchanged; the Worker/DO glue supplies the store (loaded from D1) and the provider config (built from `env`).

---

## File Structure

```
worker/
  wrangler.toml          # Worker name, D1 + DO bindings, compat date
  package.json           # deps: wrangler, vitest, @cloudflare/vitest-pool-workers
  vitest.config.js       # workers pool config
  schema.sql             # D1 tables
  src/
    index.js             # fetch handler: HTTP routes + WS upgrade → DO
    relay.js             # OrgRelay Durable Object class
    db.js                # D1 helpers: loadStore, saveCard, removeCard, contexts, sessions
    routing.js           # copied from server/agentTools.js (env threaded through)
    agui/
      tools.js           # copied verbatim from server/agui/tools.js
      events.js          # copied verbatim from server/agui/events.js
      adapter.js         # copied verbatim from server/agui/adapter.js
  test/
    http.test.js         # health, agui/tools, oauth config
    db.test.js           # schema + card round-trip
    routing.test.js      # fallback + mocked-OpenAI routing
    relay.test.js        # WS join→snapshot, submit_decision round-trip
```

`server/media.js`, the `/media` routes, and `web/index.html` are **not** ported (media capture is out of scope; the reference web client is dev-only). The org id is the repo full name (Phase 2 wires that; Phase 1 accepts any orgId string and defaults to `core-team` for parity).

---

## Task 1: Scaffold the Worker project

**Files:**
- Create: `worker/package.json`
- Create: `worker/wrangler.toml`
- Create: `worker/vitest.config.js`
- Create: `worker/src/index.js`
- Test: `worker/test/http.test.js`

- [ ] **Step 1: Create `worker/package.json`**

```json
{
  "name": "tiktokforwork-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.80.0"
  }
}
```

- [ ] **Step 2: Create `worker/wrangler.toml`**

```toml
name = "tiktokforwork"
main = "src/index.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "ORG_RELAY"
class_name = "OrgRelay"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["OrgRelay"]

[[d1_databases]]
binding = "DB"
database_name = "tiktokforwork"
database_id = "PLACEHOLDER_SET_IN_TASK_9"
```

- [ ] **Step 3: Create `worker/vitest.config.js`**

```js
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { compatibilityFlags: ["nodejs_compat"] },
      },
    },
  },
});
```

- [ ] **Step 4: Create minimal `worker/src/index.js` with the OrgRelay stub and /health**

```js
export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    return new Response("relay stub", { status: 200 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        orgId: "core-team",
        githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        aiRouting: Boolean(env.OPENAI_API_KEY),
        aiModel: env.OPENAI_MODEL || "gpt-4o-mini",
      });
    }
    return new Response("not found", { status: 404 });
  },
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 5: Write the failing test `worker/test/http.test.js`**

```js
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("GET /health reports readiness", async () => {
  const res = await SELF.fetch("https://example.com/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.aiModel).toBe("gpt-4o-mini");
});
```

- [ ] **Step 6: Install and run the test**

Run: `cd worker && npm install && npm test`
Expected: PASS (1 test). If `cloudflare:test` cannot resolve, re-check `vitest.config.js` uses `defineWorkersConfig`.

- [ ] **Step 7: Commit**

```bash
git add worker/
git commit -m "feat(worker): scaffold Cloudflare Worker with /health"
```

---

## Task 2: D1 schema and helpers

**Files:**
- Create: `worker/schema.sql`
- Create: `worker/src/db.js`
- Test: `worker/test/db.test.js`

- [ ] **Step 1: Create `worker/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS users (
  github_id     TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  locale        TEXT DEFAULT 'en',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,           -- repo full name, e.g. "acme/web"
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member',
  created_at        TEXT NOT NULL,
  PRIMARY KEY (org_id, user_github_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  user_github_id    TEXT NOT NULL,
  display_name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  org_id            TEXT NOT NULL,
  card_id           TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  sender_user_id    TEXT,
  created_at        TEXT NOT NULL,
  data              TEXT NOT NULL,          -- full card JSON
  PRIMARY KEY (org_id, card_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_recipient ON cards (org_id, recipient_user_id);

CREATE TABLE IF NOT EXISTS contexts (
  org_id  TEXT NOT NULL,
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token               TEXT PRIMARY KEY,
  github_id           TEXT NOT NULL,
  github_access_token TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT
);
```

- [ ] **Step 2: Create `worker/src/db.js`**

```js
// Loads the legacy store shape { [recipientUserID]: card[] } for one org,
// so the copied adapter.js functions can operate on it unchanged.
export async function loadStore(db, orgId) {
  const { results } = await db
    .prepare("SELECT data FROM cards WHERE org_id = ?1")
    .bind(orgId)
    .all();
  const store = {};
  for (const row of results) {
    const card = JSON.parse(row.data);
    (store[card.recipientUserID] ||= []).push(card);
  }
  return store;
}

export async function saveCard(db, orgId, card) {
  await db
    .prepare(
      `INSERT INTO cards (org_id, card_id, recipient_user_id, sender_user_id, created_at, data)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(org_id, card_id) DO UPDATE SET
         recipient_user_id = excluded.recipient_user_id,
         sender_user_id = excluded.sender_user_id,
         data = excluded.data`
    )
    .bind(
      orgId,
      card.id,
      card.recipientUserID,
      card.senderUserID || null,
      card.createdAt || new Date().toISOString(),
      JSON.stringify(card)
    )
    .run();
}

export async function removeCard(db, orgId, cardId) {
  await db
    .prepare("DELETE FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind(orgId, cardId)
    .run();
}

export async function clearCards(db, orgId) {
  await db.prepare("DELETE FROM cards WHERE org_id = ?1").bind(orgId).run();
}

export async function loadContexts(db, orgId) {
  const { results } = await db
    .prepare("SELECT user_id, data FROM contexts WHERE org_id = ?1")
    .bind(orgId)
    .all();
  const contexts = {};
  for (const row of results) contexts[row.user_id] = JSON.parse(row.data);
  return contexts;
}

export async function saveContext(db, orgId, userId, context) {
  await db
    .prepare(
      `INSERT INTO contexts (org_id, user_id, data) VALUES (?1, ?2, ?3)
       ON CONFLICT(org_id, user_id) DO UPDATE SET data = excluded.data`
    )
    .bind(orgId, userId, JSON.stringify(context))
    .run();
}
```

- [ ] **Step 3: Write the failing test `worker/test/db.test.js`**

```js
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { loadStore, saveCard, removeCard } from "../src/db.js";
import { readFileSync } from "node:fs";

beforeAll(async () => {
  await env.DB.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/\n/g, " "));
});

test("saveCard then loadStore round-trips a card into legacy shape", async () => {
  await saveCard(env.DB, "core-team", {
    id: "c1", recipientUserID: "user-yui", senderUserID: "user-toru",
    title: "Ship it?", priority: "high", createdAt: "2026-08-08T00:00:00Z",
  });
  const store = await loadStore(env.DB, "core-team");
  expect(store["user-yui"]).toHaveLength(1);
  expect(store["user-yui"][0].title).toBe("Ship it?");
  await removeCard(env.DB, "core-team", "c1");
  const after = await loadStore(env.DB, "core-team");
  expect(after["user-yui"]).toBeUndefined();
});
```

- [ ] **Step 4: Add the D1 test binding to `worker/vitest.config.js`**

Add under `miniflare`:

```js
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "test-db" },
        },
```

- [ ] **Step 5: Run the test**

Run: `cd worker && npm test -- db.test.js`
Expected: PASS. If `env.DB` is undefined, confirm the `d1Databases` binding name matches `DB`.

- [ ] **Step 6: Commit**

```bash
git add worker/schema.sql worker/src/db.js worker/test/db.test.js worker/vitest.config.js
git commit -m "feat(worker): D1 schema and store helpers"
```

---

## Task 3: Copy the AG-UI core verbatim

**Files:**
- Create: `worker/src/agui/tools.js` (copy of `server/agui/tools.js`)
- Create: `worker/src/agui/events.js` (copy of `server/agui/events.js`)
- Create: `worker/src/agui/adapter.js` (copy of `server/agui/adapter.js`)
- Test: `worker/test/agui.test.js`

- [ ] **Step 1: Copy the three files unchanged**

```bash
mkdir -p worker/src/agui
cp server/agui/tools.js worker/src/agui/tools.js
cp server/agui/events.js worker/src/agui/events.js
cp server/agui/adapter.js worker/src/agui/adapter.js
```

- [ ] **Step 2: Verify no `node:`/`process.env` usage leaked in**

Run: `grep -nE "process\\.env|node:|require\\(" worker/src/agui/*.js`
Expected: no output. If any appears (e.g. a `crypto` import), replace `randomUUID` from `node:crypto` with `crypto.randomUUID()` (available in Workers) and re-run the grep until clean.

- [ ] **Step 3: Write the test `worker/test/agui.test.js`**

```js
import { expect, test } from "vitest";
import { joinEvents, applyDecision } from "../src/agui/adapter.js";
import { PROTOCOL_VERSION, toolManifest } from "../src/agui/tools.js";

test("toolManifest advertises the agui protocol", () => {
  expect(PROTOCOL_VERSION).toBe("agui/1");
  expect(toolManifest().protocol).toBe("agui/1");
});

test("joinEvents emits RUN_STARTED then STATE_SNAPSHOT from a store", () => {
  const store = { "user-yui": [{ id: "c1", recipientUserID: "user-yui", status: "pending", title: "x", priority: "low", createdAt: "2026-08-08T00:00:00Z" }] };
  const events = joinEvents("user-yui", store, {});
  expect(events[0].type).toBe("RUN_STARTED");
  expect(events[1].type).toBe("STATE_SNAPSHOT");
  expect(events[1].snapshot.cardsById.c1.title).toBe("x");
});

test("applyDecision approves a card in the passed store", () => {
  const store = { "user-yui": [{ id: "c1", recipientUserID: "user-yui", status: "pending", title: "x", priority: "low", createdAt: "2026-08-08T00:00:00Z" }] };
  const out = applyDecision(store, { cardId: "c1", action: "approve", actorUserID: "user-yui" });
  expect(out.card.status).toBe("approved");
  expect(out.removed).toBe(false);
});
```

- [ ] **Step 4: Run the test**

Run: `cd worker && npm test -- agui.test.js`
Expected: PASS (3 tests). Fix any `node:crypto` import per Step 2 if a test errors on `randomUUID`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/agui/ worker/test/agui.test.js
git commit -m "feat(worker): port AG-UI tools/events/adapter verbatim"
```

---

## Task 4: Port AI routing with env threaded through

**Files:**
- Create: `worker/src/routing.js` (copy of `server/agentTools.js`, env-adapted)
- Modify: `worker/src/index.js` (add `/ai/route` and `/agui/tools`)
- Test: `worker/test/routing.test.js`

- [ ] **Step 1: Copy `server/agentTools.js` to `worker/src/routing.js`**

```bash
cp server/agentTools.js worker/src/routing.js
```

- [ ] **Step 2: Remove any module-level env reads from `routing.js`**

Run: `grep -nE "process\\.env" worker/src/routing.js`
For each hit, delete the module-level `const X = process.env...` line. `routeInstruction` already receives its provider config via the `openRouter` parameter, so the Worker (Step 4) supplies it — the copied file must not read `process.env` itself. Replace any `node:crypto` `randomUUID` with `crypto.randomUUID()`. Re-run the grep until it returns nothing.

- [ ] **Step 3: Add a provider-config builder + routes to `worker/src/index.js`**

Add near the top (after imports):

```js
import { routeInstruction } from "./routing.js";
import { toolManifest } from "./agui/tools.js";

function providerConfig(env) {
  if (env.OPENAI_API_KEY) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      providerName: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free",
      appName: "TikTok for Work",
      appUrl: "https://tiktokforwork.dev",
    };
  }
  return undefined; // keyword fallback
}
```

Add inside the `fetch` handler before the 404, after `/health`:

```js
    if (url.pathname === "/agui/tools" && request.method === "GET") {
      return json(toolManifest());
    }
    if (url.pathname === "/ai/route" && request.method === "POST") {
      const body = await request.json();
      const result = await routeInstruction({
        text: body.text,
        sender: body.sender,
        organization: body.organization,
        priorityOverride: body.priorityOverride,
        readerLanguage: body.readerLanguage,
        openRouter: providerConfig(env),
      });
      return json(result);
    }
```

- [ ] **Step 4: Write the test `worker/test/routing.test.js`**

```js
import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

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
```

- [ ] **Step 5: Run the test**

Run: `cd worker && npm test -- routing.test.js`
Expected: PASS (2 tests). No `OPENAI_API_KEY` is set in the test env, so routing takes the fallback path (no network).

- [ ] **Step 6: Commit**

```bash
git add worker/src/routing.js worker/src/index.js worker/test/routing.test.js
git commit -m "feat(worker): AI routing endpoint with OpenAI + keyword fallback"
```

---

## Task 5: GitHub OAuth token swap + session

**Files:**
- Modify: `worker/src/index.js` (add `/oauth/github/config`, `/oauth/github/token`)
- Modify: `worker/src/db.js` (add `createSession`)
- Test: `worker/test/oauth.test.js`

- [ ] **Step 1: Add `createSession` to `worker/src/db.js`**

```js
export async function createSession(db, githubId, accessToken) {
  const token = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at)
       VALUES (?1, ?2, ?3, ?4)`
    )
    .bind(token, githubId, accessToken, new Date().toISOString())
    .run();
  return token;
}
```

- [ ] **Step 2: Add OAuth routes to `worker/src/index.js`**

Add the import at top: `import { createSession } from "./db.js";`

Add inside `fetch`, before the 404:

```js
    if (url.pathname === "/oauth/github/config" && request.method === "GET") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return json({ message: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET as Worker secrets" }, 503);
      }
      return json({
        clientId: env.GITHUB_CLIENT_ID,
        redirectUri: env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback",
        scope: env.GITHUB_OAUTH_SCOPE || "repo",
      });
    }
    if (url.pathname === "/oauth/github/token" && request.method === "POST") {
      const { code } = await request.json();
      const ghRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: env.GITHUB_REDIRECT_URI || "tiktokforwork://oauth/callback",
        }),
      });
      const data = await ghRes.json();
      if (!data.access_token) {
        return json({ message: data.error_description || "token exchange failed" }, 400);
      }
      // Identify the user so the session is bound to a real GitHub id.
      const userRes = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${data.access_token}`, "user-agent": "tiktokforwork" },
      });
      const ghUser = await userRes.json();
      const sessionToken = await createSession(env.DB, String(ghUser.id), data.access_token);
      return json({ accessToken: data.access_token, tokenType: "bearer", sessionToken });
    }
```

- [ ] **Step 3: Write the test `worker/test/oauth.test.js`**

```js
import { SELF, env, applyD1Migrations, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(async () => {
  await env.DB.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/\n/g, " "));
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("/oauth/github/config is 503 without secrets", async () => {
  const res = await SELF.fetch("https://example.com/oauth/github/config");
  // No secrets set in test env → 503.
  expect(res.status).toBe(503);
});

test("/oauth/github/token exchanges a code and mints a session", async () => {
  fetchMock.get("https://github.com").intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(200, { access_token: "gho_test", token_type: "bearer" });
  fetchMock.get("https://api.github.com").intercept({ path: "/user" })
    .reply(200, { id: 42, login: "octocat" });
  const res = await SELF.fetch("https://example.com/oauth/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "abc" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accessToken).toBe("gho_test");
  expect(typeof body.sessionToken).toBe("string");
});
```

Note: the config test asserts 503 because Worker secrets are not present in the test env. When Step-9 deploy sets real secrets, config returns 200 in production.

- [ ] **Step 4: Run the test**

Run: `cd worker && npm test -- oauth.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js worker/src/db.js worker/test/oauth.test.js
git commit -m "feat(worker): GitHub OAuth token swap with D1 session"
```

---

## Task 6: OrgRelay Durable Object (WebSocket relay over D1)

**Files:**
- Create: `worker/src/relay.js`
- Modify: `worker/src/index.js` (replace the OrgRelay stub with an import + WS upgrade routing)
- Test: `worker/test/relay.test.js`

- [ ] **Step 1: Create `worker/src/relay.js`**

```js
import {
  joinEvents, upsertEvents, removeEvents, clearEvents,
  presenceEvents, contextEvents, applyDecision, applyRollback,
} from "./agui/adapter.js";
import { toolCallResult } from "./agui/events.js";
import {
  loadStore, saveCard, removeCard, clearCards, loadContexts, saveContext,
} from "./db.js";

export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") || "core-team";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server); // hibernation API
    server.serializeAttachment({ orgId, userId: null, agui: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(orgId, obj, exclude) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && ws !== exclude) ws.send(text);
    }
  }

  sendTo(orgId, userId, obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && att?.userId === userId) ws.send(text);
    }
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    const orgId = att.orgId || "core-team";
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    if (type === "join") {
      const userId = payload.userId;
      const agui = payload.protocol === "agui/1";
      ws.serializeAttachment({ orgId, userId, agui });
      const store = await loadStore(this.db, orgId);
      const contexts = await loadContexts(this.db, orgId);
      if (agui) {
        for (const ev of joinEvents(userId, store, contexts)) ws.send(JSON.stringify(ev));
      } else {
        ws.send(JSON.stringify({ type: "snapshot", payload: { cardsByUser: store } }));
      }
      this.broadcast(orgId, { type: "presence", payload: { userId, status: "online" } }, ws);
      for (const ev of presenceEvents(userId, "online")) this.broadcast(orgId, ev, ws);
      return;
    }

    if (type === "tool_result") {
      const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content;
      await this.applyAndPublish(orgId, content, payload.toolCallId);
      return;
    }

    if (type === "card_created" || type === "card_updated") {
      const card = payload.card;
      await saveCard(this.db, orgId, card);
      const { forEveryone, forRecipient } = upsertEvents(card, { isNew: type === "card_created" });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
      return;
    }

    if (type === "card_deleted") {
      await removeCard(this.db, orgId, payload.cardId);
      for (const ev of removeEvents(payload.cardId)) this.broadcast(orgId, ev);
      return;
    }

    if (type === "context_updated") {
      const userId = payload.userId || att.userId;
      await saveContext(this.db, orgId, userId, payload.context);
      for (const ev of contextEvents(userId, payload.context, { isNew: true })) this.broadcast(orgId, ev);
      return;
    }

    if (type === "rollback") {
      const store = await loadStore(this.db, orgId);
      const { card, notice } = applyRollback(store, payload.cardId, att.userId);
      await saveCard(this.db, orgId, card);
      this.broadcast(orgId, notice);
      const { forEveryone } = upsertEvents(card, { isNew: false });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      return;
    }

    if (type === "clear_store") {
      await clearCards(this.db, orgId);
      for (const ev of clearEvents()) this.broadcast(orgId, ev);
      return;
    }
  }

  async applyAndPublish(orgId, content, toolCallId) {
    const store = await loadStore(this.db, orgId);
    const out = applyDecision(store, content);
    if (out.removed) {
      await removeCard(this.db, orgId, out.card.id);
      for (const ev of removeEvents(out.card.id)) this.broadcast(orgId, ev);
    } else if (!out.unchanged) {
      await saveCard(this.db, orgId, out.card);
      const { forEveryone } = upsertEvents(out.card, { isNew: false });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
    }
    if (toolCallId) this.broadcast(orgId, toolCallResult(toolCallId, out.card));
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.userId) {
      for (const ev of presenceEvents(att.userId, "offline")) this.broadcast(att.orgId, ev, ws);
    }
  }
}
```

- [ ] **Step 2: Wire the DO into `worker/src/index.js`**

Delete the `OrgRelay` stub class. Add at top: `export { OrgRelay } from "./relay.js";`

Add inside `fetch`, before the 404, to forward WebSocket upgrades:

```js
    if (request.headers.get("Upgrade") === "websocket") {
      const orgId = url.searchParams.get("orgId") || "core-team";
      const id = env.ORG_RELAY.idFromName(orgId);
      const stub = env.ORG_RELAY.get(id);
      return stub.fetch(request);
    }
```

- [ ] **Step 3: Write the test `worker/test/relay.test.js`**

```js
import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";

beforeAll(async () => {
  await env.DB.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/\n/g, " "));
});

function open(orgId = "core-team") {
  return SELF.fetch(`https://example.com/?orgId=${orgId}`, {
    headers: { Upgrade: "websocket" },
  }).then((res) => {
    const ws = res.webSocket;
    ws.accept();
    return ws;
  });
}

test("join then a created card round-trips to a second client", async () => {
  const a = await open();
  const b = await open();
  const bMessages = [];
  b.addEventListener("message", (e) => bMessages.push(JSON.parse(e.data)));

  a.send(JSON.stringify({ type: "join", payload: { userId: "user-toru", protocol: "agui/1" } }));
  b.send(JSON.stringify({ type: "join", payload: { userId: "user-yui", protocol: "agui/1" } }));

  a.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-relay", recipientUserID: "user-yui", senderUserID: "user-toru",
    status: "pending", title: "Approve deploy", priority: "high", createdAt: "2026-08-08T00:00:00Z",
  } } }));

  await new Promise((r) => setTimeout(r, 50));
  const delta = bMessages.find((m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("c-relay"));
  expect(delta).toBeTruthy();
});
```

- [ ] **Step 4: Run the test**

Run: `cd worker && npm test -- relay.test.js`
Expected: PASS. If the DO cannot access `env.DB`, confirm `wrangler.toml` D1 binding name is `DB` and the migration tag lists `OrgRelay` under `new_sqlite_classes`.

- [ ] **Step 5: Run the whole suite**

Run: `cd worker && npm test`
Expected: PASS (all tests from Tasks 1–6).

- [ ] **Step 6: Commit**

```bash
git add worker/src/relay.js worker/src/index.js worker/test/relay.test.js
git commit -m "feat(worker): OrgRelay Durable Object over D1"
```

---

## Task 7: Provision D1 and deploy

**Files:**
- Modify: `worker/wrangler.toml` (real `database_id`)

- [ ] **Step 1: Authenticate wrangler**

Run: `cd worker && npx wrangler login`
Expected: browser opens; "Successfully logged in."
(If the environment is headless, the user runs this themselves via `! npx wrangler login` in the session.)

- [ ] **Step 2: Create the D1 database**

Run: `cd worker && npx wrangler d1 create tiktokforwork`
Expected: prints a `database_id`. Paste it into `wrangler.toml`'s `database_id`, replacing `PLACEHOLDER_SET_IN_TASK_9`.

- [ ] **Step 3: Apply the schema to remote D1**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --file=./schema.sql`
Expected: "Executed N commands."

- [ ] **Step 4: Set secrets**

Run each and paste the value when prompted:
```bash
cd worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```
Expected: "Success! Uploaded secret" for each.

- [ ] **Step 5: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: prints the deployed URL, e.g. `https://tiktokforwork.<subdomain>.workers.dev`.

- [ ] **Step 6: Smoke-test the live Worker**

Run: `curl https://tiktokforwork.<subdomain>.workers.dev/health`
Expected JSON: `{"ok":true,...,"githubOAuth":true,"aiRouting":true,"aiModel":"gpt-4o-mini"}`.

Run: `curl https://tiktokforwork.<subdomain>.workers.dev/agui/tools`
Expected: `{"protocol":"agui/1",...}`.

- [ ] **Step 7: Record the URL and commit**

Add the deployed base URL to `worker/README.md` (create it with the URL and the `wss://.../?orgId=<repo>` join convention), then:

```bash
git add worker/wrangler.toml worker/README.md
git commit -m "chore(worker): provision D1 and record deployed URL"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** Worker fetch (HTTP API), Durable Object relay, D1 schema, OpenAI-with-fallback routing, GitHub OAuth token swap + session, deployment — all present. Auth/org membership *tables* exist (Task 2) but are *populated* in Phase 2 (org from repo collaborators) — intentionally out of this plan.
- **Media/Slack/web client:** excluded per spec scope trim.
- **Type consistency:** the copied `adapter.js`/`agentTools.js` keep their exact signatures; `db.loadStore` returns the legacy `{ [recipientUserID]: card[] }` shape those functions expect. Card field names (`recipientUserID`, `senderUserID`, `id`, `createdAt`, `status`) match the reference across `db.js`, `relay.js`, and tests.
- **Deferred to later phases:** session-token authentication of WS `join` (Phase 2 binds join to a real session), iOS `AppConfig.relayURL` switch (Phase 4), localization (Phase 5).
```

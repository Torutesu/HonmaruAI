# Notion Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Notion database becomes the team's decision ledger — decisions written into it, work assigned in it arriving as cards.

**Architecture:** Notion joins the A1 connector registry, with the contract extended so a connector can require per-user configuration (its database id, stored in a new generic `connector_config` table). Outbound lives in the relay Durable Object, beside the audit log, because that is already the one place that sees every decision — and it is wrapped so a Notion outage costs nothing but the row.

**Tech Stack:** Cloudflare Workers + D1 + Durable Objects, Composio REST, Vitest; SwiftUI.

## Verification model

- **Worker:** `cd /Users/torutano/HonmaruAI/worker && npm test` — **68 tests green today**; each task keeps the suite green.
- **iOS:** no test target — `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` ending in `** BUILD SUCCEEDED **`.

## What already exists (do not rebuild)

- A connector is `{ id, label, authConfigId, toolSlug, buildArgs(), parse(payload) }` in `worker/src/connectors/`; `CONNECTORS` and `connectorById` come from `connectors/index.js`.
- `worker/src/sync.js` has `syncConnector(connector, {env, session, orgId, userId, readerLanguage, provider})` and `syncAll(connectors, context)` with per-connector failure isolation. It calls `connector.buildArgs()` with no arguments today.
- `worker/src/composio.js` has `executeTool(apiKey, slug, userId, args)`, `createConnectLink`, `listConnectedAccounts`.
- The relay logs every decision via `this.log(orgId, {...})` in `worker/src/relay.js` (three call sites; the `card_updated` one at ~line 99 classifies a decision-carrying update as `decided`).
- Notion auth config already created: **`ac_qtoaZ6G__JEd`**.

## The id-namespace trap in this plan

`connector_config` is keyed by the **numeric** GitHub id, matching `sessions.github_id` and `memberships.user_github_id`. But the relay only knows the **login** (`att.userId`), because that is what cards and the WebSocket use. Task 4 therefore resolves login → numeric id through the `users` table before reading config. Comparing the two directly would silently never match.

## File Structure

```
worker/
  schema.sql                    # + connector_config
  src/db.js                     # + getConnectorConfig / setConnectorConfig / getUserByLogin
  src/connectors/notion.js      # NEW inbound connector
  src/connectors/index.js       # + notion
  src/notionWriter.js           # NEW outbound: one decision -> one row
  src/sync.js                   # passes per-user config into buildArgs; skips unconfigured
  src/relay.js                  # writes the row after logging a decision
  src/index.js                  # + /connectors/notion/databases, PUT /connectors/notion/config
  test/notion.test.js           # NEW parse + buildArgs
  test/notion-config.test.js    # NEW databases list + config round-trip
  test/notion-writer.test.js    # NEW row shape + failure isolation
TikTokForWork/
  Features/Settings/ConnectorsView.swift  # database picker after connecting Notion
  Services/ConnectorService.swift         # databases() / setDatabase()
```

---

## Task 1: Pin the Notion contract against the live API

Research with a written deliverable. Nothing below is coded until these are facts.
**Prerequisite:** the Notion connection must be ACTIVE. Check with:

```bash
python3 - <<'PY'
import json, os, urllib.request
key = os.environ["COMPOSIO_API_KEY"]  # export it in your shell; never commit it
req = urllib.request.Request("https://backend.composio.dev/api/v3/connected_accounts", headers={"x-api-key": key})
items = json.load(urllib.request.urlopen(req, timeout=30)).get("items") or []
for it in items:
    tk = it.get("toolkit")
    print((tk.get("slug") if isinstance(tk, dict) else tk), it.get("status"), it.get("user_id"))
PY
```
If Notion is not ACTIVE, STOP and report NEEDS_CONTEXT — the user must finish the
authorization at the link they were given.

**Files:** Modify `worker/README.md`

- [ ] **Step 1: Find the user's databases**

```bash
python3 - <<'PY'
import json, os, urllib.request
key = os.environ["COMPOSIO_API_KEY"]  # export it in your shell; never commit it
def run(slug, args):
    req = urllib.request.Request(
        f"https://backend.composio.dev/api/v3/tools/execute/{slug}",
        data=json.dumps({"user_id": "honmaru-default", "arguments": args}).encode(),
        headers={"x-api-key": key, "content-type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req, timeout=60))
out = run("NOTION_SEARCH_NOTION_PAGE", {"query": "", "filter_value": "database"})
print("successful:", out.get("successful"))
print("top keys:", sorted((out.get("data") or {}).keys()))
print(json.dumps(out.get("data"), ensure_ascii=False)[:900])
PY
```
Record: how a database's **id** and **title** appear. If
`NOTION_SEARCH_NOTION_PAGE` is not the right tool or rejects `filter_value`, run
`composio execute NOTION_SEARCH_NOTION_PAGE --get-schema` and adapt; note what you used.

- [ ] **Step 2: Read one database's schema**

Using an id from Step 1:

```bash
python3 - <<'PY'
import json, os, urllib.request
key = os.environ["COMPOSIO_API_KEY"]  # export it in your shell; never commit it
DB = "<database id from step 1>"
req = urllib.request.Request(
    "https://backend.composio.dev/api/v3/tools/execute/NOTION_FETCH_DATABASE",
    data=json.dumps({"user_id": "honmaru-default", "arguments": {"database_id": DB}}).encode(),
    headers={"x-api-key": key, "content-type": "application/json"}, method="POST")
out = json.load(urllib.request.urlopen(req, timeout=60))
data = out.get("data") or {}
print("successful:", out.get("successful"), "keys:", sorted(data.keys()))
props = data.get("properties") or data.get("schema") or {}
for name, p in list(props.items())[:12]:
    print(f"  {name}: {p.get('type') if isinstance(p, dict) else p}")
PY
```
Record: the property names and types, and **which property is the `title` type** —
that is the only one the writer targets.

- [ ] **Step 3: Learn the row-insert argument shape**

Run: `cd /Users/torutano/HonmaruAI && composio execute NOTION_INSERT_ROW_DATABASE --get-schema 2>&1 | head -60`
Record: how properties are passed (a map? a list of `{name, type, value}`?) and how page content/children are passed.

- [ ] **Step 4: Learn the query-filter shape**

Run: `cd /Users/torutano/HonmaruAI && composio execute NOTION_QUERY_DATABASE_WITH_FILTER --get-schema 2>&1 | head -60`
Record: how a filter is expressed, and what a returned row looks like (where the page id and the title live).

- [ ] **Step 5: Write the findings into `worker/README.md`**

Add a `### Notion (verified <date>)` section under the Composio heading recording:
the search call and how database id/title appear; the fetch-database call and how
to identify the title property; the insert-row argument shape; the query-filter
shape and row shape. **Record shapes and field names only — no page contents.**

- [ ] **Step 6: Commit**

```bash
git add worker/README.md
git commit -m "docs(worker): record the verified Notion contract"
```

---

## Task 2: Per-user connector config

**Files:**
- Modify: `worker/schema.sql`, `worker/src/db.js`, `worker/src/index.js`
- Test: `worker/test/notion-config.test.js`

- [ ] **Step 1: Add the table to `worker/schema.sql`** (append)

```sql
CREATE TABLE IF NOT EXISTS connector_config (
  user_github_id TEXT NOT NULL,
  connector      TEXT NOT NULL,
  config         TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_github_id, connector)
);
```
No `--` comments in schema.sql — the tests collapse newlines before `exec`.

- [ ] **Step 2: Add the helpers to `worker/src/db.js`** (append)

```js
// Per-user connector settings, keyed by the NUMERIC github id like memberships
// and sessions. Connectors that need no configuration never touch this.
export async function getConnectorConfig(db, githubId, connector) {
  const row = await db
    .prepare("SELECT config FROM connector_config WHERE user_github_id = ?1 AND connector = ?2")
    .bind(String(githubId), connector)
    .first();
  if (!row) return null;
  try {
    return JSON.parse(row.config);
  } catch {
    return null;
  }
}

export async function setConnectorConfig(db, githubId, connector, config) {
  await db
    .prepare(
      `INSERT INTO connector_config (user_github_id, connector, config, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_github_id, connector) DO UPDATE SET
         config = excluded.config, updated_at = excluded.updated_at`
    )
    .bind(String(githubId), connector, JSON.stringify(config), new Date().toISOString())
    .run();
}

// The relay knows a person by their github LOGIN; config is keyed by the numeric
// id. This is the bridge — comparing the two directly would never match.
export async function getUserByLogin(db, login) {
  return (
    (await db
      .prepare("SELECT github_id, login FROM users WHERE login = ?1")
      .bind(login)
      .first()) || null
  );
}
```

- [ ] **Step 3: Write the failing test `worker/test/notion-config.test.js`**

```js
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, getConnectorConfig } from "../src/db.js";
import worker from "../src/index.js";

let token;
const ENV = () => ({ ...env, COMPOSIO_API_KEY: "ak-test" });
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), ENV());

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "800", "gho_notion");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("databases are listed for the caller", async () => {
  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("/tools/execute/"), method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; } })
    .reply(200, { successful: true, data: { results: [
      { id: "db-1", title: [{ plain_text: "Decisions" }] }] } });

  const res = await call("/connectors/notion/databases", { headers: { "x-session-token": token } });
  expect(res.status).toBe(200);
  const { databases } = await res.json();
  expect(databases[0]).toMatchObject({ id: "db-1", title: "Decisions" });
  expect(sent.user_id).toBe("800");
});

test("choosing a database is stored against this user", async () => {
  const res = await call("/connectors/notion/config", {
    method: "PUT",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ databaseId: "db-1" }),
  });
  expect(res.status).toBe(200);
  expect(await getConnectorConfig(env.DB, "800", "notion")).toMatchObject({ databaseId: "db-1" });
});

test("both need a session", async () => {
  expect((await call("/connectors/notion/databases", {})).status).toBe(401);
  expect((await call("/connectors/notion/config", { method: "PUT" })).status).toBe(401);
});
```

If Task 1 recorded a different search response shape, change the interceptor's
reply and the parsing to match reality — the README wins over this fixture.

- [ ] **Step 4: Run to verify it fails**

Run: `cd worker && npm test -- notion-config.test.js`
Expected: FAIL — routes 404.

- [ ] **Step 5: Add the routes to `worker/src/index.js`**

Merge `getConnectorConfig, setConnectorConfig` into the existing `./db.js` import. Add beside the other `/connectors/...` routes, **before** the sync route:

```js
    if (url.pathname === "/connectors/notion/databases" && request.method === "GET") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      if (!env.COMPOSIO_API_KEY) return json({ message: "connector not configured" }, 503);
      try {
        const payload = await executeTool(
          env.COMPOSIO_API_KEY, "NOTION_SEARCH_NOTION_PAGE",
          String(session.github_id), { query: "", filter_value: "database" }
        );
        const rows = payload?.data?.results ?? payload?.data?.databases ?? [];
        const databases = rows.map((d) => ({
          id: d.id,
          title: Array.isArray(d.title)
            ? d.title.map((t) => t.plain_text || "").join("").trim() || "Untitled"
            : (d.title || "Untitled"),
        }));
        return json({ databases });
      } catch (err) {
        return json({ message: err.message }, 502);
      }
    }

    if (url.pathname === "/connectors/notion/config" && request.method === "PUT") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const body = await request.json();
      if (!body.databaseId) return json({ message: "databaseId is required" }, 400);
      await setConnectorConfig(env.DB, session.github_id, "notion", { databaseId: body.databaseId });
      return json({ ok: true });
    }
```
`executeTool` must be imported in `index.js` — add it to the `./composio.js` import if it is not already there.

Adjust the tool slug and argument names to whatever Task 1 recorded.

- [ ] **Step 6: Run the suite and commit**

Run: `cd worker && npm test` → PASS. Paste output.

```bash
git add worker/schema.sql worker/src/db.js worker/src/index.js worker/test/notion-config.test.js
git commit -m "feat(worker): per-user connector config and Notion database picker"
```

---

## Task 3: Notion inbound

**Files:**
- Create: `worker/src/connectors/notion.js`, `worker/test/notion.test.js`
- Modify: `worker/src/connectors/index.js`, `worker/src/sync.js`

- [ ] **Step 1: Write the failing test `worker/test/notion.test.js`**

```js
import { expect, test } from "vitest";
import { notion } from "../src/connectors/notion.js";

const row = {
  id: "page-1",
  url: "https://notion.so/page-1",
  last_edited_time: "2026-08-10T01:00:00Z",
  properties: {
    Name: { type: "title", title: [{ plain_text: "Approve the Q3 budget" }] },
    Notes: { type: "rich_text", rich_text: [{ plain_text: "Finance needs a yes by Friday." }] },
  },
};

test("a row becomes the shared connector shape", () => {
  const items = notion.parse({ successful: true, data: { results: [row] } });
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe("page-1");
  expect(items[0].subject).toBe("Approve the Q3 budget");
  expect(items[0].snippet).toContain("Finance needs a yes");
  expect(items[0].date).toBe("2026-08-10T01:00:00Z");
});

test("no rows is a valid result", () => {
  expect(notion.parse({ data: { results: [] } })).toEqual([]);
  expect(notion.parse({})).toEqual([]);
});

test("it needs a database and says so", () => {
  expect(notion.requiresConfig).toBe(true);
  expect(notion.buildArgs({ databaseId: "db-1" }).database_id).toBe("db-1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- notion.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create `worker/src/connectors/notion.js`**

```js
// Rows in the user's chosen Decisions database. Unlike Gmail and Slack this
// connector cannot work until the user has picked a database, so it declares
// that and the sync loop skips it until they have.

function titleOf(properties) {
  const entry = Object.values(properties || {}).find((p) => p?.type === "title");
  return (entry?.title || []).map((t) => t.plain_text || "").join("").trim();
}

function firstText(properties) {
  const entry = Object.values(properties || {}).find((p) => p?.type === "rich_text" && p.rich_text?.length);
  return (entry?.rich_text || []).map((t) => t.plain_text || "").join("").trim();
}

export const notion = {
  id: "notion",
  label: "Notion",
  authConfigId: "ac_qtoaZ6G__JEd",
  toolSlug: "NOTION_QUERY_DATABASE_WITH_FILTER",
  requiresConfig: true,

  buildArgs(config) {
    return { database_id: config?.databaseId, page_size: 10 };
  },

  parse(payload) {
    const wrapped = payload?.results?.[0]?.response?.data?.results;
    const plain = payload?.data?.results ?? payload?.results;
    const rows = (Array.isArray(wrapped) ? wrapped : null) ?? (Array.isArray(plain) ? plain : []) ?? [];
    return rows.map((r) => ({
      id: r.id,
      from: "Notion",
      subject: titleOf(r.properties) || "Untitled",
      snippet: firstText(r.properties),
      date: r.last_edited_time || r.created_time || "",
    }));
  },
};
```
Adjust field names to whatever Task 1 recorded for a query result row.

- [ ] **Step 4: Register it in `worker/src/connectors/index.js`**

```js
import { notion } from "./notion.js";
export const CONNECTORS = [gmail, slack, notion];
```

- [ ] **Step 5: Pass per-user config into `buildArgs` in `worker/src/sync.js`**

Import the reader and use it — a connector that needs config and has none is skipped, not failed:

```js
import { isIngested, markIngested, saveCard, getConnectorConfig } from "./db.js";
```
and inside `syncConnector`, before the `executeTool` call:

```js
  const config = await getConnectorConfig(env.DB, session.github_id, connector.id);
  if (connector.requiresConfig && !config) {
    return { connector: connector.id, scanned: 0, created: 0, skipped: "not configured" };
  }
```
then change the call to `connector.buildArgs(config)`.

- [ ] **Step 6: Run the suite and commit**

Run: `cd worker && npm test` → PASS (existing connectors ignore the new argument). Paste output.

```bash
git add worker/src/connectors/notion.js worker/src/connectors/index.js worker/src/sync.js worker/test/notion.test.js
git commit -m "feat(worker): Notion inbound from the chosen database"
```

---

## Task 4: Outbound — a decision becomes a row

**Files:**
- Create: `worker/src/notionWriter.js`, `worker/test/notion-writer.test.js`
- Modify: `worker/src/relay.js`

- [ ] **Step 1: Write the failing test `worker/test/notion-writer.test.js`**

```js
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { setConnectorConfig, upsertUser } from "../src/db.js";
import { writeDecisionToNotion } from "../src/notionWriter.js";

const card = {
  id: "c1", title: "Approve the deploy", summary: "Ops is waiting.",
  status: "approved", sourceApp: "Slack",
  decision: { action: "approve", actorUserID: "octocat", decidedAt: "2026-08-10T02:00:00Z" },
};

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "800", login: "octocat", name: "octocat", locale: "en" });
  await setConnectorConfig(env.DB, "800", "notion", { databaseId: "db-1" });
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("writes a row whose title is the card title", async () => {
  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; } })
    .reply(200, { successful: true, data: { id: "page-new" } });

  const wrote = await writeDecisionToNotion({ env: { ...env, COMPOSIO_API_KEY: "ak-test" },
                                              login: "octocat", card });
  expect(wrote).toBe(true);
  expect(sent.user_id).toBe("800");
  expect(JSON.stringify(sent.arguments)).toContain("Approve the deploy");
  expect(JSON.stringify(sent.arguments)).toContain("db-1");
});

test("a user who chose no database is a silent no-op", async () => {
  const wrote = await writeDecisionToNotion({ env: { ...env, COMPOSIO_API_KEY: "ak-test" },
                                              login: "nobody", card });
  expect(wrote).toBe(false);
});

test("a Notion outage does not throw", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST" })
    .reply(500, "notion is down");

  await expect(
    writeDecisionToNotion({ env: { ...env, COMPOSIO_API_KEY: "ak-test" }, login: "octocat", card })
  ).resolves.toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- notion-writer.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create `worker/src/notionWriter.js`**

```js
import { executeTool } from "./composio.js";
import { getConnectorConfig, getUserByLogin } from "./db.js";

// A decision becomes one row. Notion databases have arbitrary schemas, so the
// only property this touches is the title — every database has exactly one, and
// guessing at the rest is how integrations break silently. Everything else goes
// in the page body, which renders in any database.
function bodyFor(card) {
  const d = card.decision || {};
  return [
    card.summary,
    d.action ? `Decision: ${d.action}` : null,
    d.actorUserID ? `By: ${d.actorUserID}` : null,
    d.decidedAt ? `When: ${d.decidedAt}` : null,
    card.sourceApp ? `Source: ${card.sourceApp}` : null,
  ].filter(Boolean).join("\n");
}

/// Returns true when a row was written. Never throws: recording a decision
/// elsewhere must not be able to break the decision itself.
export async function writeDecisionToNotion({ env, login, card }) {
  try {
    if (!env.COMPOSIO_API_KEY || !login) return false;
    const user = await getUserByLogin(env.DB, login);
    if (!user) return false;
    const config = await getConnectorConfig(env.DB, user.github_id, "notion");
    if (!config?.databaseId) return false;

    await executeTool(env.COMPOSIO_API_KEY, "NOTION_INSERT_ROW_DATABASE", String(user.github_id), {
      database_id: config.databaseId,
      title: card.title,
      content: bodyFor(card),
    });
    return true;
  } catch (err) {
    console.error("notion write failed", err);
    return false;
  }
}
```
Replace the `arguments` keys with whatever Task 1 recorded for
`NOTION_INSERT_ROW_DATABASE`; the test asserts the title and database id appear
somewhere in the arguments, so it stays honest across shapes.

- [ ] **Step 4: Call it from the relay**

In `worker/src/relay.js`, add the import:

```js
import { writeDecisionToNotion } from "./notionWriter.js";
```
In the `card_created`/`card_updated` branch, immediately after the `await this.log(orgId, {...})` call that classifies a decision, add:

```js
      if (decision?.action) {
        // Fire-and-forget beside the audit log: an outbound destination being
        // down must not stop the decision from landing or broadcasting.
        await writeDecisionToNotion({
          env: this.env,
          login: decision.actorUserID || att.userId,
          card,
        });
      }
```

- [ ] **Step 5: Run the suite and commit**

Run: `cd worker && npm test` → PASS. Paste output.

```bash
git add worker/src/notionWriter.js worker/src/relay.js worker/test/notion-writer.test.js
git commit -m "feat(worker): decisions are written to Notion"
```

---

## Task 5: Migrate and deploy

**Files:** none (operational)

- [ ] **Step 1: Apply the schema to the live database**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --file=./schema.sql`
Expected: executes without error (adds `connector_config`; everything else is `IF NOT EXISTS`). If it fails on a `CREATE INDEX` over a column that does not exist yet, run the `ALTER TABLE`s first — that ordering trap is documented in this repo's audit-log plan.

- [ ] **Step 2: Verify the table exists**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='connector_config'"`
Expected: returns `connector_config`.

- [ ] **Step 3: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID.

- [ ] **Step 4: Smoke the gates**

```bash
BASE=https://tiktokforwork.torubj0904.workers.dev
/usr/bin/curl -s -o /dev/null -w "databases  %{http_code}\n" $BASE/connectors/notion/databases
/usr/bin/curl -s -o /dev/null -w "config     %{http_code}\n" -X PUT -H 'content-type: application/json' -d '{"databaseId":"x"}' $BASE/connectors/notion/config
/usr/bin/curl -s $BASE/health
```
Expected: `401`, `401`, and the usual health JSON. Use `/usr/bin/curl` — Python's
urllib user-agent is refused at the edge with 403, which reads like an auth bug
and is not one.

---

## Task 6: The database picker, and ship

**Files:**
- Modify: `TikTokForWork/Services/ConnectorService.swift`, `TikTokForWork/Features/Settings/ConnectorsView.swift`, `TikTokForWork/Localizable.xcstrings`

- [ ] **Step 1: Add the two calls to `TikTokForWork/Services/ConnectorService.swift`**

```swift
struct NotionDatabase: Identifiable, Decodable, Equatable {
    let id: String
    let title: String
}

extension ConnectorService {
    private struct DatabaseList: Decodable { let databases: [NotionDatabase] }

    static func notionDatabases(backendBaseURL: URL) async throws -> [NotionDatabase] {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/notion/databases", relativeTo: backendBaseURL) else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(DatabaseList.self, from: data).databases
    }

    static func setNotionDatabase(_ id: String, backendBaseURL: URL) async throws {
        guard let token = SessionStore.sessionToken,
              let url = URL(string: "connectors/notion/config", relativeTo: backendBaseURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["databaseId": id])
        _ = try await URLSession.shared.data(for: request)
    }
}
```

- [ ] **Step 2: Show the picker in `TikTokForWork/Features/Settings/ConnectorsView.swift`**

Add state and, when Notion is connected, a disclosure listing databases. Add to the view:

```swift
    @State private var databases: [NotionDatabase] = []
    @State private var chosenDatabase: String?
```

and, in the `row(_:)` builder, below the existing `HStack` for a connector whose
`id == "notion"` and `isConnected`, render the choices:

```swift
            if connector.id == "notion", connector.isConnected {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(String(localized: "Where decisions are recorded"))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                    ForEach(databases) { db in
                        Button {
                            Task { await choose(db) }
                        } label: {
                            HStack {
                                Text(db.title)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Spacer()
                                if chosenDatabase == db.id {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Theme.Colors.interactive)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, Theme.Spacing.sm)
            }
```

and the loader plus chooser:

```swift
    private func choose(_ db: NotionDatabase) async {
        guard let base = appState.backendBaseURL else { return }
        do {
            try await ConnectorService.setNotionDatabase(db.id, backendBaseURL: base)
            chosenDatabase = db.id
        } catch {
            message = String(localized: "Could not save your choice.")
        }
    }
```

In `load()`, after the connectors come back, fetch databases when Notion is connected:

```swift
        if connectors.contains(where: { $0.id == "notion" && $0.isConnected }),
           let base = appState.backendBaseURL {
            databases = (try? await ConnectorService.notionDatabases(backendBaseURL: base)) ?? []
        }
```

(Read the file first and place these consistently with what A1 built — the view already has `connectors`, `message`, `busy`, `load()` and `connect(_:)`.)

- [ ] **Step 3: Japanese strings in `TikTokForWork/Localizable.xcstrings`**

Add `ja` for each new key that lacks one — SEARCH each first, a duplicate breaks the JSON:
`Where decisions are recorded`→`決定の記録先`, `Could not save your choice.`→`選択を保存できませんでした。`
Validate: `python3 -c "import json;json.load(open('TikTokForWork/Localizable.xcstrings'));print('valid json')"` → must print `valid json`.

- [ ] **Step 4: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit and ship**

```bash
git add TikTokForWork/Services/ConnectorService.swift TikTokForWork/Features/Settings/ConnectorsView.swift TikTokForWork/Localizable.xcstrings
git commit -m "feat(ios): choose the Notion database decisions go to"
cd /Users/torutano/HonmaruAI
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```
Expected: a new build number with `processingState: VALID`. If group assignment
reports `no resource of type 'builds'`, that is App Store Connect indexing lag —
the build is uploaded; assign it from the TestFlight UI. Do not re-upload.

- [ ] **Step 6: Device checklist (run by the user)**

1. Settings → Connectors → **Notion** shows Connect; connect it.
2. A list of your databases appears under it; tap the one decisions should go to.
3. Approve a card → within a moment a row appears in that database, titled with the card and the details in the page body.
4. Put an item in that database and refresh the feed → it arrives as a card if it needs a decision, and is ignored if it does not.
5. Approving still works with Notion disconnected — that is the failure isolation doing its job.

---

## Self-Review Notes (addressed)

- **Spec coverage:** one shared database both ways (Tasks 2, 3, 4); in-app picker rather than pasted ids (Tasks 2, 6); generic per-user config table (Task 2); outbound in the relay beside the audit log with a Notion outage costing only the row (Task 4, asserted by test); title property plus page body because schemas are arbitrary (Task 4); GitHub Issues untouched (nothing in this plan modifies it); contract pinned live before coding (Task 1).
- **Namespace trap handled:** the relay has a login, `connector_config` is keyed by numeric id, so `getUserByLogin` bridges them — with the test seeding `upsertUser` so the bridge is actually exercised rather than assumed.
- **Uncertainty is honest:** Task 1 records real shapes and Tasks 2–4 explicitly defer to the README over the snippets here; the writer test asserts the title and database id appear *somewhere* in the arguments so it survives a different argument shape.
- **Type consistency:** `notion.parse` emits the same `{id, from, subject, snippet, date}` as Gmail and Slack; `buildArgs(config)` is the extended contract and Gmail/Slack ignore the argument; `getConnectorConfig(db, githubId, connector)` is the single reader used by both `sync.js` and `notionWriter.js`.
- **Degradation:** connected-but-unconfigured is a skip, not an error, in both directions; a login with no `users` row simply writes nothing.

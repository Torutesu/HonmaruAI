# Backend Audit Log + DB Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the backend an append-only memory — every card mutation leaves an immutable event carrying a snapshot — plus queryable card columns and expiring sessions.

**Architecture:** A new `card_events` table is written from `worker/src/relay.js`, the single choke point every mutation already flows through; logging is best-effort so it can never break a decision. Two session-authenticated, membership-checked read endpoints expose the history. `saveCard` additionally extracts `status`/`priority`/`decided_at`/`updated_at` into columns, and sessions gain a 30-day expiry (legacy NULL-expiry sessions stay valid).

**Tech Stack:** Cloudflare Workers, D1, Durable Objects, Vitest + `@cloudflare/vitest-pool-workers`.

## Verification model

`cd /Users/torutano/HonmaruAI/worker && npm test` — currently **30 tests, all green**. Each task adds tests and must leave the whole suite green.

## Two id namespaces (do not mix)

- `card_events.actor_user_id` and everything on a card (`recipientUserID`, `senderUserID`) and the relay's `userId` are the **GitHub login** (`octocat`).
- `memberships.user_github_id` and `sessions.github_id` are the **numeric GitHub id** (`583231`).

The membership gate compares numeric-to-numeric. Events store logins for display. Never compare one to the other.

## File Structure

```
worker/
  schema.sql          # + card_events table & indexes; + card columns & index
  src/events.js       # NEW: appendCardEvent / listCardEvents / listOrgEvents
  src/db.js           # + isMember; saveCard extracts columns; session expiry
  src/relay.js        # + this.log(...) at all six mutation sites
  src/index.js        # + requireMember gate; + two events endpoints
  test/events.test.js # NEW: event persistence
  test/audit.test.js  # NEW: relay writes the trail (WS round-trip)
  test/events-api.test.js # NEW: read endpoints, 401/403
  test/identity.test.js   # (extend) session expiry
  test/db.test.js         # (extend) card columns
```

---

## Task 1: Event table and persistence helpers

**Files:**
- Modify: `worker/schema.sql`
- Create: `worker/src/events.js`, `worker/test/events.test.js`

- [ ] **Step 1: Add the table to `worker/schema.sql`**

Append:

```sql
CREATE TABLE IF NOT EXISTS card_events (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  card_id        TEXT NOT NULL,
  type           TEXT NOT NULL,
  action         TEXT,
  actor_user_id  TEXT,
  note           TEXT,
  snapshot       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_card ON card_events (org_id, card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_org ON card_events (org_id, created_at);
```

- [ ] **Step 2: Write the failing test `worker/test/events.test.js`**

```js
import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { appendCardEvent, listCardEvents, listOrgEvents } from "../src/events.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("a card's events read back oldest-first with their payload", async () => {
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c1", type: "created", actorUserId: "octocat",
    snapshot: { id: "c1", status: "pending" },
  });
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c1", type: "decided", action: "approve", actorUserId: "hubot",
    note: "lgtm", snapshot: { id: "c1", status: "approved" },
  });

  const events = await listCardEvents(env.DB, "acme/web", "c1");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].action).toBe("approve");
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].note).toBe("lgtm");
  expect(events[1].snapshot.status).toBe("approved");
});

test("org events are newest-first and never leak another org", async () => {
  await appendCardEvent(env.DB, "other/repo", {
    cardId: "x1", type: "created", snapshot: { id: "x1" },
  });
  const mine = await listOrgEvents(env.DB, "acme/web", 50);
  expect(mine.every((e) => e.cardId !== "x1")).toBe(true);
  expect(mine[0].type).toBe("decided");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npm test -- events.test.js`
Expected: FAIL — `../src/events.js` does not exist.

- [ ] **Step 4: Create `worker/src/events.js`**

```js
// Append-only history of what happened to a decision card.
//
// Rows are never updated or deleted: a decision, a rollback, and a deletion are
// all just events, each carrying a snapshot of the card at that moment. That is
// what makes "what did this look like before the rollback?" answerable, and why
// deleting a card does not erase its past.

export async function appendCardEvent(db, orgId, { cardId, type, action, actorUserId, note, snapshot }) {
  await db
    .prepare(
      `INSERT INTO card_events (id, org_id, card_id, type, action, actor_user_id, note, snapshot, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      orgId,
      cardId,
      type,
      action || null,
      actorUserId || null,
      note || null,
      JSON.stringify(snapshot ?? null),
      new Date().toISOString()
    )
    .run();
}

function toEvent(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    type: row.type,
    action: row.action,
    actorUserId: row.actor_user_id,
    note: row.note,
    snapshot: JSON.parse(row.snapshot),
    createdAt: row.created_at,
  };
}

// Ordering ties on created_at are broken by rowid: several events can land in
// the same millisecond, and a scrambled timeline is worse than a slow one.
export async function listCardEvents(db, orgId, cardId) {
  const { results } = await db
    .prepare(
      `SELECT id, card_id, type, action, actor_user_id, note, snapshot, created_at
       FROM card_events WHERE org_id = ?1 AND card_id = ?2
       ORDER BY created_at ASC, rowid ASC`
    )
    .bind(orgId, cardId)
    .all();
  return results.map(toEvent);
}

export async function listOrgEvents(db, orgId, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT id, card_id, type, action, actor_user_id, note, snapshot, created_at
       FROM card_events WHERE org_id = ?1
       ORDER BY created_at DESC, rowid DESC LIMIT ?2`
    )
    .bind(orgId, limit)
    .all();
  return results.map(toEvent);
}
```

- [ ] **Step 5: Run the test, then the full suite**

Run: `cd worker && npm test -- events.test.js` → PASS (2 tests).
Run: `cd worker && npm test` → PASS (30 + 2 = 32). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/schema.sql worker/src/events.js worker/test/events.test.js
git commit -m "feat(worker): append-only card event log"
```

---

## Task 2: The relay writes the trail

**Files:**
- Modify: `worker/src/relay.js`
- Create: `worker/test/audit.test.js`

- [ ] **Step 1: Write the failing test `worker/test/audit.test.js`**

```js
import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { listCardEvents } from "../src/events.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

function open(orgId = "audit-org") {
  return SELF.fetch(`https://example.com/?orgId=${orgId}`, {
    headers: { Upgrade: "websocket" },
  }).then((res) => {
    const ws = res.webSocket;
    ws.accept();
    return ws;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function card(id) {
  return {
    id, recipientUserID: "hubot", senderUserID: "octocat", status: "pending",
    title: "Ship it?", priority: "high", createdAt: "2026-08-09T00:00:00Z",
  };
}

test("a decision leaves created + decided, and the snapshot shows the outcome", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-audit") } }));
  await sleep(60);
  ws.send(JSON.stringify({
    type: "tool_result",
    payload: { content: { cardId: "c-audit", action: "approve", actorUserID: "hubot", note: "ok" } },
  }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-audit");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].action).toBe("approve");
  expect(events[1].snapshot.status).toBe("approved");
});

test("a rollback preserves the decision it undid", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-rb") } }));
  await sleep(60);
  ws.send(JSON.stringify({
    type: "tool_result",
    payload: { content: { cardId: "c-rb", action: "approve", actorUserID: "hubot" } },
  }));
  await sleep(60);
  ws.send(JSON.stringify({ type: "rollback", payload: { cardId: "c-rb" } }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-rb");
  const undone = events.find((e) => e.type === "rolled_back");
  expect(undone).toBeTruthy();
  // The snapshot is the card BEFORE reverting, so the undone decision survives.
  expect(undone.snapshot.decision.action).toBe("approve");
  expect(undone.snapshot.status).toBe("approved");
});

test("deleting a card keeps its history", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-del") } }));
  await sleep(60);
  ws.send(JSON.stringify({ type: "card_deleted", payload: { cardId: "c-del", recipientUserID: "hubot" } }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-del");
  expect(events.map((e) => e.type)).toEqual(["created", "deleted"]);
  const row = await env.DB
    .prepare("SELECT card_id FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind("audit-org", "c-del")
    .first();
  expect(row).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- audit.test.js`
Expected: FAIL — no events are written yet.

- [ ] **Step 3: Add the logging helper to `worker/src/relay.js`**

Extend the `./db.js` import with nothing new, and add an events import beside the existing imports:

```js
import { appendCardEvent } from "./events.js";
```

Add this method to the `OrgRelay` class (next to `broadcast`/`sendTo`):

```js
  /// Recording history must never break the mutation it records.
  async log(orgId, event) {
    try {
      await appendCardEvent(this.db, orgId, event);
    } catch (err) {
      console.error("card event log failed", err);
    }
  }
```

- [ ] **Step 4: Log on create/update**

In the `if (type === "card_created" || type === "card_updated")` branch, right after `await saveCard(this.db, orgId, card);`:

```js
      await this.log(orgId, {
        cardId: card.id,
        type: type === "card_created" ? "created" : "updated",
        actorUserId: type === "card_created" ? (card.senderUserID || att.userId) : att.userId,
        snapshot: card,
      });
```

- [ ] **Step 5: Log on delete — snapshot before removing**

Replace the body of the `if (type === "card_deleted")` branch so the card is read before it disappears:

```js
    if (type === "card_deleted") {
      if (!payload.cardId) return;
      const store = await loadStore(this.db, orgId);
      const doomed = Object.values(store).flat().find((item) => item.id === payload.cardId);
      await removeCard(this.db, orgId, payload.cardId);
      if (doomed) {
        await this.log(orgId, {
          cardId: doomed.id, type: "deleted", actorUserId: att.userId, snapshot: doomed,
        });
      }
      for (const ev of removeEvents(payload.cardId)) this.broadcast(orgId, ev);
      return;
    }
```

(Keep the existing broadcast line exactly as it is in the file; only the load + log are new.)

- [ ] **Step 6: Log on rollback — snapshot BEFORE the revert**

`applyRollback` mutates the card object in place, so the pre-rollback state must be copied first. In the `if (type === "rollback")` branch, between `const store = await loadStore(...)` and `applyRollback(...)`:

```js
      const before = JSON.parse(JSON.stringify(
        Object.values(store).flat().find((item) => item.id === payload.cardId) || null
      ));
```

and after `await saveCard(this.db, orgId, card);`:

```js
      await this.log(orgId, {
        cardId: card.id,
        type: "rolled_back",
        action: before?.decision?.action,
        actorUserId: att.userId,
        snapshot: before || card,
      });
```

- [ ] **Step 7: Log on decisions in `applyAndPublish`**

In the `if (out.removed)` branch, after `await removeCard(this.db, orgId, out.card.id);`:

```js
      await this.log(orgId, {
        cardId: out.card.id, type: "deleted", action: content.action,
        actorUserId: content.actorUserID, note: content.note, snapshot: out.card,
      });
```

In the `else if (!out.unchanged)` branch, after `await saveCard(this.db, orgId, out.card);`:

```js
      await this.log(orgId, {
        cardId: out.card.id, type: "decided", action: content.action,
        actorUserId: content.actorUserID, note: content.note || content.replyText,
        snapshot: out.card,
      });
```

(`content` is the parsed decision already in scope in that method.)

- [ ] **Step 8: Run the audit tests, then the full suite**

Run: `cd worker && npm test -- audit.test.js` → PASS (3 tests).
Run: `cd worker && npm test` → PASS (32 + 3 = 35). Paste output.

- [ ] **Step 9: Commit**

```bash
git add worker/src/relay.js worker/test/audit.test.js
git commit -m "feat(worker): relay records every card mutation"
```

---

## Task 3: History read API with a membership gate

**Files:**
- Modify: `worker/src/db.js`, `worker/src/index.js`
- Create: `worker/test/events-api.test.js`

- [ ] **Step 1: Write the failing test `worker/test/events-api.test.js`**

```js
import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, upsertMembership } from "../src/db.js";
import { appendCardEvent } from "../src/events.js";

let memberToken;
let strangerToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  // 501 is a member of acme/web; 502 is signed in but belongs to no org.
  memberToken = await createSession(env.DB, "501", "gho_member");
  strangerToken = await createSession(env.DB, "502", "gho_stranger");
  await upsertMembership(env.DB, "acme/web", "501", "Engineer");
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c-api", type: "created", actorUserId: "octocat", snapshot: { id: "c-api" },
  });
  await appendCardEvent(env.DB, "acme/web", {
    cardId: "c-api", type: "decided", action: "approve", actorUserId: "hubot",
    snapshot: { id: "c-api", status: "approved" },
  });
});

test("a member reads a card timeline oldest-first", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/cards/c-api/events", {
    headers: { "x-session-token": memberToken },
  });
  expect(res.status).toBe(200);
  const { events } = await res.json();
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
});

test("a member reads the org activity newest-first", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events?limit=10", {
    headers: { "x-session-token": memberToken },
  });
  expect(res.status).toBe(200);
  const { events } = await res.json();
  expect(events[0].type).toBe("decided");
});

test("a signed-in non-member is refused", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events", {
    headers: { "x-session-token": strangerToken },
  });
  expect(res.status).toBe(403);
});

test("no session is refused", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/events");
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- events-api.test.js`
Expected: FAIL — the routes 404.

- [ ] **Step 3: Add `isMember` to `worker/src/db.js`**

Append:

```js
// Membership is checked against the NUMERIC github id (sessions.github_id),
// not the login that cards and events use.
export async function isMember(db, orgId, githubId) {
  const row = await db
    .prepare("SELECT 1 AS ok FROM memberships WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(orgId, String(githubId))
    .first();
  return Boolean(row);
}
```

- [ ] **Step 4: Add the gate and the routes to `worker/src/index.js`**

Merge `isMember` into the existing `./db.js` import line, and add the events import:

```js
import { listCardEvents, listOrgEvents } from "./events.js";
```

Add this helper next to the other top-level functions (e.g. below `providerConfig`):

```js
// Returns an error Response when the caller may not read this org's history, or
// null when they may. History is served straight from D1, so unlike the org
// graph — where GitHub enforces access when we call its API — nothing else would
// stop one org reading another's.
async function requireMember(env, request, orgId) {
  const session = await getSession(env.DB, request.headers.get("x-session-token"));
  if (!session) return json({ message: "invalid session" }, 401);
  if (!(await isMember(env.DB, orgId, session.github_id))) {
    return json({ message: "not a member of this org" }, 403);
  }
  return null;
}
```

Add the routes inside `fetch`, next to the existing `/orgs/:owner/:repo/graph` route:

```js
    const cardEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/cards\/([^/]+)\/events$/);
    if (cardEventsMatch && request.method === "GET") {
      const [, owner, repo, cardId] = cardEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      return json({ events: await listCardEvents(env.DB, orgId, cardId) });
    }
    const orgEventsMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/events$/);
    if (orgEventsMatch && request.method === "GET") {
      const [, owner, repo] = orgEventsMatch;
      const orgId = `${owner}/${repo}`;
      const denied = await requireMember(env, request, orgId);
      if (denied) return denied;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      return json({ events: await listOrgEvents(env.DB, orgId, limit) });
    }
```

- [ ] **Step 5: Run the API tests, then the full suite**

Run: `cd worker && npm test -- events-api.test.js` → PASS (4 tests).
Run: `cd worker && npm test` → PASS (35 + 4 = 39). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/db.js worker/src/index.js worker/test/events-api.test.js
git commit -m "feat(worker): membership-gated history endpoints"
```

---

## Task 4: Queryable card columns

**Files:**
- Modify: `worker/schema.sql`, `worker/src/db.js`, `worker/test/db.test.js`

- [ ] **Step 1: Add the columns and index to `worker/schema.sql`**

In the `CREATE TABLE IF NOT EXISTS cards (...)` block, add four columns after `data TEXT NOT NULL,`:

```sql
  status            TEXT,
  priority          TEXT,
  decided_at        TEXT,
  updated_at        TEXT,
```

and after the existing `idx_cards_recipient` index:

```sql
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (org_id, status);
```

- [ ] **Step 2: Add the failing test to `worker/test/db.test.js`** (append)

```js
test("saveCard extracts status, priority and decision time into columns", async () => {
  await saveCard(env.DB, "acme/web", {
    id: "c-cols", recipientUserID: "hubot", senderUserID: "octocat",
    status: "approved", priority: "high", createdAt: "2026-08-09T00:00:00Z",
    decision: { action: "approve", actorUserID: "hubot", decidedAt: "2026-08-09T01:00:00Z" },
  });
  const row = await env.DB
    .prepare("SELECT status, priority, decided_at, updated_at FROM cards WHERE org_id = ?1 AND card_id = ?2")
    .bind("acme/web", "c-cols")
    .first();
  expect(row.status).toBe("approved");
  expect(row.priority).toBe("high");
  expect(row.decided_at).toBe("2026-08-09T01:00:00Z");
  expect(typeof row.updated_at).toBe("string");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npm test -- db.test.js`
Expected: FAIL — the columns are not written (or do not exist).

- [ ] **Step 4: Extend `saveCard` in `worker/src/db.js`**

Replace the whole `saveCard` function with:

```js
export async function saveCard(db, orgId, card) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO cards (org_id, card_id, recipient_user_id, sender_user_id, created_at, data,
                          status, priority, decided_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(org_id, card_id) DO UPDATE SET
         recipient_user_id = excluded.recipient_user_id,
         sender_user_id = excluded.sender_user_id,
         data = excluded.data,
         status = excluded.status,
         priority = excluded.priority,
         decided_at = excluded.decided_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      orgId,
      card.id,
      card.recipientUserID,
      card.senderUserID || null,
      card.createdAt || now,
      JSON.stringify(card),
      card.status || null,
      card.priority || null,
      card.decision?.decidedAt || null,
      now
    )
    .run();
}
```

The JSON blob stays the source of truth; the columns exist so cards can be filtered in SQL.

- [ ] **Step 5: Run the test, then the full suite**

Run: `cd worker && npm test -- db.test.js` → PASS.
Run: `cd worker && npm test` → PASS (39 + 1 = 40). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/schema.sql worker/src/db.js worker/test/db.test.js
git commit -m "feat(worker): cards are queryable by status and priority"
```

---

## Task 5: Sessions expire

**Files:**
- Modify: `worker/src/db.js`, `worker/test/identity.test.js`

- [ ] **Step 1: Add the failing test to `worker/test/identity.test.js`** (append)

```js
test("expired sessions are rejected, legacy and fresh ones are not", async () => {
  await env.DB
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at)
       VALUES ('tok-expired', '901', 'gho_x', '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z')`
    )
    .run();
  expect(await getSession(env.DB, "tok-expired")).toBeNull();

  // Sessions minted before expiry existed have a NULL expiry and stay valid.
  await env.DB
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at)
       VALUES ('tok-legacy', '902', 'gho_y', '2020-01-01T00:00:00Z')`
    )
    .run();
  expect((await getSession(env.DB, "tok-legacy")).github_id).toBe("902");

  const fresh = await createSession(env.DB, "903", "gho_z");
  expect((await getSession(env.DB, fresh)).github_id).toBe("903");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- identity.test.js`
Expected: FAIL — the expired token is still returned.

- [ ] **Step 3: Give new sessions an expiry in `worker/src/db.js`**

Replace `createSession` with:

```js
const SESSION_DAYS = 30;

export async function createSession(db, githubId, accessToken) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(token, githubId, accessToken, now.toISOString(), expires.toISOString())
    .run();
  return token;
}
```

- [ ] **Step 4: Enforce it in `getSession`**

Replace `getSession` with:

```js
export async function getSession(db, token) {
  if (!token) return null;
  const row = await db
    .prepare(
      "SELECT token, github_id, github_access_token, expires_at FROM sessions WHERE token = ?1"
    )
    .bind(token)
    .first();
  if (!row) return null;
  // A NULL expiry is a session minted before expiry existed — still valid, so
  // shipping this does not sign out the people currently testing.
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;
  return row;
}
```

- [ ] **Step 5: Run the test, then the full suite**

Run: `cd worker && npm test -- identity.test.js` → PASS.
Run: `cd worker && npm test` → PASS (40 + 1 = 41). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/db.js worker/test/identity.test.js
git commit -m "feat(worker): sessions expire after 30 days"
```

---

## Task 6: Migrate the live database and deploy

**Files:** none (operational)

- [ ] **Step 1: Add the card columns to the live table FIRST**

Order matters: `schema.sql` ends with `CREATE INDEX … ON cards (org_id, status)`, and
that index cannot be created before the column exists. Running the schema first
fails with `no such column: status` and rolls the whole file back (verified).
`CREATE TABLE IF NOT EXISTS` will NOT add columns to the existing `cards` table,
so add them explicitly first:

```bash
cd worker
npx wrangler d1 execute tiktokforwork --remote --command "ALTER TABLE cards ADD COLUMN status TEXT"
npx wrangler d1 execute tiktokforwork --remote --command "ALTER TABLE cards ADD COLUMN priority TEXT"
npx wrangler d1 execute tiktokforwork --remote --command "ALTER TABLE cards ADD COLUMN decided_at TEXT"
npx wrangler d1 execute tiktokforwork --remote --command "ALTER TABLE cards ADD COLUMN updated_at TEXT"
npx wrangler d1 execute tiktokforwork --remote --command "CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (org_id, status)"
```
Expected: each succeeds. If one reports `duplicate column name`, that column already exists — that is fine, continue with the rest.

- [ ] **Step 2: Now create the new table and indexes**

With the columns in place, the schema file applies cleanly and adds `card_events`
plus every `IF NOT EXISTS` index without touching existing tables:

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --file=./schema.sql`
Expected: "Executed N queries" with no error.

- [ ] **Step 3: Verify the live schema**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
Expected: the list includes `card_events`.

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --command "PRAGMA table_info(cards)"`
Expected: includes `status`, `priority`, `decided_at`, `updated_at`.

- [ ] **Step 4: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID.

- [ ] **Step 5: Smoke-test the gate**

Wait ~10s for propagation, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tiktokforwork.torubj0904.workers.dev/orgs/acme/web/events
curl -s -o /dev/null -w "%{http_code}\n" -H "x-session-token: bogus" https://tiktokforwork.torubj0904.workers.dev/orgs/acme/web/events
curl -s https://tiktokforwork.torubj0904.workers.dev/health
```
Expected: `401`, `401`, and the usual health JSON. (A 403 needs a real session, which comes from GitHub OAuth on a device — the unit tests cover that path.)

- [ ] **Step 6: Commit any drift**

```bash
git add -A && git commit -m "chore(worker): migrate live D1 for the audit log" || echo "nothing to commit"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** `card_events` table + snapshot rationale (Task 1); all six mutation sites logged, with the rollback's pre-revert snapshot and the delete's pre-removal read (Task 2); both read endpoints with 401/403 membership gating (Task 3); `status`/`priority`/`decided_at`/`updated_at` + index (Task 4); 30-day expiry with NULL-legacy sessions still valid (Task 5); live migration + deploy (Task 6).
- **Ordering hazards handled:** `applyRollback` mutates in place → the snapshot is deep-copied first; `card_deleted` previously never loaded the card → it now reads the store before removing; `created_at` ties broken by `rowid` so timelines cannot scramble.
- **Logging cannot break decisions:** `this.log` swallows and logs failures.
- **Type consistency:** `appendCardEvent(db, orgId, {cardId, type, action, actorUserId, note, snapshot})` is the single write shape used at all six sites; `listCardEvents`/`listOrgEvents` return the camelCase event shape the endpoints emit as `{ events: [...] }`.
- **Namespaces:** `isMember` binds `String(githubId)` against `memberships.user_github_id` (numeric); events store logins. Called out at the top of the plan.
- **Out of scope (unchanged):** no iOS work, no history UI — that is sub-project C.

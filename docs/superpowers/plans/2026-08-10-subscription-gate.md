# Subscriptions and the AI Usage Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meter the thing that costs money — AI routing — so a free tier is real, and sell `honmaruai Pro` through RevenueCat to lift the limit.

**Architecture:** One `gate` module on the Worker decides, per request, whether an AI call is unmetered (own API key, or Pro), metered, or over the limit; over-limit degrades to the keyword router that already exists rather than refusing. Entitlement comes from RevenueCat's REST API cached in D1 for an hour. iOS reuses the RevenueCat integration from an earlier branch, adapted to the current `AppState`.

**Tech Stack:** Cloudflare Workers + D1, RevenueCat REST + purchases-ios-spm, Vitest; SwiftUI.

## Verification model

- **Worker:** `cd /Users/torutano/HonmaruAI/worker && npm test` — **68 tests green today**; every task keeps the suite green.
- **iOS:** no test target — `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` ending in `** BUILD SUCCEEDED **`.

## The rule that makes this shippable before billing exists

**If `REVENUECAT_SECRET_KEY` is not set, the gate is off entirely — everything is
unmetered.** The user is setting up RevenueCat later, and shipping a free limit
with no way to upgrade would be worse than shipping no limit at all. Setting the
secret is what turns both billing and metering on, together.

## Reuse from `origin/claude/honmaruai-revenuecat-sdk-1hdfr4`

That branch predates the Phase 1–6 rebuild. Take the self-contained files, leave
the rest:

| take | leave |
|---|---|
| `TikTokForWork/App/RevenueCatConfig.swift` | its `AppState.swift` edits |
| `TikTokForWork/Services/SubscriptionService.swift` | its `FeedView.swift` edits |
| `TikTokForWork/Features/Subscription/ProPaywallSheet.swift` | its `RootView.swift` edits |
| `TikTokForWork/Features/Subscription/SubscriptionView.swift` | its `OrgGraphView.swift` edits |
| `docs/revenuecat.md` | `TikTokForWork/Services/RoutingQuota.swift` — the meter moves server-side |
| the `project.yml` SPM package block | |

Known constants on that branch: entitlement `honmaruai Pro`, offering `default`,
products `monthly` / `yearly`, `freeDailyRoutes = 3`, and a `test_…` public SDK key.

## File Structure

```
worker/
  schema.sql          # + ai_usage, entitlements
  src/db.js           # + usage counters and entitlement cache helpers
  src/entitlements.js # NEW: ask RevenueCat, cache for an hour
  src/gate.js         # NEW: the one decision — unmetered / metered / over limit
  src/index.js        # /ai/route reads x-session-token and applies the gate
  src/sync.js         # connector triage is metered too
  test/gate.test.js       # NEW
  test/entitlements.test.js # NEW
  test/ai-gate.test.js    # NEW end-to-end through /ai/route
TikTokForWork/
  App/RevenueCatConfig.swift          # ported
  Services/SubscriptionService.swift  # ported + adapted
  Features/Subscription/*.swift       # ported
  Features/Shell/YouView.swift        # Plan row replaces the dimmed one
  ViewModels/FeedViewModel.swift      # surfaces quotaExceeded once
  project.yml                         # + RevenueCat SPM package
```

---

## Task 1: Usage counter and entitlement cache

**Files:**
- Modify: `worker/schema.sql`, `worker/src/db.js`
- Test: `worker/test/gate.test.js` (created here, extended in Task 3)

- [ ] **Step 1: Add the tables to `worker/schema.sql`** (append)

```sql
CREATE TABLE IF NOT EXISTS ai_usage (
  user_github_id TEXT NOT NULL,
  day            TEXT NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_github_id, day)
);

CREATE TABLE IF NOT EXISTS entitlements (
  user_github_id TEXT PRIMARY KEY,
  is_pro         INTEGER NOT NULL,
  checked_at     TEXT NOT NULL
);
```
No `--` comments in schema.sql — the tests collapse newlines before `exec`.

- [ ] **Step 2: Write the failing test `worker/test/gate.test.js`**

```js
import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { countAIUse, usedToday, readEntitlement, writeEntitlement } from "../src/db.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("usage counts per user per day", async () => {
  expect(await usedToday(env.DB, "1", "2026-08-10")).toBe(0);
  await countAIUse(env.DB, "1", "2026-08-10");
  await countAIUse(env.DB, "1", "2026-08-10");
  expect(await usedToday(env.DB, "1", "2026-08-10")).toBe(2);
  // A different day starts over, and a different user is unaffected.
  expect(await usedToday(env.DB, "1", "2026-08-11")).toBe(0);
  expect(await usedToday(env.DB, "2", "2026-08-10")).toBe(0);
});

test("the entitlement cache round-trips with its timestamp", async () => {
  expect(await readEntitlement(env.DB, "9")).toBeNull();
  await writeEntitlement(env.DB, "9", true);
  const row = await readEntitlement(env.DB, "9");
  expect(row.is_pro).toBe(1);
  expect(typeof row.checked_at).toBe("string");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npm test -- gate.test.js`
Expected: FAIL — the helpers are not exported.

- [ ] **Step 4: Add the helpers to `worker/src/db.js`** (append)

```js
// The AI meter lives here rather than on the device: the model call happens on
// the Worker and we pay for it, so a counter the user can reset by deleting the
// app is not a limit on our bill.
export async function usedToday(db, githubId, day) {
  const row = await db
    .prepare("SELECT used FROM ai_usage WHERE user_github_id = ?1 AND day = ?2")
    .bind(String(githubId), day)
    .first();
  return row ? Number(row.used) : 0;
}

export async function countAIUse(db, githubId, day) {
  await db
    .prepare(
      `INSERT INTO ai_usage (user_github_id, day, used) VALUES (?1, ?2, 1)
       ON CONFLICT(user_github_id, day) DO UPDATE SET used = used + 1`
    )
    .bind(String(githubId), day)
    .run();
}

export async function readEntitlement(db, githubId) {
  return (
    (await db
      .prepare("SELECT user_github_id, is_pro, checked_at FROM entitlements WHERE user_github_id = ?1")
      .bind(String(githubId))
      .first()) || null
  );
}

export async function writeEntitlement(db, githubId, isPro) {
  await db
    .prepare(
      `INSERT INTO entitlements (user_github_id, is_pro, checked_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_github_id) DO UPDATE SET is_pro = excluded.is_pro, checked_at = excluded.checked_at`
    )
    .bind(String(githubId), isPro ? 1 : 0, new Date().toISOString())
    .run();
}
```

- [ ] **Step 5: Run the suite and commit**

Run: `cd worker && npm test` → PASS. Paste output.

```bash
git add worker/schema.sql worker/src/db.js worker/test/gate.test.js
git commit -m "feat(worker): AI usage meter and entitlement cache"
```

---

## Task 2: Ask RevenueCat, cache for an hour

**Files:**
- Create: `worker/src/entitlements.js`, `worker/test/entitlements.test.js`

- [ ] **Step 1: Write the failing test `worker/test/entitlements.test.js`**

```js
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { writeEntitlement } from "../src/db.js";
import { isPro } from "../src/entitlements.js";

const ENV = () => ({ ...env, REVENUECAT_SECRET_KEY: "sk-rc" });

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function subscriber(active) {
  return {
    subscriber: {
      entitlements: active
        ? { "honmaruai Pro": { expires_date: "2099-01-01T00:00:00Z" } }
        : {},
    },
  };
}

test("an active entitlement is read from RevenueCat and cached", async () => {
  let seenPath;
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => { seenPath = p; return true; } })
    .reply(200, subscriber(true));

  expect(await isPro(ENV(), "500")).toBe(true);
  expect(seenPath).toContain("/v1/subscribers/500");

  // Second call inside the hour must not hit the network — an unmatched
  // interceptor would make assertNoPendingInterceptors fail if it did.
  expect(await isPro(ENV(), "500")).toBe(true);
});

test("a stale cache is refreshed", async () => {
  await env.DB
    .prepare("INSERT INTO entitlements (user_github_id, is_pro, checked_at) VALUES ('501', 0, '2020-01-01T00:00:00Z')")
    .run();
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/501") })
    .reply(200, subscriber(true));

  expect(await isPro(ENV(), "501")).toBe(true);
});

test("RevenueCat being down means free, never blocked", async () => {
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/502") })
    .reply(500, "revenuecat is down");

  expect(await isPro(ENV(), "502")).toBe(false);
});

test("no secret configured means we never ask", async () => {
  // No interceptor registered: a network call here would throw.
  expect(await isPro({ ...env }, "503")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- entitlements.test.js`
Expected: FAIL — `../src/entitlements.js` does not exist.

- [ ] **Step 3: Create `worker/src/entitlements.js`**

```js
import { readEntitlement, writeEntitlement } from "./db.js";

const PRO_ENTITLEMENT = "honmaruai Pro";
const CACHE_MS = 60 * 60 * 1000;

// Asked on demand and cached for an hour. Webhooks would be more immediate but
// need an endpoint to secure and can be missed; one call per user per hour is
// cheaper than either failure mode.
export async function isPro(env, githubId) {
  if (!env.REVENUECAT_SECRET_KEY) return false;

  const cached = await readEntitlement(env.DB, githubId);
  if (cached && Date.now() - Date.parse(cached.checked_at) < CACHE_MS) {
    return cached.is_pro === 1;
  }

  let active = false;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(githubId))}`,
      { headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` } }
    );
    if (res.ok) {
      const body = await res.json();
      const entitlement = body?.subscriber?.entitlements?.[PRO_ENTITLEMENT];
      active = Boolean(entitlement) &&
        (!entitlement.expires_date || Date.parse(entitlement.expires_date) > Date.now());
    }
  } catch {
    // Fall through: a billing outage must never block the product.
    active = false;
  }

  await writeEntitlement(env.DB, githubId, active);
  return active;
}
```

- [ ] **Step 4: Run the suite and commit**

Run: `cd worker && npm test` → PASS. Paste output.

```bash
git add worker/src/entitlements.js worker/test/entitlements.test.js
git commit -m "feat(worker): entitlement lookup with an hour of cache"
```

---

## Task 3: The gate

**Files:**
- Create: `worker/src/gate.js`
- Modify: `worker/test/gate.test.js`

- [ ] **Step 1: Add the failing tests to `worker/test/gate.test.js`** (append)

```js
import { fetchMock } from "cloudflare:test";
import { beforeEach, afterEach } from "vitest";
import { checkAIAllowance, FREE_DAILY_ROUTES } from "../src/gate.js";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a caller-supplied key is never metered", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: "600", userKey: "sk-user" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});

test("with no billing configured nothing is metered", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: "601" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});

test("a free user is allowed up to the limit and degraded after it", async () => {
  const e = { ...env, REVENUECAT_SECRET_KEY: "sk-rc" };
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/602") })
    .reply(200, { subscriber: { entitlements: {} } })
    .persist();

  for (let i = 0; i < FREE_DAILY_ROUTES; i += 1) {
    const ok = await checkAIAllowance(e, { githubId: "602" });
    expect(ok).toMatchObject({ allowed: true, metered: true });
    await ok.consume();
  }
  const over = await checkAIAllowance(e, { githubId: "602" });
  expect(over).toMatchObject({ allowed: false, quotaExceeded: true });
});

test("a Pro subscriber is never metered", async () => {
  const e = { ...env, REVENUECAT_SECRET_KEY: "sk-rc" };
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/603") })
    .reply(200, { subscriber: { entitlements: { "honmaruai Pro": { expires_date: "2099-01-01T00:00:00Z" } } } });

  const decision = await checkAIAllowance(e, { githubId: "603" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- gate.test.js`
Expected: FAIL — `../src/gate.js` does not exist.

- [ ] **Step 3: Create `worker/src/gate.js`**

```js
import { isPro } from "./entitlements.js";
import { usedToday, countAIUse } from "./db.js";

export const FREE_DAILY_ROUTES = 3;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/// The one place that decides whether an AI call may happen on our key.
///
/// Returns `{ allowed, metered, quotaExceeded, consume() }`. `consume()` is
/// called only after a model call actually happened, so a failed call does not
/// burn someone's allowance.
export async function checkAIAllowance(env, { githubId, userKey }) {
  const free = { allowed: true, metered: false, quotaExceeded: false, consume: async () => {} };

  // Their key, their bill.
  if (userKey) return free;
  // Billing is not configured, so metering would only punish people with no way
  // to upgrade.
  if (!env.REVENUECAT_SECRET_KEY) return free;
  // Anonymous callers cannot be metered; they also should not spend our budget.
  if (!githubId) return { allowed: false, metered: false, quotaExceeded: true, consume: async () => {} };

  if (await isPro(env, githubId)) return free;

  const day = today();
  const used = await usedToday(env.DB, githubId, day);
  if (used >= FREE_DAILY_ROUTES) {
    return { allowed: false, metered: true, quotaExceeded: true, consume: async () => {} };
  }
  return {
    allowed: true,
    metered: true,
    quotaExceeded: false,
    consume: async () => countAIUse(env.DB, githubId, day),
  };
}
```

- [ ] **Step 4: Run the suite and commit**

Run: `cd worker && npm test` → PASS. Paste output.

```bash
git add worker/src/gate.js worker/test/gate.test.js
git commit -m "feat(worker): one decision for whether an AI call may happen"
```

---

## Task 4: Apply the gate to routing and triage

**Files:**
- Modify: `worker/src/index.js`, `worker/src/sync.js`
- Test: `worker/test/ai-gate.test.js`

- [ ] **Step 1: Write the failing test `worker/test/ai-gate.test.js`**

```js
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, countAIUse } from "../src/db.js";
import { FREE_DAILY_ROUTES } from "../src/gate.js";
import worker from "../src/index.js";

let token;
const ENV = () => ({ ...env, REVENUECAT_SECRET_KEY: "sk-rc", OPENAI_API_KEY: "sk-server" });
const ORG = { nodes: [
  { id: "octocat", kind: "person", label: "octocat · Admin" },
  { id: "hubot", kind: "person", label: "hubot · Engineer" }], edges: [] };

const route = (headers) => worker.fetch(new Request("https://example.com/ai/route", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ text: "Ask hubot to review the deploy",
                         sender: { id: "octocat", name: "octocat" }, organization: ORG }),
}), ENV());

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "700", "gho_gate");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function freeSubscriber() {
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/700") })
    .reply(200, { subscriber: { entitlements: {} } }).persist();
}

test("a free user over the limit is degraded, not refused", async () => {
  freeSubscriber();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FREE_DAILY_ROUTES; i += 1) await countAIUse(env.DB, "700", day);

  // No OpenAI interceptor: reaching the model here would fail the test.
  const res = await route({ "x-session-token": token });
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.quotaExceeded).toBe(true);
  expect(card.routedBy).toBe("fallback");
  expect(card.recipientUserID).toBe("hubot");
});

test("a caller-supplied key skips the meter entirely", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
      name: "create_decision_card",
      arguments: JSON.stringify({ recipientUserID: "hubot", cardType: "task",
        title: "Review the deploy", summary: "x", context: "scope: deploy",
        priority: "medium", routingReason: "y" }) } }] } }] });

  const res = await route({ "x-session-token": token, "x-ai-key": "sk-user" });
  const card = await res.json();
  expect(card.routedBy).toBe("OpenAI");
  expect(card.quotaExceeded).toBeFalsy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- ai-gate.test.js`
Expected: FAIL — nothing gates the route yet.

- [ ] **Step 3: Apply the gate in `worker/src/index.js`**

Add the import:

```js
import { checkAIAllowance } from "./gate.js";
```

In the `/ai/route` handler, replace the `providerConfig(env, userKey)` line and the call with a gated version:

```js
      const userKey = request.headers.get("x-ai-key") || undefined;
      // The route is usable without a session (guests), but only a session can
      // be metered — and an unmetered guest must not spend our AI budget.
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      const allowance = await checkAIAllowance(env, {
        githubId: session ? String(session.github_id) : null,
        userKey,
      });

      const result = await routeInstruction({
        text: body.text,
        sender: body.sender,
        organization: body.organization,
        priorityOverride: body.priorityOverride,
        readerLanguage: body.readerLanguage,
        senderContext: body.senderContext,
        // No provider means the local keyword router — the graceful degradation.
        openRouter: allowance.allowed ? providerConfig(env, userKey) : undefined,
      });
      if (allowance.allowed && allowance.metered) await allowance.consume();

      return json(allowance.quotaExceeded ? { ...result, quotaExceeded: true } : result);
```

- [ ] **Step 4: Meter the connector triage in `worker/src/sync.js`**

The triage is the same model call and the same cost. Add the import:

```js
import { checkAIAllowance } from "./gate.js";
```
and in `syncConnector`, replace the `provider ? await triageMessage(...) : null` expression with a gated one:

```js
    const allowance = await checkAIAllowance(env, { githubId: String(session.github_id) });
    const triaged = provider && allowance.allowed
      ? await triageMessage(message, { provider, readerLanguage, sourceLabel: connector.label })
      : null;
    if (triaged && allowance.metered) await allowance.consume();
```
(The allowance is checked per message, so a sync stops creating cards the moment the day's allowance runs out rather than blowing through it.)

- [ ] **Step 5: Run the suite and commit**

Run: `cd worker && npm test` → PASS. Paste output.

```bash
git add worker/src/index.js worker/src/sync.js worker/test/ai-gate.test.js
git commit -m "feat(worker): meter AI routing and triage against the free tier"
```

---

## Task 5: Migrate and deploy

**Files:** none (operational)

- [ ] **Step 1: Apply the schema to the live database**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --file=./schema.sql`
Expected: executes without error (adds `ai_usage` and `entitlements`).

- [ ] **Step 2: Verify both tables**

Run: `cd worker && npx wrangler d1 execute tiktokforwork --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_usage','entitlements')"`
Expected: both names come back.

- [ ] **Step 3: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID.

- [ ] **Step 4: Confirm nothing is metered yet**

`REVENUECAT_SECRET_KEY` is deliberately not set, so the gate is off:

```bash
/usr/bin/curl -s -X POST https://tiktokforwork.torubj0904.workers.dev/ai/route \
  -H 'content-type: application/json' \
  -d '{"text":"Ask hubot to review the deploy","sender":{"id":"octocat","name":"octocat"},"organization":{"nodes":[{"id":"octocat","kind":"person","label":"octocat · Admin"},{"id":"hubot","kind":"person","label":"hubot · Engineer"}],"edges":[]}}'
```
Expected: a normal routed card with `"routedBy":"OpenAI"` and **no** `quotaExceeded`. Use `/usr/bin/curl` — Python's urllib user-agent is refused at the edge with 403.

---

## Task 6: iOS — port the RevenueCat integration

**Files:**
- Create (ported): `TikTokForWork/App/RevenueCatConfig.swift`, `TikTokForWork/Services/SubscriptionService.swift`, `TikTokForWork/Features/Subscription/ProPaywallSheet.swift`, `TikTokForWork/Features/Subscription/SubscriptionView.swift`, `docs/revenuecat.md`
- Modify: `project.yml`, `TikTokForWork/App/AppState.swift`

- [ ] **Step 1: Bring the files across**

```bash
cd /Users/torutano/HonmaruAI
git checkout origin/claude/honmaruai-revenuecat-sdk-1hdfr4 -- \
  TikTokForWork/App/RevenueCatConfig.swift \
  TikTokForWork/Services/SubscriptionService.swift \
  TikTokForWork/Features/Subscription/ProPaywallSheet.swift \
  TikTokForWork/Features/Subscription/SubscriptionView.swift \
  docs/revenuecat.md
```
Do **not** take `TikTokForWork/Services/RoutingQuota.swift` — the meter is now
server-side and a second client-side one would disagree with it.

- [ ] **Step 2: Add the SPM package to `project.yml`**

Read the same block on that branch and copy it:

```bash
git show origin/claude/honmaruai-revenuecat-sdk-1hdfr4:project.yml | grep -n -A 12 "packages:"
```
Add the `packages:` entry for `https://github.com/RevenueCat/purchases-ios-spm.git` (up to next major from `5.30.0`) and the two target dependencies (`RevenueCat`, `RevenueCatUI`) exactly as they appear there.

- [ ] **Step 3: Identify the RevenueCat user with the GitHub id**

The Worker asks RevenueCat about the **numeric GitHub id**, so the app must log
in to RevenueCat as that same id or the two will never agree. In
`TikTokForWork/App/AppState.swift`, inside `activateGitHubSession(connection:)`
after `currentUser = user`, add:

```swift
        // RevenueCat's app_user_id must match what the Worker asks about.
        if let githubId = SessionStore.githubUserId {
            await SubscriptionService.shared.identify(githubId)
        }
```

`SessionStore` does not store the numeric id yet. Add it alongside the other
keychain accessors in `TikTokForWork/Services/SessionStore.swift`:

```swift
    static var githubUserId: String? {
        get { read(Key.githubUserId) }
        set { write(newValue, key: Key.githubUserId) }
    }
```
with `static let githubUserId = "githubUserId"` in the `Key` enum, and write it
in `GitHubService.exchangeCode(_:backendBaseURL:)` next to where `sessionToken`
is captured:

```swift
        if let ghId = ghUser["id"] { SessionStore.githubUserId = String(describing: ghId) }
```
(Read that method first — `ghUser` is the parsed `/user` response already in scope.)

Adapt `SubscriptionService` so it exposes `shared`, an `identify(_:)` that calls
`Purchases.shared.logIn(_:)`, and an `isPro` published property. Read the ported
file and reshape it to the current app's conventions rather than rewriting it.

- [ ] **Step 4: Build**

Run the iOS build command.
Expected: `** BUILD SUCCEEDED **`. The first build resolves the SPM package and
will be slow. If `RevenueCatUI` fails to resolve, check the `project.yml` block
matches the branch's exactly.

- [ ] **Step 5: Commit**

```bash
git add project.yml TikTokForWork/App/RevenueCatConfig.swift TikTokForWork/Services/SubscriptionService.swift TikTokForWork/Features/Subscription TikTokForWork/App/AppState.swift TikTokForWork/Services/SessionStore.swift TikTokForWork/Services/GitHubService.swift docs/revenuecat.md
git commit -m "feat(ios): RevenueCat subscriptions, identified by GitHub id"
```

---

## Task 7: The Plan row and the quota message

**Files:**
- Modify: `TikTokForWork/Features/Shell/YouView.swift`, `TikTokForWork/ViewModels/FeedViewModel.swift`, `TikTokForWork/Services/AIService.swift`, `TikTokForWork/Localizable.xcstrings`

- [ ] **Step 1: Replace the dimmed Plan row in `YouView`**

It currently reads `pendingRow(String(localized: "Plan"))`. Replace it with a
row that pushes the ported subscription screen:

```swift
                    navRow(String(localized: "Plan")) { SubscriptionView() }
```

- [ ] **Step 2: Surface `quotaExceeded` in `AIService`**

`RouteInstructionResponse` decodes the routing reply. Add the flag:

```swift
    let quotaExceeded: Bool?
```
and carry it on the returned `InstructionRouting` (read the struct and add a
`quotaExceeded: Bool` with a default of `false`, set from the response).

- [ ] **Step 3: Say it once in `FeedViewModel`**

Add a published flag and set it when a draft comes back over quota:

```swift
    @Published var quotaExceeded = false
```
In `draftInstruction(...)`, after the routing call returns, add:

```swift
        if routing.quotaExceeded { quotaExceeded = true }
```
(Match the actual local variable name in that method.) The feed shows this once
as a quiet line offering the paywall — it must not become a repeating alert.

- [ ] **Step 4: Japanese strings**

Add to `TikTokForWork/Localizable.xcstrings` any new key that lacks a `ja` entry —
SEARCH each first, a duplicate breaks the JSON:
`You've used today's AI routing.`→`今日の AI ルーティングを使い切りました。`, `Upgrade`→`アップグレード`
(`Plan` already exists — verify before adding.)
Validate: `python3 -c "import json;json.load(open('TikTokForWork/Localizable.xcstrings'));print('valid json')"` → must print `valid json`.

- [ ] **Step 5: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit and ship**

```bash
git add TikTokForWork/Features/Shell/YouView.swift TikTokForWork/ViewModels/FeedViewModel.swift TikTokForWork/Services/AIService.swift TikTokForWork/Localizable.xcstrings
git commit -m "feat(ios): plan screen and the quota message"
cd /Users/torutano/HonmaruAI
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```
Expected: a new build number with `processingState: VALID`. If group assignment
reports `no resource of type 'builds'`, that is App Store Connect indexing lag —
the build is uploaded; assign it from the TestFlight UI. Do not re-upload.

---

## Turning it on (the user does this when RevenueCat is ready)

1. Create the `monthly` and `yearly` subscriptions in App Store Connect and link
   them in RevenueCat to the `honmaruai Pro` entitlement.
2. Put the **public** SDK key in `RevenueCatConfig.apiKey` (it is meant to ship in
   the app) and ship a build.
3. `cd worker && npx wrangler secret put REVENUECAT_SECRET_KEY` — **this is the
   switch**. Until it is set, nothing is metered.
4. Verify: a free account's fourth routing of the day comes back with
   `quotaExceeded`, and a sandbox purchase removes the limit.

---

## Self-Review Notes (addressed)

- **Spec coverage:** usage meter and entitlement cache (Task 1), RevenueCat lookup with an hour of cache and free-on-outage (Task 2), the four-way decision incl. own-key and Pro (Task 3), applied to both `/ai/route` and connector triage with degradation to the keyword router (Task 4), migrate/deploy (Task 5), the ported iOS integration identified by GitHub id (Task 6), Plan row and the quota message (Task 7).
- **Shippable before billing exists:** every path returns "unmetered" when `REVENUECAT_SECRET_KEY` is absent, tested explicitly, and Task 5 Step 4 verifies it in production.
- **Identity consistency:** RevenueCat's `app_user_id`, `entitlements.user_github_id` and `ai_usage.user_github_id` are all the numeric GitHub id — the same one `sessions`, `memberships` and `connector_config` use. Task 6 Step 3 adds the missing piece (the app did not store the numeric id) so the two sides can agree.
- **Allowance is consumed only after a real call:** `consume()` is separate from the check, so a failed model call does not burn someone's three.
- **Known gap, deliberate:** the guest path (no session) is refused an AI call rather than metered, because an anonymous caller cannot be counted and should not spend the budget. Guests still get keyword routing.

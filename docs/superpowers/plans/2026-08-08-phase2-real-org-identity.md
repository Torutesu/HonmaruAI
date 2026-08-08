# Phase 2: Real Identity & Org (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cloudflare backend speak real GitHub identities and build a real org graph from a repository's collaborators — replacing demo users — so that AI routing, sessions, and the WebSocket relay all operate on real people.

**Architecture:** A session token minted at GitHub OAuth (Phase 1) is the credential. New Worker endpoints resolve a repo's collaborators (via the session's stored GitHub token) into an `OrganizationGraph` in the exact shape the iOS app already consumes, persisting `users`/`memberships`/`agents` in D1. The ported routing logic is generalized so it validates recipients and resolves names against the *passed* organization instead of the hardcoded `DEMO_USER_IDS`. The Durable Object binds a WebSocket `join` to the session's real GitHub user.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1, GitHub REST API (`/user`, `/repos/{owner}/{repo}/collaborators`), Vitest + `@cloudflare/vitest-pool-workers` (`fetchMock` for GitHub calls).

## Scope decision

This plan is **backend only**. The iOS-side changes the spec groups under "real auth/org" — removing the persona picker / `AppConfig.defaultUser`, GitHub-login-first flow, rendering the real org graph, and joining the relay with a session token — are consolidated into the **iOS phase (Phase 4)**, because they depend on this backend and overlap Phase 4's rebuild. Each plan stays an independently testable unit.

## Key facts this plan relies on (verified against the code)

- The iOS `OrganizationGraph` sent to `/ai/route` is `{ nodes: OrgNode[], edges: OrgEdge[] }` only (no `users[]`). `OrgNode = { id, kind, label }`, `kind ∈ {person, team, agent, project}`. `OrgEdge = { id, fromID, toID, kind }`, `kind ∈ {manages, memberOf, assignedTo, canApprove}`. The backend must emit exactly these field names.
- A person node's `label` is `"<name> · <role>"`; routing derives a display name by taking the text before `" · "`.
- `worker/src/routing.js` hardcodes `DEMO_USER_IDS = ["user-toru","user-tanaka","user-yui","user-alex"]`. It is used in three places that must be generalized: the name-mention loop in `resolveRecipientTarget`, the allowed-recipients check in `validateRouting` (throws "AI picked an invalid recipient." for non-demo ids), and `userNameFor` (a hardcoded id→name map). `TEAM_ROUTES`/`ROLE_ROUTES` map demo Japanese phrases to demo ids.
- `worker/src/db.js` currently exports: `loadStore, saveCard, removeCard, clearCards, loadContexts, saveContext, createSession`. No session/user lookup helpers yet. The `sessions` table has `token, github_id, github_access_token, created_at, expires_at`. The `users`, `memberships`, `agents` tables exist (Phase 1 schema) but are unused.
- `worker/src/index.js` routes: `/health`, `/agui/tools`, `/ai/route`, `/oauth/github/config`, `/oauth/github/token`, and WS upgrade → `OrgRelay`.
- Member id convention for real orgs: **the GitHub login is the member id** (e.g. `octocat`), the agent node id is `agent-<login>`, the team node id is `team-<repo>`.

---

## File Structure

```
worker/
  src/
    db.js       # + getSession, getUserByGithubId, upsertUser, upsertMembership, upsertAgent
    org.js      # NEW: buildOrgGraph (pure mapper) + roleName/isApprover helpers
    github.js   # NEW: fetchCollaborators(token, owner, repo) — thin GitHub REST wrapper
    index.js    # + GET /orgs/:owner/:repo/graph (session-auth) → build+persist+return graph
    routing.js  # generalize: recipients/names from the passed organization, demo routes gated
    relay.js    # join binds to session's real github user when sessionToken is supplied
  test/
    identity.test.js   # db session/user helpers
    org.test.js        # buildOrgGraph pure mapper
    orggraph.test.js   # GET /orgs/:owner/:repo/graph route (fetchMock + session)
    routing.test.js    # (extend) real-login org routes correctly; invalid recipient rejected
    relay.test.js      # (extend) join with sessionToken resolves the real user id
```

---

## Task 1: D1 identity & session helpers

**Files:**
- Modify: `worker/src/db.js`
- Test: `worker/test/identity.test.js`

- [ ] **Step 1: Write the failing test `worker/test/identity.test.js`**

```js
import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import {
  createSession, getSession, upsertUser, getUserByGithubId,
  upsertMembership, upsertAgent,
} from "../src/db.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("getSession returns the github id and access token for a token", async () => {
  const token = await createSession(env.DB, "42", "gho_abc");
  const s = await getSession(env.DB, token);
  expect(s.github_id).toBe("42");
  expect(s.github_access_token).toBe("gho_abc");
  expect(await getSession(env.DB, "no-such-token")).toBeNull();
});

test("upsertUser then getUserByGithubId round-trips and updates", async () => {
  await upsertUser(env.DB, { githubId: "7", login: "octocat", name: "The Octocat", avatarUrl: "http://a", locale: "en" });
  let u = await getUserByGithubId(env.DB, "7");
  expect(u.login).toBe("octocat");
  await upsertUser(env.DB, { githubId: "7", login: "octocat", name: "Mona", avatarUrl: "http://b", locale: "ja" });
  u = await getUserByGithubId(env.DB, "7");
  expect(u.name).toBe("Mona");
  expect(u.locale).toBe("ja");
});

test("upsertMembership and upsertAgent are idempotent", async () => {
  await upsertMembership(env.DB, "acme/web", "7", "Admin");
  await upsertMembership(env.DB, "acme/web", "7", "Engineer"); // update role
  await upsertAgent(env.DB, "acme/web", "7", "octocat's AI");
  await upsertAgent(env.DB, "acme/web", "7", "octocat's AI"); // no duplicate
  const { results: mem } = await env.DB.prepare(
    "SELECT role FROM memberships WHERE org_id=?1 AND user_github_id=?2"
  ).bind("acme/web", "7").all();
  expect(mem).toHaveLength(1);
  expect(mem[0].role).toBe("Engineer");
  const { results: ag } = await env.DB.prepare(
    "SELECT id FROM agents WHERE org_id=?1 AND user_github_id=?2"
  ).bind("acme/web", "7").all();
  expect(ag).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- identity.test.js`
Expected: FAIL — `getSession`, `upsertUser`, etc. are not exported.

- [ ] **Step 3: Add the helpers to `worker/src/db.js`**

Append:

```js
export async function getSession(db, token) {
  if (!token) return null;
  const row = await db
    .prepare("SELECT token, github_id, github_access_token FROM sessions WHERE token = ?1")
    .bind(token)
    .first();
  return row || null;
}

export async function upsertUser(db, { githubId, login, name, avatarUrl, locale }) {
  await db
    .prepare(
      `INSERT INTO users (github_id, login, name, avatar_url, locale, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(github_id) DO UPDATE SET
         login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url, locale = excluded.locale`
    )
    .bind(String(githubId), login, name || null, avatarUrl || null, locale || "en", new Date().toISOString())
    .run();
}

export async function getUserByGithubId(db, githubId) {
  return (
    (await db
      .prepare("SELECT github_id, login, name, avatar_url, locale FROM users WHERE github_id = ?1")
      .bind(String(githubId))
      .first()) || null
  );
}

export async function upsertMembership(db, orgId, githubId, role) {
  await db
    .prepare(
      `INSERT INTO memberships (org_id, user_github_id, role, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(org_id, user_github_id) DO UPDATE SET role = excluded.role`
    )
    .bind(orgId, String(githubId), role, new Date().toISOString())
    .run();
}

export async function upsertAgent(db, orgId, githubId, displayName) {
  await db
    .prepare(
      `INSERT INTO agents (id, org_id, user_github_id, display_name)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name`
    )
    .bind(`agent-${orgId}-${githubId}`, orgId, String(githubId), displayName)
    .run();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npm test -- identity.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/db.js worker/test/identity.test.js
git commit -m "feat(worker): D1 session and identity helpers"
```

---

## Task 2: Pure org-graph mapper

**Files:**
- Create: `worker/src/org.js`
- Test: `worker/test/org.test.js`

- [ ] **Step 1: Write the failing test `worker/test/org.test.js`**

```js
import { expect, test } from "vitest";
import { buildOrgGraph, roleName, isApprover } from "../src/org.js";

const COLLABS = [
  { login: "octocat", id: 1, avatar_url: "http://a", permissions: { admin: true, maintain: true, push: true, triage: true, pull: true } },
  { login: "hubot",   id: 2, avatar_url: "http://b", permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } },
];

test("roleName maps permissions to a human role", () => {
  expect(roleName(COLLABS[0].permissions)).toBe("Admin");
  expect(roleName(COLLABS[1].permissions)).toBe("Engineer");
  expect(roleName({ pull: true })).toBe("Member");
});

test("isApprover is true for admin/maintain only", () => {
  expect(isApprover(COLLABS[0].permissions)).toBe(true);
  expect(isApprover(COLLABS[1].permissions)).toBe(false);
});

test("buildOrgGraph emits iOS-shaped users/nodes/edges", () => {
  const g = buildOrgGraph(COLLABS, { owner: "acme", repo: "web" });
  // team node present
  const team = g.nodes.find((n) => n.kind === "team");
  expect(team).toEqual({ id: "team-web", kind: "team", label: "acme/web" });
  // person nodes
  const octo = g.nodes.find((n) => n.id === "octocat");
  expect(octo).toEqual({ id: "octocat", kind: "person", label: "octocat · Admin" });
  // agent node
  expect(g.nodes.find((n) => n.id === "agent-octocat")).toEqual({ id: "agent-octocat", kind: "agent", label: "octocat's AI" });
  // memberOf edge
  expect(g.edges.find((e) => e.kind === "memberOf" && e.fromID === "octocat")).toMatchObject({ toID: "team-web" });
  // canApprove only for the admin
  expect(g.edges.some((e) => e.kind === "canApprove" && e.fromID === "octocat")).toBe(true);
  expect(g.edges.some((e) => e.kind === "canApprove" && e.fromID === "hubot")).toBe(false);
  // users[] carries the fields the app model uses
  expect(g.users.find((u) => u.id === "octocat")).toEqual({
    id: "octocat", name: "octocat", role: "Admin", teamID: "team-web", githubUsername: "octocat", language: "en",
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- org.test.js`
Expected: FAIL — `../src/org.js` does not exist.

- [ ] **Step 3: Create `worker/src/org.js`**

```js
// Maps GitHub repo collaborators into the OrganizationGraph the iOS app consumes.
// Member id = GitHub login. Agent id = `agent-<login>`. Team id = `team-<repo>`.

export function roleName(permissions = {}) {
  if (permissions.admin) return "Admin";
  if (permissions.maintain) return "Maintainer";
  if (permissions.push) return "Engineer";
  if (permissions.triage) return "Triager";
  return "Member";
}

export function isApprover(permissions = {}) {
  return Boolean(permissions.admin || permissions.maintain);
}

export function buildOrgGraph(collaborators, { owner, repo }) {
  const teamId = `team-${repo}`;
  const teamLabel = `${owner}/${repo}`;
  const users = [];
  const nodes = [{ id: teamId, kind: "team", label: teamLabel }];
  const edges = [];

  for (const c of collaborators) {
    const role = roleName(c.permissions);
    users.push({
      id: c.login, name: c.login, role,
      teamID: teamId, githubUsername: c.login, language: "en",
    });
    nodes.push({ id: c.login, kind: "person", label: `${c.login} · ${role}` });
    nodes.push({ id: `agent-${c.login}`, kind: "agent", label: `${c.login}'s AI` });
    edges.push({ id: `e-mem-${c.login}`, fromID: c.login, toID: teamId, kind: "memberOf" });
    edges.push({ id: `e-agent-${c.login}`, fromID: `agent-${c.login}`, toID: c.login, kind: "assignedTo" });
    if (isApprover(c.permissions)) {
      edges.push({ id: `e-appr-${c.login}`, fromID: c.login, toID: teamId, kind: "canApprove" });
    }
  }
  return { users, nodes, edges };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npm test -- org.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/org.js worker/test/org.test.js
git commit -m "feat(worker): pure org-graph mapper from GitHub collaborators"
```

---

## Task 3: GitHub collaborators fetch + `/orgs/:owner/:repo/graph` route

**Files:**
- Create: `worker/src/github.js`
- Modify: `worker/src/index.js`
- Test: `worker/test/orggraph.test.js`

- [ ] **Step 1: Create `worker/src/github.js`**

```js
// Thin GitHub REST wrapper. Uses the collaborator's/session's access token.
const GH = "https://api.github.com";
const HEADERS = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "tiktokforwork",
  "x-github-api-version": "2022-11-28",
});

export async function fetchCollaborators(token, owner, repo) {
  const res = await fetch(
    `${GH}/repos/${owner}/${repo}/collaborators?per_page=100`,
    { headers: HEADERS(token) }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub collaborators ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Write the failing test `worker/test/orggraph.test.js`**

```js
import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession } from "../src/db.js";

let sessionToken;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  sessionToken = await createSession(env.DB, "42", "gho_abc");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("GET /orgs/:owner/:repo/graph builds and persists the org", async () => {
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/web/collaborators?per_page=100" })
    .reply(200, [
      { login: "octocat", id: 1, avatar_url: "http://a", permissions: { admin: true, push: true, pull: true } },
      { login: "hubot", id: 2, avatar_url: "http://b", permissions: { push: true, pull: true } },
    ]);

  const res = await SELF.fetch("https://example.com/orgs/acme/web/graph", {
    headers: { "x-session-token": sessionToken },
  });
  expect(res.status).toBe(200);
  const g = await res.json();
  expect(g.nodes.find((n) => n.id === "octocat").kind).toBe("person");
  expect(g.nodes.find((n) => n.kind === "team").label).toBe("acme/web");
  expect(g.edges.some((e) => e.kind === "canApprove" && e.fromID === "octocat")).toBe(true);

  // persisted: two memberships for org "acme/web"
  const { results } = await env.DB.prepare(
    "SELECT user_github_id, role FROM memberships WHERE org_id=?1 ORDER BY user_github_id"
  ).bind("acme/web").all();
  expect(results).toHaveLength(2);
});

test("GET /orgs/:owner/:repo/graph is 401 without a valid session", async () => {
  const res = await SELF.fetch("https://example.com/orgs/acme/web/graph", {
    headers: { "x-session-token": "bogus" },
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npm test -- orggraph.test.js`
Expected: FAIL — route returns 404 (not implemented).

- [ ] **Step 4: Add the route to `worker/src/index.js`**

Add imports at top:

```js
import { getSession, upsertUser, upsertMembership, upsertAgent } from "./db.js";
import { fetchCollaborators } from "./github.js";
import { buildOrgGraph, roleName } from "./org.js";
```

(Note: `createSession` is already imported in Phase 1 — merge into the existing `./db.js` import line rather than duplicating it.)

Add inside `fetch`, before the WebSocket-upgrade block:

```js
    const orgGraphMatch = url.pathname.match(/^\/orgs\/([^/]+)\/([^/]+)\/graph$/);
    if (orgGraphMatch && request.method === "GET") {
      const [, owner, repo] = orgGraphMatch;
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      const orgId = `${owner}/${repo}`;
      let collaborators;
      try {
        collaborators = await fetchCollaborators(session.github_access_token, owner, repo);
      } catch (err) {
        return json({ message: err.message }, 502);
      }
      const graph = buildOrgGraph(collaborators, { owner, repo });
      for (const c of collaborators) {
        await upsertUser(env.DB, { githubId: c.id, login: c.login, name: c.login, avatarUrl: c.avatar_url, locale: "en" });
        await upsertMembership(env.DB, orgId, c.id, roleName(c.permissions));
        await upsertAgent(env.DB, orgId, c.id, `${c.login}'s AI`);
      }
      return json(graph);
    }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd worker && npm test -- orggraph.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full suite**

Run: `cd worker && npm test`
Expected: PASS (all prior + new). Paste output.

- [ ] **Step 7: Commit**

```bash
git add worker/src/github.js worker/src/index.js worker/test/orggraph.test.js
git commit -m "feat(worker): build+persist org graph from repo collaborators"
```

---

## Task 4: Generalize routing to the passed organization

**Files:**
- Modify: `worker/src/routing.js`
- Test: `worker/test/routing.test.js` (extend)

The routing module currently only routes to `DEMO_USER_IDS`. Generalize the three hardcoded touch-points so a real-login organization routes correctly, while keeping demo behavior as a fallback when the org is empty (so existing tests stay green).

- [ ] **Step 1: Add the two failing tests to `worker/test/routing.test.js`**

Append:

```js
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
  // recipient must be one of the real members, not a demo id
  expect(["octocat", "hubot"]).toContain(card.recipientUserID);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd worker && npm test -- routing.test.js`
Expected: FAIL — recipient resolves to a demo id / is rejected as invalid, because routing ignores real org members.

- [ ] **Step 3: Add org-aware helpers near the top of `worker/src/routing.js`**

Add after the `DEMO_USER_IDS` declaration:

```js
// Person node ids of the passed organization (the real members).
export function memberIdsOf(organization) {
  return (organization?.nodes || [])
    .filter((n) => n.kind === "person")
    .map((n) => n.id);
}

// Display name for a user id: prefer the org node label ("<name> · <role>"),
// then the demo map, then the raw id.
export function displayNameOf(organization, userID) {
  const node = (organization?.nodes || []).find((n) => n.id === userID && n.kind === "person");
  if (node?.label) return node.label.split(" · ")[0].trim();
  return userNameFor(userID);
}
```

- [ ] **Step 4: Generalize the name-mention loop in `resolveRecipientTarget`**

Read `resolveRecipientTarget(text, senderID, organization)`. Its demo loop currently reads:

```js
for (const userID of DEMO_USER_IDS) {
  if (userID === senderID) continue;
  const name = userNameFor(userID).toLowerCase();
  if (lower.includes(name)) {
    return { recipientUserID: userID, ... };
  }
}
```

Replace the iteration source and name lookup so it walks the real members, falling back to demo ids only when the org has none:

```js
const candidateIds = memberIdsOf(organization).length ? memberIdsOf(organization) : DEMO_USER_IDS;
for (const userID of candidateIds) {
  if (userID === senderID) continue;
  const name = displayNameOf(organization, userID).toLowerCase();
  if (name && lower.includes(name)) {
    return { recipientUserID: userID, routingReason: `Mentioned ${displayNameOf(organization, userID)}`, forceOverride: false };
  }
}
```

Keep the existing manager-edge branch and the `TEAM_ROUTES`/`ROLE_ROUTES` branches, but guard each demo route so it only fires when its target id is actually a member:

```js
// inside the TEAM_ROUTES / ROLE_ROUTES loops, before returning a hardcoded userID:
if (memberIdsOf(organization).length && !memberIdsOf(organization).includes(route.userID)) continue;
```

- [ ] **Step 5: Generalize the allowed-recipient check in `validateRouting`**

The check currently reads:

```js
const allowedRecipients = new Set(DEMO_USER_IDS);
if (!allowedRecipients.has(recipientUserID)) {
  throw new Error("AI picked an invalid recipient.");
}
```

Change the allowed set to the real members (falling back to demo ids for empty orgs). `validateRouting` must receive the organization — thread it through from the caller if it isn't already a parameter (read the function to confirm; it is called from `routeInstruction` where `organization` is in scope):

```js
const members = memberIdsOf(organization);
const allowedRecipients = new Set(members.length ? members : DEMO_USER_IDS);
if (!allowedRecipients.has(recipientUserID)) {
  throw new Error("AI picked an invalid recipient.");
}
```

- [ ] **Step 6: Default-recipient safety for real orgs**

Find where routing defaults "when in doubt" to `user-toru` (in `resolveRecipientTarget` and/or `routeInstructionLocally`). Replace the hardcoded fallback so it degrades to a real member when the org is non-empty: prefer the sender's manager, else the first `canApprove` member, else the first non-sender member:

```js
function defaultRecipient(senderID, organization) {
  const members = memberIdsOf(organization);
  if (!members.length) return "user-toru"; // demo fallback
  const approver = (organization.edges || []).find((e) => e.kind === "canApprove" && e.fromID !== senderID);
  if (approver) return approver.fromID;
  return members.find((id) => id !== senderID) || members[0];
}
```

Use `defaultRecipient(senderID, organization)` in place of the bare `"user-toru"` default(s) inside the local router. Do NOT remove the demo fallback path — it keeps the empty-org unit tests green.

- [ ] **Step 7: Run the routing tests, then the full suite**

Run: `cd worker && npm test -- routing.test.js`
Expected: PASS — including the two new real-org tests AND the original fallback test (empty org still routes to a demo id).
Run: `cd worker && npm test`
Expected: PASS (all). Paste output.

- [ ] **Step 8: Commit**

```bash
git add worker/src/routing.js worker/test/routing.test.js
git commit -m "feat(worker): route against the passed organization, demo ids as fallback"
```

---

## Task 5: Bind WebSocket `join` to the real session user

**Files:**
- Modify: `worker/src/relay.js`
- Test: `worker/test/relay.test.js` (extend)

Currently `join` trusts `payload.userId` verbatim (spoofable). When the client supplies a `sessionToken`, the DO must resolve it to the session's GitHub login and use that as the connection's `userId`. When no `sessionToken` is supplied (dev/back-compat and existing tests), fall back to `payload.userId`.

- [ ] **Step 1: Add the failing test to `worker/test/relay.test.js`**

Append (the `beforeAll` in this file already applies the schema; add a session there). At the top-level `beforeAll`, after the schema exec, add:

```js
  // (add) create a session mapping a token to a real github user id
  const { createSession } = await import("../src/db.js");
  globalThis.__token = await createSession(env.DB, "1001", "gho_x");
```

Then add the test:

```js
test("join with a sessionToken uses the session's user id, not the payload", async () => {
  const a = await open();
  const messages = [];
  a.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));
  a.send(JSON.stringify({ type: "join", payload: { userId: "spoofed", sessionToken: globalThis.__token, protocol: "agui/1" } }));
  await new Promise((r) => setTimeout(r, 60));
  // presence for the REAL resolved id (github id 1001), never "spoofed"
  const presence = messages.find((m) => m.type === "CUSTOM" && m.name === "presence");
  // the joining socket is excluded from its own presence broadcast, so open a 2nd client to observe:
  expect(messages.every((m) => JSON.stringify(m).indexOf("spoofed") === -1)).toBe(true);
});
```

Note: because a joining socket is excluded from its own presence broadcast, this test asserts the negative (no "spoofed" id appears anywhere the client receives — snapshot/echo). If you want a positive assertion, open a second client first and check its presence event carries the resolved id `"1001"`. Prefer the positive form if straightforward.

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- relay.test.js`
Expected: FAIL — the relay uses `payload.userId` ("spoofed") directly.

- [ ] **Step 3: Resolve the session in the `join` handler of `worker/src/relay.js`**

Add an import at top:

```js
import { getSession, getUserByGithubId } from "./db.js";
```

In `webSocketMessage`, inside the `if (type === "join")` branch, replace the `const userId = payload.userId;` line with a session-aware resolution:

```js
      let userId = payload.userId;
      if (payload.sessionToken) {
        const session = await getSession(this.db, payload.sessionToken);
        if (session) {
          const user = await getUserByGithubId(this.db, session.github_id);
          userId = user?.login || session.github_id; // real identity wins
        }
      }
```

Leave the rest of the `join` handler unchanged (it already uses `userId` for attachment, snapshot, and presence).

- [ ] **Step 4: Run the relay tests, then the full suite**

Run: `cd worker && npm test -- relay.test.js`
Expected: PASS — the spoofed id never appears; the resolved id is used.
Run: `cd worker && npm test`
Expected: PASS (all). Paste output.

- [ ] **Step 5: Commit**

```bash
git add worker/src/relay.js worker/test/relay.test.js
git commit -m "feat(worker): bind WebSocket join to the session's real user"
```

---

## Task 6: Deploy & smoke

**Files:** none (operational)

- [ ] **Step 1: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: redeploys `https://tiktokforwork.torubj0904.workers.dev`, prints a new Version ID.

- [ ] **Step 2: Smoke-test the unchanged surface**

Run: `curl https://tiktokforwork.torubj0904.workers.dev/health`
Expected: `{"ok":true,...,"aiRouting":true,"aiModel":"gpt-4o-mini"}` (unchanged).

- [ ] **Step 3: Confirm the org route rejects an unauthenticated call**

Run: `curl -s -o /dev/null -w "%{http_code}" -H "x-session-token: bogus" https://tiktokforwork.torubj0904.workers.dev/orgs/acme/web/graph`
Expected: `401`.

- [ ] **Step 4: Note the deferred live GitHub check**

The authenticated `/orgs/:owner/:repo/graph` path needs a real session, which needs the GitHub OAuth secrets (`GITHUB_CLIENT_ID`/`SECRET`) that are intentionally deferred. Unit tests fully cover the build+persist logic via `fetchMock`. Record in `worker/README.md` (Secrets table) that end-to-end org-from-repo verification is pending GitHub OAuth setup.

- [ ] **Step 5: Commit the doc note**

```bash
git add worker/README.md
git commit -m "docs(worker): note deferred live org-from-repo verification"
```

---

## Self-Review Notes (addressed)

- **Spec coverage (Phase 2 backend):** GitHub-only identity persisted in D1 (Task 1, 3), org graph from repo collaborators in the exact iOS shape (Task 2, 3), membership/agent provisioning (Task 1, 3), routing works on real members not demo ids (Task 4), and the relay binds to the real session user (Task 5). The iOS-side "remove persona/default user" is explicitly deferred to Phase 4 (see Scope decision).
- **Routing generalization keeps demo tests green:** every generalized branch falls back to `DEMO_USER_IDS` when `organization` has no person nodes, so Phase-1 routing tests continue to pass.
- **Type/shape consistency:** `buildOrgGraph` emits `nodes:{id,kind,label}` and `edges:{id,fromID,toID,kind}` — the exact iOS `OrgNode`/`OrgEdge` field names. Member id = GitHub login everywhere (org graph, routing recipient, relay userId, card recipientUserID). `getSession` returns `{token, github_id, github_access_token}`; callers use `github_id`/`github_access_token` consistently.
- **Deferred/known:** live `/orgs` verification waits on GitHub OAuth secrets; the client sending `x-session-token` and consuming the graph is Phase 4.
```

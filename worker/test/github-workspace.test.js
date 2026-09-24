import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { joined, until } from "./helpers.js";

// GitHub as a tool any workspace connects: name a repository, hold a token
// that writes there, and every decision becomes an issue — written by the
// Worker, whoever decided it and however they signed in.

const ORG = "team:eeeeeeeeeeeeeeeeee";
let toru, mika, out;
const call = (path, init = {}, over = {}) =>
  worker.fetch(new Request("https://example.com" + path, init), { ...env, ...over }, { waitUntil() {} });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const get = (path, token) => call(path, { headers: { "x-session-token": token } });
const put = (path, token, body) => call(path, { method: "PUT", headers: headers(token), body: JSON.stringify(body) });
const del = (path, token, body) => call(path, { method: "DELETE", headers: headers(token), body: JSON.stringify(body) });

const repoReply = (permissions) => ({ full_name: "acme/ops", html_url: "https://github.com/acme/ops", permissions });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:toru@x.jp", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "email:mika@x.jp", login: "u:mika@x.jp", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:out@x.jp", login: "u:out@x.jp", name: "Out", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "email:toru@x.jp", "admin");
  await upsertMembership(env.DB, ORG, "email:mika@x.jp", "member");
  await upsertMembership(env.DB, "personal:out", "email:out@x.jp", "admin");
  toru = await createSession(env.DB, "email:toru@x.jp", "email-auth");
  mika = await createSession(env.DB, "email:mika@x.jp", "email-auth");
  out = await createSession(env.DB, "email:out@x.jp", "email-auth");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a team workspace starts unconnected, and says what would connect it", async () => {
  const status = await (await get(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(status).toMatchObject({ builtIn: false, connected: false, repo: null, canEdit: true, mine: false });
  expect(status.reason).toMatch(/repository/);
  const member = await (await get(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, mika)).json();
  expect(member.canEdit).toBe(false);
});

test("an admin connects a repository with a token that can write issues", async () => {
  let auth;
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/ops", method: "GET" })
    .reply(200, (opts) => { auth = opts.headers?.authorization; return repoReply({ push: true }); })
    .times(1);
  const res = await put("/connectors/github", toru, { orgId: ORG, repo: "acme/ops", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });
  expect(res.status).toBe(200);
  const status = await res.json();
  expect(status).toMatchObject({ connected: true, repo: "acme/ops", canEdit: true });
  expect(auth).toBe("Bearer github_pat_abcdefghijklmnopqrstuvwxyz");
  expect(JSON.stringify(status)).not.toContain("github_pat_");
  // Everyone in the workspace sees it connected; nobody outside sees it at all.
  expect((await (await get(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, mika)).json()).connected).toBe(true);
  expect((await get(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, out)).status).toBe(403);
});

test("a read-only token, a wrong name, a member, and a refused repository", async () => {
  fetchMock.get("https://api.github.com").intercept({ path: "/repos/acme/ops", method: "GET" }).reply(200, repoReply({ pull: true })).times(1);
  let res = await put("/connectors/github", toru, { orgId: ORG, repo: "acme/ops", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/not write issues/);
  res = await put("/connectors/github", toru, { orgId: ORG, repo: "not a repo", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });
  expect(res.status).toBe(400);
  res = await put("/connectors/github", mika, { orgId: ORG, repo: "acme/ops", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });
  expect(res.status).toBe(403);
  fetchMock.get("https://api.github.com").intercept({ path: "/repos/acme/private", method: "GET" }).reply(404, { message: "Not Found" }).times(1);
  res = await put("/connectors/github", toru, { orgId: ORG, repo: "acme/private", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });
  expect(res.status).toBe(400);
  // No token and no GitHub sign-in: nothing to connect with.
  res = await put("/connectors/github", toru, { orgId: ORG, repo: "acme/ops" });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/token|GitHub/);
});

test("a GitHub sign-in connects with one tap, on its own token", async () => {
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "4242", login: "octo", name: "Octo", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "4242", "admin");
  const octo = await createSession(env.DB, "4242", "gho_realtoken_abcdefghijklmnop");
  let auth;
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/ops", method: "GET" })
    .reply(200, (opts) => { auth = opts.headers?.authorization; return repoReply({ admin: true }); })
    .times(1);
  const status = await (await get(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, octo)).json();
  expect(status.mine).toBe(true);
  const res = await put("/connectors/github", octo, { orgId: ORG, repo: "acme/ops" });
  expect(res.status).toBe(200);
  expect(auth).toBe("Bearer gho_realtoken_abcdefghijklmnop");
});

test("once connected, a card becomes an issue and a decision closes it", async () => {
  fetchMock.get("https://api.github.com").intercept({ path: "/repos/acme/ops", method: "GET" }).reply(200, repoReply({ push: true })).times(1);
  await put("/connectors/github", toru, { orgId: ORG, repo: "acme/ops", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });

  let created;
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/ops/issues", method: "POST", body: (b) => { created = JSON.parse(b); return true; } })
    .reply(201, { number: 7, html_url: "https://github.com/acme/ops/issues/7" })
    .times(1);
  let patched;
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/ops/issues/7", method: "PATCH", body: (b) => { patched = JSON.parse(b); return true; } })
    .reply(200, { number: 7 })
    .times(1);

  const { ws: a, messages: aMessages } = await joined(ORG, toru);
  const { messages: bMessages } = await joined(ORG, mika);
  a.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-gh", recipientUserID: "u:mika@x.jp", senderUserID: "u:toru@x.jp", type: "approval",
    status: "pending", title: "Approve the ops budget", summary: "Q4.", priority: "high", createdAt: "2026-09-24T00:00:00Z",
  } } }));
  const withIssue = await until(() => bMessages.find((m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes('"githubIssueNumber":7')));
  expect(withIssue).toBeTruthy();
  expect(created.title).toBe("[Approval] Approve the ops budget");
  expect(created.body).toContain("Q4.");

  // Mika decides; the issue is brought up to date and closed.
  const { getCard } = await import("../src/db.js");
  const stored = await until(async () => (await getCard(env.DB, ORG, "c-gh"))?.githubIssueNumber === 7);
  expect(stored).toBeTruthy();
  const { ws: b } = await joined(ORG, mika);
  b.send(JSON.stringify({ type: "card_updated", payload: { card: {
    ...(await getCard(env.DB, ORG, "c-gh")), status: "rejected",
    decision: { action: "decline", actorUserID: "u:mika@x.jp", decidedAt: "2026-09-24T01:00:00Z" },
  } } }));
  const closed = await until(() => patched && patched.state === "closed");
  expect(closed).toBeTruthy();
  expect(patched.body).toContain("**Decision:** decline");
  void aMessages;
});

test("disconnecting stops the writing, and the token is gone", async () => {
  fetchMock.get("https://api.github.com").intercept({ path: "/repos/acme/ops", method: "GET" }).reply(200, repoReply({ push: true })).times(1);
  await put("/connectors/github", toru, { orgId: ORG, repo: "acme/ops", token: "github_pat_abcdefghijklmnopqrstuvwxyz" });
  const res = await del("/connectors/github", toru, { orgId: ORG });
  expect(res.status).toBe(200);
  expect((await res.json()).connected).toBe(false);
  const row = await env.DB.prepare("SELECT token FROM org_github WHERE org_id = ?1").bind(ORG).first();
  expect(row).toBeNull();
});

// The OAuth way: no token to paste. A page opens (Composio hosts it), GitHub
// asks, you say yes; back here you pick a repository, and the Worker writes
// issues as you from then on.
const COMPOSIO = { COMPOSIO_API_KEY: "ck_test" };
const composio = () => fetchMock.get("https://backend.composio.dev");

test("connecting GitHub is a link to a page, made on an auth config the Worker makes once", async () => {
  let made = 0;
  composio().intercept({ path: "/api/v3/auth_configs", method: "POST", body: (b) => JSON.parse(b).toolkit?.slug === "github" })
    .reply(200, () => { made += 1; return { auth_config: { id: "ac_github_made" }, toolkit: { slug: "github" } }; }).times(1);
  composio().intercept({ path: "/api/v3/connected_accounts/link", method: "POST", body: (b) => JSON.parse(b).auth_config_id === "ac_github_made" })
    .reply(200, { redirect_url: "https://connect.composio.dev/go/abc", connected_account_id: "ca_1" }).times(2);
  let res = await call("/connectors/github/connect", { method: "POST", headers: { "x-session-token": toru } }, COMPOSIO);
  expect(res.status).toBe(200);
  expect((await res.json()).redirectUrl).toBe("https://connect.composio.dev/go/abc");
  // The second person reuses the config; it is not made twice.
  res = await call("/connectors/github/connect", { method: "POST", headers: { "x-session-token": mika } }, COMPOSIO);
  expect(res.status).toBe(200);
  expect(made).toBe(1);
  const kept = await env.DB.prepare("SELECT value FROM kv WHERE key = 'composio_auth_config_github'").first();
  expect(kept.value).toBe("ac_github_made");
});

test("once your GitHub is connected, you pick a repository and the Worker writes issues as you", async () => {
  composio().intercept({ path: (p) => p.startsWith("/api/v3/connected_accounts?"), method: "GET" })
    .reply(200, (opts) => ({ items: opts.path.includes("email%3Atoru") ? [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "github" } }] : [] }))
    .persist();
  composio().intercept({ path: "/api/v3/tools/execute/GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", method: "POST" })
    .reply(200, { successful: true, data: { details: [
      { full_name: "acme/ops", html_url: "https://github.com/acme/ops", private: true, permissions: { push: true } },
      { full_name: "acme/readonly", html_url: "https://github.com/acme/readonly", private: false, permissions: { pull: true } },
    ] } }).times(1);
  composio().intercept({ path: "/api/v3/tools/execute/GITHUB_GET_A_REPOSITORY", method: "POST", body: (b) => JSON.parse(b).arguments?.repo === "ops" })
    .reply(200, { successful: true, data: { full_name: "acme/ops", html_url: "https://github.com/acme/ops", permissions: { push: true } } }).times(1);
  let issueArgs;
  composio().intercept({ path: "/api/v3/tools/execute/GITHUB_CREATE_AN_ISSUE", method: "POST", body: (b) => { issueArgs = JSON.parse(b); return true; } })
    .reply(200, { successful: true, data: { number: 12, html_url: "https://github.com/acme/ops/issues/12" } }).times(1);

  // Status says the journey is offered and that Toru's GitHub is in.
  let status = await (await call(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": toru } }, COMPOSIO)).json();
  expect(status).toMatchObject({ oauth: true, mine: true, connected: false });
  // Mika has not connected hers.
  status = await (await call(`/connectors/github?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": mika } }, COMPOSIO)).json();
  expect(status.mine).toBe(false);
  expect((await call("/connectors/github/repos", { headers: { "x-session-token": mika } }, COMPOSIO)).status).toBe(409);

  // Only the repositories Toru can write to are offered.
  const repos = await (await call("/connectors/github/repos", { headers: { "x-session-token": toru } }, COMPOSIO)).json();
  expect(repos.repos.map((r) => r.repo)).toEqual(["acme/ops"]);

  // Picking one connects the workspace, with no token anywhere.
  let res = await call("/connectors/github", { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, repo: "acme/ops" }) }, COMPOSIO);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ connected: true, repo: "acme/ops", via: "account" });
  const row = await env.DB.prepare("SELECT token, composio_user FROM org_github WHERE org_id = ?1").bind(ORG).first();
  expect(row).toEqual({ token: null, composio_user: "email:toru@x.jp" });

  // A card becomes an issue, written as Toru.
  const { ws: a } = await joined(ORG, toru, COMPOSIO);
  const { messages: bMessages } = await joined(ORG, mika, COMPOSIO);
  void a;
  const { getCard, saveCard } = await import("../src/db.js");
  void getCard;
  const { syncCardToGitHub } = await import("../src/githubWorkspace.js");
  const card = { id: "c-oauth", recipientUserID: "u:mika@x.jp", senderUserID: "u:toru@x.jp", type: "task", status: "pending", title: "Fix the sign", summary: "Front door.", priority: "low", createdAt: "2026-09-24T00:00:00Z" };
  await saveCard(env.DB, ORG, card);
  const synced = await syncCardToGitHub({ ...env, ...COMPOSIO }, ORG, card);
  expect(synced).toMatchObject({ githubIssueNumber: 12, githubRepository: "acme/ops" });
  expect(issueArgs.user_id).toBe("email:toru@x.jp");
  expect(issueArgs.arguments).toMatchObject({ owner: "acme", repo: "ops", title: "[Task] Fix the sign" });
  void bMessages;
});

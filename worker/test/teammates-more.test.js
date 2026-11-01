import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { watchTeammateRuns } from "../src/channelRoutes.js";

// Devin and Cursor as teammates, on the same footing as Claude: set up with
// the workspace's own key, @devin or @cursor in a thread starts the work on
// the team's repositories, and the answer comes back into the thread. Devin
// is counted in ACUs, Cursor in tasks.

const ORG = "personal:teammates-more";
let toru; let mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, extra = {}) => { const res = await worker.fetch(new Request("https://example.com" + path, init), { ...env, OPENAI_API_KEY: undefined, ...extra }, ctx); await settle(); return res; };
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (method, path, token, body, extra) => call(path, { method, headers: headers(token), body: JSON.stringify(body) }, extra);
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const devin = () => fetchMock.get("https://api.devin.ai");
const cursor = () => fetchMock.get("https://api.cursor.com");
const github = () => fetchMock.get("https://api.github.com");
const thread = async (token, messageId) => (await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId })}`, token)).json()).replies;
const teammate = async (provider) => (await (await get(`/teammates?${q({ orgId: ORG, provider })}`, toru)).json()).teammate;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9801", "toru", "Toru", "admin"], ["9802", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  toru = await createSession(env.DB, "9801", "gho_t");
  mika = await createSession(env.DB, "9802", "gho_m");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("Devin: set up with its organization, @devin starts a session capped in ACUs, and a follow-up waits for its answer", async () => {
  // Its organization is needed, and the key is checked against it.
  const bare = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "devin", enabled: true, apiKey: "cog_test" });
  expect(bare.status).toBe(400);
  expect((await bare.json()).message).toBe("Add your Devin organization ID (org-…).");
  devin().intercept({ path: "/v3/organizations/org-abc/sessions?first=1", method: "GET", headers: { authorization: "Bearer cog_test" } }).reply(200, { items: [] });
  const res = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "devin", enabled: true, apiKey: "cog_test", account: "org-abc", repos: ["acme/app"], instructions: "Run the tests first." });
  expect(res.status).toBe(200);
  const set = (await res.json()).teammate;
  expect(set).toMatchObject({ enabled: true, ready: true, unit: "acu", account: "org-abc", monthlyLimit: 100, handle: "devin" });
  expect(JSON.stringify(set)).not.toContain("cog_test");

  let made = null;
  devin().intercept({ path: "/v3/organizations/org-abc/sessions", method: "POST" }).reply(200, (opts) => { made = JSON.parse(opts.body); return { session_id: "devin-1", status: "new" }; });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1/messages?first=200", method: "GET" }).reply(200, {
    items: [
      { event_id: "m1", source: "user", message: "the task", created_at: 1 },
      { event_id: "m2", source: "devin", message: "Fixed the redirect.", created_at: 2 },
    ],
    end_cursor: "c2", has_next_page: false,
  });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1", method: "GET" }).reply(200, {
    session_id: "devin-1", status: "running", status_detail: "waiting_for_user", acus_consumed: 2.5,
    pull_requests: [{ pr_url: "https://github.com/acme/app/pull/9" }],
  });
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@devin the login page 404s, fix it" })).json()).message;
  expect(made.repos).toEqual(["acme/app"]);
  expect(made.max_acu_limit).toBe(100);
  expect(made.tags).toEqual(["honmaruai"]);
  expect(made.prompt).toContain("Run the tests first.");
  expect(made.prompt).toContain("the login page 404s, fix it");
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual([
    "On it. I'll answer here when I'm done.",
    "Fixed the redirect.\n\nhttps://github.com/acme/app/pull/9",
  ]);
  expect((await teammate("devin")).spentThisMonth).toBe(2.5);

  // A follow-up: just after it is handed on, Devin still reads as waiting,
  // with nothing said since — that is not an answer.
  let followed = null;
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1/messages", method: "POST" }).reply(200, (opts) => { followed = JSON.parse(opts.body); return { session_id: "devin-1" }; });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1/messages?first=200&after=c2", method: "GET" }).reply(200, {
    items: [{ event_id: "m3", source: "user", message: "Mika: also add a test", created_at: 3 }], end_cursor: "c3", has_next_page: false,
  });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1", method: "GET" }).reply(200, { session_id: "devin-1", status: "running", status_detail: "waiting_for_user", acus_consumed: 2.5, pull_requests: [] });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@devin also add a test", parentId: posted.id }, { TEAMMATE_WATCH_MS: "0" });
  expect(followed).toEqual({ message: "Mika: also add a test" });
  expect((await thread(mika, posted.id)).map((m) => m.body).slice(-1)).toEqual(["Picking this up where we left off."]);
  // The cron, later: answered.
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1/messages?first=200&after=c2", method: "GET" }).reply(200, {
    items: [
      { event_id: "m3", source: "user", message: "Mika: also add a test", created_at: 3 },
      { event_id: "m4", source: "devin", message: "Added a test to https://github.com/acme/app/pull/9.", created_at: 4 },
    ],
    end_cursor: "c4", has_next_page: false,
  });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-1", method: "GET" }).reply(200, {
    session_id: "devin-1", status: "running", status_detail: "waiting_for_user", acus_consumed: 3.1, pull_requests: [{ pr_url: "https://github.com/acme/app/pull/9" }],
  });
  await watchTeammateRuns(env);
  expect((await thread(mika, posted.id)).map((m) => m.body).slice(-1)).toEqual(["Added a test to https://github.com/acme/app/pull/9."]);
  const run = await env.DB.prepare("SELECT * FROM ai_teammate_runs WHERE org_id = ?1").bind(ORG).first();
  expect(run).toMatchObject({ status: "idle", cost_cents: 310, last_event_at: "c4" });
});

test("Devin: out of its allowance, it says so", async () => {
  devin().intercept({ path: "/v3/organizations/org-abc/sessions?first=1", method: "GET" }).reply(200, { items: [] });
  await send("PUT", "/teammates", toru, { orgId: ORG, provider: "devin", enabled: true, apiKey: "cog_test", account: "org-abc" });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions", method: "POST" }).reply(200, { session_id: "devin-2" });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-2/messages?first=200", method: "GET" }).reply(200, { items: [{ source: "devin", message: "Looking into it." }], end_cursor: "x", has_next_page: false });
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-2", method: "GET" }).reply(200, { status: "suspended", status_detail: "usage_limit_exceeded", acus_consumed: 100, pull_requests: [] });
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@devin rewrite the billing module" })).json()).message;
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual([
    "On it. I'll answer here when I'm done.",
    "Looking into it.\n\nI stopped because I reached this month's spending limit. An admin can raise it in Studio → AI teammates.",
  ]);
});

test("stopping a Devin assignment terminates only its exact provider session", async () => {
  devin().intercept({ path: "/v3/organizations/org-abc/sessions?first=1", method: "GET" }).reply(200, { items: [] });
  await send("PUT", "/teammates", toru, { orgId: ORG, provider: "devin", enabled: true, apiKey: "cog_cancel_test", account: "org-abc" });
  await env.DB.prepare(`INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,created_at,updated_at,assignment_id,assignment_generation)
    VALUES ('devin-current',?1,'devin','b:cafe','thread','devin-current','running','2026-10-26','2026-10-26','assignment-stop',7),
           ('devin-stale',?1,'devin','b:cafe','thread','devin-stale','running','2026-10-25','2026-10-25','assignment-stop',6)`)
    .bind(ORG).run();

  let deleted;
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-current", method: "DELETE", headers: { authorization: "Bearer cog_cancel_test" } })
    .reply(200, (opts) => { deleted = { path: opts.path, method: opts.method }; return { session_id: "devin-current", status: "suspended" }; });
  const { cancelAssignedTeammateRuns } = await import("../src/teammates.js");
  const result = await cancelAssignedTeammateRuns(env, { orgId: ORG, assignmentId: "assignment-stop", generation: 7 });
  expect(result).toEqual({ status: "requested" });
  expect(deleted).toEqual({ path: "/v3/organizations/org-abc/sessions/devin-current", method: "DELETE" });

  await env.DB.prepare(`INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,created_at,updated_at,assignment_id,assignment_generation)
    VALUES ('devin-gone',?1,'devin','b:cafe','thread','devin-gone','running','2026-10-26','2026-10-26','assignment-gone',1)`).bind(ORG).run();
  devin().intercept({ path: "/v3/organizations/org-abc/sessions/devin-gone", method: "DELETE" }).reply(410, { detail: "Session is no longer active." });
  const gone = await cancelAssignedTeammateRuns(env, { orgId: ORG, assignmentId: "assignment-gone", generation: 1 });
  expect(gone).toEqual({ status: "already_finished" });
});

test("Cursor: needs a repository, @cursor starts an agent that opens a PR, and each hand-off is a task", async () => {
  expect((await send("PUT", "/teammates", toru, { orgId: ORG, provider: "cursor", enabled: true, apiKey: "crsr_test" })).status).toBe(400);
  cursor().intercept({ path: "/v1/me", method: "GET", headers: { authorization: "Bearer crsr_test" } }).reply(200, { apiKeyName: "honmaru" });
  const res = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "cursor", enabled: true, apiKey: "crsr_test", repos: ["acme/app"], model: "composer-2", monthlyLimit: 2 });
  expect(res.status).toBe(200);
  expect((await res.json()).teammate).toMatchObject({ enabled: true, unit: "task", model: "composer-2", monthlyLimit: 2, handle: "cursor" });

  let made = null;
  cursor().intercept({ path: "/v1/agents", method: "POST" }).reply(200, (opts) => { made = JSON.parse(opts.body); return { agent: { id: "bc-1", status: "ACTIVE" }, run: { id: "run-1", status: "CREATING" } }; });
  cursor().intercept({ path: "/v1/agents/bc-1/runs/run-1", method: "GET" }).reply(200, {
    id: "run-1", status: "FINISHED", result: "Fixed the redirect.", git: { branches: [{ repoUrl: "github.com/acme/app", branch: "cursor/fix", prUrl: "https://github.com/acme/app/pull/3" }] },
  });
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@cursor the login page 404s" })).json()).message;
  expect(made).toMatchObject({ repos: [{ url: "https://github.com/acme/app" }], autoCreatePR: true, model: { id: "composer-2" } });
  expect(made.prompt.text).toContain("the login page 404s");
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual([
    "On it. I'll answer here when I'm done.",
    "Fixed the redirect.\n\nhttps://github.com/acme/app/pull/3",
  ]);
  expect((await teammate("cursor")).spentThisMonth).toBe(1);

  // Still busy with the last run: said so, nothing counted.
  cursor().intercept({ path: "/v1/agents/bc-1/runs", method: "POST" }).reply(409, { code: "agent_busy", message: "Agent is busy" });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@cursor and the signup page", parentId: posted.id });
  expect((await thread(mika, posted.id)).map((m) => m.body).slice(-1)).toEqual(["I'm still working on the last request in this thread. Ask again once I've answered."]);
  expect((await teammate("cursor")).spentThisMonth).toBe(1);
  // Free again: a new run on the same agent.
  cursor().intercept({ path: "/v1/agents/bc-1/runs", method: "POST" }).reply(202, { run: { id: "run-2", status: "CREATING" } });
  cursor().intercept({ path: "/v1/agents/bc-1/runs/run-2", method: "GET" }).reply(200, { id: "run-2", status: "FINISHED", result: "Fixed the signup page too, same PR.", git: { branches: [{ prUrl: "https://github.com/acme/app/pull/3" }] } });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@cursor and the signup page", parentId: posted.id });
  expect((await thread(mika, posted.id)).map((m) => m.body).slice(-2)).toEqual(["Picking this up where we left off.", "Fixed the signup page too, same PR.\n\nhttps://github.com/acme/app/pull/3"]);
  expect((await teammate("cursor")).spentThisMonth).toBe(2);
  // The month's two tasks are used.
  const again = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@cursor one more thing" })).json()).message;
  expect((await thread(mika, again.id)).map((m) => m.body)).toEqual(["I've reached this workspace's monthly spending limit for me. An admin can raise it in Studio → AI teammates."]);
});

test("a bad Cursor or Devin key is said plainly", async () => {
  cursor().intercept({ path: "/v1/me", method: "GET" }).reply(401, { message: "Invalid API key" });
  const c = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "cursor", enabled: true, apiKey: "bad", repos: ["acme/app"] });
  expect((await c.json()).message).toBe("Cursor did not accept that API key.");
  devin().intercept({ path: "/v3/organizations/org-nope/sessions?first=1", method: "GET" }).reply(404, { detail: "Not found" });
  const d = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "devin", enabled: true, apiKey: "cog_x", account: "org-nope" });
  expect((await d.json()).message).toBe("Devin did not find that organization ID.");
});

test("Codex: through GitHub, @codex opens a draft pull request, asks Codex there, and brings its reply back", async () => {
  // No key of its own: a GitHub token that can push to the repository.
  const bare = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "codex", enabled: true, repos: ["acme/app"] });
  expect((await bare.json()).message).toBe("Add a GitHub token that can push to the repository Codex works in.");
  github().intercept({ path: "/user", method: "GET" }).reply(200, { login: "toru-bot" });
  github().intercept({ path: "/repos/acme/app", method: "GET" }).reply(200, { default_branch: "main", permissions: { push: false } });
  const readOnly = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "codex", enabled: true, githubToken: "ghp_ro", repos: ["acme/app"] });
  expect((await readOnly.json()).message).toBe("That GitHub token cannot push to acme/app.");
  github().intercept({ path: "/user", method: "GET", headers: { authorization: "Bearer ghp_codex" } }).reply(200, { login: "toru-bot" });
  github().intercept({ path: "/repos/acme/app", method: "GET" }).reply(200, { default_branch: "main", permissions: { push: true } });
  const res = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "codex", enabled: true, githubToken: "ghp_codex", repos: ["acme/app"] });
  expect(res.status).toBe(200);
  const set = (await res.json()).teammate;
  expect(set).toMatchObject({ enabled: true, unit: "task", handle: "codex", hasKey: true, needs: { apiKey: false, githubToken: true } });
  expect(JSON.stringify(set)).not.toContain("ghp_codex");

  // @codex: an empty commit on a codex/ branch, a draft pull request, and
  // the task as an @codex comment on it.
  let pr = null; let asked = null; let ref = null;
  github().intercept({ path: "/repos/acme/app/git/ref/heads/main", method: "GET" }).reply(200, { object: { sha: "base1" } });
  github().intercept({ path: "/repos/acme/app/git/commits/base1", method: "GET" }).reply(200, { sha: "base1", tree: { sha: "tree1" } });
  github().intercept({ path: "/repos/acme/app/git/commits", method: "POST" }).reply(201, (opts) => { expect(JSON.parse(opts.body)).toMatchObject({ tree: "tree1", parents: ["base1"] }); return { sha: "empty1" }; });
  github().intercept({ path: "/repos/acme/app/git/refs", method: "POST" }).reply(201, (opts) => { ref = JSON.parse(opts.body); return { ref: ref.ref }; });
  github().intercept({ path: "/repos/acme/app/pulls", method: "POST" }).reply(201, (opts) => { pr = JSON.parse(opts.body); return { number: 42 }; });
  github().intercept({ path: "/repos/acme/app/issues/42/comments", method: "POST" }).reply(201, (opts) => { asked = JSON.parse(opts.body); return { id: 1000 }; });
  // The first look: only what was there before.
  github().intercept({ path: "/repos/acme/app/issues/42/comments?per_page=100&page=1", method: "GET" }).reply(200, [
    { id: 1000, user: { login: "toru-bot" }, body: "@codex ..." },
  ]);
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@codex the login page 404s" }, { TEAMMATE_WATCH_MS: "0" })).json()).message;
  expect(ref.ref).toMatch(/^refs\/heads\/codex\/honmaru-/);
  expect(ref.sha).toBe("empty1");
  expect(pr).toMatchObject({ base: "main", draft: true, head: ref.ref.replace("refs/heads/", "") });
  expect(asked.body.startsWith("@codex ")).toBe(true);
  expect(asked.body).toContain("the login page 404s");
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual(["On it. I'll answer here when I'm done."]);

  // Codex answers on the pull request; the cron brings it back once.
  github().intercept({ path: "/repos/acme/app/issues/42/comments?per_page=100&page=1", method: "GET" }).reply(200, [
    { id: 1000, user: { login: "toru-bot" }, body: "@codex ..." },
    { id: 1001, user: { login: "someone" }, body: "+1" },
    { id: 1002, user: { login: "chatgpt-codex-connector[bot]" }, body: "Fixed the redirect and pushed to this pull request." },
  ]);
  await watchTeammateRuns(env);
  await watchTeammateRuns(env);
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual([
    "On it. I'll answer here when I'm done.",
    "Fixed the redirect and pushed to this pull request.\n\nhttps://github.com/acme/app/pull/42",
  ]);
  expect((await teammate("codex")).spentThisMonth).toBe(1);

  // A follow-up is another @codex comment; only what came after it is posted.
  let again = null;
  github().intercept({ path: "/repos/acme/app/issues/42/comments", method: "POST" }).reply(201, (opts) => { again = JSON.parse(opts.body); return { id: 1003 }; });
  github().intercept({ path: "/repos/acme/app/issues/42/comments?per_page=100&page=1", method: "GET" }).reply(200, [
    { id: 1002, user: { login: "chatgpt-codex-connector[bot]" }, body: "Fixed the redirect and pushed to this pull request." },
    { id: 1003, user: { login: "toru-bot" }, body: "@codex Mika: add a test" },
    { id: 1004, user: { login: "chatgpt-codex-connector[bot]" }, body: "Added a test in https://github.com/acme/app/pull/42." },
  ]);
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@codex add a test", parentId: posted.id });
  expect(again).toEqual({ body: "@codex Mika: add a test" });
  expect((await thread(mika, posted.id)).map((m) => m.body).slice(-2)).toEqual(["Picking this up where we left off.", "Added a test in https://github.com/acme/app/pull/42."]);
  expect((await teammate("codex")).spentThisMonth).toBe(2);
});

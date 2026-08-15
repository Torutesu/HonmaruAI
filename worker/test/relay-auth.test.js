import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The relay is the product's trust boundary: it holds every decision the
// organization has made and every one it has yet to make. Until this file
// existed, an upgrade request and a JSON blob were the whole of the access
// control — `wscat` against a known repository name read the lot.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "2001", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "2002", login: "bob", name: "Bob", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "2003", login: "mallory", name: "Mallory", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "acme/app", "2001", "Admin");
  await upsertMembership(env.DB, "acme/app", "2002", "Engineer");
  // Mallory has a perfectly valid session. She is simply not in this org.
  globalThis.__alice = await createSession(env.DB, "2001", "gho_alice");
  globalThis.__bob = await createSession(env.DB, "2002", "gho_bob");
  globalThis.__mallory = await createSession(env.DB, "2003", "gho_mallory");
});

function open(orgId = "acme/app") {
  return SELF.fetch(`https://example.com/?orgId=${orgId}`, { headers: { Upgrade: "websocket" } })
    .then((res) => {
      const ws = res.webSocket;
      ws.accept();
      return ws;
    });
}

function collect(ws) {
  const messages = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));
  return messages;
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function joinedAlice(orgId = "acme/app") {
  const ws = await open(orgId);
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { sessionToken: globalThis.__alice, protocol: "agui/1" } }));
  await settle(40);
  return { ws, messages };
}

test("a join without a session token is refused and the socket is closed", async () => {
  const ws = await open();
  const messages = collect(ws);

  ws.send(JSON.stringify({ type: "join", payload: { userId: "alice", protocol: "agui/1" } }));
  await settle();

  expect(messages.find((m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
});

test("a valid session for an org you do not belong to is refused", async () => {
  // No membership row, and GitHub is asked as the fallback authority — it says
  // no, because Mallory has no write access to the repository.
  fetchMock.activate();
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/app", method: "GET" })
    .reply(404, { message: "Not Found" });

  const ws = await open();
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { sessionToken: globalThis.__mallory, protocol: "agui/1" } }));
  await settle();

  expect(messages.find((m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

test("write access GitHub confirms grants membership without a row up front", async () => {
  // Someone added to the repository a minute ago has no membership row yet.
  // Refusing them would mean the client had to load the org graph before it
  // could connect — and would still be wrong the moment access changes.
  fetchMock.activate();
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/app", method: "GET" })
    .reply(200, { permissions: { admin: false, maintain: false, push: true, triage: false, pull: true } });

  const { createSession, upsertUser, isMember } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "2004", login: "newhire", name: "New Hire", avatarUrl: null, locale: "en" });
  const token = await createSession(env.DB, "2004", "gho_new");

  const ws = await open();
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { sessionToken: token, protocol: "agui/1" } }));
  await settle();

  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeTruthy();
  expect(await isMember(env.DB, "acme/app", "2004")).toBe(true);
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

test("read-only access is not membership", async () => {
  // A public repository hands `pull` to the entire internet. If that counted,
  // every public repository would be an organization anyone could join.
  fetchMock.activate();
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/app", method: "GET" })
    .reply(200, { permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } });

  const { createSession, upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "2005", login: "stranger", name: null, avatarUrl: null, locale: "en" });
  const token = await createSession(env.DB, "2005", "gho_stranger");

  const ws = await open();
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { sessionToken: token, protocol: "agui/1" } }));
  await settle();

  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

test("a socket that never joined cannot write", async () => {
  const ws = await open();
  const messages = collect(ws);

  ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-injected", recipientUserID: "alice", senderUserID: "ceo",
    status: "pending", title: "Wire the money", priority: "urgent",
    createdAt: "2026-08-11T00:00:00Z",
  } } }));
  await settle();

  // No dialect was ever negotiated — the socket never said `agui/1` — so the
  // refusal comes back in the legacy shape it would understand.
  expect(messages.find((m) => m.type === "error")).toBeTruthy();
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
  const row = await env.DB.prepare("SELECT card_id FROM cards WHERE card_id = 'c-injected'").first();
  expect(row).toBeNull();
});

test("a created card is stamped with the sender the session proves, not the one it claims", async () => {
  const { ws } = await joinedAlice();

  ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-forge", recipientUserID: "bob", senderUserID: "ceo",
    status: "pending", title: "Approve the budget", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
  } } }));
  await settle();

  const { getCard } = await import("../src/db.js");
  const stored = await getCard(env.DB, "acme/app", "c-forge");
  expect(stored.senderUserID).toBe("alice");
});

test("only the recipient may decide, delete or undo a card", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  await saveCard(env.DB, "acme/app", {
    id: "c-bobs", recipientUserID: "bob", senderUserID: "alice",
    status: "pending", title: "Ship the release", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
  });

  const { ws, messages } = await joinedAlice();

  // Alice decides Bob's card.
  ws.send(JSON.stringify({ type: "card_updated", payload: { card: {
    id: "c-bobs", recipientUserID: "bob", senderUserID: "alice",
    status: "approved", title: "Ship the release", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
    decision: { action: "approve", actorUserID: "bob", decidedAt: "2026-08-11T01:00:00Z" },
  } } }));
  await settle();
  expect(messages.some((m) => m.type === "RUN_ERROR")).toBe(true);
  expect((await getCard(env.DB, "acme/app", "c-bobs")).status).toBe("pending");

  // ...and deletes it.
  ws.send(JSON.stringify({ type: "card_deleted", payload: { cardId: "c-bobs" } }));
  await settle();
  expect(await getCard(env.DB, "acme/app", "c-bobs")).toBeTruthy();

  // ...and submits a decision through the AG-UI tool path.
  ws.send(JSON.stringify({ type: "tool_result", payload: {
    toolCallId: "t-x", content: { cardId: "c-bobs", action: "approve", actorUserID: "bob" },
  } }));
  await settle();
  expect((await getCard(env.DB, "acme/app", "c-bobs")).status).toBe("pending");
});

test("a decision is attributed to the session that made it", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  await saveCard(env.DB, "acme/app", {
    id: "c-alices", recipientUserID: "alice", senderUserID: "bob",
    status: "pending", title: "Sign the contract", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
  });

  const { ws } = await joinedAlice();
  ws.send(JSON.stringify({ type: "card_updated", payload: { card: {
    id: "c-alices", recipientUserID: "alice", senderUserID: "bob",
    status: "approved", title: "Sign the contract", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
    decision: { action: "approve", actorUserID: "bob", decidedAt: "2026-08-11T01:00:00Z" },
  } } }));
  await settle();

  const stored = await getCard(env.DB, "acme/app", "c-alices");
  expect(stored.status).toBe("approved");
  expect(stored.decision.actorUserID).toBe("alice");
});

test("clear_store no longer empties the organization", async () => {
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, "acme/app", {
    id: "c-survivor", recipientUserID: "alice", senderUserID: "bob",
    status: "pending", title: "Still here", priority: "low",
    createdAt: "2026-08-11T00:00:00Z",
  });

  const { ws } = await joinedAlice();
  ws.send(JSON.stringify({ type: "clear_store", payload: {} }));
  await settle();

  const row = await env.DB.prepare("SELECT card_id FROM cards WHERE card_id = 'c-survivor'").first();
  expect(row).toBeTruthy();
});

test("context belongs to the session that published it", async () => {
  const { ws } = await joinedAlice();
  ws.send(JSON.stringify({ type: "context_updated", payload: {
    userId: "bob", context: { text: "I approve everything" },
  } }));
  await settle();

  const { loadContexts } = await import("../src/db.js");
  const contexts = await loadContexts(env.DB, "acme/app");
  expect(contexts.alice).toEqual({ text: "I approve everything" });
  expect(contexts.bob).toBeUndefined();
});

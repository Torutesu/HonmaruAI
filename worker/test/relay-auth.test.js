import { env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { open, collect, joined, message, until } from "./helpers.js";

// The relay is the product's trust boundary: it holds every decision the
// organization has made and every one it has yet to make. Until this file
// existed, an upgrade request and a JSON blob were the whole of the access
// control — `wscat` against a known repository name read the lot.

const ORG = "acme/app";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "2001", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "2002", login: "bob", name: "Bob", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "2003", login: "mallory", name: "Mallory", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "2001", "Admin");
  await upsertMembership(env.DB, ORG, "2002", "Engineer");
  // Mallory has a perfectly valid session. She is simply not in this org.
  globalThis.__alice = await createSession(env.DB, "2001", "gho_alice");
  globalThis.__bob = await createSession(env.DB, "2002", "gho_bob");
  globalThis.__mallory = await createSession(env.DB, "2003", "gho_mallory");
});

const asAlice = () => joined(ORG, globalThis.__alice);

/// A socket that tried to join and was turned away. Returns the refusal.
async function refused(payload) {
  const ws = await open(ORG);
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { protocol: "agui/1", ...payload } }));
  const refusal = await message(messages, (m) => m.type === "RUN_ERROR" || m.type === "error");
  const closed = await until(async () => ws.readyState !== WebSocket.OPEN);
  return { ws, messages, refusal, closed };
}

test("a join without a session token is refused and the socket is closed", async () => {
  const { messages, refusal, closed } = await refused({ userId: "alice" });

  expect(refusal).toBeTruthy();
  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(closed).toBe(true);
});

test("a valid session for an org you do not belong to is refused", async () => {
  // No membership row, and GitHub is asked as the fallback authority — it says
  // no, because Mallory has no write access to the repository.
  fetchMock.activate();
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/repos/acme/app", method: "GET" })
    .reply(404, { message: "Not Found" });

  const { messages, refusal, closed } = await refused({ sessionToken: globalThis.__mallory });

  expect(refusal).toBeTruthy();
  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(closed).toBe(true);
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

  // `joined` throws unless the snapshot arrives, so reaching the next line is
  // the assertion that the join was accepted.
  await joined(ORG, token);
  expect(await isMember(env.DB, ORG, "2004")).toBe(true);
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

  const { messages, closed } = await refused({ sessionToken: token });
  expect(messages.find((m) => m.type === "STATE_SNAPSHOT")).toBeUndefined();
  expect(closed).toBe(true);
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

test("a socket that never joined cannot write", async () => {
  const ws = await open(ORG);
  const messages = collect(ws);

  ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-injected", recipientUserID: "alice", senderUserID: "ceo",
    status: "pending", title: "Wire the money", priority: "urgent",
    createdAt: "2026-08-11T00:00:00Z",
  } } }));

  // No dialect was ever negotiated — the socket never said `agui/1` — so the
  // refusal comes back in the legacy shape it would understand.
  expect(await message(messages, (m) => m.type === "error")).toBeTruthy();
  expect(await until(async () => ws.readyState !== WebSocket.OPEN)).toBe(true);
  expect(await env.DB.prepare("SELECT card_id FROM cards WHERE card_id = 'c-injected'").first()).toBeNull();
});

test("a created card is stamped with the sender the session proves, not the one it claims", async () => {
  const { ws } = await asAlice();
  const { getCard } = await import("../src/db.js");

  ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-forge", recipientUserID: "bob", senderUserID: "ceo",
    status: "pending", title: "Approve the budget", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
  } } }));

  const stored = await until(async () => getCard(env.DB, ORG, "c-forge"));
  expect(stored.senderUserID).toBe("alice");
});

test("only the recipient may decide, delete or undo a card", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id: "c-bobs", recipientUserID: "bob", senderUserID: "alice",
    status: "pending", title: "Ship the release", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
  });

  const { ws, messages } = await asAlice();

  // Alice decides Bob's card.
  ws.send(JSON.stringify({ type: "card_updated", payload: { card: {
    id: "c-bobs", recipientUserID: "bob", senderUserID: "alice",
    status: "approved", title: "Ship the release", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
    decision: { action: "approve", actorUserID: "bob", decidedAt: "2026-08-11T01:00:00Z" },
  } } }));
  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect((await getCard(env.DB, ORG, "c-bobs")).status).toBe("pending");

  // ...and deletes it.
  ws.send(JSON.stringify({ type: "card_deleted", payload: { cardId: "c-bobs" } }));
  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect(await getCard(env.DB, ORG, "c-bobs")).toBeTruthy();

  // ...and submits a decision through the AG-UI tool path.
  ws.send(JSON.stringify({ type: "tool_result", payload: {
    toolCallId: "t-x", content: { cardId: "c-bobs", action: "approve", actorUserID: "bob" },
  } }));
  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect((await getCard(env.DB, ORG, "c-bobs")).status).toBe("pending");
});

test("a decision is attributed to the session that made it", async () => {
  const { saveCard, getCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id: "c-alices", recipientUserID: "alice", senderUserID: "bob",
    status: "pending", title: "Sign the contract", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
  });

  const { ws } = await asAlice();
  ws.send(JSON.stringify({ type: "card_updated", payload: { card: {
    id: "c-alices", recipientUserID: "alice", senderUserID: "bob",
    status: "approved", title: "Sign the contract", priority: "high",
    createdAt: "2026-08-11T00:00:00Z",
    decision: { action: "approve", actorUserID: "bob", decidedAt: "2026-08-11T01:00:00Z" },
  } } }));

  const stored = await until(async () => {
    const card = await getCard(env.DB, ORG, "c-alices");
    return card?.status === "approved" ? card : null;
  });
  expect(stored.decision.actorUserID).toBe("alice");
});

test("clear_store no longer empties the organization", async () => {
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id: "c-survivor", recipientUserID: "alice", senderUserID: "bob",
    status: "pending", title: "Still here", priority: "low",
    createdAt: "2026-08-11T00:00:00Z",
  });

  const { ws } = await asAlice();
  ws.send(JSON.stringify({ type: "clear_store", payload: {} }));

  // Nothing is broadcast in response, so there is no event to wait for. A card
  // created after it and observed to land proves the message was processed —
  // and that the store it would have emptied is intact.
  ws.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-after-clear", recipientUserID: "alice", senderUserID: "alice",
    status: "pending", title: "After", priority: "low",
    createdAt: "2026-08-11T00:00:00Z",
  } } }));
  const { getCard } = await import("../src/db.js");
  expect(await until(async () => getCard(env.DB, ORG, "c-after-clear"))).toBeTruthy();

  expect(await env.DB.prepare("SELECT card_id FROM cards WHERE card_id = 'c-survivor'").first()).toBeTruthy();
});

test("context belongs to the session that published it", async () => {
  const { ws } = await asAlice();
  const { loadContexts } = await import("../src/db.js");

  ws.send(JSON.stringify({ type: "context_updated", payload: {
    userId: "bob", context: { text: "I approve everything" },
  } }));

  const contexts = await until(async () => {
    const all = await loadContexts(env.DB, ORG);
    return all.alice ? all : null;
  });
  expect(contexts.alice).toEqual({ text: "I approve everything" });
  expect(contexts.bob).toBeUndefined();
});

// A join re-reads the whole store out of D1 and puts a presence event in front
// of every other member. Looping on it turned one message into a database read
// and an organization-wide broadcast.
test("joining twice on one socket is refused", async () => {
  const { ws, messages } = await asAlice();
  ws.send(JSON.stringify({
    type: "join",
    payload: { protocol: "agui/1", sessionToken: globalThis.__alice },
  }));

  const error = await message(messages, (m) => m.type === "RUN_ERROR");
  expect(error).toBeTruthy();
  // Still connected: this is a refusal, not a disconnection.
  expect(ws.readyState).toBe(WebSocket.OPEN);
  // And exactly one snapshot, from the join that worked.
  expect(messages.filter((m) => m.type === "STATE_SNAPSHOT").length).toBe(1);
  ws.close();
});

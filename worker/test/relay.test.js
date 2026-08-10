import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, setConnectorConfig } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "1001", login: "realdev", name: "Real Dev", avatarUrl: "http://a", locale: "en" });
  globalThis.__sessionToken = await createSession(env.DB, "1001", "gho_x");
  // realdev connected Notion and picked a database, so their decisions attempt a
  // Notion write — the non-blocking test below leans on that.
  await setConnectorConfig(env.DB, "1001", "notion", { databaseId: "db-relay" });
});

function open(orgId = "core-team") {
  return SELF.fetch(`https://example.com/?orgId=${orgId}`, {
    headers: { Upgrade: "websocket" },
  }).then((res) => {
    const ws = res.webSocket;
    ws.accept();
    return ws;
  });
}

test("join then a created card round-trips to a second client", async () => {
  const a = await open();
  const b = await open();
  const bMessages = [];
  b.addEventListener("message", (e) => bMessages.push(JSON.parse(e.data)));

  a.send(JSON.stringify({ type: "join", payload: { userId: "user-toru", protocol: "agui/1" } }));
  b.send(JSON.stringify({ type: "join", payload: { userId: "user-yui", protocol: "agui/1" } }));

  a.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-relay", recipientUserID: "user-yui", senderUserID: "user-toru",
    status: "pending", title: "Approve deploy", priority: "high", createdAt: "2026-08-08T00:00:00Z",
  } } }));

  await new Promise((r) => setTimeout(r, 50));
  const delta = bMessages.find((m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("c-relay"));
  expect(delta).toBeTruthy();
});

test("join with a sessionToken uses the session's real user id, not the payload", async () => {
  const b = await open();               // observer joins first
  const bMessages = [];
  b.addEventListener("message", (e) => bMessages.push(JSON.parse(e.data)));
  b.send(JSON.stringify({ type: "join", payload: { userId: "observer", protocol: "agui/1" } }));
  await new Promise((r) => setTimeout(r, 30));

  const a = await open();               // A joins with a spoofed userId but a real session token
  a.send(JSON.stringify({ type: "join", payload: { userId: "spoofed", sessionToken: globalThis.__sessionToken, protocol: "agui/1" } }));
  await new Promise((r) => setTimeout(r, 60));

  const presence = bMessages.find(
    (m) => (m.type === "presence" && m.payload?.userId) || (m.type === "CUSTOM" && m.name === "presence")
  );
  const asText = JSON.stringify(bMessages);
  expect(asText).toContain("realdev");   // resolved login was broadcast
  expect(asText).not.toContain("spoofed"); // the spoofed id never appears
});

test("a decision broadcasts and is audited even while the Notion write is slow", async () => {
  // The design's promise: a Notion failure — or a slow Notion — must never
  // break OR stall the decision. If the relay awaited the write, this slow
  // interceptor (a full second) would delay the STATE_DELTA past our 100ms
  // check. Because it goes through waitUntil, the broadcast and audit land
  // immediately and the write settles afterward. The interceptor is still
  // registered and consumed, so assertNoPendingInterceptors confirms the write
  // was in fact attempted (not silently skipped).
  fetchMock.activate();
  let notionCalled = false;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST",
      body: () => { notionCalled = true; return true; } })
    .reply(200, { successful: true, data: { id: "page-relay-1" } })
    .delay(1000);

  const a = await open("notion-org");
  const b = await open("notion-org");
  const bMessages = [];
  b.addEventListener("message", (e) => bMessages.push(JSON.parse(e.data)));

  // A joins with the real session so its login resolves to realdev (github 1001),
  // the user who configured a Notion database above.
  a.send(JSON.stringify({ type: "join", payload: { userId: "spoof", sessionToken: globalThis.__sessionToken, protocol: "agui/1" } }));
  b.send(JSON.stringify({ type: "join", payload: { userId: "watcher", protocol: "agui/1" } }));
  await new Promise((r) => setTimeout(r, 40));

  a.send(JSON.stringify({ type: "card_updated", payload: { card: {
    id: "c-decided", recipientUserID: "watcher", senderUserID: "realdev",
    status: "approved", title: "Approve the deploy", priority: "high",
    createdAt: "2026-08-10T00:00:00Z",
    decision: { action: "approve", actorUserID: "realdev", decidedAt: "2026-08-10T02:00:00Z" },
  } } }));

  // Well before the 1s Notion delay could resolve, the broadcast must be out...
  await new Promise((r) => setTimeout(r, 100));
  const delta = bMessages.find((m) => JSON.stringify(m).includes("c-decided"));
  expect(delta).toBeTruthy();

  // ...and the audit event must already be persisted.
  const { appendCardEvent } = await import("../src/events.js"); // touch to ensure module cached
  void appendCardEvent;
  const eventRow = await env.DB
    .prepare("SELECT type, action FROM card_events WHERE org_id='notion-org' AND card_id='c-decided'")
    .first();
  expect(eventRow).toMatchObject({ type: "decided", action: "approve" });

  // Let the deferred Notion write settle so the interceptor is consumed.
  await new Promise((r) => setTimeout(r, 1100));
  expect(notionCalled).toBe(true);
  fetchMock.assertNoPendingInterceptors();
});

test("a bad submit sends RUN_ERROR to the sender without closing the socket", async () => {
  const a = await open();
  const aMessages = [];
  a.addEventListener("message", (e) => aMessages.push(JSON.parse(e.data)));

  a.send(JSON.stringify({ type: "join", payload: { userId: "user-toru", protocol: "agui/1" } }));
  a.send(JSON.stringify({
    type: "tool_result",
    payload: { toolCallId: "t-1", content: { cardId: "does-not-exist", action: "delete" } },
  }));

  await new Promise((r) => setTimeout(r, 50));
  const err = aMessages.find((m) => m.type === "RUN_ERROR");
  expect(err).toBeTruthy();
  expect(err.message).toContain("does-not-exist");
  expect(a.readyState).toBe(WebSocket.OPEN);
});

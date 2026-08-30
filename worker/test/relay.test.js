import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, messageContaining, until, untilNoThrow } from "./helpers.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, setConnectorConfig } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "1001", login: "realdev", name: "Real Dev", avatarUrl: "http://a", locale: "en" });
  await upsertUser(env.DB, { githubId: "1002", login: "watcher", name: "Watcher", avatarUrl: "http://b", locale: "en" });
  for (const orgId of ["core-team", "notion-org"]) {
    await upsertMembership(env.DB, orgId, "1001", "Admin");
    await upsertMembership(env.DB, orgId, "1002", "Engineer");
  }
  globalThis.__tokenA = await createSession(env.DB, "1001", "gho_x");
  globalThis.__tokenB = await createSession(env.DB, "1002", "gho_y");
  // realdev connected Notion and picked a database, so their decisions attempt a
  // Notion write — the non-blocking test below leans on that.
  await setConnectorConfig(env.DB, "1001", "notion", { databaseId: "db-relay" });
});

test("join then a created card round-trips to a second client", async () => {
  const { ws: a } = await joined("core-team", globalThis.__tokenA);
  const { messages: bMessages } = await joined("core-team", globalThis.__tokenB);

  a.send(JSON.stringify({ type: "card_created", payload: { card: {
    id: "c-relay", recipientUserID: "watcher", senderUserID: "realdev",
    status: "pending", title: "Approve deploy", priority: "high", createdAt: "2026-08-08T00:00:00Z",
  } } }));

  const delta = await message(
    bMessages,
    (m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("c-relay")
  );
  expect(delta).toBeTruthy();
});

test("join uses the session's real user id, not the payload", async () => {
  const { messages: bMessages } = await joined("core-team", globalThis.__tokenB);

  // A joins with a spoofed userId alongside a real session token.
  const { ws: a } = await joined("core-team", globalThis.__tokenA);
  a.send(JSON.stringify({ type: "join", payload: { userId: "spoofed", sessionToken: globalThis.__tokenA, protocol: "agui/1" } }));

  expect(await messageContaining(bMessages, "realdev")).toBeTruthy();
  expect(JSON.stringify(bMessages)).not.toContain("spoofed");
});

test("a decision broadcasts and is audited even while the Notion write is slow", async () => {
  // The design's promise: a Notion failure — or a slow Notion — must never
  // break OR stall the decision. The interceptor below takes a full second; if
  // the relay awaited the write, the broadcast and the audit row would both
  // arrive after it. Because it goes through waitUntil they land first, and the
  // write settles behind them. assertNoPendingInterceptors then confirms the
  // write was in fact attempted rather than silently skipped.
  fetchMock.activate();
  let notionCalled = false;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST",
      body: () => { notionCalled = true; return true; } })
    .reply(200, { successful: true, data: { id: "page-relay-1" } })
    .delay(1000);

  const { ws: a } = await joined("notion-org", globalThis.__tokenA);   // realdev, who configured Notion
  const { messages: bMessages } = await joined("notion-org", globalThis.__tokenB);

  // realdev decides a card addressed to realdev — the only card anyone is
  // allowed to decide is their own.
  a.send(JSON.stringify({ type: "card_updated", payload: { card: {
    id: "c-decided", recipientUserID: "realdev", senderUserID: "watcher",
    status: "approved", title: "Approve the deploy", priority: "high",
    createdAt: "2026-08-10T00:00:00Z",
    decision: { action: "approve", actorUserID: "realdev", decidedAt: "2026-08-10T02:00:00Z" },
  } } }));

  // Bounded on purpose: 300ms, against a Notion reply held for a full second.
  // A generous budget would let a broadcast that *is* blocked on the write pass
  // anyway, which is the one thing this test exists to catch.
  expect(await messageContaining(bMessages, "c-decided", 15)).toBeTruthy();

  const eventRow = await until(async () =>
    env.DB.prepare("SELECT type, action FROM card_events WHERE org_id='notion-org' AND card_id='c-decided'").first()
  , 15);
  expect(eventRow).toMatchObject({ type: "decided", action: "approve" });

  // The request goes out immediately; it is the reply that is held, so
  // `notionCalled` proves the write was attempted, not that it finished.
  expect(notionCalled).toBe(true);
  // Finishing is what frees the interceptor, so waiting for that is waiting for
  // the deferred write to settle.
  expect(await untilNoThrow(() => fetchMock.assertNoPendingInterceptors())).toBe(true);
});

test("a bad submit sends RUN_ERROR to the sender without closing the socket", async () => {
  const { ws: a, messages: aMessages } = await joined("core-team", globalThis.__tokenA);

  a.send(JSON.stringify({
    type: "tool_result",
    payload: { toolCallId: "t-1", content: { cardId: "does-not-exist", action: "delete" } },
  }));

  const err = await message(aMessages, (m) => m.type === "RUN_ERROR");
  expect(err).toBeTruthy();
  expect(err.message).toContain("does-not-exist");
  expect(a.readyState).toBe(WebSocket.OPEN);
});

// The app used to announce a decision by republishing the whole card
// (`card_updated`); it now answers the `request_decision` tool call instead.
// The Notion write hung off the old path only, so making that switch without
// this would have quietly stopped writing decisions to the database people
// deliberately connected — with nothing failing to show for it.
test("a decision sent as tool_result is written to Notion, same as card_updated", async () => {
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, "notion-org", {
    id: "c-toolresult", recipientUserID: "realdev", senderUserID: "watcher",
    status: "pending", title: "Approve the rollout", priority: "high",
    createdAt: "2026-08-10T00:00:00Z",
  });

  fetchMock.activate();
  let notionCalled = false;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST",
      body: () => { notionCalled = true; return true; } })
    .reply(200, { successful: true, data: { id: "page-toolresult-1" } });

  const { ws: a } = await joined("notion-org", globalThis.__tokenA);   // realdev, who configured Notion

  a.send(JSON.stringify({ type: "tool_result", payload: {
    toolCallId: "tc-1",
    content: { cardId: "c-toolresult", action: "approve", actorUserID: "realdev", decidedAt: "2026-08-10T02:00:00Z" },
  } }));

  const eventRow = await until(async () =>
    env.DB.prepare("SELECT type, action FROM card_events WHERE org_id='notion-org' AND card_id='c-toolresult'").first()
  );
  expect(eventRow).toMatchObject({ type: "decided", action: "approve" });

  expect(await until(() => notionCalled)).toBe(true);
  expect(await untilNoThrow(() => fetchMock.assertNoPendingInterceptors())).toBe(true);
});

// The public handler forwards to the stub only for `Upgrade: websocket`, so the
// announce path is not reachable from the internet. Pinned because
// "unreachable" is a property of code someone can change.
test("the announce path is not reachable over HTTP", async () => {
  const res = await SELF.fetch("https://example.com/internal/announce?orgId=core-team", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cards: [{ id: "c-injected", recipientUserID: "watcher", status: "pending" }] }),
  });
  expect(res.status).toBe(404);
});

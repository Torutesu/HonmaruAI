import {SELF, env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, messageContaining, until, untilNoThrow } from "./helpers.js";
import { setMode } from "../src/harness/mode.js";

beforeEach(async () => {
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

test("live browser frames and controls stay inside the current private-room membership", async () => {
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "1003", login: "outsider", name: "Outsider", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "core-team", "1003", "Engineer");
  const outsiderToken = await createSession(env.DB, "1003", "gho_outside");
  const channel = "b:browser-private";
  const threadId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const browserContext = { channel, threadId, sourceMessageId: threadId, requesterLogin: "realdev" };
  await env.DB.prepare(`INSERT INTO businesses(org_id,slug,name,created_by,created_at,private)
    VALUES('core-team','browser-private','Private browser room','1001','now',1)`).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES('core-team',?1,'realdev','now')").bind(channel),
    env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES('core-team',?1,'watcher','now')").bind(channel),
    env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at)
      VALUES(?1,'core-team',?2,'realdev','message','Review this page','now')`).bind(threadId, channel),
    env.DB.prepare(`INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at)
      VALUES('browser-node','core-team','Mac mini',?1,'1001',1)`).bind("a".repeat(64)),
    env.DB.prepare(`INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at)
      VALUES(?1,'core-team','browser-node','1001',?2,?3,'running',1)`)
      .bind(jobId, jobId, JSON.stringify({ acp: true, browserTools: true, browserIdentity: "browser-agent", browserContext })),
  ]);
  await setMode(env.DB, "core-team", "harness", "1001");

  const { ws: owner, messages: ownerMessages } = await joined("core-team", globalThis.__tokenA);
  let { ws: secondOwnerTab, messages: secondOwnerMessages } = await joined("core-team", globalThis.__tokenA);
  const { ws: roomMember, messages: memberMessages } = await joined("core-team", globalThis.__tokenB);
  const { ws: outsider, messages: outsiderMessages } = await joined("core-team", outsiderToken);
  owner.send(JSON.stringify({ type: "desktop_join", payload: { jobId } }));
  secondOwnerTab.send(JSON.stringify({ type: "desktop_join", payload: { jobId } }));
  roomMember.send(JSON.stringify({ type: "desktop_join", payload: { jobId } }));
  outsider.send(JSON.stringify({ type: "desktop_join", payload: { jobId } }));
  expect(await message(ownerMessages, m => m.type === "CUSTOM" && m.name === "browser_frame_ready" && m.value?.jobId === jobId)).toMatchObject({ value: { canControl: true } });
  expect(await message(secondOwnerMessages, m => m.type === "CUSTOM" && m.name === "browser_frame_ready" && m.value?.jobId === jobId)).toMatchObject({ value: { canControl: true } });
  expect(await message(memberMessages, m => m.type === "CUSTOM" && m.name === "browser_frame_ready" && m.value?.jobId === jobId)).toMatchObject({ value: { canControl: false } });
  expect(await message(outsiderMessages, m => m.type === "CUSTOM" && m.name === "browser_frame_unavailable" && m.value?.jobId === jobId)).toBeTruthy();

  roomMember.send(JSON.stringify({ type: "desktop_control", payload: { jobId, action: { type: "click", x: 42, y: 84 } } }));
  expect(await message(memberMessages, m => m.type === "CUSTOM" && m.name === "browser_control_rejected" && m.value?.jobId === jobId)).toBeTruthy();
  owner.send(JSON.stringify({ type: "desktop_control", payload: { jobId, action: { type: "click", x: 42, y: 84 } } }));
  expect(await message(ownerMessages, m => m.type === "CUSTOM" && m.name === "browser_control_queued" && m.value?.jobId === jobId)).toBeTruthy();
  secondOwnerTab.send(JSON.stringify({ type: "desktop_control", payload: { jobId, action: { type: "click", x: 43, y: 85 } } }));
  expect(await message(secondOwnerMessages, m => m.type === "CUSTOM" && m.name === "browser_control_rejected" && m.value?.jobId === jobId)).toBeTruthy();

  // The creator's second tab can take over after the active control socket closes.
  owner.close();
  await until(() => owner.readyState === 3);
  secondOwnerTab.send(JSON.stringify({ type: "desktop_control", payload: { jobId, action: { type: "click", x: 44, y: 86 } } }));
  expect(await message(secondOwnerMessages, m => m.type === "CUSTOM" && m.name === "browser_control_queued" && m.value?.jobId === jobId)).toBeTruthy();
  const relay = env.ORG_RELAY.get(env.ORG_RELAY.idFromName("core-team"));
  const controls = await relay.fetch(new Request(`https://relay.invalid/desktop/controls?orgId=core-team`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }),
  }));
  const deliveredControls = await controls.json();
  expect(deliveredControls.controls).toHaveLength(1);
  const [deliveredControl] = deliveredControls.controls;
  expect(deliveredControl).toMatchObject({ action: { type: "click", x: 44, y: 86 }, controllerId: expect.any(String), expiresAt: expect.any(Number) });
  const authorizeControl = () => relay.fetch(new Request(`https://relay.invalid/desktop/authorize-control?orgId=core-team`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId, controllerId: deliveredControl.controllerId, expiresAt: deliveredControl.expiresAt }),
  }));
  expect((await authorizeControl()).status).toBe(200);
  secondOwnerTab.close();
  await until(() => secondOwnerTab.readyState === 3);
  expect((await authorizeControl()).status).toBe(403);
  ({ ws: secondOwnerTab, messages: secondOwnerMessages } = await joined("core-team", globalThis.__tokenA));
  secondOwnerTab.send(JSON.stringify({ type: "desktop_join", payload: { jobId } }));
  expect(await message(secondOwnerMessages, m => m.type === "CUSTOM" && m.name === "browser_frame_ready" && m.value?.jobId === jobId)).toMatchObject({ value: { canControl: true } });

  const sendFrame = () => relay.fetch(new Request(`https://relay.invalid/desktop/frame?orgId=core-team`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, image: "/9j/AA==" }),
  }));
  const firstFrame = await sendFrame();
  expect(firstFrame.status).toBe(200);
  expect(await firstFrame.json()).toEqual({ delivered: 2 });
  expect(secondOwnerMessages.some(m => m.type === "CUSTOM" && m.name === "browser_frame" && m.value?.jobId === jobId)).toBe(true);
  expect(memberMessages.some(m => m.type === "CUSTOM" && m.name === "browser_frame" && m.value?.jobId === jobId)).toBe(true);
  expect(outsiderMessages.some(m => m.type === "CUSTOM" && m.name === "browser_frame" && m.value?.jobId === jobId)).toBe(false);

  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id='core-team' AND channel=?1 AND login='watcher'").bind(channel).run();
  const afterMemberRemoval = await sendFrame();
  expect(await afterMemberRemoval.json()).toEqual({ delivered: 1 });
  expect(memberMessages.filter(m => m.type === "CUSTOM" && m.name === "browser_frame" && m.value?.jobId === jobId)).toHaveLength(1);

  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id='core-team' AND channel=?1 AND login='realdev'").bind(channel).run();
  secondOwnerTab.send(JSON.stringify({ type: "desktop_control", payload: { jobId, action: { type: "click", x: 10, y: 20 } } }));
  expect(await message(secondOwnerMessages, m => m.type === "CUSTOM" && m.name === "browser_control_rejected" && m.value?.jobId === jobId)).toBeTruthy();
  const revokedFrame = await sendFrame();
  expect(revokedFrame.status).toBe(404);
  secondOwnerTab.close();
  roomMember.close();
  outsider.close();
}, 10000);

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

test("a joiner is told who is already online", async () => {
  await joined("core-team", globalThis.__tokenA);
  // B joins after A: without this, B's presence set is empty until somebody
  // else connects or drops — a room that looks empty while someone is in it.
  const { messages: bMessages } = await joined("core-team", globalThis.__tokenB);
  const presence = await message(
    bMessages,
    (m) => m.type === "CUSTOM" && m.name === "presence" && m.value?.userId === "realdev" && m.value?.status === "online"
  );
  expect(presence).toBeTruthy();
});

test("closing one of someone's tabs leaves them online; closing the last takes them offline", async () => {
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "1003", login: "third", name: "Third", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "core-team", "1003", "Engineer");
  const tokenC = await createSession(env.DB, "1003", "gho_z");
  // realdev on two tabs; somebody else in another workspace on a third.
  const { ws: tab1 } = await joined("core-team", globalThis.__tokenA);
  const { ws: tab2 } = await joined("core-team", globalThis.__tokenA);
  await joined("notion-org", globalThis.__tokenA);
  const { ws: c } = await joined("core-team", tokenC);
  const { messages: watching } = await joined("core-team", globalThis.__tokenB);
  const offline = (login) => (m) => m.type === "CUSTOM" && m.name === "presence" && m.value?.userId === login && m.value?.status === "offline";

  // One tab closes, then Third leaves: by Third's offline, the tab's close
  // has been heard too — and said nothing.
  tab1.close();
  c.close();
  expect(await message(watching, offline("third"))).toBeTruthy();
  expect(await message(watching, offline("realdev"), 15)).toBeNull();

  // The last tab here closes: now realdev is offline, although they are
  // still connected to another workspace.
  tab2.close();
  expect(await message(watching, offline("realdev"))).toBeTruthy();
});

test("join is bounded per socket", async () => {
  const { ws, messages } = await joined("core-team", globalThis.__tokenA);
  for (let i = 0; i < 5; i += 1) {
    ws.send(JSON.stringify({ type: "join", payload: { sessionToken: globalThis.__tokenA, protocol: "agui/1" } }));
  }
  const refusal = await message(
    messages,
    (m) => (m.type === "RUN_ERROR" || m.type === "error") &&
      JSON.stringify(m).includes("Too many join attempts")
  );
  expect(refusal).toBeTruthy();
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

  // The card exists before it is decided. An update naming an id the relay
  // has never seen is refused now — it used to be a second way to create a
  // card, one that stamped no sender — so the test seeds what a real client
  // would have created first.
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, "notion-org", {
    id: "c-decided", recipientUserID: "realdev", senderUserID: "watcher",
    status: "pending", title: "Approve the deploy", priority: "high",
    createdAt: "2026-08-10T00:00:00Z",
  });

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

test("a decided card published again writes no second Notion page", async () => {
  const { saveCard } = await import("../src/db.js");
  const pending = { id: "c-again", recipientUserID: "realdev", senderUserID: "watcher", status: "pending", title: "Approve the deploy", priority: "high", createdAt: "2026-08-10T00:00:00Z" };
  await saveCard(env.DB, "notion-org", pending);
  fetchMock.activate();
  let inserts = 0;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST", body: () => { inserts += 1; return true; } })
    .reply(200, { successful: true, data: { id: "page-again" } })
    .persist();
  const { ws: a } = await joined("notion-org", globalThis.__tokenA);
  const decided = { ...pending, status: "approved", decision: { action: "approve", actorUserID: "realdev", decidedAt: "2026-08-10T02:00:00Z" } };
  a.send(JSON.stringify({ type: "card_updated", payload: { card: decided } }));
  expect(await until(() => inserts === 1)).toBe(true);
  // The phone republishes the decided card whole, and again with an
  // unrelated change: neither is a new decision.
  a.send(JSON.stringify({ type: "card_updated", payload: { card: decided } }));
  a.send(JSON.stringify({ type: "card_updated", payload: { card: { ...decided, priority: "low" } } }));
  const events = await until(async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM card_events WHERE org_id='notion-org' AND card_id='c-again'").first();
    return row.n >= 3 ? row.n : null;
  });
  expect(events).toBe(3);
  await new Promise((r) => setTimeout(r, 200));
  expect(inserts).toBe(1);
  fetchMock.deactivate();
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

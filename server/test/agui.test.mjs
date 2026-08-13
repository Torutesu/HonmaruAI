// AG-UI layer tests: unit (adapter/events) + integration (relay speaking
// both dialects at once). Run with `npm test` from server/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { toolCallSequence, EventType } from "../agui/events.js";
import {
  snapshotState,
  upsertEvents,
  removeEvents,
  applyDecision,
} from "../agui/adapter.js";
import { toolManifest, PROTOCOL_VERSION } from "../agui/tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 18641;

/* ---------------- unit: events ---------------- */

test("toolCallSequence emits START / ARGS / END and args reassemble", () => {
  const args = { card: { id: "c1", title: "x".repeat(2000) } };
  const { toolCallId, events } = toolCallSequence("request_decision", args);

  assert.equal(events[0].type, EventType.TOOL_CALL_START);
  assert.equal(events[0].toolCallName, "request_decision");
  assert.equal(events.at(-1).type, EventType.TOOL_CALL_END);

  const argEvents = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
  assert.ok(argEvents.length > 1, "large args should stream in chunks");
  const reassembled = argEvents.map((e) => e.delta).join("");
  assert.deepEqual(JSON.parse(reassembled), args);
  for (const e of events) assert.equal(e.toolCallId, toolCallId);
});

/* ---------------- unit: adapter ---------------- */

test("snapshotState converts store to cardsById", () => {
  const store = {
    alice: [{ id: "c1", recipientUserID: "alice" }],
    bob: [{ id: "c2", recipientUserID: "bob" }],
  };
  assert.deepEqual(Object.keys(snapshotState(store).cardsById).sort(), ["c1", "c2"]);
});

test("upsertEvents: new pending card → patch for all + tool call for recipient", () => {
  const card = { id: "c1", recipientUserID: "alice", status: "pending" };
  const { forEveryone, forRecipient } = upsertEvents(card, { isNew: true });

  assert.equal(forEveryone[0].type, EventType.STATE_DELTA);
  assert.deepEqual(forEveryone[0].delta[0], {
    op: "add",
    path: "/cardsById/c1",
    value: card,
  });
  assert.equal(forRecipient[0].type, EventType.TOOL_CALL_START);
});

test("upsertEvents: update → replace patch, no tool call", () => {
  const { forEveryone, forRecipient } = upsertEvents(
    { id: "c1", recipientUserID: "alice", status: "approved" },
    { isNew: false }
  );
  assert.equal(forEveryone[0].delta[0].op, "replace");
  assert.equal(forRecipient.length, 0);
});

test("JSON Pointer escaping for hostile ids", () => {
  const { forEveryone } = upsertEvents(
    { id: "a/b~c", recipientUserID: "alice" },
    { isNew: true }
  );
  assert.equal(forEveryone[0].delta[0].path, "/cardsById/a~1b~0c");
  assert.equal(removeEvents("a/b~c")[0].delta[0].path, "/cardsById/a~1b~0c");
});

test("applyDecision: approve / choose / reply / delete semantics", () => {
  const mk = () => ({
    alice: [{ id: "c1", recipientUserID: "alice", status: "pending", options: [{ id: "o1" }] }],
  });

  let store = mk();
  let r = applyDecision(store, { cardId: "c1", action: "approve", actorUserID: "alice" });
  assert.equal(r.card.status, "approved");
  assert.equal(r.card.decision.action, "approve");

  store = mk();
  assert.throws(() => applyDecision(store, { cardId: "c1", action: "choose", actorUserID: "alice" }));
  r = applyDecision(store, { cardId: "c1", action: "choose", optionId: "o1", actorUserID: "alice" });
  assert.equal(r.card.decision.optionId, "o1");

  store = mk();
  assert.throws(() => applyDecision(store, { cardId: "c1", action: "reply", actorUserID: "alice" }));
  r = applyDecision(store, { cardId: "c1", action: "reply", replyText: "yes", actorUserID: "alice" });
  assert.equal(r.card.status, "completed");

  store = mk();
  r = applyDecision(store, { cardId: "c1", action: "delete", actorUserID: "alice" });
  assert.equal(r.removed, true);
  assert.equal(store.alice.length, 0);

  assert.throws(() => applyDecision(mk(), { cardId: "nope", action: "approve" }));
});

// Regression: tool_result only carries the decision, not the whole card
// (unlike the legacy card_updated message it replaced), so "revised" and
// "delegate" used to silently leave the card's status at "pending" — the
// server's ACTION_STATUS/DECISION_ACTIONS never knew about either action.
test("applyDecision: revised / delegate set status and apply side effects tool_result carries", () => {
  const mk = () => ({
    alice: [{ id: "c1", recipientUserID: "alice", status: "pending", context: "original context" }],
  });

  let store = mk();
  let r = applyDecision(store, {
    cardId: "c1",
    action: "revised",
    actorUserID: "alice",
    note: "please add error handling",
  });
  assert.equal(r.card.status, "revised");
  assert.equal(r.card.revisionNote, "please add error handling");
  assert.equal(r.card.context, "original context\nRevision: please add error handling");

  store = mk();
  r = applyDecision(store, { cardId: "c1", action: "delegate", actorUserID: "alice" });
  assert.equal(r.card.status, "delegated");

  // GitHub sync fields ride along on the decision content since tool_result
  // doesn't carry the whole card.
  store = mk();
  r = applyDecision(store, {
    cardId: "c1",
    action: "approve",
    actorUserID: "alice",
    githubIssueNumber: 42,
    githubIssueURL: "https://github.com/acme/repo/issues/42",
    githubRepository: "acme/repo",
  });
  assert.equal(r.card.githubIssueNumber, 42);
  assert.equal(r.card.githubIssueURL, "https://github.com/acme/repo/issues/42");
  assert.equal(r.card.githubRepository, "acme/repo");
});

test("tool manifest exposes request_decision", () => {
  const manifest = toolManifest();
  assert.equal(manifest.protocol, PROTOCOL_VERSION);
  assert.equal(manifest.tools[0].name, "request_decision");
  assert.ok(manifest.results.submit_decision);
});

/* ---------------- integration: dual-dialect relay ---------------- */

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, "..", "index.js")], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Relay listening")) resolve(child);
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("relay did not start")), 5000);
  });
}

function connect(joinPayload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join", payload: joinPayload }));
      setTimeout(() => resolve({ ws, received }), 150);
    });
    ws.on("error", reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("relay speaks legacy and AG-UI side by side", async () => {
  const relay = await startRelay();
  try {
    const legacy = await connect({ userId: "user-bob", orgId: "t1" });
    const agui = await connect({ userId: "user-alice", orgId: "t1", protocol: PROTOCOL_VERSION });

    // AG-UI join: RUN_STARTED + STATE_SNAPSHOT; legacy join: snapshot message
    assert.equal(legacy.received[0].type, "snapshot");
    assert.deepEqual(
      agui.received.map((e) => e.type).slice(0, 2),
      [EventType.RUN_STARTED, EventType.STATE_SNAPSHOT]
    );

    // Legacy client creates a card addressed to alice…
    const card = {
      id: "c-int-1",
      recipientUserID: "user-alice",
      senderUserID: "user-bob",
      format: "approve",
      title: "Ship it?",
      priority: "urgent",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    agui.received.length = 0;
    legacy.received.length = 0;
    legacy.ws.send(JSON.stringify({ type: "card_created", payload: { card } }));
    await wait(200);

    // …legacy echo stays legacy; AG-UI recipient gets patch + tool call.
    assert.equal(legacy.received[0].type, "card_created");
    const types = agui.received.map((e) => e.type);
    assert.ok(types.includes(EventType.STATE_DELTA), "state patch");
    assert.ok(types.includes(EventType.TOOL_CALL_START), "request_decision start");
    const start = agui.received.find((e) => e.type === EventType.TOOL_CALL_START);
    assert.equal(start.toolCallName, "request_decision");
    const argJson = agui.received
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
      .map((e) => e.delta)
      .join("");
    assert.equal(JSON.parse(argJson).card.id, "c-int-1");

    // AG-UI client answers via tool_result…
    agui.received.length = 0;
    legacy.received.length = 0;
    agui.ws.send(
      JSON.stringify({
        type: "tool_result",
        payload: {
          toolCallId: start.toolCallId,
          content: { cardId: "c-int-1", action: "approve", actorUserID: "user-alice" },
        },
      })
    );
    await wait(200);

    // …legacy sees card_updated with approved status; AG-UI sees result + patch.
    const legacyUpdate = legacy.received.find((m) => m.type === "card_updated");
    assert.equal(legacyUpdate.payload.card.status, "approved");
    assert.equal(legacyUpdate.payload.card.decision.action, "approve");
    const aguiTypes = agui.received.map((e) => e.type);
    assert.ok(aguiTypes.includes(EventType.TOOL_CALL_RESULT));
    assert.ok(aguiTypes.includes(EventType.STATE_DELTA));

    legacy.ws.close();
    agui.ws.close();
    await wait(100);
  } finally {
    relay.kill();
  }
});

/* ---------------- phase 2: context sync + rollback ---------------- */

test("relay syncs context and rolls back decisions", async () => {
  const relay = await startRelay();
  try {
    const alice = await connect({ userId: "user-alice", orgId: "t2", protocol: PROTOCOL_VERSION });
    const bob = await connect({ userId: "user-bob", orgId: "t2", protocol: PROTOCOL_VERSION });
    const legacy = await connect({ userId: "user-carol", orgId: "t2" });

    // context_updated → other AG-UI clients get STATE_DELTA on /context/<user>
    bob.received.length = 0;
    alice.ws.send(JSON.stringify({
      type: "context_updated",
      payload: { context: { md: "# profile.md — Alice\n- Title: PM" } },
    }));
    await wait(200);
    const ctxDelta = bob.received.find((e) => e.type === EventType.STATE_DELTA);
    assert.ok(ctxDelta, "bob receives context delta");
    assert.equal(ctxDelta.delta[0].path, "/context/user-alice");
    assert.match(ctxDelta.delta[0].value.md, /profile\.md/);

    // late joiner gets context in the snapshot
    const dana = await connect({ userId: "user-dana", orgId: "t2", protocol: PROTOCOL_VERSION });
    const snap = dana.received.find((e) => e.type === EventType.STATE_SNAPSHOT);
    assert.match(snap.snapshot.context["user-alice"].md, /Alice/);

    // create + decide + rollback
    const card = {
      id: "c-rb-1", recipientUserID: "user-alice", senderUserID: "user-bob",
      format: "approve", title: "Ship?", priority: "high", status: "pending",
      createdAt: new Date().toISOString(),
    };
    legacy.ws.send(JSON.stringify({ type: "card_created", payload: { card } }));
    await wait(200);
    alice.ws.send(JSON.stringify({
      type: "tool_result",
      payload: { content: { cardId: "c-rb-1", action: "approve", actorUserID: "user-alice" } },
    }));
    await wait(200);

    bob.received.length = 0;
    legacy.received.length = 0;
    alice.ws.send(JSON.stringify({ type: "rollback", payload: { cardId: "c-rb-1" } }));
    await wait(200);

    // AG-UI peers get the compensating notice + pending patch
    const notice = bob.received.find((e) => e.type === EventType.CUSTOM && e.name === "decision_rolled_back");
    assert.ok(notice, "sender's side is notified");
    assert.equal(notice.value.previousAction, "approve");
    assert.equal(notice.value.senderUserID, "user-bob");
    const patch = bob.received.find((e) => e.type === EventType.STATE_DELTA);
    assert.equal(patch.delta[0].value.status, "pending");
    assert.equal(patch.delta[0].value.decision, undefined);

    // legacy dialect sees a plain card_updated back to pending
    const legacyUpdate = legacy.received.find((m) => m.type === "card_updated");
    assert.equal(legacyUpdate.payload.card.status, "pending");

    // rolling back a pending card fails cleanly
    alice.received.length = 0;
    alice.ws.send(JSON.stringify({ type: "rollback", payload: { cardId: "c-rb-1" } }));
    await wait(200);
    assert.ok(alice.received.some((e) => e.type === EventType.RUN_ERROR));

    for (const c of [alice, bob, dana, legacy]) c.ws.close();
    await wait(100);
  } finally {
    relay.kill();
  }
});

test("relay serves the reference web client", async () => {
  const relay = await startRelay();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/web`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /AG-UI reference client/);
    const manifest = await (await fetch(`http://127.0.0.1:${PORT}/agui/tools`)).json();
    assert.equal(manifest.tools[0].name, "request_decision");
  } finally {
    relay.kill();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryStore,
  recordableTransition,
  heuristicRecommendation,
  recommendDecision,
} from "../memory.js";

test("memory store records, caps at 50, and round-trips", () => {
  const store = createMemoryStore(null);
  for (let i = 0; i < 60; i += 1) {
    store.record("user-alice", { action: "approve", type: "task", senderUserID: "user-bob", title: `t${i}` });
  }
  assert.equal(store.entriesFor("user-alice").length, 50);
  assert.equal(store.entriesFor("user-alice")[49].title, "t59");
  assert.equal(store.record("user-alice", {}), false);

  const restored = createMemoryStore(store.serialize());
  assert.equal(restored.entriesFor("user-alice").length, 50);
});

test("recordableTransition only fires on pending → decided", () => {
  assert.equal(recordableTransition("pending", "approved"), "approve");
  assert.equal(recordableTransition("pending", "rejected"), "reject");
  assert.equal(recordableTransition("pending", "revised"), "revise");
  assert.equal(recordableTransition("pending", "acknowledged"), null);
  assert.equal(recordableTransition("approved", "completed"), null);
  assert.equal(recordableTransition(undefined, "approved"), null);
});

const APPROVALS = [
  { action: "approve", type: "approval", senderUserID: "user-carol", title: "a" },
  { action: "approve", type: "approval", senderUserID: "user-carol", title: "b" },
  { action: "approve", type: "approval", senderUserID: "user-carol", title: "c" },
];

test("heuristic: consistent history recommends, thin or mixed history stays quiet", () => {
  const card = { type: "approval", senderUserID: "user-carol" };

  const strong = heuristicRecommendation({ card, history: APPROVALS });
  assert.equal(strong.action, "approve");
  assert.ok(strong.reason.includes("3"));

  assert.equal(heuristicRecommendation({ card, history: APPROVALS.slice(0, 2) }), null);

  const mixed = heuristicRecommendation({
    card,
    history: [
      ...APPROVALS.slice(0, 2),
      { action: "reject", type: "approval", senderUserID: "user-carol", title: "d" },
      { action: "revise", type: "approval", senderUserID: "user-carol", title: "e" },
    ],
  });
  assert.equal(mixed, null);

  const unrelated = heuristicRecommendation({
    card: { type: "delegation", senderUserID: "user-dana" },
    history: APPROVALS,
  });
  assert.equal(unrelated, null);
});

test("recommendDecision without an AI key uses the heuristic and respects thin history", async () => {
  const card = { type: "approval", senderUserID: "user-carol", title: "t", summary: "s" };
  const rec = await recommendDecision({ card, history: APPROVALS, openRouter: null });
  assert.equal(rec.action, "approve");

  const none = await recommendDecision({ card, history: [], openRouter: null });
  assert.equal(none, null);
});

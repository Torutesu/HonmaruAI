import { expect, test } from "vitest";
import { joinEvents, applyDecision } from "../src/agui/adapter.js";
import { PROTOCOL_VERSION, toolManifest } from "../src/agui/tools.js";

test("toolManifest advertises the agui protocol", () => {
  expect(PROTOCOL_VERSION).toBe("agui/1");
  expect(toolManifest().protocol).toBe("agui/1");
});

test("joinEvents emits RUN_STARTED then STATE_SNAPSHOT from a store", () => {
  const store = { "user-yui": [{ id: "c1", recipientUserID: "user-yui", status: "pending", title: "x", priority: "low", createdAt: "2026-08-08T00:00:00Z" }] };
  const events = joinEvents("user-yui", store, {});
  expect(events[0].type).toBe("RUN_STARTED");
  expect(events[1].type).toBe("STATE_SNAPSHOT");
  expect(events[1].snapshot.cardsById.c1.title).toBe("x");
});

test("applyDecision approves a card in the passed store", () => {
  const store = { "user-yui": [{ id: "c1", recipientUserID: "user-yui", status: "pending", title: "x", priority: "low", createdAt: "2026-08-08T00:00:00Z" }] };
  const out = applyDecision(store, { cardId: "c1", action: "approve", actorUserID: "user-yui" });
  expect(out.card.status).toBe("approved");
  expect(out.removed).toBe(false);
});

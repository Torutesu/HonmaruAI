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

// The app answers `request_decision` with a tool_result carrying the decision
// alone, not the whole card. Every action it can send therefore has to map to a
// status here; `revised` and `delegate` did not, so both silently left the
// card pending — the decider saw it resolved, everyone else kept seeing it in
// their queue.
test("applyDecision maps every action the iOS client sends to a status", () => {
  const card = () => ({ "user-yui": [{ id: "c1", recipientUserID: "user-yui", status: "pending", title: "x", priority: "low", createdAt: "2026-08-08T00:00:00Z" }] });
  const status = (action) => applyDecision(card(), { cardId: "c1", action, actorUserID: "user-yui" }).card.status;

  expect(status("approve")).toBe("approved");
  expect(status("decline")).toBe("rejected");
  expect(status("revised")).toBe("revised");
  expect(status("delegate")).toBe("delegated");
});

test("applyDecision re-applies what tool_result carries instead of the card", () => {
  const store = { "user-yui": [{ id: "c1", recipientUserID: "user-yui", status: "pending", title: "x", context: "Ship v2?", priority: "low", createdAt: "2026-08-08T00:00:00Z" }] };
  const out = applyDecision(store, {
    cardId: "c1", action: "revised", actorUserID: "user-yui", note: "tighten the title",
    githubIssueNumber: 42, githubIssueURL: "https://github.com/o/r/issues/42", githubRepository: "o/r",
  });

  expect(out.card.revisionNote).toBe("tighten the title");
  expect(out.card.context).toContain("Revision: tighten the title");
  expect(out.card.githubIssueNumber).toBe(42);
  expect(out.card.githubRepository).toBe("o/r");
});

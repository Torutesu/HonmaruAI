import test from "node:test";
import assert from "node:assert/strict";
import {
  routeInstructionLocally,
  refineCardLocally,
  refineCard,
  resolveRecipientTarget,
  interpretReply,
  interpretReplyLocally,
} from "../agentTools.js";

const alice = { id: "user-alice", name: "Alice", role: "Product Manager" };

const organization = {
  nodes: [
    { id: "user-alice", kind: "person", label: "Alice · Product" },
    { id: "user-bob", kind: "person", label: "Bob · Engineering" },
  ],
  edges: [{ id: "e5", fromID: "user-alice", toID: "user-bob", kind: "manages" }],
};

test("routes to a person named in the instruction", () => {
  const routing = routeInstructionLocally({
    text: "Ask Bob to review the onboarding PR",
    sender: alice,
    organization,
  });
  assert.equal(routing.recipientUserID, "user-bob");
  assert.equal(routing.routingReason, "Named in your instruction");
});

test("routes design work to Carol", () => {
  const target = resolveRecipientTarget("The empty state mockup needs a copy pass", "user-alice", null);
  assert.equal(target.recipientUserID, "user-carol");
});

test("never routes an instruction back to its sender", () => {
  const routing = routeInstructionLocally({
    text: "roadmap needs a priorities pass",
    sender: alice,
    organization: null,
  });
  assert.notEqual(routing.recipientUserID, alice.id);
});

test("routing rewrites instead of echoing the instruction", () => {
  const text = "Tell Bob to fix the login bug";
  const routing = routeInstructionLocally({ text, sender: alice, organization });
  assert.notEqual(routing.summary.toLowerCase(), text.toLowerCase());
  assert.ok(!routing.summary.toLowerCase().startsWith("tell bob"));
});

test("urgent keyword raises routing priority", () => {
  const routing = routeInstructionLocally({
    text: "Ask Bob to fix the login bug urgently",
    sender: alice,
    organization,
  });
  assert.equal(routing.priority, "urgent");
});

const card = {
  title: "Auth latency regression",
  summary: "p95 on auth endpoint up 18% after last deploy.",
  context: "metric: p95 +18%",
  priority: "medium",
  cardType: "task",
};

test("refine keeps card fields and appends the note", () => {
  const refined = refineCardLocally({ card, instruction: "deadline is Friday" });
  assert.equal(refined.title, card.title);
  assert.equal(refined.summary, card.summary);
  assert.ok(refined.context.includes("note: deadline is Friday"));
  assert.equal(refined.priority, "medium");
});

test("refine detects urgency", () => {
  const refined = refineCardLocally({ card, instruction: "this is urgent now" });
  assert.equal(refined.priority, "urgent");
});

test("refine treats 'not urgent' as low, not urgent", () => {
  const refined = refineCardLocally({ card, instruction: "not urgent anymore, backlog it" });
  assert.equal(refined.priority, "low");
});

test("refine without OpenRouter key falls back locally", async () => {
  const refined = await refineCard({ card, instruction: "bump this, high priority", openRouter: null });
  assert.equal(refined.priority, "high");
  assert.ok(refined.toolCalls.some((call) => call.name === "set_priority"));
});

test("reply: plain approval", () => {
  const result = interpretReplyLocally({ reply: "Approved, ship it" });
  assert.equal(result.action, "approve");
});

test("reply: conditional approval keeps the condition as note", () => {
  const result = interpretReplyLocally({ reply: "OK, but release after Friday" });
  assert.equal(result.action, "approve");
  assert.ok(result.note.toLowerCase().includes("release after friday"));
});

test("reply: rejection with reason", () => {
  const result = interpretReplyLocally({ reply: "No, we don't have budget this quarter" });
  assert.equal(result.action, "reject");
  assert.ok(result.note.toLowerCase().includes("budget"));
});

test("reply: a question defers the decision", () => {
  const result = interpretReplyLocally({ reply: "Has the auth team signed off on this?" });
  assert.equal(result.action, "question");
});

test("reply: revise request", () => {
  const result = interpretReplyLocally({ reply: "Split this into two smaller tasks and resend" });
  assert.equal(result.action, "revise");
});

test("reply: a remark is a comment", () => {
  const result = interpretReplyLocally({ reply: "Heads up, Carol is out next week" });
  assert.equal(result.action, "comment");
});

test("reply without an AI key falls back locally", async () => {
  const result = await interpretReply({
    card: { title: "T", summary: "S" },
    reply: "lgtm",
    openRouter: null,
  });
  assert.equal(result.action, "approve");
});

test("empty instruction leaves the card untouched", () => {
  const refined = refineCardLocally({ card, instruction: "" });
  assert.equal(refined.context, card.context);
  assert.equal(refined.priority, card.priority);
  assert.equal(refined.toolCalls.length, 0);
});

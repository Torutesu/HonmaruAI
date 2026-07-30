import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SLA_MINUTES,
  parseSLAConfig,
  findOverdueCards,
  buildEscalationCard,
} from "../escalation.js";

test("parseSLAConfig merges overrides with defaults and ignores junk", () => {
  const sla = parseSLAConfig("urgent:60,high:abc,medium:720,unknown:5");
  assert.equal(sla.urgent, 60);
  assert.equal(sla.high, DEFAULT_SLA_MINUTES.high);
  assert.equal(sla.medium, 720);
  assert.deepEqual(parseSLAConfig(""), DEFAULT_SLA_MINUTES);
});

test("findOverdueCards flags only pending, un-escalated cards past SLA", () => {
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3600000).toISOString();
  const cardsByUser = {
    "user-bob": [
      { id: "late", status: "pending", priority: "high", createdAt: hoursAgo(9) },
      { id: "fresh", status: "pending", priority: "high", createdAt: hoursAgo(1) },
      { id: "done", status: "approved", priority: "urgent", createdAt: hoursAgo(20) },
      { id: "already", status: "pending", priority: "urgent", createdAt: hoursAgo(20), escalatedAt: hoursAgo(2) },
      { id: "quiet", status: "pending", priority: "low", createdAt: hoursAgo(100) },
      { id: "nodate", status: "pending", priority: "high" },
    ],
  };

  const overdue = findOverdueCards({ cardsByUser, slaMinutes: DEFAULT_SLA_MINUTES, now });
  assert.deepEqual(overdue.map((item) => item.card.id), ["late"]);
  assert.ok(overdue[0].overdueMinutes > 0);
});

test("escalation card targets the manager and keeps urgency", () => {
  const card = {
    id: "c1", recipientUserID: "user-bob", senderUserID: "user-alice",
    type: "approval", title: "Approve launch plan", summary: "Launch plan needs sign-off.",
    context: "deadline: Friday", priority: "urgent",
    createdAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    channelID: "channel-general", sourceInstruction: "original ask",
  };
  const escalation = buildEscalationCard({
    card,
    recipient: { id: "user-bob", name: "Bob" },
    manager: { id: "user-alice", name: "Alice" },
    ageMinutes: 180,
  });

  assert.equal(escalation.recipientUserID, "user-alice");
  assert.equal(escalation.senderUserID, "user-alice");
  assert.equal(escalation.priority, "urgent");
  assert.equal(escalation.type, "approval");
  assert.ok(escalation.title.startsWith("Escalated:"));
  assert.ok(escalation.summary.includes("Bob"));
  assert.ok(escalation.routingReason.includes("you manage Bob"));
  assert.equal(escalation.channelID, "channel-general");

  const highCard = buildEscalationCard({
    card: { ...card, priority: "medium", type: "task" },
    recipient: { id: "user-bob", name: "Bob" },
    manager: { id: "user-alice", name: "Alice" },
    ageMinutes: 60,
  });
  assert.equal(highCard.priority, "high");
  assert.ok(highCard.summary.includes("60m") || highCard.summary.includes("1h"));
});

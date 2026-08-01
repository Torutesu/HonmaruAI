import test from "node:test";
import assert from "node:assert/strict";
import {
  bottlenecks,
  isDecided,
  leadTimeMinutes,
  leadTimeStats,
  ledgerEntries,
} from "../ledger.js";

const NOW = Date.parse("2026-01-08T12:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

const card = (overrides = {}) => ({
  id: "card-1",
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "approval",
  title: "Approve the vendor contract",
  summary: "Legal signed off",
  context: "",
  status: "approved",
  priority: "high",
  createdAt: at(120),
  decidedAt: at(90),
  decidedByUserID: "user-bob",
  ...overrides,
});

const store = (...cards) => {
  const byUser = {};
  for (const item of cards) {
    (byUser[item.recipientUserID] ||= []).push(item);
  }
  return byUser;
};

test("lead time is the gap between arriving and being decided", () => {
  assert.equal(leadTimeMinutes(card()), 30);
  // Still pending: there is no answer yet, and 0 would be a lie.
  assert.equal(leadTimeMinutes(card({ status: "pending", decidedAt: undefined })), null);
  // Decided before decidedAt existed on the card — unknowable, not zero.
  assert.equal(leadTimeMinutes(card({ decidedAt: undefined })), null);
  assert.equal(isDecided(card({ status: "pending" })), false);
  assert.equal(isDecided(card({ status: "acknowledged" })), true);
});

test("a person's history includes what they sent, not only what they received", () => {
  const cards = store(
    card({ id: "to-bob", recipientUserID: "user-bob", senderUserID: "user-alice" }),
    card({ id: "from-bob", recipientUserID: "user-carol", senderUserID: "user-bob" }),
    card({
      id: "unrelated",
      recipientUserID: "user-carol",
      senderUserID: "user-alice",
      decidedByUserID: "user-carol",
    })
  );

  const entries = ledgerEntries({ cardsByUser: cards, userID: "user-bob" });
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ["from-bob", "to-bob"]);
});

test("filters by status, text and date", () => {
  const cards = store(
    card({ id: "old", createdAt: at(60 * 24 * 30), decidedAt: at(60 * 24 * 29) }),
    card({ id: "pending", status: "pending", decidedAt: undefined }),
    card({ id: "rejected", status: "rejected", title: "Approve the office move" })
  );

  assert.deepEqual(
    ledgerEntries({ cardsByUser: cards, status: "pending" }).map((e) => e.id),
    ["pending"]
  );
  assert.deepEqual(
    ledgerEntries({ cardsByUser: cards, status: "rejected" }).map((e) => e.id),
    ["rejected"]
  );
  // "decided" is every terminal status at once.
  assert.deepEqual(
    ledgerEntries({ cardsByUser: cards, status: "decided" }).map((e) => e.id).sort(),
    ["old", "rejected"]
  );
  assert.deepEqual(
    ledgerEntries({ cardsByUser: cards, query: "office" }).map((e) => e.id),
    ["rejected"]
  );
  assert.ok(
    !ledgerEntries({ cardsByUser: cards, since: at(60 * 24 * 7) }).some((e) => e.id === "old")
  );
});

test("newest first, and a card is listed once however many queues hold it", () => {
  const cards = {
    "user-bob": [card({ id: "older", decidedAt: at(300) }), card({ id: "newest", decidedAt: at(5) })],
    // The same object reachable twice must not double-count.
    "user-carol": [card({ id: "older", decidedAt: at(300) })],
  };

  const entries = ledgerEntries({ cardsByUser: cards });
  assert.deepEqual(entries.map((entry) => entry.id), ["newest", "older"]);
});

test("lead time is reported as median and p90, not an average", () => {
  const cards = store(
    ...[5, 10, 15, 20, 500].map((minutes, index) =>
      card({ id: `c${index}`, createdAt: at(600), decidedAt: at(600 - minutes) })
    ),
    card({ id: "still-open", status: "pending", decidedAt: undefined })
  );

  const stats = leadTimeStats(ledgerEntries({ cardsByUser: cards }));
  assert.equal(stats.decided, 5);
  assert.equal(stats.pending, 1);
  // A mean would read 110 minutes; one card that sat over a weekend must not
  // define the picture.
  assert.equal(stats.medianMinutes, 15);
  assert.equal(stats.p90Minutes, 500);
});

test("stats break down the outcomes, including what the AI decided", () => {
  const cards = store(
    card({ id: "a", status: "approved" }),
    card({ id: "b", status: "approved", decidedByAI: true }),
    card({ id: "c", status: "rejected", priority: "low" }),
    card({ id: "d", status: "pending", decidedAt: undefined, escalatedAt: at(10) })
  );

  const stats = leadTimeStats(ledgerEntries({ cardsByUser: cards }));
  assert.deepEqual(stats.outcomes, { approved: 2, rejected: 1, pending: 1 });
  assert.equal(stats.byAI, 1);
  assert.equal(stats.escalated, 1);
  assert.equal(stats.byPriority.low.decided, 1);
  assert.equal(stats.byPriority.high.decided, 2);
});

test("bottlenecks rank by how long the oldest thing has been waiting", () => {
  const cards = store(
    // Carol has a long queue that moves.
    ...Array.from({ length: 6 }, (_, index) =>
      card({ id: `carol-${index}`, recipientUserID: "user-carol", status: "pending", decidedAt: undefined, createdAt: at(30) })
    ),
    // Bob has one card, stuck for three days.
    card({ id: "bob-stuck", recipientUserID: "user-bob", status: "pending", decidedAt: undefined, createdAt: at(60 * 72) })
  );

  const queues = bottlenecks({ entries: ledgerEntries({ cardsByUser: cards }), now: NOW });
  assert.equal(queues[0].userID, "user-bob");
  assert.equal(queues[0].oldestPendingMinutes, 60 * 72);
  assert.equal(queues[1].userID, "user-carol");
  assert.equal(queues[1].pending, 6);
});

test("an empty store produces an empty ledger, not a crash", () => {
  const entries = ledgerEntries({ cardsByUser: {} });
  assert.deepEqual(entries, []);
  assert.deepEqual(leadTimeStats(entries).outcomes, {});
  assert.equal(leadTimeStats(entries).medianMinutes, null);
  assert.deepEqual(bottlenecks({ entries, now: NOW }), []);
  assert.deepEqual(ledgerEntries({ cardsByUser: undefined }), []);
});

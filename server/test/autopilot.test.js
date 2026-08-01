import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTOPILOT,
  autopilotDecision,
  autopilotNote,
  autopilotSettings,
  findAutopilotCards,
} from "../autopilot.js";

// Autopilot is a delegation of authority, so most of what matters is what it
// refuses to do. These tests are mostly refusals.

const NOW = Date.parse("2026-01-01T12:00:00Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60000).toISOString();

const on = (overrides = {}) =>
  autopilotSettings({ autopilot: { enabled: true, ...overrides } });

const card = (overrides = {}) => ({
  id: "card-1",
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "approval",
  title: "Approve the staging rollout",
  summary: "10% traffic",
  context: "",
  status: "pending",
  priority: "medium",
  createdAt: minutesAgo(180),
  recommendation: { action: "approve", reason: "You approved the last 4 from Alice" },
  ...overrides,
});

test("off by default — nobody has decisions made for them without asking", () => {
  assert.equal(DEFAULT_AUTOPILOT.enabled, false);
  assert.equal(autopilotSettings({}).enabled, false);
  assert.equal(autopilotSettings(undefined).enabled, false);
  assert.equal(autopilotDecision({ card: card(), settings: autopilotSettings({}), now: NOW }), null);
});

test("acts on a confident recommendation the human left sitting", () => {
  const decision = autopilotDecision({ card: card(), settings: on(), now: NOW });
  assert.equal(decision.action, "approve");
  assert.equal(decision.waitedMinutes, 180);
  assert.match(decision.reason, /last 4 from Alice/);
});

test("the hold window gives the human first refusal", () => {
  // Same card, an hour old against a two-hour hold.
  const fresh = card({ createdAt: minutesAgo(60) });
  assert.equal(autopilotDecision({ card: fresh, settings: on(), now: NOW }), null);
  assert.ok(autopilotDecision({ card: fresh, settings: on({ holdMinutes: 30 }), now: NOW }));
});

test("a hold short enough to be no hold at all is refused", () => {
  // Zero would mean deciding the moment the card lands.
  assert.equal(autopilotSettings({ autopilot: { holdMinutes: 0 } }).holdMinutes, 120);
  assert.equal(autopilotSettings({ autopilot: { holdMinutes: -5 } }).holdMinutes, 120);
  assert.equal(autopilotSettings({ autopilot: { holdMinutes: 45 } }).holdMinutes, 45);
});

test("urgent always needs a person, whatever the setting says", () => {
  const urgent = card({ priority: "urgent" });
  assert.equal(autopilotDecision({ card: urgent, settings: on(), now: NOW }), null);
  // Even if someone stores maxPriority: urgent, it is clamped away.
  const settings = autopilotSettings({ autopilot: { enabled: true, maxPriority: "urgent" } });
  assert.equal(settings.maxPriority, "high");
  assert.equal(autopilotDecision({ card: urgent, settings, now: NOW }), null);
});

test("priority ceiling is respected", () => {
  const high = card({ priority: "high" });
  assert.ok(autopilotDecision({ card: high, settings: on(), now: NOW }));
  assert.equal(
    autopilotDecision({ card: high, settings: on({ maxPriority: "medium" }), now: NOW }),
    null
  );
});

test("declining takes its own opt-in — approving is the only default", () => {
  const rejection = card({
    recommendation: { action: "reject", reason: "You declined the last 5" },
  });
  assert.deepEqual(DEFAULT_AUTOPILOT.actions, ["approve"]);
  assert.equal(autopilotDecision({ card: rejection, settings: on(), now: NOW }), null);

  const decision = autopilotDecision({
    card: rejection,
    settings: on({ actions: ["approve", "reject"] }),
    now: NOW,
  });
  assert.equal(decision.action, "reject");
});

test("nothing else can be smuggled into the action list", () => {
  const settings = autopilotSettings({
    autopilot: { enabled: true, actions: ["approve", "delegate", "revise", "drop"] },
  });
  assert.deepEqual(settings.actions, ["approve"]);
});

test("refuses the cards where a pattern means least", () => {
  const cases = {
    "no recommendation at all": card({ recommendation: undefined }),
    "already decided": card({ status: "approved" }),
    "already handled by autopilot": card({ autopilotAt: minutesAgo(10) }),
    // A revision request exists because something was wrong with the ask.
    "a revision request": card({ type: "revision" }),
    "your own card": card({ senderUserID: "user-bob" }),
    "an unparseable timestamp": card({ createdAt: "whenever" }),
  };

  for (const [label, subject] of Object.entries(cases)) {
    assert.equal(
      autopilotDecision({ card: subject, settings: on(), now: NOW }),
      null,
      `autopilot should refuse ${label}`
    );
  }
});

test("the sweep only picks up people who opted in", () => {
  const settingsFor = (userID) =>
    autopilotSettings(userID === "user-bob" ? { autopilot: { enabled: true } } : {});

  const ready = findAutopilotCards({
    cardsByUser: {
      "user-bob": [card({ id: "bob-1" }), card({ id: "bob-2", priority: "urgent" })],
      "user-carol": [card({ id: "carol-1", recipientUserID: "user-carol" })],
    },
    settingsFor,
    now: NOW,
  });

  assert.deepEqual(
    ready.map((item) => item.card.id),
    ["bob-1"]
  );
});

test("the note says a machine decided, and how long it waited", () => {
  assert.equal(
    autopilotNote({ action: "approve", reason: "You approved the last 4", waitedMinutes: 180 }),
    "Approved by your AI after 3h · You approved the last 4"
  );
  assert.match(autopilotNote({ action: "reject", reason: "…", waitedMinutes: 45 }), /^Declined .* 45m/);
});

// Autopilot: the recommendation engine already predicts how someone decides.
// This lets it act — under conditions strict enough that acting is defensible.
//
// The design is mostly about what it *won't* do:
//
// - Opt-in per person. Nobody has decisions made for them by default.
// - Never immediately. A hold window means the human always gets first refusal;
//   autopilot only ever handles what they left sitting.
// - Never urgent. If it genuinely can't wait, it needs a person.
// - Approve only, by default. Auto-approving is recoverable and visible.
//   Silently declining someone's request is the kind of thing that costs trust
//   permanently, so it takes an explicit opt-in of its own.
// - Never a revision request. Those exist *because* something was wrong.
// - Never twice, and never invisibly: the card is marked and the sender's
//   notification says a machine decided.
//
// One more, in index.js rather than here: an autopilot decision is not written
// to decision memory. Learning from your own predictions is how a system
// convinces itself of anything.

export const DEFAULT_AUTOPILOT = Object.freeze({
  enabled: false,
  /** Minutes a card must sit unanswered before autopilot may touch it. */
  holdMinutes: 120,
  /** Highest priority autopilot may decide. "urgent" is never allowed. */
  maxPriority: "high",
  /** Which recommendations it may act on. */
  actions: Object.freeze(["approve"]),
});

const PRIORITY_RANK = { low: 0, medium: 1, high: 2, urgent: 3 };

/** Merge a user's stored preferences over the defaults, clamping the unsafe parts. */
export function autopilotSettings(user) {
  const stored = user?.autopilot || {};
  const maxPriority =
    stored.maxPriority in PRIORITY_RANK && stored.maxPriority !== "urgent"
      ? stored.maxPriority
      : DEFAULT_AUTOPILOT.maxPriority;

  const actions = Array.isArray(stored.actions)
    ? stored.actions.filter((action) => ["approve", "reject"].includes(action))
    : [...DEFAULT_AUTOPILOT.actions];

  const holdMinutes = Number(stored.holdMinutes);

  return {
    enabled: stored.enabled === true,
    // A zero hold would mean deciding the instant the card lands, which is
    // exactly the behaviour the hold exists to prevent.
    holdMinutes:
      Number.isFinite(holdMinutes) && holdMinutes >= 15
        ? holdMinutes
        : DEFAULT_AUTOPILOT.holdMinutes,
    maxPriority,
    actions: actions.length > 0 ? actions : [...DEFAULT_AUTOPILOT.actions],
  };
}

/**
 * The decision autopilot would take on this card, or null. Pure: the caller
 * owns applying it.
 */
export function autopilotDecision({ card, settings, now = Date.now() }) {
  if (!settings?.enabled) return null;
  if (!card || card.status !== "pending") return null;
  if (card.autopilotAt) return null;

  // A revision request is bespoke by definition, and deciding your own card
  // is not a decision.
  if (card.type === "revision") return null;
  if (card.recipientUserID === card.senderUserID) return null;

  if (card.priority === "urgent") return null;
  const rank = PRIORITY_RANK[card.priority];
  if (rank === undefined || rank > PRIORITY_RANK[settings.maxPriority]) return null;

  const recommendation = card.recommendation;
  if (!recommendation?.action || !settings.actions.includes(recommendation.action)) {
    return null;
  }

  const createdAt = Date.parse(card.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  const waitedMinutes = (now - createdAt) / 60000;
  if (waitedMinutes < settings.holdMinutes) return null;

  return {
    action: recommendation.action,
    reason: recommendation.reason,
    waitedMinutes: Math.round(waitedMinutes),
  };
}

/** Every card autopilot is ready to decide, across the whole store. */
export function findAutopilotCards({ cardsByUser, settingsFor, now = Date.now() }) {
  const ready = [];

  for (const cards of Object.values(cardsByUser || {})) {
    for (const card of cards) {
      const decision = autopilotDecision({
        card,
        settings: settingsFor(card.recipientUserID),
        now,
      });
      if (decision) ready.push({ card, decision });
    }
  }

  return ready;
}

function hoursLabel(minutes) {
  return minutes < 90 ? `${Math.max(1, Math.round(minutes))}m` : `${Math.round(minutes / 60)}h`;
}

/** The note that goes on the card and into the sender's notification. */
export function autopilotNote({ action, reason, waitedMinutes }) {
  const verb = action === "approve" ? "Approved" : "Declined";
  return `${verb} by your AI after ${hoursLabel(waitedMinutes)} · ${reason}`;
}

// Bridges the relay's card store to AG-UI events.
//
// State model on the wire: { cardsById: { [cardId]: card } }.
// Keyed by id (not array index) so JSON Patch paths stay stable no matter
// what order mutations arrive in — index-based patches break under races.

import {
  runStarted,
  stateSnapshot,
  stateDelta,
  custom,
  toolCallSequence,
} from "./events.js";
import { ACTION_STATUS } from "./tools.js";

// legacy store shape: { [recipientUserID]: card[] } → AG-UI state
export function snapshotState(store) {
  const cardsById = {};
  for (const cards of Object.values(store)) {
    for (const card of cards) cardsById[card.id] = card;
  }
  return { cardsById };
}

// JSON Pointer escaping (RFC 6901): "~" → "~0", "/" → "~1"
function pointer(id) {
  return "/cardsById/" + String(id).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function joinEvents(userId, store) {
  return [
    runStarted(userId),
    stateSnapshot(snapshotState(store)),
  ];
}

// Everyone gets the state patch; the recipient additionally gets the
// request_decision tool call — state sync and "answer this" are separate
// concerns, which is what lets a second device stay in sync passively.
export function upsertEvents(card, { isNew }) {
  const patch = stateDelta([
    { op: isNew ? "add" : "replace", path: pointer(card.id), value: card },
  ]);
  const forEveryone = [patch];
  let forRecipient = [];
  if (isNew && (card.status === "pending" || card.status === undefined)) {
    forRecipient = toolCallSequence("request_decision", { card }).events;
  }
  return { forEveryone, forRecipient };
}

export function removeEvents(cardId) {
  return [stateDelta([{ op: "remove", path: pointer(cardId) }])];
}

export function clearEvents() {
  return [stateSnapshot({ cardsById: {} })];
}

export function presenceEvents(userId, status) {
  return [custom("presence", { userId, status })];
}

// Apply a submit_decision tool result to the store.
// Returns { card, removed } — card is the updated card (or null), removed
// tells the caller to broadcast a removal instead of an upsert.
export function applyDecision(store, content) {
  const { cardId, action } = content || {};
  if (!cardId || !action) {
    throw new Error("submit_decision requires cardId and action");
  }

  let found = null;
  let owner = null;
  for (const [userId, cards] of Object.entries(store)) {
    const card = cards.find((item) => item.id === cardId);
    if (card) {
      found = card;
      owner = userId;
      break;
    }
  }
  if (!found) throw new Error(`Unknown card: ${cardId}`);

  if (action === "delete" || action === "mute") {
    store[owner] = store[owner].filter((item) => item.id !== cardId);
    return { card: found, removed: true };
  }

  if (action === "later") {
    // Stays pending; ordering is a client concern. No state change.
    return { card: found, removed: false, unchanged: true };
  }

  if (action === "choose" && !content.optionId) {
    throw new Error("choose requires optionId");
  }
  if (action === "reply" && !content.replyText) {
    throw new Error("reply requires replyText");
  }

  found.status = ACTION_STATUS[action] || found.status;
  found.decision = {
    action,
    optionId: content.optionId,
    note: content.note,
    replyText: content.replyText,
    actorUserID: content.actorUserID,
    decidedAt: content.decidedAt || new Date().toISOString(),
  };
  return { card: found, removed: false };
}

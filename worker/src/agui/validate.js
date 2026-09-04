// What the relay will accept onto a card.
//
// CARD_SCHEMA has always described this. It was served at `GET /agui/tools` and
// nothing ever checked anything against it, so `saveCard` wrote whatever JSON a
// client sent — any field, any length. The schema was documentation about code
// that did not exist.
//
// This is that code, written out rather than driven by the schema, because a
// validator you can read line by line is worth more here than one assembled at
// runtime from a JSON document.

import { DECISION_ACTIONS } from "./tools.js";

export const CARD_TYPES = new Set(["approval", "delegation", "notification", "task", "revision"]);
export const CARD_STATUSES = new Set(["pending", "approved", "rejected", "revised", "delegated", "completed"]);
export const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
export const ACTIONS = new Set(DECISION_ACTIONS);

// Long enough for anything a person writes, short enough that a card cannot be
// used to push a wall of text into everyone's feed — every member of the org
// receives every card in the join snapshot.
const LIMITS = {
  title: 300, summary: 2000, context: 8000, revisionNote: 2000, sourceDetail: 500,
  // Who asked first, when this card is a hand-on of someone else's request.
  originSenderUserID: 128,
};

// A curated context is a person's profile document, so it is allowed to be
// bigger than a card — but not unbounded, and it goes straight into D1.
export const MAX_CONTEXT_BYTES = 64 * 1024;

/// Returns an error message, or null when the card may be stored.
///
/// Rejecting is deliberate rather than trimming: a card silently shortened is a
/// decision whose terms changed on the way to the person deciding it.
export function validateIncomingCard(card) {
  if (!card || typeof card !== "object") return "A card is required.";
  if (typeof card.id !== "string" || !card.id || card.id.length > 128) return "A card needs an id.";
  if (typeof card.recipientUserID !== "string" || !card.recipientUserID) {
    return "A card needs a recipient.";
  }

  for (const [field, max] of Object.entries(LIMITS)) {
    const value = card[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return `${field} must be text.`;
    if (value.length > max) return `${field} is longer than ${max} characters.`;
  }

  if (card.type !== undefined && !CARD_TYPES.has(card.type)) return `Unknown card type: ${card.type}`;
  if (card.status !== undefined && !CARD_STATUSES.has(card.status)) return `Unknown status: ${card.status}`;
  if (card.priority !== undefined && !PRIORITIES.has(card.priority)) return `Unknown priority: ${card.priority}`;
  if (card.decision !== undefined) {
    if (typeof card.decision !== "object" || card.decision === null) return "decision must be an object.";
    if (!ACTIONS.has(card.decision.action)) return `Unknown decision action: ${card.decision.action}`;
  }
  return null;
}

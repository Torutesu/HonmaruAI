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

import { DECISION_ACTIONS, DECISION_FORMATS } from "./tools.js";

export const CARD_TYPES = new Set(["approval", "delegation", "notification", "task", "revision"]);
export const CARD_STATUSES = new Set(["pending", "approved", "rejected", "revised", "delegated", "completed"]);
export const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
export const ACTIONS = new Set(DECISION_ACTIONS);
export const FORMATS = new Set(DECISION_FORMATS);

// Long enough for anything a person writes, short enough that a card cannot be
// used to push a wall of text into everyone's feed — every member of the org
// receives every card in the join snapshot.
const LIMITS = { title: 300, summary: 2000, context: 8000, revisionNote: 2000, sourceDetail: 500, business: 64 };

// The AI's suggestion, and who asked. Both are shown on the card itself, so
// both are as unbounded a surface as the summary and get the same treatment.
const RECOMMENDED = new Set(["approve", "decline", "revise"]);
const REQUESTER_LIMITS = { login: 128, name: 120, role: 60, quote: 600, sourceUrl: 500 };
// Where a synced card came from, kept so a reply can go back the same way.
// A client may write it, but a reply is only ever sent for a card the sync
// recorded as ingested by the caller — see POST /cards/:id/reply.
const SOURCE_FIELDS = ["connector", "id", "threadId", "from", "channel", "ts"];

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
  // The schema already enumerated this — nothing enforced it, so a client
  // could store any string under `format`, and the reference web client
  // rendered it unescaped. The enum is the check.
  if (card.format !== undefined && !FORMATS.has(card.format)) return `Unknown format: ${card.format}`;
  if (card.recommendation !== undefined) {
    const r = card.recommendation;
    if (typeof r !== "object" || r === null) return "recommendation must be an object.";
    if (!RECOMMENDED.has(r.action)) return `Unknown recommended action: ${r.action}`;
    if (r.reason !== undefined) {
      if (typeof r.reason !== "string") return "recommendation reason must be text.";
      if (r.reason.length > 600) return "recommendation reason is longer than 600 characters.";
    }
  }
  if (card.requestedBy !== undefined) {
    const who = card.requestedBy;
    if (typeof who !== "object" || who === null) return "requestedBy must be an object.";
    for (const [field, max] of Object.entries(REQUESTER_LIMITS)) {
      const value = who[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") return `requestedBy.${field} must be text.`;
      if (value.length > max) return `requestedBy.${field} is longer than ${max} characters.`;
    }
  }
  if (card.source !== undefined) {
    const src = card.source;
    if (typeof src !== "object" || src === null) return "source must be an object.";
    for (const field of SOURCE_FIELDS) {
      const value = src[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") return `source.${field} must be text.`;
      if (value.length > 300) return `source.${field} is longer than 300 characters.`;
    }
  }
  if (card.decision !== undefined) {
    if (typeof card.decision !== "object" || card.decision === null) return "decision must be an object.";
    if (!ACTIONS.has(card.decision.action)) return `Unknown decision action: ${card.decision.action}`;
  }
  // Who the sender named with an @: member refs, a handful at most. The relay
  // resolves them against the real member list; here they only have to be
  // short strings.
  if (card.mentions !== undefined) {
    if (!Array.isArray(card.mentions) || card.mentions.length > 10) return "mentions must be a list of at most 10.";
    for (const m of card.mentions) {
      if (typeof m !== "string" || !m || m.length > 128) return "Each mention must be a short string.";
    }
  }
  // The thread's summary is the server's to write (see threads.js); a client
  // may carry it back unchanged, but not invent it.
  if (card.commentCount !== undefined && (typeof card.commentCount !== "number" || card.commentCount < 0)) return "commentCount must be a number.";
  if (card.reactions !== undefined && (typeof card.reactions !== "object" || card.reactions === null)) return "reactions must be an object.";
  return null;
}

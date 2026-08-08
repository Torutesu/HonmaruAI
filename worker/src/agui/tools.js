// AG-UI frontend tools exposed by the relay.
//
// The agent side never renders UI. It calls `request_decision` with a typed
// payload; the client renders the matching native component (approve / choice /
// reply / fyi) and answers with a `submit_decision` tool result. This file is
// the single source of truth for both payloads.

export const PROTOCOL_VERSION = "agui/1";

export const DECISION_FORMATS = ["approve", "choice", "reply", "fyi"];
export const DECISION_ACTIONS = [
  "approve",
  "decline",
  "choose",
  "reply",
  "acknowledge",
  "later",
  "delete",
  "mute",
];

export const CARD_SCHEMA = {
  $id: "https://tiktokforwork.dev/schemas/decision-card.json",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "recipientUserID",
    "senderUserID",
    "format",
    "title",
    "priority",
    "createdAt",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    recipientUserID: { type: "string", minLength: 1 },
    senderUserID: { type: "string", minLength: 1 },
    // Domain type (what it is) — kept from the iOS model.
    type: {
      type: "string",
      enum: ["approval", "delegation", "notification", "task", "revision"],
    },
    // Answer shape (how the human responds) — drives which component renders.
    format: { type: "string", enum: DECISION_FORMATS },
    title: { type: "string", minLength: 1, maxLength: 140 },
    summary: { type: "string" },
    context: { type: "string" },
    priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
    createdAt: { type: "string", format: "date-time" },
    agentRoute: { type: "string" },
    routingReason: { type: "string" },
    // Provenance: the raw human input this card was shaped from.
    source: {
      type: "object",
      additionalProperties: false,
      required: ["type", "raw"],
      properties: {
        type: { type: "string" },   // "Slack" | "Voice memo" | "GitHub" | ...
        where: { type: "string" },  // "#release" | "PR #214" | "0:42"
        raw: { type: "string" },
      },
    },
    // format === "choice": options proposed by the sender / sender's AI.
    options: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string" },
          label: { type: "string", maxLength: 60 },
          detail: { type: "string" },
          recommended: { type: "boolean" },
        },
      },
    },
    // format === "reply": AI-drafted answers the user can tap instead of typing.
    drafts: { type: "array", maxItems: 4, items: { type: "string" } },
    labels: { type: "array", items: { type: "string" } },
    githubIssueNumber: { type: "integer" },
    githubIssueURL: { type: "string" },
    githubRepository: { type: "string" },
    // Set once decided; absent while pending.
    status: {
      type: "string",
      enum: ["pending", "approved", "rejected", "revised", "delegated", "completed"],
    },
    decision: { $ref: "#/$defs/decision" },
    sourceInstruction: { type: "string" },
    revisionNote: { type: "string" },
  },
  $defs: {
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["action", "actorUserID", "decidedAt"],
      properties: {
        action: { type: "string", enum: DECISION_ACTIONS },
        optionId: { type: "string" },
        note: { type: "string" },
        replyText: { type: "string" },
        actorUserID: { type: "string" },
        decidedAt: { type: "string", format: "date-time" },
      },
    },
  },
};

// Frontend tool the agent calls to put a decision in front of a human.
export const REQUEST_DECISION_TOOL = {
  name: "request_decision",
  description:
    "Render a decision card to the recipient. The card's `format` selects the native component: approve (one-tap yes/no), choice (pick one option), reply (needs words; drafts help), fyi (acknowledge only).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["card"],
    properties: { card: CARD_SCHEMA },
  },
};

// Tool result the client sends back when the human decides.
export const SUBMIT_DECISION_SCHEMA = {
  $id: "https://tiktokforwork.dev/schemas/submit-decision.json",
  type: "object",
  additionalProperties: false,
  required: ["cardId", "action", "actorUserID"],
  properties: {
    cardId: { type: "string" },
    action: { type: "string", enum: DECISION_ACTIONS },
    optionId: { type: "string" },   // required when action === "choose"
    note: { type: "string" },       // optional note on approve/decline
    replyText: { type: "string" },  // required when action === "reply"
    actorUserID: { type: "string" },
    decidedAt: { type: "string", format: "date-time" },
  },
};

// action → card status. `later` keeps the card pending (client re-orders);
// `delete` / `mute` remove it from the store.
export const ACTION_STATUS = {
  approve: "approved",
  decline: "rejected",
  choose: "approved",
  reply: "completed",
  acknowledge: "completed",
};

export function toolManifest() {
  return {
    protocol: PROTOCOL_VERSION,
    tools: [REQUEST_DECISION_TOOL],
    results: { submit_decision: SUBMIT_DECISION_SCHEMA },
  };
}

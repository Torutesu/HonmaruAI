import { z } from "zod";

// ---------------------------------------------------------------------------
// Core entities. These schemas are the single source of truth for every
// client (iOS / web / desktop / Android) and the server. Swift and Kotlin
// types are ported from this file; do not add fields anywhere else first.
// ---------------------------------------------------------------------------

export const CardType = z.enum([
  "approval",
  "delegation",
  "notification",
  "task",
  "revision",
]);
export type CardType = z.infer<typeof CardType>;

// Status values intentionally match the existing Swift `CardStatus` raw
// values so the iOS client can migrate without a data mapping layer.
export const CardStatus = z.enum([
  "pending",
  "approved",
  "rejected",
  "revised",
  "delegated",
  "completed",
]);
export type CardStatus = z.infer<typeof CardStatus>;

export const CardPriority = z.enum(["low", "medium", "high", "urgent"]);
export type CardPriority = z.infer<typeof CardPriority>;

export const IntegrationKind = z.enum(["github_issues"]);
export type IntegrationKind = z.infer<typeof IntegrationKind>;

// A card's reflection in an external system. Generalizes the old
// githubIssueNumber/githubIssueURL fields so integrations stay pluggable.
export const ExternalRef = z.object({
  integration: IntegrationKind,
  externalId: z.string(),
  url: z.string().nullish(),
  state: z.string().nullish(),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const User = z.object({
  id: z.string(),
  name: z.string(),
  githubUsername: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  createdAt: z.string(),
});
export type User = z.infer<typeof User>;

export const Org = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type Org = z.infer<typeof Org>;

// A user's presence inside one org. Job title lives here (not on User)
// because the same human can hold different roles in different orgs.
export const Member = z.object({
  userId: z.string(),
  name: z.string(),
  title: z.string(),
  isAdmin: z.boolean(),
  teamId: z.string().nullish(),
  githubUsername: z.string().nullish(),
});
export type Member = z.infer<typeof Member>;

export const Team = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
});
export type Team = z.infer<typeof Team>;

export const OrgEdgeKind = z.enum([
  "manages",
  "memberOf",
  "assignedTo",
  "canApprove",
]);
export type OrgEdgeKind = z.infer<typeof OrgEdgeKind>;

export const OrgEdge = z.object({
  id: z.string(),
  orgId: z.string(),
  kind: OrgEdgeKind,
  fromId: z.string(),
  toId: z.string(),
});
export type OrgEdge = z.infer<typeof OrgEdge>;

export const DecisionCard = z.object({
  id: z.string(),
  orgId: z.string(),
  senderUserId: z.string(),
  recipientUserId: z.string(),
  type: CardType,
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  status: CardStatus,
  priority: CardPriority,
  labels: z.array(z.string()).default([]),
  agentRoute: z.string().nullish(),
  routingReason: z.string().nullish(),
  sourceInstruction: z.string().nullish(),
  revisionNote: z.string().nullish(),
  // Set when this card was spawned by delegating another card.
  parentCardId: z.string().nullish(),
  // SLA: decide-by deadline derived from priority at creation (and
  // recomputed when refinement changes the priority). Null = no SLA.
  dueAt: z.string().nullish(),
  // Set once the overdue sweeper has escalated this card.
  escalatedAt: z.string().nullish(),
  externalRefs: z.array(ExternalRef).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DecisionCard = z.infer<typeof DecisionCard>;

export const CardAction = z.enum([
  "approve",
  "reject",
  "request_revision",
  "delegate",
  "complete",
  "delete",
]);
export type CardAction = z.infer<typeof CardAction>;

// A message in a card's thread — the high-frequency rally layer. Cards are
// the decision container; messages are the back-and-forth around it.
export const MessageKind = z.enum(["comment", "system", "ai_note"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const CardMessage = z.object({
  id: z.string(),
  cardId: z.string(),
  orgId: z.string(),
  authorUserId: z.string(),
  kind: MessageKind,
  text: z.string(),
  createdAt: z.string(),
});
export type CardMessage = z.infer<typeof CardMessage>;

export const NotificationKind = z.enum([
  "card_assigned",
  "card_status",
  "card_message",
  "card_rerouted",
  "card_overdue",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

// Per-user notification. Delivered in-app over WS immediately, and to
// external channels (webhook / push) by the notification engine.
export const Notification = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  kind: NotificationKind,
  cardId: z.string().nullish(),
  title: z.string(),
  body: z.string(),
  readAt: z.string().nullish(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof Notification>;

export const DevicePlatform = z.enum(["ios", "android", "web"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const IntegrationConfig = z.object({
  kind: IntegrationKind,
  enabled: z.boolean(),
  // Kind-specific settings, validated by the integration itself
  // (e.g. github_issues: { repo: "owner/name", token: "..." }).
  config: z.record(z.unknown()).default({}),
});
export type IntegrationConfig = z.infer<typeof IntegrationConfig>;

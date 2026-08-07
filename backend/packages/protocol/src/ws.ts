import { z } from "zod";
import {
  CardAction,
  CardMessage,
  CardPriority,
  Channel,
  DecisionCard,
  Member,
  Notification,
  Org,
  OrgEdge,
  Team,
} from "./entities.js";
import { OrgEvent } from "./events.js";

// ---------------------------------------------------------------------------
// WebSocket protocol v1.
//
// Lifecycle:
//   1. client connects and MUST send `hello` first (token from REST auth)
//   2. server replies `welcome` (org roster + current seq), then either
//      `snapshot` (sinceSeq absent) or a burst of `event` frames (resume)
//   3. client sends `instruction` / `card_action`; server never trusts the
//      client to construct cards — all writes happen server-side and come
//      back as `event` frames
//   4. `clientRef` correlates a request with its `ack`/`error`
// ---------------------------------------------------------------------------

export const HelloMessage = z.object({
  type: z.literal("hello"),
  token: z.string(),
  orgId: z.string(),
  sinceSeq: z.number().int().optional(),
});

export const InstructionMessage = z.object({
  type: z.literal("instruction"),
  clientRef: z.string().optional(),
  text: z.string().min(1).max(4000),
  priorityOverride: CardPriority.optional(),
});

export const CardActionMessage = z.object({
  type: z.literal("card_action"),
  clientRef: z.string().optional(),
  cardId: z.string(),
  action: CardAction,
  note: z.string().max(2000).optional(),
  delegateToUserId: z.string().optional(),
});

// A thread reply on a card — the high-frequency rally path. Handled
// synchronously (no AI in the hot path) so round-trips stay fast.
export const CardMessageMessage = z.object({
  type: z.literal("card_message"),
  clientRef: z.string().optional(),
  cardId: z.string(),
  text: z.string().min(1).max(4000),
});

// Classic chat: post into a channel or DM.
export const ChatMessageMessage = z.object({
  type: z.literal("chat_message"),
  clientRef: z.string().optional(),
  channelId: z.string(),
  text: z.string().min(1).max(4000),
  // Reply into a message's thread.
  parentMessageId: z.string().optional(),
});

export const PingMessage = z.object({ type: z.literal("ping") });

export const ClientMessage = z.discriminatedUnion("type", [
  HelloMessage,
  InstructionMessage,
  CardActionMessage,
  CardMessageMessage,
  ChatMessageMessage,
  PingMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const WelcomeMessage = z.object({
  type: z.literal("welcome"),
  self: Member,
  org: Org,
  members: z.array(Member),
  teams: z.array(Team),
  edges: z.array(OrgEdge),
  // Channels visible to this user (all org channels + their DMs).
  channels: z.array(Channel),
  seq: z.number().int(),
});

export const SnapshotMessage = z.object({
  type: z.literal("snapshot"),
  cards: z.array(DecisionCard),
  seq: z.number().int(),
});

export const EventMessage = z.object({
  type: z.literal("event"),
  event: OrgEvent,
});

export const AckMessage = z.object({
  type: z.literal("ack"),
  clientRef: z.string().nullish(),
  card: DecisionCard.nullish(),
  message: CardMessage.nullish(),
});

// Per-user frame (not part of the org event log).
export const NotificationFrame = z.object({
  type: z.literal("notification"),
  notification: Notification,
});

export const PresenceMessage = z.object({
  type: z.literal("presence"),
  userId: z.string(),
  status: z.enum(["online", "offline"]),
});

export const PongMessage = z.object({ type: z.literal("pong") });

export const ErrorMessage = z.object({
  type: z.literal("error"),
  clientRef: z.string().nullish(),
  code: z.string(),
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion("type", [
  WelcomeMessage,
  SnapshotMessage,
  EventMessage,
  AckMessage,
  NotificationFrame,
  PresenceMessage,
  PongMessage,
  ErrorMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

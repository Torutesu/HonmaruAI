import { z } from "zod";
import {
  CardMessage,
  Channel,
  ChannelKind,
  ChatMessage,
  DecisionCard,
  Member,
  OrgEdge,
  Team,
} from "./entities.js";

// ---------------------------------------------------------------------------
// Domain events. Every state change appends exactly one event to the org's
// ordered log (seq is a per-org monotonically increasing integer). Clients
// resume after a disconnect by sending the last seq they saw; the server
// replays everything newer. This is the only realtime sync mechanism —
// there is no out-of-band mutation.
// ---------------------------------------------------------------------------

export const EventType = z.enum([
  "card_created",
  "card_updated",
  "card_deleted",
  "message_created",
  "channel_created",
  "chat_message_created",
  "member_joined",
  "member_updated",
  "member_left",
  "org_graph_updated",
]);
export type EventType = z.infer<typeof EventType>;

const base = {
  seq: z.number().int(),
  orgId: z.string(),
  actorUserId: z.string().nullish(),
  createdAt: z.string(),
};

export const CardCreatedEvent = z.object({
  ...base,
  type: z.literal("card_created"),
  payload: z.object({ card: DecisionCard }),
});

export const CardUpdatedEvent = z.object({
  ...base,
  type: z.literal("card_updated"),
  payload: z.object({
    card: DecisionCard,
    // Set when async AI refinement re-routed the card. The previous
    // recipient receives this event too, and must drop the card.
    previousRecipientUserId: z.string().nullish(),
  }),
});

export const MessageCreatedEvent = z.object({
  ...base,
  type: z.literal("message_created"),
  payload: z.object({
    message: CardMessage,
    // Card participants + watchers, denormalized so visibility can be
    // decided without a lookup.
    cardSenderUserId: z.string(),
    cardRecipientUserId: z.string(),
    watcherUserIds: z.array(z.string()).default([]),
    // Org members @mentioned in this message (they get a dedicated
    // card_mention notification and become watchers).
    mentionedUserIds: z.array(z.string()).default([]),
  }),
});

export const CardDeletedEvent = z.object({
  ...base,
  type: z.literal("card_deleted"),
  payload: z.object({
    cardId: z.string(),
    recipientUserId: z.string(),
    senderUserId: z.string(),
  }),
});

export const ChannelCreatedEvent = z.object({
  ...base,
  type: z.literal("channel_created"),
  payload: z.object({ channel: Channel }),
});

export const ChatMessageCreatedEvent = z.object({
  ...base,
  type: z.literal("chat_message_created"),
  payload: z.object({
    message: ChatMessage,
    // Denormalized for lookup-free visibility + notification rendering.
    channelKind: ChannelKind,
    channelName: z.string(),
    memberUserIds: z.array(z.string()).default([]),
    mentionedUserIds: z.array(z.string()).default([]),
    // For thread replies: authors already in the thread (they get a
    // "reply in thread" notification).
    threadParticipantIds: z.array(z.string()).default([]),
  }),
});

export const MemberJoinedEvent = z.object({
  ...base,
  type: z.literal("member_joined"),
  payload: z.object({ member: Member }),
});

export const MemberUpdatedEvent = z.object({
  ...base,
  type: z.literal("member_updated"),
  payload: z.object({ member: Member }),
});

export const MemberLeftEvent = z.object({
  ...base,
  type: z.literal("member_left"),
  payload: z.object({ userId: z.string() }),
});

export const OrgGraphUpdatedEvent = z.object({
  ...base,
  type: z.literal("org_graph_updated"),
  payload: z.object({
    teams: z.array(Team),
    edges: z.array(OrgEdge),
  }),
});

export const OrgEvent = z.discriminatedUnion("type", [
  CardCreatedEvent,
  CardUpdatedEvent,
  CardDeletedEvent,
  MessageCreatedEvent,
  ChannelCreatedEvent,
  ChatMessageCreatedEvent,
  MemberJoinedEvent,
  MemberUpdatedEvent,
  MemberLeftEvent,
  OrgGraphUpdatedEvent,
]);
export type OrgEvent = z.infer<typeof OrgEvent>;

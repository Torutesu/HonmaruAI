import type {
  ChatChannel,
  ChatMessage,
  DecisionCard,
  OrgEdge,
  OrgNode,
  User,
} from "./types";

// Wire envelope: { type, payload, eventId } — see server/index.js send().

export type ServerEvent =
  | { type: "snapshot"; payload: { cardsByUser: Record<string, DecisionCard[]> } }
  | {
      type: "channel_snapshot";
      payload: {
        channels: Record<string, ChatChannel>;
        messagesByChannel: Record<string, ChatMessage[]>;
      };
    }
  | { type: "card_created"; payload: { card: DecisionCard } }
  | { type: "card_updated"; payload: { card: DecisionCard } }
  | { type: "card_deleted"; payload: { cardId: string; recipientUserID: string } }
  | { type: "channel_created"; payload: { channel: ChatChannel } }
  | { type: "channel_message"; payload: { message: ChatMessage } }
  | {
      type: "org_updated";
      payload: { users: User[]; nodes: OrgNode[]; edges: OrgEdge[] };
    }
  | { type: "presence"; payload: { userId: string; status: "online" | "offline" } }
  | { type: "error"; payload: { message: string } };

export type ClientEvent =
  | { type: "join"; payload: { userId: string; orgId?: string; token?: string } }
  | { type: "card_created"; payload: { card: DecisionCard } }
  | { type: "card_updated"; payload: { card: DecisionCard } }
  | { type: "card_deleted"; payload: { cardId: string; recipientUserID: string } }
  | { type: "channel_message"; payload: { channelID: string; text: string } }
  | { type: "channel_create"; payload: { name: string; purpose?: string } }
  | { type: "clear_store"; payload: Record<string, never> };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Decode a raw frame. Returns null for anything malformed or for event types
 * this client doesn't know — forward compatibility is a decoding concern, not
 * a runtime crash.
 */
export function decodeServerEvent(raw: string): ServerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.type !== "string") return null;

  const { type, payload } = parsed as { type: string; payload?: unknown };
  if (!isObject(payload)) return null;

  switch (type) {
    case "snapshot":
      return isObject(payload.cardsByUser)
        ? ({ type, payload } as ServerEvent)
        : null;
    case "channel_snapshot":
      return isObject(payload.channels) && isObject(payload.messagesByChannel)
        ? ({ type, payload } as ServerEvent)
        : null;
    case "card_created":
    case "card_updated":
      return isObject(payload.card) && typeof payload.card.id === "string"
        ? ({ type, payload } as ServerEvent)
        : null;
    case "card_deleted":
      return typeof payload.cardId === "string" &&
        typeof payload.recipientUserID === "string"
        ? ({ type, payload } as ServerEvent)
        : null;
    case "channel_created":
      return isObject(payload.channel) ? ({ type, payload } as ServerEvent) : null;
    case "channel_message":
      return isObject(payload.message) && typeof payload.message.id === "string"
        ? ({ type, payload } as ServerEvent)
        : null;
    case "org_updated":
      return Array.isArray(payload.users) ? ({ type, payload } as ServerEvent) : null;
    case "presence":
      return typeof payload.userId === "string"
        ? ({ type, payload } as ServerEvent)
        : null;
    case "error":
      return typeof payload.message === "string"
        ? ({ type, payload } as ServerEvent)
        : null;
    default:
      return null; // unknown event from a newer relay — ignore, don't throw
  }
}

export const encodeClientEvent = (event: ClientEvent): string => JSON.stringify(event);

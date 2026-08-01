import type { RelaySocket } from "./socket";
import type { DecisionCard } from "./types";

// The app holds one socket; features publish through these helpers instead of
// threading the instance down the tree (mirrors the shared services on iOS).
let socket: RelaySocket | null = null;

export function setRelaySocket(next: RelaySocket | null) {
  socket = next;
}

export function publishCard(card: DecisionCard) {
  socket?.send({ type: "card_created", payload: { card } });
}

export function publishChannelMessage(channelID: string, text: string) {
  socket?.send({ type: "channel_message", payload: { channelID, text } });
}

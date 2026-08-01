import { create } from "zustand";
import type { DecisionCard } from "../types";
import type { ServerEvent } from "../protocol";

interface CardState {
  cardsByUser: Record<string, DecisionCard[]>;
  connected: boolean;
  apply: (event: ServerEvent) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
}

/** Newest first, matching the iOS feed order. */
const sortByNewest = (cards: DecisionCard[]) =>
  [...cards].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

function upsert(
  cardsByUser: Record<string, DecisionCard[]>,
  card: DecisionCard
): Record<string, DecisionCard[]> {
  const existing = cardsByUser[card.recipientUserID] ?? [];
  const index = existing.findIndex((item) => item.id === card.id);
  const next =
    index >= 0
      ? existing.map((item) => (item.id === card.id ? card : item))
      : [card, ...existing];

  return { ...cardsByUser, [card.recipientUserID]: sortByNewest(next) };
}

export const useCardStore = create<CardState>((set) => ({
  cardsByUser: {},
  connected: false,

  setConnected: (connected) => set({ connected }),
  reset: () => set({ cardsByUser: {} }),

  apply: (event) =>
    set((state) => {
      switch (event.type) {
        case "snapshot": {
          const snapshot = Object.fromEntries(
            Object.entries(event.payload.cardsByUser).map(([userID, cards]) => [
              userID,
              sortByNewest(cards),
            ])
          );
          return { cardsByUser: snapshot };
        }
        case "card_created":
        case "card_updated":
          return { cardsByUser: upsert(state.cardsByUser, event.payload.card) };
        case "card_deleted": {
          const { cardId, recipientUserID } = event.payload;
          const existing = state.cardsByUser[recipientUserID];
          if (!existing) return state;
          return {
            cardsByUser: {
              ...state.cardsByUser,
              [recipientUserID]: existing.filter((card) => card.id !== cardId),
            },
          };
        }
        default:
          return state;
      }
    }),
}));

// Shared empty array: a selector that returns a fresh `[]` hands zustand a new
// snapshot identity on every render, which useSyncExternalStore reads as "the
// store changed" — an infinite render loop.
const NO_CARDS: DecisionCard[] = [];

export const selectCardsFor = (userID: string | null) => (state: CardState) =>
  (userID ? state.cardsByUser[userID] : null) ?? NO_CARDS;

export const selectPendingCount = (userID: string | null) => (state: CardState) =>
  ((userID ? state.cardsByUser[userID] : null) ?? NO_CARDS).filter(
    (card) => card.status === "pending"
  ).length;

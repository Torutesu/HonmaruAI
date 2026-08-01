import { create } from "zustand";
import type { ChatChannel, ChatMessage } from "../types";
import type { ServerEvent } from "../protocol";

interface ChannelState {
  channels: ChatChannel[];
  messagesByChannel: Record<string, ChatMessage[]>;
  apply: (event: ServerEvent) => void;
  reset: () => void;
}

const byCreatedAt = (a: ChatChannel, b: ChatChannel) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt);

export const useChannelStore = create<ChannelState>((set) => ({
  channels: [],
  messagesByChannel: {},

  reset: () => set({ channels: [], messagesByChannel: {} }),

  apply: (event) =>
    set((state) => {
      switch (event.type) {
        case "channel_snapshot":
          return {
            channels: Object.values(event.payload.channels).sort(byCreatedAt),
            messagesByChannel: event.payload.messagesByChannel,
          };

        case "channel_created": {
          const channel = event.payload.channel;
          if (state.channels.some((item) => item.id === channel.id)) return state;
          return { channels: [...state.channels, channel].sort(byCreatedAt) };
        }

        case "channel_message": {
          const message = event.payload.message;
          const existing = state.messagesByChannel[message.channelID] ?? [];
          // The relay echoes our own messages back — don't double-render.
          if (existing.some((item) => item.id === message.id)) return state;
          return {
            messagesByChannel: {
              ...state.messagesByChannel,
              [message.channelID]: [...existing, message],
            },
          };
        }

        default:
          return state;
      }
    }),
}));

/** Same identity rule as the card store: never hand back a fresh empty array. */
const NO_MESSAGES: ChatMessage[] = [];

export const selectMessages = (channelID: string | null) => (state: ChannelState) =>
  (channelID ? state.messagesByChannel[channelID] : null) ?? NO_MESSAGES;

export const selectLastMessage = (channelID: string) => (state: ChannelState) => {
  const messages = state.messagesByChannel[channelID] ?? [];
  return messages[messages.length - 1] ?? null;
};

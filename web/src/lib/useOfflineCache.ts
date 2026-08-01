import { useEffect, useState } from "react";
import { readSnapshot, writeSnapshot } from "../core/cache";
import { useCardStore } from "../core/stores/cards";
import { useChannelStore } from "../core/stores/channels";

const WRITE_DEBOUNCE_MS = 800;

/**
 * Fills the stores from the last cached snapshot while the socket is still
 * connecting, then keeps that cache current. Returns when the shown data was
 * synced, or null once we're live — the banner uses it to be honest about
 * what you're looking at.
 */
export function useOfflineCache(userID: string | null) {
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const connected = useCardStore((state) => state.connected);

  useEffect(() => {
    if (!userID) return;
    let cancelled = false;

    readSnapshot(userID).then((snapshot) => {
      if (cancelled || !snapshot) return;
      // Live data always wins: if the socket already delivered a snapshot,
      // restoring the cache would be a visible step backwards.
      const cards = useCardStore.getState();
      if (cards.connected || Object.keys(cards.cardsByUser).length > 0) return;

      cards.apply({ type: "snapshot", payload: { cardsByUser: snapshot.cardsByUser } });
      useChannelStore.getState().apply({
        type: "channel_snapshot",
        payload: {
          channels: Object.fromEntries(snapshot.channels.map((channel) => [channel.id, channel])),
          messagesByChannel: snapshot.messagesByChannel,
        },
      });
      setRestoredAt(snapshot.savedAt);
    });

    return () => {
      cancelled = true;
    };
  }, [userID]);

  useEffect(() => {
    if (!userID) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const cards = useCardStore.getState();
        // Only cache state the relay confirmed; optimistic edits are not truth.
        if (!cards.connected) return;
        const channels = useChannelStore.getState();
        void writeSnapshot({
          userID,
          savedAt: new Date().toISOString(),
          cardsByUser: cards.cardsByUser,
          channels: channels.channels,
          messagesByChannel: channels.messagesByChannel,
        });
      }, WRITE_DEBOUNCE_MS);
    };

    const offCards = useCardStore.subscribe(schedule);
    const offChannels = useChannelStore.subscribe(schedule);
    return () => {
      if (timer) clearTimeout(timer);
      offCards();
      offChannels();
    };
  }, [userID]);

  return connected ? null : restoredAt;
}

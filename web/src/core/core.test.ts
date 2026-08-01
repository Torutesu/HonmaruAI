import { describe, expect, it, beforeEach } from "vitest";
import { decodeServerEvent, encodeClientEvent } from "./protocol";
import { useCardStore } from "./stores/cards";
import { useChannelStore } from "./stores/channels";
import type { ChatMessage, DecisionCard } from "./types";
import { urlBase64ToUint8Array } from "../lib/push";

const card = (overrides: Partial<DecisionCard> = {}): DecisionCard => ({
  id: "c1",
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "task",
  title: "Fix login",
  summary: "Login is broken",
  context: "deadline: Friday",
  status: "pending",
  priority: "high",
  createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
  ...overrides,
});

const frame = (type: string, payload: unknown) => JSON.stringify({ type, payload });

describe("protocol", () => {
  it("decodes the events the relay actually sends", () => {
    expect(decodeServerEvent(frame("card_created", { card: card() }))?.type).toBe("card_created");
    expect(decodeServerEvent(frame("snapshot", { cardsByUser: {} }))?.type).toBe("snapshot");
    expect(
      decodeServerEvent(frame("channel_snapshot", { channels: {}, messagesByChannel: {} }))?.type
    ).toBe("channel_snapshot");
    expect(
      decodeServerEvent(frame("card_deleted", { cardId: "c1", recipientUserID: "user-bob" }))?.type
    ).toBe("card_deleted");
    expect(decodeServerEvent(frame("presence", { userId: "user-bob", status: "online" }))?.type).toBe(
      "presence"
    );
  });

  it("ignores malformed frames instead of throwing", () => {
    expect(decodeServerEvent("not json")).toBeNull();
    expect(decodeServerEvent(frame("card_created", { card: {} }))).toBeNull();
    expect(decodeServerEvent(frame("card_created", null))).toBeNull();
    expect(decodeServerEvent(JSON.stringify({ payload: {} }))).toBeNull();
  });

  it("tolerates event types a newer relay might add", () => {
    expect(decodeServerEvent(frame("card_archived", { card: card() }))).toBeNull();
  });

  it("keeps unknown enum values rather than dropping the card", () => {
    const decoded = decodeServerEvent(frame("card_created", { card: card({ status: "snoozed" }) }));
    expect(decoded).not.toBeNull();
    if (decoded?.type === "card_created") {
      expect(decoded.payload.card.status).toBe("snoozed");
    }
  });

  it("encodes join the way the relay expects", () => {
    expect(
      JSON.parse(
        encodeClientEvent({ type: "join", payload: { userId: "user-alice", orgId: "core-team" } })
      )
    ).toEqual({ type: "join", payload: { userId: "user-alice", orgId: "core-team" } });
  });
});

describe("card store", () => {
  beforeEach(() => useCardStore.setState({ cardsByUser: {}, connected: false }));

  it("replaces everything on snapshot, newest first", () => {
    const older = card({ id: "old", createdAt: "2026-01-01T09:00:00Z" });
    const newer = card({ id: "new", createdAt: "2026-01-01T11:00:00Z" });

    useCardStore.getState().apply({
      type: "snapshot",
      payload: { cardsByUser: { "user-bob": [older, newer] } },
    });

    expect(useCardStore.getState().cardsByUser["user-bob"]?.map((c) => c.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("adds created cards and replaces updated ones in place", () => {
    const store = useCardStore.getState();
    store.apply({ type: "card_created", payload: { card: card() } });
    store.apply({
      type: "card_updated",
      payload: { card: card({ status: "approved", githubIssueNumber: 12 }) },
    });

    const cards = useCardStore.getState().cardsByUser["user-bob"] ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.status).toBe("approved");
    expect(cards[0]?.githubIssueNumber).toBe(12);
  });

  it("keeps each recipient's feed separate", () => {
    const store = useCardStore.getState();
    store.apply({ type: "card_created", payload: { card: card() } });
    store.apply({
      type: "card_created",
      payload: { card: card({ id: "c2", recipientUserID: "user-alice" }) },
    });

    const state = useCardStore.getState();
    expect(state.cardsByUser["user-bob"]).toHaveLength(1);
    expect(state.cardsByUser["user-alice"]).toHaveLength(1);
  });

  it("keeps the relay's version of an optimistically updated card", () => {
    const store = useCardStore.getState();
    store.apply({ type: "card_created", payload: { card: card() } });
    // Optimistic flip in the UI…
    store.apply({ type: "card_updated", payload: { card: card({ status: "approved" }) } });
    // …then the authoritative result arrives with the issue attached.
    store.apply({
      type: "card_updated",
      payload: {
        card: card({ status: "approved", githubIssueNumber: 42, context: "Condition: Friday" }),
      },
    });

    const stored = useCardStore.getState().cardsByUser["user-bob"]?.[0];
    expect(stored?.githubIssueNumber).toBe(42);
    expect(stored?.context).toContain("Condition: Friday");
  });

  it("removes deleted cards and ignores unknown recipients", () => {
    const store = useCardStore.getState();
    store.apply({ type: "card_created", payload: { card: card() } });
    store.apply({
      type: "card_deleted",
      payload: { cardId: "c1", recipientUserID: "user-bob" },
    });
    store.apply({
      type: "card_deleted",
      payload: { cardId: "nope", recipientUserID: "user-nobody" },
    });

    expect(useCardStore.getState().cardsByUser["user-bob"]).toHaveLength(0);
  });
});

describe("web push key conversion", () => {
  it("decodes base64url VAPID keys into raw bytes", () => {
    // "hello" in base64url, no padding
    expect(Array.from(urlBase64ToUint8Array("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
  });

  it("handles the url-safe alphabet and missing padding", () => {
    // 0xFB 0xFF 0xBE encodes to "+/++" in standard base64 → "-_--" url-safe
    expect(Array.from(urlBase64ToUint8Array("-_--"))).toEqual(
      Array.from(urlBase64ToUint8Array("+/++"))
    );
    expect(urlBase64ToUint8Array("aGVsbG8gd29ybGQ").length).toBe(11);
  });

  it("returns a plain ArrayBuffer — PushManager rejects shared buffers", () => {
    expect(urlBase64ToUint8Array("aGVsbG8").buffer).toBeInstanceOf(ArrayBuffer);
  });
});

describe("channel store", () => {
  const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    id: "m1",
    channelID: "channel-general",
    authorID: "user-alice",
    authorKind: "user",
    authorName: "Alice",
    text: "shipping today",
    createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
    ...overrides,
  });

  beforeEach(() => useChannelStore.setState({ channels: [], messagesByChannel: {} }));

  it("loads the snapshot and appends new messages", () => {
    const store = useChannelStore.getState();
    store.apply({
      type: "channel_snapshot",
      payload: {
        channels: {
          "channel-general": {
            id: "channel-general",
            name: "general",
            purpose: "",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
        messagesByChannel: { "channel-general": [message()] },
      },
    });
    store.apply({
      type: "channel_message",
      payload: { message: message({ id: "m2", text: "and again" }) },
    });

    const state = useChannelStore.getState();
    expect(state.channels.map((c) => c.name)).toEqual(["general"]);
    expect(state.messagesByChannel["channel-general"]).toHaveLength(2);
  });

  it("ignores the echo of a message it already has", () => {
    const store = useChannelStore.getState();
    store.apply({ type: "channel_message", payload: { message: message() } });
    store.apply({ type: "channel_message", payload: { message: message() } });
    expect(useChannelStore.getState().messagesByChannel["channel-general"]).toHaveLength(1);
  });

  it("adds channels created by other clients, once", () => {
    const channel = {
      id: "channel-launch",
      name: "launch-plan",
      purpose: "",
      createdAt: "2026-01-02T00:00:00Z",
    };
    const store = useChannelStore.getState();
    store.apply({ type: "channel_created", payload: { channel } });
    store.apply({ type: "channel_created", payload: { channel } });
    expect(useChannelStore.getState().channels).toHaveLength(1);
  });
});

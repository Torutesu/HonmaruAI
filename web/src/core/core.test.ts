import { describe, expect, it, beforeEach } from "vitest";
import { decodeServerEvent, encodeClientEvent } from "./protocol";
import { useCardStore } from "./stores/cards";
import type { DecisionCard } from "./types";

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

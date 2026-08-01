import { describe, expect, it } from "vitest";
import { isStale, isUsable, trimSnapshot, MAX_AGE_MS, type CachedSnapshot } from "./cache";
import type { ChatMessage, DecisionCard } from "./types";

const card = (id: string): DecisionCard => ({
  id,
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "task",
  title: id,
  summary: "",
  context: "",
  status: "pending",
  priority: "medium",
  createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
});

const message = (id: string): ChatMessage => ({
  id,
  channelID: "channel-1",
  authorID: "user-alice",
  authorKind: "user",
  authorName: "Alice",
  text: id,
  createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
});

const snapshot = (overrides: Partial<CachedSnapshot> = {}): CachedSnapshot => ({
  userID: "user-bob",
  savedAt: new Date("2026-01-01T10:00:00Z").toISOString(),
  cardsByUser: { "user-bob": [card("c1")] },
  channels: [{ id: "channel-1", name: "core", purpose: "", createdAt: "2026-01-01T09:00:00Z" }],
  messagesByChannel: { "channel-1": [message("m1")] },
  ...overrides,
});

describe("trimSnapshot", () => {
  it("keeps the recent end of each list", () => {
    const trimmed = trimSnapshot(
      snapshot({
        cardsByUser: { "user-bob": [card("newest"), card("older"), card("oldest")] },
        messagesByChannel: { "channel-1": [message("m1"), message("m2"), message("m3")] },
      }),
      { cardsPerUser: 2, messagesPerChannel: 2 }
    );

    // Cards are newest-first; messages are appended, so oldest-first.
    expect(trimmed.cardsByUser["user-bob"]!.map((c) => c.id)).toEqual(["newest", "older"]);
    expect(trimmed.messagesByChannel["channel-1"]!.map((m) => m.id)).toEqual(["m2", "m3"]);
  });
});

describe("isStale", () => {
  const savedAt = new Date("2026-01-01T10:00:00Z").toISOString();
  const at = (offset: number) => Date.parse(savedAt) + offset;

  it("expires a snapshot older than the max age", () => {
    expect(isStale({ savedAt }, at(MAX_AGE_MS - 1000))).toBe(false);
    expect(isStale({ savedAt }, at(MAX_AGE_MS + 1000))).toBe(true);
  });

  it("treats an unparseable timestamp as stale", () => {
    expect(isStale({ savedAt: "whenever" })).toBe(true);
  });
});

describe("isUsable", () => {
  const now = Date.parse("2026-01-01T11:00:00Z");

  it("accepts a fresh snapshot for the same person", () => {
    expect(isUsable(snapshot(), "user-bob", now)).toBe(true);
  });

  it("never shows another member's feed after switching", () => {
    expect(isUsable(snapshot(), "user-alice", now)).toBe(false);
  });

  it("rejects an empty snapshot — there is nothing to restore", () => {
    expect(
      isUsable(snapshot({ cardsByUser: {}, channels: [], messagesByChannel: {} }), "user-bob", now)
    ).toBe(false);
  });

  it("rejects an expired snapshot rather than showing a week-old feed", () => {
    expect(isUsable(snapshot(), "user-bob", now + MAX_AGE_MS)).toBe(false);
  });
});

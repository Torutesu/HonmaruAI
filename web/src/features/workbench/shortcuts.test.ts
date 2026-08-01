import { describe, expect, it } from "vitest";
import type { DecisionCard } from "../../core/types";
import { appliesTo, moveIndex, resolveShortcut } from "./shortcuts";

const card = (overrides: Partial<DecisionCard> = {}): DecisionCard => ({
  id: "c1",
  recipientUserID: "user-bob",
  senderUserID: "user-alice",
  type: "approval",
  title: "Ship the pricing page",
  summary: "Copy is final",
  context: "deadline: Friday",
  status: "pending",
  priority: "high",
  createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
  ...overrides,
});

describe("resolveShortcut", () => {
  it("maps the deciding keys", () => {
    expect(resolveShortcut({ key: "j" })).toBe("next");
    expect(resolveShortcut({ key: "ArrowDown" })).toBe("next");
    expect(resolveShortcut({ key: "k" })).toBe("previous");
    expect(resolveShortcut({ key: "ArrowUp" })).toBe("previous");
    expect(resolveShortcut({ key: "Enter" })).toBe("approve");
    expect(resolveShortcut({ key: "Backspace" })).toBe("reject");
    expect(resolveShortcut({ key: "r" })).toBe("reply");
    expect(resolveShortcut({ key: "?" })).toBe("help");
  });

  it("never decides while the user is typing", () => {
    for (const key of ["j", "k", "Enter", "Backspace", "r", "?"]) {
      expect(resolveShortcut({ key }, { typing: true })).toBeNull();
    }
  });

  it("opens the palette on ⌘K / Ctrl+K even from a text field", () => {
    expect(resolveShortcut({ key: "k", metaKey: true })).toBe("palette");
    expect(resolveShortcut({ key: "K", ctrlKey: true }, { typing: true })).toBe("palette");
  });

  it("ignores other modified keys so browser shortcuts still work", () => {
    expect(resolveShortcut({ key: "r", metaKey: true })).toBeNull();
    expect(resolveShortcut({ key: "j", altKey: true })).toBeNull();
    expect(resolveShortcut({ key: "z" })).toBeNull();
  });
});

describe("appliesTo", () => {
  it("only decides pending cards", () => {
    expect(appliesTo("approve", card())).toBe(true);
    expect(appliesTo("approve", card({ status: "approved" }))).toBe(false);
    expect(appliesTo("reply", card({ status: "rejected" }))).toBe(false);
  });

  it("has nothing to decline on a notification", () => {
    const notification = card({ type: "notification" });
    expect(appliesTo("approve", notification)).toBe(true);
    expect(appliesTo("reject", notification)).toBe(false);
  });

  it("lets navigation work with no selection at all", () => {
    expect(appliesTo("next", null)).toBe(true);
    expect(appliesTo("palette", null)).toBe(true);
    expect(appliesTo("approve", null)).toBe(false);
  });
});

describe("moveIndex", () => {
  it("clamps at both ends instead of wrapping", () => {
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(1, 1, 3)).toBe(2);
  });

  it("enters the queue from either direction when nothing is selected", () => {
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
    expect(moveIndex(-1, 1, 0)).toBe(-1);
  });
});

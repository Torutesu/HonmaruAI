import type { DecisionCard } from "../../core/types";
import { isNotification, isPending } from "../../core/types";

export type ShortcutIntent =
  | "next"
  | "previous"
  | "approve"
  | "reject"
  | "reply"
  | "help"
  | "palette";

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * Key → intent, with no DOM and no React, so the whole shortcut table is
 * testable in Node. The palette is the one binding that survives a modifier
 * (and typing), because ⌘K is how you leave a text field.
 */
export function resolveShortcut(
  event: KeyEventLike,
  { typing = false }: { typing?: boolean } = {}
): ShortcutIntent | null {
  const modified = Boolean(event.metaKey || event.ctrlKey);
  if (modified && event.key.toLowerCase() === "k") return "palette";
  if (typing || modified || event.altKey) return null;

  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    case "Enter":
      return "approve";
    case "Backspace":
      return "reject";
    case "r":
      return "reply";
    case "?":
      return "help";
    default:
      return null;
  }
}

/** Decision intents only apply to a pending card — and nothing declines a notification. */
export function appliesTo(intent: ShortcutIntent, card: DecisionCard | null): boolean {
  if (intent === "next" || intent === "previous" || intent === "help" || intent === "palette") {
    return true;
  }
  if (!card || !isPending(card)) return false;
  if (intent === "reject") return !isNotification(card);
  return true;
}

/** Queue movement clamps at both ends: no wrap-around past the last decision. */
export function moveIndex(index: number, delta: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(Math.max(index + delta, 0), length - 1);
}

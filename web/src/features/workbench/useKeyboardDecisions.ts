import { useEffect } from "react";
import type { DecisionCard } from "../../core/types";
import { appliesTo, moveIndex, resolveShortcut } from "./shortcuts";

interface Options {
  cards: DecisionCard[];
  selectedID: string | null;
  onSelect: (cardID: string) => void;
  onApprove: (card: DecisionCard) => void;
  onReject: (card: DecisionCard) => void;
  onReply: (card: DecisionCard) => void;
  onToggleHelp: () => void;
  onCommandPalette: () => void;
  enabled: boolean;
}

/** Typing must never trigger a decision. */
function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable;
}

/**
 * Keyboard-first deciding: move through the queue and decide without reaching
 * for the mouse. The key table itself lives in ./shortcuts.
 */
export function useKeyboardDecisions({
  cards,
  selectedID,
  onSelect,
  onApprove,
  onReject,
  onReply,
  onToggleHelp,
  onCommandPalette,
  enabled,
}: Options) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const intent = resolveShortcut(event, { typing: isTyping(event.target) });
      if (!intent) return;

      const index = cards.findIndex((card) => card.id === selectedID);
      const current = index >= 0 ? cards[index]! : null;
      if (!appliesTo(intent, current)) return;

      event.preventDefault();

      switch (intent) {
        case "next":
        case "previous": {
          const target = cards[moveIndex(index, intent === "next" ? 1 : -1, cards.length)];
          if (target) onSelect(target.id);
          break;
        }
        case "approve":
          onApprove(current!);
          break;
        case "reject":
          onReject(current!);
          break;
        case "reply":
          onReply(current!);
          break;
        case "help":
          onToggleHelp();
          break;
        case "palette":
          onCommandPalette();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    enabled,
    cards,
    selectedID,
    onSelect,
    onApprove,
    onReject,
    onReply,
    onToggleHelp,
    onCommandPalette,
  ]);
}

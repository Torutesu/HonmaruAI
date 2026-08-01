import { useCallback, useState } from "react";
import { api, ApiError } from "../../core/api";
import type { DecisionAction } from "../../core/api";
import { useCardStore } from "../../core/stores/cards";
import { useSessionStore } from "../../core/stores/session";
import type { DecisionCard } from "../../core/types";

/**
 * Failures the user can act on. Offline is the common one and the least
 * self-explanatory: the cached feed still reads, but nothing decides.
 */
function describeFailure(cause: unknown, fallback: string) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline — reconnect to decide.";
  }
  if (cause instanceof ApiError) {
    if (cause.status === 409) return "Someone already decided this card.";
    if (cause.status === 401) return "Your session expired — sign in again.";
    return cause.message;
  }
  // fetch() rejects with a TypeError when the relay is unreachable.
  if (cause instanceof TypeError) return "Can't reach the relay — retry in a moment.";
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Card actions. The relay owns the outcome; the store still updates
 * optimistically so the feed feels instant, and rolls back on failure.
 */
export function useDecisions() {
  const me = useSessionStore((state) => state.me);
  const apply = useCardStore((state) => state.apply);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async (
      card: DecisionCard,
      action: DecisionAction,
      extra: { note?: string; delegateToUserID?: string; priority?: string } = {}
    ) => {
      if (!me) return;
      setBusyCardId(card.id);
      setError(null);

      const optimisticStatus: Record<string, DecisionCard["status"]> = {
        approve: "approved",
        reject: "rejected",
        revise: "revised",
        acknowledge: "acknowledged",
        delegate: "delegated",
      };
      const previous = card;
      if (optimisticStatus[action]) {
        apply({
          type: "card_updated",
          payload: { card: { ...card, status: optimisticStatus[action]! } },
        });
      }

      try {
        const { card: decided } = await api.decide({
          cardId: card.id,
          action,
          ...extra,
        });
        // The relay's version is authoritative (issue number, context notes).
        apply({ type: "card_updated", payload: { card: decided } });
      } catch (cause) {
        apply({ type: "card_updated", payload: { card: previous } });
        setError(describeFailure(cause, "Could not save the decision."));
      } finally {
        setBusyCardId(null);
      }
    },
    [me, apply]
  );

  /** Freeform reply: the AI decides whether it's a decision, a question or a note. */
  const reply = useCallback(
    async (card: DecisionCard, text: string) => {
      if (!me) return;
      setBusyCardId(card.id);
      setError(null);

      try {
        const interpretation = await api.interpretReply({ card, reply: text, sender: me });
        const note = interpretation.note || text;

        if (interpretation.action === "approve") await run(card, "approve", { note });
        else if (interpretation.action === "reject") await run(card, "reject", { note });
        else if (interpretation.action === "revise") await run(card, "revise", { note });
        else {
          // Questions and comments keep the decision pending: they go back to
          // the sender as their own card via the revise-free path.
          setNotice(
            interpretation.action === "question"
              ? "Question sent — this decision stays pending"
              : "Note sent to the sender"
          );
        }
      } catch (cause) {
        setError(describeFailure(cause, "Could not read the reply."));
      } finally {
        setBusyCardId(null);
      }
    },
    [me, run]
  );

  const askAI = useCallback(
    async (card: DecisionCard, instruction: string) => {
      setBusyCardId(card.id);
      setError(null);
      try {
        const refined = await api.refineCard({ card, instruction });
        apply({
          type: "card_updated",
          payload: {
            card: {
              ...card,
              title: refined.title,
              summary: refined.summary,
              context: refined.context,
              priority: refined.priority,
            },
          },
        });
        setNotice("Card updated by your AI");
      } catch (cause) {
        setError(describeFailure(cause, "Could not update the card."));
      } finally {
        setBusyCardId(null);
      }
    },
    [apply]
  );

  return {
    busyCardId,
    error,
    notice,
    clearError: () => setError(null),
    clearNotice: () => setNotice(null),
    approve: (card: DecisionCard, note?: string) => run(card, "approve", { note }),
    reject: (card: DecisionCard, note?: string) => run(card, "reject", { note }),
    revise: (card: DecisionCard, note: string) => run(card, "revise", { note }),
    acknowledge: (card: DecisionCard) => run(card, "acknowledge"),
    delegate: (card: DecisionCard, delegateToUserID: string) =>
      run(card, "delegate", { delegateToUserID }),
    setPriority: (card: DecisionCard, priority: string) => run(card, "priority", { priority }),
    reply,
    askAI,
  };
}

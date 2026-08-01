import { useEffect, useRef, useState } from "react";
import { selectCardsFor, selectPendingCount, useCardStore } from "../../core/stores/cards";
import { useSessionStore } from "../../core/stores/session";
import type { CardSource } from "../../core/types";
import { ComposeBar } from "../compose/ComposeBar";
import { DecisionCardView } from "./DecisionCardView";
import { useDecisions } from "./useDecisions";
import styles from "./FeedScreen.module.css";

interface Props {
  onOpenSource?: (source: CardSource) => void;
  /** From a notification tap: scroll this card into view. */
  focusCardID?: string | null;
  onFocusHandled?: () => void;
}

export function FeedScreen({ onOpenSource, focusCardID, onFocusHandled }: Props) {
  const me = useSessionStore((state) => state.me);
  const users = useSessionStore((state) => state.users);
  const cards = useCardStore(selectCardsFor(me?.id ?? null));
  const pending = useCardStore(selectPendingCount(me?.id ?? null));
  const decisions = useDecisions();
  const [toast, setToast] = useState<string | null>(null);

  const message = toast ?? decisions.notice ?? decisions.error;

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => {
      setToast(null);
      decisions.clearNotice();
      decisions.clearError();
    }, 3000);
    return () => clearTimeout(timer);
  }, [message, decisions]);

  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // A tapped notification lands on its card — once it has actually arrived.
  useEffect(() => {
    if (!focusCardID) return;
    const element = cardRefs.current.get(focusCardID);
    if (!element) return;
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    onFocusHandled?.();
  }, [focusCardID, cards, onFocusHandled]);

  const nameFor = (userID: string) =>
    users.find((user) => user.id === userID)?.name ?? userID;

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <span className={styles.pending}>{pending} pending</span>
      </header>

      {message && (
        <div
          className={`${styles.toast} ${decisions.error ? styles.toastError : ""}`}
          role="status"
        >
          {message}
        </div>
      )}

      <main className={styles.feed}>
        {cards.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Tell your AI what you need</p>
            <p className={styles.emptyHint}>Decisions will show up here</p>
          </div>
        ) : (
          cards.map((card) => (
            <div
              key={card.id}
              className={styles.slot}
              ref={(element) => {
                if (element) cardRefs.current.set(card.id, element);
                else cardRefs.current.delete(card.id);
              }}
            >
            <DecisionCardView
              card={card}
              senderName={nameFor(card.senderUserID)}
              busy={decisions.busyCardId === card.id}
              actions={decisions}
              onOpenSource={onOpenSource}
            />
            </div>
          ))
        )}
      </main>

      <footer className={styles.composer}>
        <ComposeBar onSent={setToast} />
      </footer>
    </div>
  );
}

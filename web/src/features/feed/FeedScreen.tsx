import { selectCardsFor, selectPendingCount, useCardStore } from "../../core/stores/cards";
import { useSessionStore } from "../../core/stores/session";
import { DecisionCardView } from "./DecisionCardView";
import styles from "./FeedScreen.module.css";

export function FeedScreen() {
  const me = useSessionStore((state) => state.me);
  const users = useSessionStore((state) => state.users);
  const connected = useCardStore((state) => state.connected);
  const cards = useCardStore(selectCardsFor(me?.id ?? null));
  const pending = useCardStore(selectPendingCount(me?.id ?? null));

  const nameFor = (userID: string) =>
    users.find((user) => user.id === userID)?.name ?? userID;

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <button className={styles.user} type="button">
          <span
            className={`${styles.dot} ${connected ? styles.dotOnline : ""}`}
            title={connected ? "Connected" : "Reconnecting…"}
          />
          {me?.name ?? "…"}
        </button>
        <span className={styles.pending}>
          {pending} pending
        </span>
      </header>

      <main className={styles.feed}>
        {cards.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Tell your AI what you need</p>
            <p className={styles.emptyHint}>Decisions will show up here</p>
          </div>
        ) : (
          cards.map((card) => (
            <DecisionCardView key={card.id} card={card} senderName={nameFor(card.senderUserID)} />
          ))
        )}
      </main>
    </div>
  );
}

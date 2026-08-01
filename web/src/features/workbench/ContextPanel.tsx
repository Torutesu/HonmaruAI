import { useChannelStore } from "../../core/stores/channels";
import type { DecisionCard } from "../../core/types";
import { isReadableDoc, useDocPreview } from "../sources/docPreview";
import styles from "./Workbench.module.css";

interface Props {
  card: DecisionCard | null;
}

/**
 * The payoff of the wide layout: the summary you're deciding on and the
 * conversation it came from, side by side — no navigation at all.
 */
export function ContextPanel({ card }: Props) {
  const channels = useChannelStore((state) => state.channels);
  const messagesByChannel = useChannelStore((state) => state.messagesByChannel);
  const openDoc = useDocPreview((state) => state.open);

  if (!card) {
    return (
      <aside className={styles.context}>
        <div className={styles.contextHeader}>Context</div>
        <p className={styles.contextEmpty}>Select a decision to see where it came from.</p>
      </aside>
    );
  }

  const channelSource = card.sources?.find((source) => source.kind === "channel");
  const links = card.sources?.filter((source) => Boolean(source.url)) ?? [];
  const channel = channelSource?.channelID
    ? channels.find((item) => item.id === channelSource.channelID)
    : null;
  const messages = channel ? messagesByChannel[channel.id] ?? [] : [];

  return (
    <aside className={styles.context}>
      <div className={styles.contextHeader}>
        {channel ? `#${channel.name}` : "Context"}
      </div>

      <div className={styles.contextBody}>
        {channel ? (
          <div className={styles.thread}>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`${styles.message} ${
                  // The message that triggered this decision, marked so the
                  // eye lands on it without reading the whole thread.
                  message.id === card.sourceMessageID ? styles.messageSource : ""
                }`}
              >
                <div className={styles.messageAuthor}>
                  {message.authorName}
                  {message.authorKind === "agent" && (
                    <span className={styles.agentTag}>AI</span>
                  )}
                </div>
                <div className={styles.messageText}>{message.text}</div>
              </div>
            ))}
            {messages.length === 0 && (
              <p className={styles.contextEmpty}>No messages in this channel yet.</p>
            )}
          </div>
        ) : (
          <p className={styles.contextEmpty}>
            This decision has no linked conversation. Its context lives on the card itself.
          </p>
        )}
      </div>

      {links.length > 0 && (
        <div className={styles.contextLinks}>
          {links.map((source) =>
            isReadableDoc(source) ? (
              <button
                key={source.url}
                className={styles.contextLink}
                style={{ textAlign: "left", background: "none", border: 0 }}
                onClick={() => openDoc(source)}
              >
                ▤ {source.label}
              </button>
            ) : (
              <a
                key={source.url}
                className={styles.contextLink}
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                ↗ {source.label}
              </a>
            )
          )}
        </div>
      )}
    </aside>
  );
}

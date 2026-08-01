import { useChannelStore } from "../../core/stores/channels";
import type { DecisionCard } from "../../core/types";
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
          <div style={{ padding: "0 18px 12px", display: "grid", gap: 14 }}>
            {messages.map((message) => {
              const highlighted = message.id === card.sourceMessageID;
              return (
                <div
                  key={message.id}
                  style={{
                    padding: highlighted ? 10 : 0,
                    margin: highlighted ? -10 : 0,
                    borderRadius: 12,
                    background: highlighted ? "var(--tint)" : "transparent",
                  }}
                >
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color:
                        message.authorKind === "agent" ? "var(--accent)" : "var(--t1)",
                    }}
                  >
                    {message.authorName}
                    {message.authorKind === "agent" && " · AI"}
                  </div>
                  <div style={{ fontSize: 13.5, color: "var(--t2)", marginTop: 2 }}>
                    {message.text}
                  </div>
                </div>
              );
            })}
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
          {links.map((source) => (
            <a
              key={source.url}
              className={styles.contextLink}
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              ↗ {source.label}
            </a>
          ))}
        </div>
      )}
    </aside>
  );
}

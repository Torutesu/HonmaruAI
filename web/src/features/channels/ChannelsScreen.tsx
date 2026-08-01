import { useEffect, useRef, useState } from "react";
import { publishChannelMessage } from "../../core/relay";
import { selectMessages, useChannelStore } from "../../core/stores/channels";
import styles from "./ChannelsScreen.module.css";

interface Props {
  /** Deep link from a card's source chip. */
  initialChannelID?: string | null;
  highlightMessageID?: string | null;
  onConsumeDeepLink?: () => void;
}

export function ChannelsScreen({
  initialChannelID = null,
  highlightMessageID = null,
  onConsumeDeepLink,
}: Props) {
  const channels = useChannelStore((state) => state.channels);
  const [openChannelID, setOpenChannelID] = useState<string | null>(initialChannelID);

  useEffect(() => {
    if (initialChannelID) setOpenChannelID(initialChannelID);
  }, [initialChannelID]);

  const openChannel = channels.find((channel) => channel.id === openChannelID) ?? null;

  if (!openChannel) {
    return (
      <div className={styles.screen}>
        <div className={styles.list}>
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channelID={channel.id}
              name={channel.name}
              purpose={channel.purpose}
              onOpen={() => setOpenChannelID(channel.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <Timeline
      channelID={openChannel.id}
      name={openChannel.name}
      highlightMessageID={highlightMessageID}
      onBack={() => {
        setOpenChannelID(null);
        onConsumeDeepLink?.();
      }}
    />
  );
}

function ChannelRow({
  channelID,
  name,
  purpose,
  onOpen,
}: {
  channelID: string;
  name: string;
  purpose: string;
  onOpen: () => void;
}) {
  const messages = useChannelStore(selectMessages(channelID));
  const last = messages[messages.length - 1];

  return (
    <button className={styles.row} onClick={onOpen}>
      <span className={styles.rowName}>#{name}</span>
      <span className={styles.rowPreview}>
        {last ? `${last.authorName}: ${last.text}` : purpose}
      </span>
    </button>
  );
}

function Timeline({
  channelID,
  name,
  highlightMessageID,
  onBack,
}: {
  channelID: string;
  name: string;
  highlightMessageID: string | null;
  onBack: () => void;
}) {
  const messages = useChannelStore(selectMessages(channelID));
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // A deep link lands on the exact message; otherwise stay pinned to the end.
  useEffect(() => {
    if (highlightMessageID && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: "center" });
    } else {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [highlightMessageID, messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    publishChannelMessage(channelID, text);
    setDraft("");
  };

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <button className={styles.back} onClick={onBack} aria-label="Back to channels">
          ‹
        </button>
        #{name}
      </div>

      <div className={styles.timeline}>
        {messages.map((message) => {
          const highlighted = message.id === highlightMessageID;
          const isAgent = message.authorKind === "agent";

          return (
            <div
              key={message.id}
              ref={highlighted ? highlightRef : undefined}
              className={`${styles.message} ${highlighted ? styles.highlighted : ""}`}
            >
              <div className={`${styles.avatar} ${isAgent ? styles.avatarAgent : ""}`}>
                {isAgent ? "✦" : message.authorName.charAt(0)}
              </div>
              <div className={styles.body}>
                <div className={`${styles.header} ${isAgent ? styles.headerAgent : ""}`}>
                  {message.authorName}
                  {isAgent && <span className={styles.badge}>AI</span>}
                  <span className={styles.time}>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className={styles.text}>{message.text}</div>
                {message.toolCalls?.map((call) => (
                  <span className={styles.tool} key={`${call.name}-${call.detail}`}>
                    ⑃ {call.label} — {call.detail}
                  </span>
                ))}
                {message.cardID && (
                  <div className={styles.cardNote}>
                    Decision card routed — it's in the recipient's feed
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <p className={styles.tip}>@ai joins the conversation · @ai file: &lt;ask&gt; routes a card</p>

      <div className={styles.composer}>
        <input
          value={draft}
          aria-label={`Message #${name}`}
          placeholder={`Message #${name}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send()}
        />
        <button onClick={send} aria-label="Send">
          ↑
        </button>
      </div>
    </div>
  );
}

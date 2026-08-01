import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../core/api";
import { selectCardsFor, selectPendingCount, useCardStore } from "../../core/stores/cards";
import { useChannelStore } from "../../core/stores/channels";
import { useSessionStore } from "../../core/stores/session";
import type { CardSource, DecisionCard } from "../../core/types";
import { isNotification, isPending } from "../../core/types";
import { ChannelsScreen } from "../channels/ChannelsScreen";
import { ComposeBar } from "../compose/ComposeBar";
import { DecisionCardView } from "../feed/DecisionCardView";
import { useDecisions } from "../feed/useDecisions";
import { SettingsScreen } from "../settings/SettingsScreen";
import { CommandPalette } from "./CommandPalette";
import type { Command } from "./CommandPalette";
import { ContextPanel } from "./ContextPanel";
import { useKeyboardDecisions } from "./useKeyboardDecisions";
import styles from "./Workbench.module.css";

type View = "decisions" | "channels" | "settings";

interface Props {
  connected: boolean;
  /** From a notification tap: select this card. */
  focusCardID?: string | null;
  onFocusHandled?: () => void;
}

/**
 * The desktop face of the same app. The phone shell is one card at a time;
 * here the queue, the card and the conversation it came from are all visible
 * at once, and a decision session runs entirely from the keyboard.
 */
export function Workbench({ connected, focusCardID, onFocusHandled }: Props) {
  const me = useSessionStore((state) => state.me);
  const users = useSessionStore((state) => state.users);
  const setMe = useSessionStore((state) => state.setMe);
  const channels = useChannelStore((state) => state.channels);
  const cards = useCardStore(selectCardsFor(me?.id ?? null));
  const pending = useCardStore(selectPendingCount(me?.id ?? null));
  const decisions = useDecisions();

  const [view, setView] = useState<View>("decisions");
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<{ channelID: string; messageID?: string } | null>(
    null
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [replySignal, setReplySignal] = useState(0);
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

  // Something is always selected, so the keyboard has a target from the first
  // keystroke — and a decided card keeps its place instead of jumping away.
  useEffect(() => {
    if (cards.length === 0) {
      if (selectedID) setSelectedID(null);
      return;
    }
    if (!selectedID || !cards.some((card) => card.id === selectedID)) {
      setSelectedID(cards[0]!.id);
    }
  }, [cards, selectedID]);

  useEffect(() => {
    if (!focusCardID) return;
    if (!cards.some((card) => card.id === focusCardID)) return;
    setView("decisions");
    setSelectedID(focusCardID);
    onFocusHandled?.();
  }, [focusCardID, cards, onFocusHandled]);

  const selected = cards.find((card) => card.id === selectedID) ?? null;

  // Keyboard navigation has to bring the selection into view; the mouse never
  // scrolled for us.
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedID]);

  const openReplyOn = useCallback((card: DecisionCard) => {
    setSelectedID(card.id);
    setReplySignal((signal) => signal + 1);
  }, []);

  useKeyboardDecisions({
    cards,
    selectedID,
    enabled: view === "decisions" && !paletteOpen,
    onSelect: setSelectedID,
    onApprove: (card) => (isNotification(card) ? decisions.acknowledge(card) : decisions.approve(card)),
    onReject: (card) => decisions.reject(card),
    onReply: openReplyOn,
    onToggleHelp: () => setHelpOpen((open) => !open),
    onCommandPalette: () => setPaletteOpen(true),
  });

  const openChannel = useCallback((channelID: string, messageID?: string) => {
    setDeepLink({ channelID, messageID });
    setView("channels");
  }, []);

  const onOpenSource = useCallback(
    (source: CardSource) => {
      if (source.url) {
        window.open(source.url, "_blank", "noreferrer");
        return;
      }
      if (source.channelID) openChannel(source.channelID, source.messageID);
    },
    [openChannel]
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "view-decisions", label: "Go to Decisions", hint: "queue", run: () => setView("decisions") },
      { id: "view-channels", label: "Go to Channels", hint: "conversations", run: () => setView("channels") },
      { id: "view-settings", label: "Go to Settings", hint: "appearance, org", run: () => setView("settings") },
      {
        id: "run-digest",
        label: "Run daily digest",
        hint: "summary cards",
        run: () =>
          api
            .runDigest()
            .then((result) => setToast(`Digest sent to ${result.digests} member(s)`))
            .catch(() => setToast("Digest run failed")),
      },
      {
        id: "run-escalations",
        label: "Run escalation sweep",
        hint: "SLA breaches",
        run: () =>
          api
            .runEscalations()
            .then((result) => setToast(`${result.escalated} card(s) escalated`))
            .catch(() => setToast("Escalation sweep failed")),
      },
    ];

    for (const channel of channels) {
      list.push({
        id: `channel-${channel.id}`,
        label: `Jump to #${channel.name}`,
        hint: channel.purpose,
        run: () => openChannel(channel.id),
      });
    }

    for (const user of users) {
      if (user.id === me?.id) continue;
      list.push({
        id: `member-${user.id}`,
        label: `Switch to ${user.name}`,
        hint: user.role,
        run: () =>
          api
            .selectMember(user.id)
            .then((result) => setMe(result.user))
            .catch(() => setToast("Could not switch member")),
      });
    }

    return list;
  }, [channels, users, me?.id, openChannel, setMe]);

  const nameFor = (userID: string) => users.find((user) => user.id === userID)?.name ?? userID;

  return (
    <div className={view === "decisions" ? styles.shell : styles.shellWide}>
      <aside className={styles.sidebar}>
        <div className={styles.identity}>
          <span className={`${styles.dot} ${connected ? styles.dotOnline : ""}`} />
          {me?.name ?? "Signed in"}
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>Work</span>
          {(
            [
              ["decisions", "Decisions", pending],
              ["channels", "Channels", channels.length],
              ["settings", "Settings", null],
            ] as [View, string, number | null][]
          ).map(([id, label, count]) => (
            <button
              key={id}
              className={`${styles.navItem} ${view === id ? styles.navItemActive : ""}`}
              aria-current={view === id}
              onClick={() => setView(id)}
            >
              {label}
              {count !== null && <span className={styles.count}>{count}</span>}
            </button>
          ))}
        </div>

        <div className={styles.section}>
          <span className={styles.sectionTitle}>Channels</span>
          {channels.slice(0, 8).map((channel) => (
            <button
              key={channel.id}
              className={styles.navItem}
              onClick={() => openChannel(channel.id)}
            >
              #{channel.name}
            </button>
          ))}
          {channels.length === 0 && <span className={styles.count}>None yet</span>}
        </div>

        <div className={styles.hintKeys}>
          <kbd>J</kbd> <kbd>K</kbd> move · <kbd>⏎</kbd> approve
          <br />
          <kbd>⌫</kbd> decline · <kbd>R</kbd> reply
          <br />
          <kbd>⌘K</kbd> commands · <kbd>?</kbd> all keys
        </div>
      </aside>

      {view === "decisions" ? (
        <section className={styles.queue}>
          <header className={styles.queueHeader}>
            <span className={styles.queueTitle}>Decisions</span>
            <span className={styles.queueMeta}>
              {pending} pending · {cards.length} total
            </span>
          </header>

          {message && (
            <div className={styles.toast} role="status">
              {message}
            </div>
          )}

          <div className={styles.queueList}>
            {cards.length === 0 && (
              <p className={styles.contextEmpty}>
                Nothing to decide. Tell your AI what you need below.
              </p>
            )}
            {cards.map((card) =>
              card.id === selectedID ? (
                <div key={card.id} ref={selectedRef} className={styles.selectedCard}>
                  <DecisionCardView
                    card={card}
                    senderName={nameFor(card.senderUserID)}
                    busy={decisions.busyCardId === card.id}
                    actions={decisions}
                    onOpenSource={onOpenSource}
                    openReplySignal={replySignal}
                  />
                </div>
              ) : (
                <QueueRow
                  key={card.id}
                  card={card}
                  senderName={nameFor(card.senderUserID)}
                  onSelect={() => setSelectedID(card.id)}
                />
              )
            )}
          </div>

          <footer className={styles.queueFooter}>
            <ComposeBar onSent={setToast} />
          </footer>
        </section>
      ) : (
        <section className={styles.queue}>
          {view === "channels" ? (
            <ChannelsScreen
              initialChannelID={deepLink?.channelID ?? null}
              highlightMessageID={deepLink?.messageID ?? null}
              onConsumeDeepLink={() => setDeepLink(null)}
            />
          ) : (
            <SettingsScreen />
          )}
        </section>
      )}

      {view === "decisions" && <ContextPanel card={selected} />}

      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}

      {helpOpen && (
        <div className={styles.help} role="dialog" aria-label="Keyboard shortcuts">
          <div>
            <kbd>J</kbd> / <kbd>↓</kbd> next decision
          </div>
          <div>
            <kbd>K</kbd> / <kbd>↑</kbd> previous decision
          </div>
          <div>
            <kbd>⏎</kbd> approve (or mark a notification read)
          </div>
          <div>
            <kbd>⌫</kbd> decline
          </div>
          <div>
            <kbd>R</kbd> reply — condition, question or note
          </div>
          <div>
            <kbd>⌘K</kbd> command palette
          </div>
          <div>
            <kbd>?</kbd> close this sheet
          </div>
        </div>
      )}
    </div>
  );
}

function QueueRow({
  card,
  senderName,
  onSelect,
}: {
  card: DecisionCard;
  senderName: string;
  onSelect: () => void;
}) {
  const priority = card.priority as string;
  const priorityClass =
    priority === "urgent" ? styles.pillUrgent : priority === "high" ? styles.pillHigh : "";

  return (
    <button
      className={styles.row}
      aria-label={`${card.title} — ${priority} priority, from ${senderName}`}
      onClick={onSelect}
    >
      <span className={styles.rowTop}>
        <span className={`${styles.pill} ${priorityClass}`}>{priority}</span>
        <span>{senderName}</span>
        {!isPending(card) && <span className={styles.rowDone}>✓ {card.status}</span>}
      </span>
      <span className={styles.rowTitle}>{card.title}</span>
      <span className={styles.rowSummary}>{card.summary}</span>
    </button>
  );
}

import { useEffect, useState } from "react";
import type { CardSource, DecisionCard } from "../../core/types";
import { isNotification, isPending, isRevisionRequest } from "../../core/types";
import { MicButton } from "../../ui/MicButton";
import styles from "./DecisionCardView.module.css";

export interface CardActions {
  approve: (card: DecisionCard) => void;
  reject: (card: DecisionCard) => void;
  acknowledge: (card: DecisionCard) => void;
  reply: (card: DecisionCard, text: string) => void;
  revise: (card: DecisionCard, note: string) => void;
  askAI: (card: DecisionCard, instruction: string) => void;
}

interface Props {
  card: DecisionCard;
  senderName: string;
  busy?: boolean;
  actions?: CardActions;
  onOpenSource?: (source: CardSource) => void;
  /** Bumped by the workbench's `R` shortcut to open the reply composer. */
  openReplySignal?: number;
}

const priorityClass: Record<string, string | undefined> = {
  high: styles.high,
  urgent: styles.urgent,
};

/** "deadline: Friday · metric: p95 +18%" → labelled chips. */
function contextChips(context: string) {
  return context
    .split(/\s·\s|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const colon = segment.indexOf(":");
      if (colon > 0 && colon <= 24) {
        return { label: segment.slice(0, colon).trim(), value: segment.slice(colon + 1).trim() };
      }
      return { label: null, value: segment };
    });
}

function relativeTime(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const statusLabels: Record<string, string> = {
  approved: "Issue created",
  rejected: "Declined",
  revised: "Revision requested",
  delegated: "Delegated",
  completed: "Closed on GitHub",
  resent: "Revised and resent",
  acknowledged: "Read",
};

type Composer = { mode: "reply" | "revise" | "askAI"; text: string } | null;

const composerCopy = {
  reply: {
    placeholder: "OK, but release after Friday",
    hint: "Your AI reads the intent — approve with a condition, decline with a reason, or ask a question.",
    send: "Send reply",
  },
  revise: {
    placeholder: "Split this into two smaller tasks",
    hint: "Goes back to the sender as an actionable revision request.",
    send: "Request revision",
  },
  askAI: {
    placeholder: "Deadline moved — make this urgent",
    hint: "Updates this card in place.",
    send: "Update card",
  },
} as const;

export function DecisionCardView({
  card,
  senderName,
  busy = false,
  actions,
  onOpenSource,
  openReplySignal = 0,
}: Props) {
  const priority = card.priority as string;
  const [composer, setComposer] = useState<Composer>(null);

  useEffect(() => {
    if (openReplySignal > 0) setComposer({ mode: "reply", text: "" });
  }, [openReplySignal]);

  const submitComposer = () => {
    if (!composer || !actions) return;
    const text = composer.text.trim();
    if (!text) return;

    if (composer.mode === "reply") actions.reply(card, text);
    else if (composer.mode === "revise") actions.revise(card, text);
    else actions.askAI(card, text);

    setComposer(null);
  };

  return (
    <article className={styles.card} aria-label={card.title}>
      <div className={styles.inner}>
        <div className={styles.meta}>
          <span>{card.type}</span>
          <span aria-hidden>·</span>
          <span className={priorityClass[priority]}>
            {priority.charAt(0).toUpperCase() + priority.slice(1)}
          </span>
          <span className={styles.when}>{relativeTime(card.createdAt)}</span>
        </div>

        <div className={styles.from}>From {senderName}</div>
        {card.agentRoute && <div className={styles.route}>{card.agentRoute}</div>}
        {card.routingReason && <div className={styles.why}>{card.routingReason}</div>}

        <h2 className={styles.title}>{card.title}</h2>
        <p className={styles.summary}>{card.summary}</p>

        {card.context && (
          <div className={styles.chips}>
            {contextChips(card.context).map((chip, index) => (
              <span className={styles.chip} key={`${chip.value}-${index}`}>
                {chip.label && <b>{chip.label} </b>}
                {chip.value}
              </span>
            ))}
          </div>
        )}

        {card.sources && card.sources.length > 0 && (
          <div className={styles.sources}>
            <span className={styles.sourcesLabel}>Sources</span>
            {card.sources.map((source) =>
              source.url ? (
                <a
                  key={source.url}
                  className={styles.sourceChip}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  ↗ {source.label}
                </a>
              ) : (
                <button
                  key={source.channelID ?? source.label}
                  className={styles.sourceChip}
                  onClick={() => onOpenSource?.(source)}
                >
                  # {source.label.replace(/^#/, "")}
                </button>
              )
            )}
          </div>
        )}

        {isPending(card) && card.recommendation && actions && (
          <button
            className={styles.recommendation}
            disabled={busy}
            onClick={() => {
              if (card.recommendation?.action === "reject") actions.reject(card);
              else actions.approve(card);
            }}
          >
            ✦ Your AI suggests:{" "}
            {card.recommendation.action === "reject" ? "Decline" : "Approve"}
            <span>{card.recommendation.reason} · tap to accept</span>
          </button>
        )}

        {card.githubIssueURL && (
          <a
            className={styles.issueLink}
            href={card.githubIssueURL}
            target="_blank"
            rel="noreferrer"
          >
            {card.githubIssueNumber ? `Issue #${card.githubIssueNumber}` : "View on GitHub"} ↗
          </a>
        )}

        <div className={styles.spacer} />

        {!isPending(card) && (
          <div className={styles.status}>{statusLabels[card.status] ?? card.status}</div>
        )}

        {isPending(card) && actions && (
          <div className={styles.actions}>
            {composer ? (
              <div className={styles.composerRow}>
                <textarea
                  autoFocus
                  value={composer.text}
                  placeholder={composerCopy[composer.mode].placeholder}
                  aria-label={composerCopy[composer.mode].send}
                  onChange={(event) =>
                    setComposer({ ...composer, text: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      submitComposer();
                    }
                    if (event.key === "Escape") setComposer(null);
                  }}
                />
                <div className={styles.micRow}>
                  <MicButton
                    onTranscript={(text) => setComposer((current) => (current ? { ...current, text } : current))}
                  />
                  <span className={styles.hint}>{composerCopy[composer.mode].hint}</span>
                </div>
                <div className={styles.composerActions}>
                  <button onClick={() => setComposer(null)}>Cancel</button>
                  <button
                    className={styles.send}
                    disabled={busy || !composer.text.trim()}
                    onClick={submitComposer}
                  >
                    {composerCopy[composer.mode].send}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  className={styles.replyBar}
                  onClick={() => setComposer({ mode: "reply", text: "" })}
                >
                  💬 Reply — add a condition, ask a question…
                </button>

                {isNotification(card) ? (
                  <>
                    <button
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => actions.acknowledge(card)}
                    >
                      Mark as read
                    </button>
                    <p className={styles.hint}>Reply above to respond</p>
                  </>
                ) : (
                  <>
                    <button
                      className={`${styles.primary} ${isRevisionRequest(card) ? "" : styles.github}`}
                      disabled={busy}
                      onClick={() => actions.approve(card)}
                    >
                      {isRevisionRequest(card) ? "Approve as revised" : "Create issue"}
                    </button>
                    <div className={styles.secondaryRow}>
                      <button
                        className={`${styles.secondary} ${styles.danger}`}
                        disabled={busy}
                        onClick={() => actions.reject(card)}
                      >
                        Decline
                      </button>
                      <button
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => setComposer({ mode: "revise", text: "" })}
                      >
                        Revise
                      </button>
                      <button
                        className={styles.secondary}
                        disabled={busy}
                        onClick={() => setComposer({ mode: "askAI", text: "" })}
                      >
                        Ask AI
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

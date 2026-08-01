import type { CardSource, DecisionCard } from "../../core/types";
import { isPending } from "../../core/types";
import styles from "./DecisionCardView.module.css";

interface Props {
  card: DecisionCard;
  senderName: string;
  onOpenSource?: (source: CardSource) => void;
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

export function DecisionCardView({ card, senderName, onOpenSource }: Props) {
  const priority = card.priority as string;

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

        {isPending(card) && card.recommendation && (
          <div className={styles.recommendation}>
            ✦ Your AI suggests: {card.recommendation.action}
            <span>{card.recommendation.reason}</span>
          </div>
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
      </div>
    </article>
  );
}

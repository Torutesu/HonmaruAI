import { useCallback, useEffect, useState } from "react";
import { api } from "../../core/api";
import type { Bottleneck, LedgerEntry, LedgerStats } from "../../core/api";
import { useSessionStore } from "../../core/stores/session";
import styles from "./LedgerScreen.module.css";

type Scope = "mine" | "everyone";
type Filter = "all" | "pending" | "decided";

function duration(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const OUTCOME_LABEL: Record<string, string> = {
  approved: "Approved",
  rejected: "Declined",
  revised: "Sent back",
  delegated: "Delegated",
  completed: "Closed",
  acknowledged: "Read",
  pending: "Still open",
};

/**
 * The decision ledger. The feed answers "what needs me now"; this answers
 * "what did we decide, how long did it take, and where is work waiting".
 */
export function LedgerScreen() {
  const me = useSessionStore((state) => state.me);
  const users = useSessionStore((state) => state.users);

  const [scope, setScope] = useState<Scope>("mine");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [stats, setStats] = useState<LedgerStats | null>(null);
  const [queues, setQueues] = useState<Bottleneck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const nameFor = (userID: string | null) =>
    users.find((user) => user.id === userID)?.name ?? userID ?? "—";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.ledger({
        userId: scope === "mine" ? me?.id : undefined,
        status: filter === "all" ? undefined : filter,
        q: query.trim() || undefined,
      });
      setEntries(result.entries);
      setStats(result.stats);
      setQueues(result.bottlenecks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the ledger.");
    } finally {
      setLoading(false);
    }
  }, [scope, filter, query, me?.id]);

  // Typing shouldn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <div className={styles.screen}>
      <div className={styles.controls}>
        <div className={styles.segment}>
          {(["mine", "everyone"] as Scope[]).map((option) => (
            <button
              key={option}
              className={scope === option ? styles.segmentActive : ""}
              aria-pressed={scope === option}
              onClick={() => setScope(option)}
            >
              {option === "mine" ? "Mine" : "Everyone"}
            </button>
          ))}
        </div>
        <div className={styles.segment}>
          {(["all", "pending", "decided"] as Filter[]).map((option) => (
            <button
              key={option}
              className={filter === option ? styles.segmentActive : ""}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <input
        className={styles.search}
        value={query}
        aria-label="Search decisions"
        placeholder="Search decisions…"
        onChange={(event) => setQuery(event.target.value)}
      />

      {stats && (
        <div className={styles.stats}>
          <Stat label="Decided" value={String(stats.decided)} />
          <Stat label="Still open" value={String(stats.pending)} />
          <Stat label="Median" value={duration(stats.medianMinutes)} hint="time to decide" />
          <Stat label="p90" value={duration(stats.p90Minutes)} hint="the slow tail" />
          {stats.byAI > 0 && <Stat label="By your AI" value={String(stats.byAI)} />}
          {stats.escalated > 0 && <Stat label="Escalated" value={String(stats.escalated)} />}
        </div>
      )}

      {queues.length > 0 && (
        <section className={styles.queues}>
          <h2 className={styles.sectionTitle}>Where decisions are waiting</h2>
          {queues
            .filter((queue) => queue.pending > 0)
            .map((queue) => (
              <div key={queue.userID} className={styles.queue}>
                <span className={styles.queueName}>{nameFor(queue.userID)}</span>
                <span className={styles.queueMeta}>
                  {queue.pending} open · oldest {duration(queue.oldestPendingMinutes)}
                </span>
              </div>
            ))}
          <p className={styles.note}>
            Ranked by how long the oldest item has waited — a long queue that moves is fine.
          </p>
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {loading && entries.length === 0 ? (
        <p className={styles.note}>Reading the ledger…</p>
      ) : entries.length === 0 ? (
        <p className={styles.note}>
          {query ? `Nothing matches “${query}”.` : "No decisions recorded yet."}
        </p>
      ) : (
        <ol className={styles.timeline}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <div className={styles.entryTop}>
                <span
                  className={`${styles.outcome} ${
                    entry.status === "pending" ? styles.outcomePending : ""
                  }`}
                >
                  {OUTCOME_LABEL[entry.status] ?? entry.status}
                </span>
                {entry.decidedByAI && <span className={styles.chip}>✦ by AI</span>}
                {entry.escalated && <span className={styles.chip}>escalated</span>}
                <span className={styles.lead}>{duration(entry.leadTimeMinutes)}</span>
              </div>

              <div className={styles.entryTitle}>{entry.title}</div>
              {/* The search covers the summary, so hiding it would leave a
                  result with no visible reason for matching. */}
              {entry.summary && <div className={styles.entrySummary}>{entry.summary}</div>}
              <div className={styles.entryMeta}>
                {nameFor(entry.senderUserID)} → {nameFor(entry.recipientUserID)} ·{" "}
                {new Date(entry.decidedAt ?? entry.createdAt).toLocaleDateString()}
                {entry.githubIssueURL && (
                  <>
                    {" · "}
                    <a href={entry.githubIssueURL} target="_blank" rel="noreferrer">
                      #{entry.githubIssueNumber}
                    </a>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </div>
  );
}

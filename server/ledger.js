// The decision ledger. Every card the relay has ever held is already a record
// of a decision — who asked, who decided, how long it took. This reads that
// store as a history rather than a feed.
//
// Two things it is deliberately not: an analytics pipeline (it computes over
// the live store, because the store is small and honest), and a productivity
// scoreboard. The bottleneck view names where decisions *wait*, which is a
// property of the queue, not of the person.

const TERMINAL = new Set([
  "approved",
  "rejected",
  "revised",
  "delegated",
  "completed",
  "acknowledged",
]);

export const isDecided = (card) => TERMINAL.has(card?.status);

/** Minutes from arrival to decision, or null while it is still pending. */
export function leadTimeMinutes(card) {
  if (!isDecided(card)) return null;
  const created = Date.parse(card?.createdAt);
  const decided = Date.parse(card?.decidedAt);
  if (!Number.isFinite(created) || !Number.isFinite(decided)) return null;
  return Math.max(0, Math.round((decided - created) / 60000));
}

function matchesQuery(card, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return ["title", "summary", "context", "sourceInstruction"].some((field) =>
    String(card[field] || "").toLowerCase().includes(needle)
  );
}

/**
 * Flatten the store into a searchable, newest-first history.
 *
 * `userID` means "this person was involved" — as recipient, sender or the one
 * who decided it. Asking "what happened with Bob" and getting only the cards
 * addressed to him would quietly hide half the story.
 */
export function ledgerEntries({
  cardsByUser,
  userID = null,
  status = null,
  query = null,
  since = null,
  limit = 200,
}) {
  const seen = new Set();
  const entries = [];
  const sinceMs = since ? Date.parse(since) : null;

  for (const cards of Object.values(cardsByUser || {})) {
    for (const card of cards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);

      if (userID) {
        const involved =
          card.recipientUserID === userID ||
          card.senderUserID === userID ||
          card.decidedByUserID === userID;
        if (!involved) continue;
      }
      if (status === "pending" && isDecided(card)) continue;
      if (status === "decided" && !isDecided(card)) continue;
      if (status && status !== "pending" && status !== "decided" && card.status !== status) {
        continue;
      }
      if (!matchesQuery(card, query)) continue;

      const at = Date.parse(card.decidedAt || card.createdAt);
      if (Number.isFinite(sinceMs) && Number.isFinite(at) && at < sinceMs) continue;

      entries.push({
        id: card.id,
        title: card.title,
        summary: card.summary,
        type: card.type,
        priority: card.priority,
        status: card.status,
        senderUserID: card.senderUserID,
        recipientUserID: card.recipientUserID,
        decidedByUserID: card.decidedByUserID ?? null,
        createdAt: card.createdAt,
        decidedAt: card.decidedAt ?? null,
        leadTimeMinutes: leadTimeMinutes(card),
        decidedByAI: card.decidedByAI === true,
        escalated: Boolean(card.escalatedAt),
        githubIssueNumber: card.githubIssueNumber ?? null,
        githubIssueURL: card.githubIssueURL ?? null,
        channelID: card.channelID ?? null,
      });
    }
  }

  entries.sort(
    (a, b) =>
      Date.parse(b.decidedAt || b.createdAt) - Date.parse(a.decidedAt || a.createdAt)
  );
  return entries.slice(0, limit);
}

/** Nearest-rank percentile over a sorted numeric array. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * How long decisions take. Median and p90 rather than a mean: one card that
 * sat over a holiday weekend would otherwise define the whole picture.
 */
export function leadTimeStats(entries) {
  const times = entries
    .map((entry) => entry.leadTimeMinutes)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);

  const byPriority = {};
  for (const entry of entries) {
    if (entry.leadTimeMinutes === null) continue;
    (byPriority[entry.priority] ||= []).push(entry.leadTimeMinutes);
  }

  return {
    decided: times.length,
    pending: entries.filter((entry) => entry.leadTimeMinutes === null).length,
    medianMinutes: percentile(times, 0.5),
    p90Minutes: percentile(times, 0.9),
    byPriority: Object.fromEntries(
      Object.entries(byPriority).map(([priority, values]) => {
        const sorted = values.sort((a, b) => a - b);
        return [priority, { decided: sorted.length, medianMinutes: percentile(sorted, 0.5) }];
      })
    ),
    outcomes: entries.reduce((counts, entry) => {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
      return counts;
    }, {}),
    byAI: entries.filter((entry) => entry.decidedByAI).length,
    escalated: entries.filter((entry) => entry.escalated).length,
  };
}

/**
 * Where decisions are waiting, per person's queue. Sorted by the age of the
 * oldest thing still sitting there — a long queue that moves is fine, one
 * card stuck for three days is not.
 */
export function bottlenecks({ entries, now = Date.now() }) {
  const queues = new Map();

  for (const entry of entries) {
    const queue = queues.get(entry.recipientUserID) || {
      userID: entry.recipientUserID,
      pending: 0,
      oldestPendingMinutes: 0,
      decided: 0,
      medianMinutes: null,
      times: [],
    };

    if (entry.leadTimeMinutes === null) {
      queue.pending += 1;
      const waited = Math.round((now - Date.parse(entry.createdAt)) / 60000);
      if (Number.isFinite(waited)) {
        queue.oldestPendingMinutes = Math.max(queue.oldestPendingMinutes, waited);
      }
    } else {
      queue.decided += 1;
      queue.times.push(entry.leadTimeMinutes);
    }

    queues.set(entry.recipientUserID, queue);
  }

  return [...queues.values()]
    .map(({ times, ...queue }) => ({
      ...queue,
      medianMinutes: percentile(times.sort((a, b) => a - b), 0.5),
    }))
    .sort(
      (a, b) =>
        b.oldestPendingMinutes - a.oldestPendingMinutes || b.pending - a.pending
    );
}

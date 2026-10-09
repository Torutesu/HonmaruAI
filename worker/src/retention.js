// Tables that only ever grew: caches and meters that nothing reads past a
// window, trimmed once a day (docs/architecture/discord-model-platform-plan.md §7).
//
// Each rule is the longest anything reads the table, with room to spare:
//   ai_calls              spend charts read at most 90 days; a year and a month kept
//   message_translations  a cache checked against the source hash; made again on demand
//   channel_journal       one summary per channel-day; a year of scrolling back
//   ai_suggestions        fresh for six hours; a week is plenty
//   notification_jobs     a finished job is only looked up while it retries; a week
//   notification_deliveries  each delivery's outcome, read by its job; a week
//
// card_events are not here on purpose: they are the record of who decided
// what (account.js keeps them even after an account is deleted).

const DAY = 86_400_000;
const BATCH = 5000;
const MAX_BATCHES = 20;

export const RETENTION = [
  { table: "ai_calls", column: "created_at", days: 400 },
  { table: "message_translations", column: "created_at", days: 60 },
  { table: "channel_journal", column: "updated_at", days: 365 },
  { table: "ai_suggestions", column: "created_at", days: 7 },
  // A pending job is still owed to someone, however old.
  { table: "notification_jobs", column: "updated_at", days: 7, where: "state != 'pending'" },
  { table: "notification_deliveries", column: "updated_at", days: 7 },
];

/// Rows past each table's window, deleted a batch at a time so one run never
/// holds the database for long. Returns how many went from each table.
export async function pruneGrowth(db, { now = Date.now(), batch = BATCH, maxBatches = MAX_BATCHES } = {}) {
  const out = {};
  for (const { table, column, days, where } of RETENTION) {
    const cutoff = new Date(now - days * DAY).toISOString();
    let removed = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const res = await db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ?1${where ? ` AND ${where}` : ""} LIMIT ?2)`
      ).bind(cutoff, batch).run();
      const n = Number(res?.meta?.changes) || 0;
      removed += n;
      if (n < batch) break;
    }
    out[table] = removed;
  }
  return out;
}

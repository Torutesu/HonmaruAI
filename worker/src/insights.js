// What the team can learn from its own decisions, and what the router can
// learn from the team.
//
// Three readers, one source. `card_feedback` and `cards` feed a metrics view
// ("how long does a decision wait, what gets declined, which sources produce
// cards worth deciding"), the router reads the team's current load and its
// recent decisions before it writes a card, and the eval harness exports real
// cards, with the verdicts people gave them, as candidates for the golden set.
// None of this is a product feature on its own; it is what makes the next
// improvement measurable rather than felt.

export const FEEDBACK_VERDICTS = new Set(["right", "wrong"]);
export const FEEDBACK_REASONS = new Set(["wrong-person", "not-a-decision", "wrong-priority", "wrong-words", "other"]);
const MAX_NOTE = 500;

/// One verdict per person per card; the latest stands.
export async function recordFeedback(db, { orgId, cardId, githubId, verdict, reason, note }) {
  await db
    .prepare(
      `INSERT INTO card_feedback (id, org_id, card_id, user_github_id, verdict, reason, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(org_id, card_id, user_github_id) DO UPDATE SET
         verdict = excluded.verdict, reason = excluded.reason, note = excluded.note,
         created_at = excluded.created_at`
    )
    .bind(
      crypto.randomUUID(), orgId, cardId, String(githubId), verdict,
      reason || null, note ? String(note).slice(0, MAX_NOTE) : null, new Date().toISOString()
    )
    .run();
}

function parseCard(row) {
  try { return JSON.parse(row.data); } catch { return null; }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const MAX_METRIC_ROWS = 2000;

/// The numbers a team looks at to know whether the product is working for
/// it. Over a window of days, from the cards themselves — no counters to
/// keep in sync, and nothing here that the cards do not already say.
export async function orgMetrics(db, orgId, { days = 14 } = {}) {
  const span = Math.max(1, Math.min(Number(days) || 14, 90));
  const since = new Date(Date.now() - span * 86400000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT card_id, recipient_user_id, sender_user_id, created_at, decided_at, status, priority, data
         FROM cards WHERE org_id = ?1 AND created_at >= ?2
        ORDER BY created_at DESC LIMIT ?3`
    )
    .bind(orgId, since, MAX_METRIC_ROWS)
    .all();
  const rows = results || [];

  const perDay = new Map();
  const bySource = new Map();
  const byAction = new Map();
  const minutesToDecide = [];
  let pending = 0;
  let decided = 0;
  let selfAddressed = 0;
  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
    const card = parseCard(row) || {};
    const source = card.sourceApp || "You";
    bySource.set(source, (bySource.get(source) || 0) + 1);
    if (row.sender_user_id && row.sender_user_id === row.recipient_user_id) selfAddressed += 1;
    if (row.status === "pending" && !row.decided_at) pending += 1;
    if (row.decided_at) {
      decided += 1;
      const action = card.decision?.action || row.status || "decided";
      byAction.set(action, (byAction.get(action) || 0) + 1);
      const wait = (Date.parse(row.decided_at) - Date.parse(row.created_at)) / 60000;
      if (Number.isFinite(wait) && wait >= 0) minutesToDecide.push(wait);
    }
  }

  const nudged = await db
    .prepare("SELECT COUNT(*) AS n FROM card_events WHERE org_id = ?1 AND type = 'nudged' AND created_at >= ?2")
    .bind(orgId, since)
    .first();

  const feedbackRows = await db
    .prepare(
      `SELECT verdict, reason, COUNT(*) AS n FROM card_feedback
        WHERE org_id = ?1 AND created_at >= ?2 GROUP BY verdict, reason`
    )
    .bind(orgId, since)
    .all();
  const feedback = { right: 0, wrong: 0, reasons: {} };
  for (const r of feedbackRows.results || []) {
    feedback[r.verdict] = (feedback[r.verdict] || 0) + r.n;
    if (r.verdict === "wrong") feedback.reasons[r.reason || "other"] = (feedback.reasons[r.reason || "other"] || 0) + r.n;
  }

  // Every day in the window, zero included, oldest first — a chart with the
  // quiet days missing reads as a busier team than it is.
  const created = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    created.push({ day, count: perDay.get(day) || 0 });
  }
  const declined = byAction.get("decline") || 0;

  return {
    days: span,
    cards: rows.length,
    pending,
    decided,
    selfAddressed,
    medianMinutesToDecide: median(minutesToDecide),
    declineRate: decided ? declined / decided : null,
    nudges: nudged?.n || 0,
    created,
    bySource: [...bySource].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    byAction: [...byAction].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
    feedback,
  };
}

/// What each member is carrying right now: how many cards wait on them and
/// how long the oldest has waited. The router reads this so that, between two
/// people who could equally decide something, the one who is not drowning
/// gets it — and says so.
export async function recipientLoad(db, orgId) {
  const { results } = await db
    .prepare(
      `SELECT recipient_user_id AS id, COUNT(*) AS pending, MIN(created_at) AS oldest
         FROM cards WHERE org_id = ?1 AND status = 'pending' AND decided_at IS NULL
        GROUP BY recipient_user_id`
    )
    .bind(orgId)
    .all();
  const now = Date.now();
  return (results || []).map((r) => ({
    id: r.id,
    pending: r.pending,
    oldestHours: r.oldest ? Math.max(0, Math.round((now - Date.parse(r.oldest)) / 3600000)) : 0,
  }));
}

/// The team's last few decisions, as one line each. Enough for the router to
/// notice "this was decided last week" and for a recommendation to lean on
/// what the person actually does rather than on the instruction alone.
export async function recentDecisions(db, orgId, { limit = 12 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT recipient_user_id, sender_user_id, decided_at, data
         FROM cards WHERE org_id = ?1 AND decided_at IS NOT NULL
        ORDER BY decided_at DESC LIMIT ?2`
    )
    .bind(orgId, Math.max(1, Math.min(Number(limit) || 12, 30)))
    .all();
  return (results || []).map((row) => {
    const card = parseCard(row) || {};
    return {
      recipient: row.recipient_user_id,
      sender: row.sender_user_id || null,
      action: card.decision?.action || card.status || "decided",
      title: String(card.title || "").slice(0, 120),
      business: card.business || null,
      note: card.decision?.replyText || card.decision?.note || null,
      decidedAt: row.decided_at,
    };
  });
}

/// Real cards, with what people said about them, in the golden-set shape the
/// eval harness reads. A card somebody flagged as wrong is the most valuable
/// row here: the expectation is left for a person to fill in, and the reason
/// they gave says what was wrong. Names and addresses are what the org's own
/// members already see; this endpoint is gated on membership like every
/// other read of an org.
export async function exportGolden(db, orgId, { limit = 200 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT c.card_id, c.recipient_user_id, c.sender_user_id, c.priority, c.data,
              f.verdict, f.reason, f.note
         FROM cards c
         LEFT JOIN card_feedback f ON f.org_id = c.org_id AND f.card_id = c.card_id
        WHERE c.org_id = ?1
        ORDER BY c.created_at DESC LIMIT ?2`
    )
    .bind(orgId, Math.max(1, Math.min(Number(limit) || 200, 1000)))
    .all();
  const entries = [];
  for (const row of results || []) {
    const card = parseCard(row) || {};
    const text = card.sourceInstruction || card.requestedBy?.quote || card.originalBody;
    if (!text) continue;
    const wrong = row.verdict === "wrong";
    entries.push({
      id: row.card_id,
      source: "export",
      text: String(text).slice(0, 4000),
      sender: { id: row.sender_user_id || "", role: card.requestedBy?.role || "member" },
      org: orgId,
      // A card nobody flagged is presumed right; a flagged one is a question
      // for whoever curates the set, with the reason attached.
      expect: {
        recipientUserID: wrong && row.reason === "wrong-person" ? null : row.recipient_user_id,
        cardType: wrong && row.reason === "not-a-decision" ? null : card.type || null,
        priority: wrong && row.reason === "wrong-priority" ? null : row.priority || null,
      },
      feedback: row.verdict ? { verdict: row.verdict, reason: row.reason || null, note: row.note || null } : null,
    });
  }
  return entries;
}

/// What this team already decided about something, by keyword. The model's
/// research tool: two to four words in, at most eight one-line decisions out.
/// LIKE over the card JSON is crude and fast, and a team of ten has hundreds
/// of cards, not millions.
export async function searchDecisions(db, orgId, query, { limit = 8 } = {}) {
  const words = String(query || "")
    .split(/[\s,、。・]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  if (!words.length) return [];
  const clauses = words.map((_, i) => `data LIKE ?${i + 2}`).join(" OR ");
  const { results } = await db
    .prepare(
      `SELECT recipient_user_id, decided_at, data FROM cards
        WHERE org_id = ?1 AND (${clauses})
        ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?${words.length + 2}`
    )
    .bind(orgId, ...words.map((w) => `%${w}%`), Math.max(1, Math.min(Number(limit) || 8, 20)))
    .all();
  return (results || []).map((row) => {
    const card = parseCard(row) || {};
    return {
      title: String(card.title || "").slice(0, 120),
      recipient: row.recipient_user_id,
      status: card.decision?.action || card.status || "pending",
      decidedAt: row.decided_at || null,
      note: card.decision?.replyText || card.decision?.note || null,
      business: card.business || null,
    };
  });
}

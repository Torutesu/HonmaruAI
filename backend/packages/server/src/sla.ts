import type { CardPriority, Notification, OrgEvent } from "@honmaru/protocol";
import { getCard } from "./cards.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { now } from "./ids.js";
import { managerOf } from "./orgs.js";

// ---------------------------------------------------------------------------
// SLA + escalation. Every pending card carries a decide-by deadline derived
// from its priority. A periodic sweep escalates overdue cards: priority is
// bumped to urgent (which re-ranks it to the top of the feed), the
// recipient is re-notified, and the recipient's manager is looped in.
// Escalation happens at most once per card.
// ---------------------------------------------------------------------------

export const DUE_HOURS: Record<CardPriority, number> = {
  urgent: 2,
  high: 8,
  medium: 24,
  low: 72,
};

export function dueAtFor(priority: CardPriority, fromMs = Date.now()): string {
  return new Date(fromMs + DUE_HOURS[priority] * 3_600_000).toISOString();
}

export interface EscalationResult {
  orgId: string;
  events: OrgEvent[];
  notifications: Omit<Notification, "id" | "createdAt" | "readAt">[];
}

export function sweepOverdue(db: Db, nowIso: string = now()): EscalationResult[] {
  const rows = db
    .prepare(
      `SELECT id, org_id, recipient_user_id, title FROM cards
       WHERE status = 'pending' AND escalated_at IS NULL
         AND due_at IS NOT NULL AND due_at < ?`
    )
    .all(nowIso) as {
    id: string;
    org_id: string;
    recipient_user_id: string;
    title: string;
  }[];

  const results: EscalationResult[] = [];
  for (const row of rows) {
    const events: OrgEvent[] = [];
    db.transaction(() => {
      db.prepare(
        `UPDATE cards SET priority = 'urgent', escalated_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(nowIso, nowIso, row.id);
      const card = getCard(db, row.id)!;
      events.push(appendEvent(db, row.org_id, "card_updated", null, { card }));
    })();

    const notifications: EscalationResult["notifications"] = [
      {
        orgId: row.org_id,
        userId: row.recipient_user_id,
        kind: "card_overdue",
        cardId: row.id,
        title: `Overdue: ${row.title}`,
        body: "This decision passed its deadline and was bumped to urgent.",
      },
    ];
    const manager = managerOf(db, row.org_id, row.recipient_user_id);
    if (manager && manager !== row.recipient_user_id) {
      notifications.push({
        orgId: row.org_id,
        userId: manager,
        kind: "card_overdue",
        cardId: row.id,
        title: `Escalated: ${row.title}`,
        body: "A decision assigned to your report is overdue.",
      });
    }
    results.push({ orgId: row.org_id, events, notifications });
  }
  return results;
}

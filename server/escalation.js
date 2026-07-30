import { randomUUID } from "node:crypto";

// How long a pending card may wait before its recipient's manager hears
// about it. Low-priority cards never escalate.
export const DEFAULT_SLA_MINUTES = { urgent: 120, high: 480, medium: 1440 };

/** Parse "urgent:60,high:240,medium:720" into an SLA table (merged with defaults). */
export function parseSLAConfig(value) {
  const sla = { ...DEFAULT_SLA_MINUTES };
  for (const pair of String(value || "").split(",")) {
    const [key, minutes] = pair.split(":").map((part) => part && part.trim());
    const parsed = Number(minutes);
    if (key in sla && Number.isFinite(parsed) && parsed > 0) {
      sla[key] = parsed;
    }
  }
  return sla;
}

/**
 * Find pending cards past their SLA that have not been escalated yet.
 * @returns {{ card: object, overdueMinutes: number }[]}
 */
export function findOverdueCards({ cardsByUser, slaMinutes, now = Date.now() }) {
  const overdue = [];

  for (const cards of Object.values(cardsByUser || {})) {
    for (const card of cards) {
      if (card.status !== "pending") continue;
      if (card.escalatedAt) continue;
      const limit = slaMinutes[card.priority];
      if (!limit) continue;

      const createdAt = Date.parse(card.createdAt);
      if (!Number.isFinite(createdAt)) continue;

      const ageMinutes = (now - createdAt) / 60000;
      if (ageMinutes > limit) {
        overdue.push({ card, overdueMinutes: Math.round(ageMinutes - limit) });
      }
    }
  }

  return overdue;
}

function hoursLabel(minutes) {
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * Build the card the manager receives. It carries the stuck decision's
 * content so the manager can decide it directly.
 */
export function buildEscalationCard({ card, recipient, manager, ageMinutes }) {
  return {
    id: `card-esc-${randomUUID()}`,
    recipientUserID: manager.id,
    senderUserID: card.senderUserID,
    type: card.type === "approval" ? "approval" : "task",
    title: `Escalated: ${card.title}`,
    summary: `${recipient.name} hasn't decided this in ${hoursLabel(ageMinutes)} (${card.priority}). ${card.summary}`,
    context: [card.context, `escalated from: ${recipient.name} · waiting: ${hoursLabel(ageMinutes)}`]
      .filter(Boolean)
      .join(" · "),
    status: "pending",
    priority: card.priority === "urgent" ? "urgent" : "high",
    createdAt: new Date().toISOString(),
    agentRoute: `${recipient.name}'s AI → ${manager.name}'s AI`,
    routingReason: `SLA breach — you manage ${recipient.name}`,
    sourceInstruction: card.sourceInstruction,
    channelID: card.channelID,
    githubIssueURL: card.githubIssueURL,
    githubRepository: card.githubRepository,
  };
}

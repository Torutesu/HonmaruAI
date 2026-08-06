import type { DecisionCard, OrgEdge } from "@honmaru/protocol";
import type { Db } from "./db.js";
import { listMembers } from "./orgs.js";

// ---------------------------------------------------------------------------
// Feed ranking + org analytics, both derived from primary state. Nothing
// here writes; it can be recomputed at any time.
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHT: Record<DecisionCard["priority"], number> = {
  urgent: 400,
  high: 200,
  medium: 100,
  low: 20,
};

// Higher score = shown earlier. Pending cards always outrank decided ones;
// within pending, urgency dominates, waiting time escalates steadily, and
// a card from your manager gets a nudge.
export function cardScore(
  card: DecisionCard,
  edges: OrgEdge[],
  nowMs: number
): number {
  let score = PRIORITY_WEIGHT[card.priority];
  const ageHours = Math.max(0, nowMs - Date.parse(card.createdAt)) / 3_600_000;
  score += Math.min(ageHours * 8, 300);
  const fromManager = edges.some(
    (edge) =>
      edge.kind === "manages" &&
      edge.fromId === card.senderUserId &&
      edge.toId === card.recipientUserId
  );
  if (fromManager) score += 80;
  if (card.status === "pending") score += 10_000;
  return score;
}

export function rankCards(
  cards: DecisionCard[],
  edges: OrgEdge[],
  nowMs = Date.now()
): DecisionCard[] {
  return [...cards].sort(
    (a, b) => cardScore(b, edges, nowMs) - cardScore(a, edges, nowMs)
  );
}

interface DecisionRow {
  recipient_user_id: string;
  created_at: string;
  updated_at: string;
  status: string;
}

const DECIDED = new Set(["approved", "rejected", "revised", "delegated", "completed"]);

export interface OrgAnalytics {
  totalCards: number;
  pendingCards: number;
  decidedCards: number;
  avgDecisionSeconds: number | null;
  perMember: {
    userId: string;
    name: string;
    pendingCount: number;
    oldestPendingAgeSeconds: number | null;
    decidedCount: number;
    avgDecisionSeconds: number | null;
  }[];
  bottlenecks: string[];
}

export function computeAnalytics(
  db: Db,
  orgId: string,
  nowMs = Date.now()
): OrgAnalytics {
  const rows = db
    .prepare(
      "SELECT recipient_user_id, created_at, updated_at, status FROM cards WHERE org_id = ?"
    )
    .all(orgId) as DecisionRow[];
  const members = listMembers(db, orgId);

  const decisionSeconds = (row: DecisionRow): number =>
    Math.max(0, (Date.parse(row.updated_at) - Date.parse(row.created_at)) / 1000);

  const decidedRows = rows.filter((row) => DECIDED.has(row.status));
  const pendingRows = rows.filter((row) => row.status === "pending");
  const average = (values: number[]): number | null =>
    values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;

  const perMember = members.map((member) => {
    const memberDecided = decidedRows.filter(
      (row) => row.recipient_user_id === member.userId
    );
    const memberPending = pendingRows.filter(
      (row) => row.recipient_user_id === member.userId
    );
    const oldest = memberPending
      .map((row) => (nowMs - Date.parse(row.created_at)) / 1000)
      .sort((a, b) => b - a)[0];
    return {
      userId: member.userId,
      name: member.name,
      pendingCount: memberPending.length,
      oldestPendingAgeSeconds: oldest ?? null,
      decidedCount: memberDecided.length,
      avgDecisionSeconds: average(memberDecided.map(decisionSeconds)),
    };
  });

  // Stuck-ness: pending volume weighted by how long the oldest card has
  // been waiting. Members with nothing pending are not bottlenecks.
  const bottlenecks = perMember
    .filter((member) => member.pendingCount > 0)
    .sort(
      (a, b) =>
        b.pendingCount * (1 + (b.oldestPendingAgeSeconds ?? 0) / 3600) -
        a.pendingCount * (1 + (a.oldestPendingAgeSeconds ?? 0) / 3600)
    )
    .map((member) => member.userId);

  return {
    totalCards: rows.length,
    pendingCards: pendingRows.length,
    decidedCards: decidedRows.length,
    avgDecisionSeconds: average(decidedRows.map(decisionSeconds)),
    perMember,
    bottlenecks,
  };
}

import type { Notification, OrgEvent } from "@honmaru/protocol";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { getCard } from "./cards.js";
import { now } from "./ids.js";

// ---------------------------------------------------------------------------
// GitHub reverse sync. The github_issues integration mirrors decisions
// outward; this webhook receiver closes the loop: closing an issue on
// GitHub completes the card, reopening it re-activates the card. Cards
// are located by the issue's html_url recorded on the external ref, so
// multiple repos/orgs coexist safely.
// ---------------------------------------------------------------------------

export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

export interface WebhookResult {
  orgId: string;
  events: OrgEvent[];
  notifications: Omit<Notification, "id" | "createdAt" | "readAt">[];
}

interface GitHubIssuePayload {
  action?: string;
  issue?: { number?: number; html_url?: string; state?: string };
}

export function handleGitHubEvent(
  db: Db,
  eventName: string,
  payload: GitHubIssuePayload
): WebhookResult | null {
  if (eventName !== "issues") return null;
  const action = payload.action;
  const url = payload.issue?.html_url;
  if (!url || (action !== "closed" && action !== "reopened")) return null;

  const row = db
    .prepare(
      `SELECT card_id FROM external_refs
       WHERE integration = 'github_issues' AND url = ?`
    )
    .get(url) as { card_id: string } | undefined;
  if (!row) return null;

  const card = getCard(db, row.card_id);
  if (!card) return null;

  const nextStatus =
    action === "closed"
      ? card.status === "approved"
        ? "completed"
        : null
      : card.status === "completed"
        ? "approved"
        : null;
  if (!nextStatus) return null;

  const timestamp = now();
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ?").run(
      nextStatus,
      timestamp,
      card.id
    );
    db.prepare(
      `UPDATE external_refs SET state = ? WHERE card_id = ? AND integration = 'github_issues'`
    ).run(action === "closed" ? "closed" : "open", card.id);
    const next = getCard(db, card.id)!;
    events.push(appendEvent(db, card.orgId, "card_updated", null, { card: next }));
  })();

  const title =
    action === "closed"
      ? `${card.title}: closed on GitHub`
      : `${card.title}: reopened on GitHub`;
  const notifications: WebhookResult["notifications"] = [
    ...new Set([card.recipientUserId, card.senderUserId]),
  ].map((userId) => ({
    orgId: card.orgId,
    userId,
    kind: "card_status" as const,
    cardId: card.id,
    title,
    body:
      action === "closed"
        ? "The linked issue was closed — the decision is now completed."
        : "The linked issue was reopened — the decision is active again.",
  }));

  return { orgId: card.orgId, events, notifications };
}

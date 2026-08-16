import { randomUUID } from "node:crypto";
import { triageEmail } from "./email-triage.js";

/**
 * Build a DecisionCard-shaped card from a parsed email, or return null if
 * the email doesn't need a decision. Shape matches
 * TikTokForWork/Models/DecisionCard.swift and the relay's in-memory store
 * (id, recipientUserID, senderUserID, camelCase, createdAt as ISO string).
 *
 * Recipient resolution (matching the email to an org member) is the
 * caller's responsibility — this module has no knowledge of the org graph.
 *
 * @param {Object} parsed - Output of parseEmailMessage()
 * @param {string} orgId - Organization the email belongs to
 * @param {{ recipientUserID: string }} resolved - Recipient already resolved by the caller
 * @returns {Promise<Object|null>}
 */
async function createEmailDecisionCard(parsed, orgId, { recipientUserID } = {}) {
  if (!recipientUserID) {
    throw new Error("recipientUserID is required to create a card");
  }

  const triageResult = await triageEmail(parsed.subject, parsed.textBody || parsed.htmlBody);
  if (!triageResult.needs_decision) {
    return null;
  }

  const senderEmail = extractEmailAddress(parsed.from);

  return {
    id: randomUUID(),
    recipientUserID,
    senderUserID: `email-${parsed.hash}`,
    type: triageResult.card_type,
    title: parsed.subject,
    summary: triageResult.summary,
    context: parsed.textBody || parsed.htmlBody,
    status: "pending",
    priority: triageResult.priority,
    createdAt: new Date().toISOString(),

    sourceApp: "Email",
    sourceDetail: senderEmail,
    routingReason: "Email received asking for decision",
  };
}

/** Extract the address out of "Name <email@example.com>"; passes plain addresses through. */
function extractEmailAddress(fromString) {
  const match = fromString.match(/<(.+?)>/);
  return match ? match[1] : fromString;
}

export { createEmailDecisionCard, extractEmailAddress };

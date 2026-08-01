import { randomUUID } from "node:crypto";
import { userNameFor } from "./agentTools.js";

// Server-side decision resolution — the logic that used to live only in
// DecisionCardService.swift. Keeping it here means every client (iOS, web,
// macOS) resolves decisions identically instead of each re-implementing it.

export const DECISION_ACTIONS = [
  "approve",
  "reject",
  "revise",
  "acknowledge",
  "delegate",
  "priority",
];

const STATUS_FOR_ACTION = {
  approve: "approved",
  reject: "rejected",
  revise: "revised",
  acknowledge: "acknowledged",
  delegate: "delegated",
};

const NOTE_LABEL = {
  approve: "Condition",
  reject: "Reason",
  revise: "Revision",
};

const RESULT_LABEL = {
  approved: "created GitHub issue",
  rejected: "declined",
  revised: "requested revision",
  delegated: "delegated",
};

export function findCard(store, userID, cardID) {
  return (store[userID] || []).find((card) => card.id === cardID) || null;
}

export function issueBody(card) {
  const labels = card.labels?.length
    ? `\n\n## Labels\n${card.labels.map((label) => `- \`${label}\``).join("\n")}`
    : "";

  return `| Field | Value |
|---|---|
| Status | ${card.status} |
| Priority | ${card.priority} |
| Type | ${card.type} |
| From | ${userNameFor(card.senderUserID)} |
| Card ID | ${card.id} |

## Summary
${card.summary}

## Context
${card.context}${labels}`;
}

export function issueTitle(card) {
  return `[${card.type}] ${card.title}`;
}

export function githubStateFor(status) {
  return status === "completed" || status === "rejected" ? "closed" : "open";
}

/**
 * Apply a decision to a card. Pure: mutates and returns the card plus the
 * follow-up cards to deliver. GitHub sync is the caller's job (it owns the
 * credentials).
 */
export function applyDecision({ card, action, note, actorUserID, delegateToUserID }) {
  const trimmedNote = String(note || "").trim();
  const actorName = userNameFor(actorUserID);
  const followUps = [];

  if (action === "priority") {
    return { card, followUps };
  }

  const status = STATUS_FOR_ACTION[action];
  card.status = status;

  if (trimmedNote) {
    const label = NOTE_LABEL[action];
    if (label) {
      card.context = [card.context, `${label}: ${trimmedNote}`].filter(Boolean).join("\n");
    }
    if (action === "revise") {
      card.revisionNote = trimmedNote;
    }
  }

  // Acknowledging a notification is deliberately silent: no response card,
  // no notification noise back to the sender.
  if (action === "acknowledge") {
    return { card, followUps };
  }

  if (action === "delegate") {
    const recipientName = userNameFor(delegateToUserID);
    followUps.push({
      id: `card-${randomUUID()}`,
      recipientUserID: delegateToUserID,
      senderUserID: actorUserID,
      type: "delegation",
      title: card.title,
      summary: card.summary,
      context: `Delegated by ${actorName} · ${card.context}`,
      status: "pending",
      priority: card.priority,
      createdAt: new Date().toISOString(),
      githubIssueNumber: card.githubIssueNumber,
      githubIssueURL: card.githubIssueURL,
      githubRepository: card.githubRepository,
      agentRoute: `${actorName}'s AI → ${recipientName}'s AI`,
      routingReason: `Delegated by ${actorName}`,
      sourceInstruction: card.sourceInstruction,
      channelID: card.channelID,
    });
  }

  // The sender hears back. A revision request comes back actionable so they
  // can revise and resend; everything else is a plain notification.
  const isRevision = action === "revise";
  const summaryTail =
    action === "delegate"
      ? `delegated to ${userNameFor(delegateToUserID)}`
      : RESULT_LABEL[card.status] || card.status;

  followUps.push({
    id: `card-${randomUUID()}`,
    recipientUserID: card.senderUserID,
    senderUserID: actorUserID,
    type: isRevision ? "revision" : "notification",
    title: card.title,
    summary: `${actorName} · ${summaryTail}${
      trimmedNote && action === "approve" ? ` — ${trimmedNote}` : ""
    }`,
    context: trimmedNote || card.summary,
    status: "pending",
    priority: isRevision ? card.priority : "medium",
    createdAt: new Date().toISOString(),
    githubIssueNumber: card.githubIssueNumber,
    githubIssueURL: card.githubIssueURL,
    githubRepository: card.githubRepository,
    agentRoute: card.agentRoute,
    routingReason: isRevision
      ? `${actorName} asked for changes — revise and resend`
      : card.routingReason,
    sourceInstruction: card.sourceInstruction || card.summary,
    ...(isRevision && trimmedNote ? { revisionNote: trimmedNote } : {}),
    channelID: card.channelID,
  });

  return { card, followUps };
}

/** Does this action need a GitHub issue created or updated? */
export function needsGitHubSync(action, card) {
  if (action === "approve" || action === "delegate") return true;
  return Boolean(card.githubIssueNumber);
}

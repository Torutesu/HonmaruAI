import type {
  CardAction,
  DecisionCard,
  ExternalRef,
  OrgEvent,
} from "@honmaru/protocol";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { newId, now } from "./ids.js";
import type { RoutingResult } from "./routing.js";

export class CardError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

interface CardRow {
  id: string;
  org_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  type: string;
  title: string;
  summary: string;
  context: string;
  status: string;
  priority: string;
  labels: string;
  agent_route: string | null;
  routing_reason: string | null;
  source_instruction: string | null;
  revision_note: string | null;
  parent_card_id: string | null;
  due_at: string | null;
  escalated_at: string | null;
  created_at: string;
  updated_at: string;
}

function toCard(db: Db, row: CardRow): DecisionCard {
  const refs = db
    .prepare("SELECT * FROM external_refs WHERE card_id = ?")
    .all(row.id) as {
    integration: string;
    external_id: string;
    url: string | null;
    state: string | null;
  }[];
  const watchers = db
    .prepare("SELECT user_id FROM card_watchers WHERE card_id = ?")
    .all(row.id) as { user_id: string }[];
  return {
    watcherUserIds: watchers.map((watcher) => watcher.user_id),
    id: row.id,
    orgId: row.org_id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    type: row.type as DecisionCard["type"],
    title: row.title,
    summary: row.summary,
    context: row.context,
    status: row.status as DecisionCard["status"],
    priority: row.priority as DecisionCard["priority"],
    labels: JSON.parse(row.labels),
    agentRoute: row.agent_route,
    routingReason: row.routing_reason,
    sourceInstruction: row.source_instruction,
    revisionNote: row.revision_note,
    parentCardId: row.parent_card_id,
    dueAt: row.due_at,
    escalatedAt: row.escalated_at,
    externalRefs: refs.map((ref) => ({
      integration: ref.integration as ExternalRef["integration"],
      externalId: ref.external_id,
      url: ref.url,
      state: ref.state,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCard(db: Db, cardId: string): DecisionCard | null {
  const row = db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as
    | CardRow
    | undefined;
  return row ? toCard(db, row) : null;
}

// A user sees a card when they sent it, must decide on it, or were pulled
// in as a watcher (e.g. via an @mention in the thread).
export function listCardsForUser(
  db: Db,
  orgId: string,
  userId: string
): DecisionCard[] {
  const rows = db
    .prepare(
      `SELECT * FROM cards
       WHERE org_id = ? AND (
         recipient_user_id = ? OR sender_user_id = ?
         OR id IN (SELECT card_id FROM card_watchers WHERE user_id = ?)
       )
       ORDER BY created_at DESC`
    )
    .all(orgId, userId, userId, userId) as CardRow[];
  return rows.map((row) => toCard(db, row));
}

export function isCardVisibleTo(card: DecisionCard, userId: string): boolean {
  return (
    card.recipientUserId === userId ||
    card.senderUserId === userId ||
    card.watcherUserIds.includes(userId)
  );
}

// Pull a member into the card (mention/cc). Emits card_updated so the new
// watcher's feed picks the card up in real time.
export function addWatcher(
  db: Db,
  cardId: string,
  userId: string,
  actorUserId: string
): { card: DecisionCard; events: OrgEvent[] } | null {
  const card = getCard(db, cardId);
  if (!card || isCardVisibleTo(card, userId)) return null;
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO card_watchers (card_id, user_id, created_at)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`
    ).run(cardId, userId, now());
    db.prepare("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
    const next = getCard(db, cardId)!;
    events.push(
      appendEvent(db, card.orgId, "card_updated", actorUserId, { card: next })
    );
  })();
  return { card: getCard(db, cardId)!, events };
}

function insertCard(db: Db, card: DecisionCard): void {
  db.prepare(
    `INSERT INTO cards (
       id, org_id, sender_user_id, recipient_user_id, type, title, summary,
       context, status, priority, labels, agent_route, routing_reason,
       source_instruction, revision_note, parent_card_id, due_at, escalated_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id,
    card.orgId,
    card.senderUserId,
    card.recipientUserId,
    card.type,
    card.title,
    card.summary,
    card.context,
    card.status,
    card.priority,
    JSON.stringify(card.labels),
    card.agentRoute ?? null,
    card.routingReason ?? null,
    card.sourceInstruction ?? null,
    card.revisionNote ?? null,
    card.parentCardId ?? null,
    card.dueAt ?? null,
    card.escalatedAt ?? null,
    card.createdAt,
    card.updatedAt
  );
}

export function createCardFromRouting(
  db: Db,
  orgId: string,
  senderUserId: string,
  sourceInstruction: string,
  routing: RoutingResult,
  dueAt: string | null = null
): { card: DecisionCard; events: OrgEvent[] } {
  const timestamp = now();
  const card: DecisionCard = {
    id: newId("card"),
    orgId,
    senderUserId,
    recipientUserId: routing.recipientUserId,
    type: routing.cardType,
    title: routing.title,
    summary: routing.summary,
    context: routing.context,
    status: "pending",
    priority: routing.priority,
    labels: routing.labels,
    agentRoute: routing.agentRoute,
    routingReason: routing.routingReason,
    sourceInstruction,
    revisionNote: null,
    parentCardId: null,
    watcherUserIds: [],
    dueAt,
    escalatedAt: null,
    externalRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const events: OrgEvent[] = [];
  db.transaction(() => {
    insertCard(db, card);
    events.push(appendEvent(db, orgId, "card_created", senderUserId, { card }));
  })();
  return { card, events };
}

const RECIPIENT_ACTIONS: CardAction[] = [
  "approve",
  "reject",
  "request_revision",
  "delegate",
  "complete",
];

export function applyCardAction(
  db: Db,
  actorUserId: string,
  cardId: string,
  action: CardAction,
  options: { note?: string; delegateToUserId?: string } = {}
): { card: DecisionCard | null; events: OrgEvent[] } {
  const card = getCard(db, cardId);
  if (!card) {
    throw new CardError("card_not_found", "Card not found.");
  }
  if (
    RECIPIENT_ACTIONS.includes(action) &&
    card.recipientUserId !== actorUserId
  ) {
    throw new CardError(
      "not_recipient",
      "Only the card's recipient can take this action."
    );
  }

  const events: OrgEvent[] = [];
  const timestamp = now();

  const update = (patch: Partial<DecisionCard>): DecisionCard => {
    const next = { ...card, ...patch, updatedAt: timestamp };
    db.prepare(
      `UPDATE cards SET status = ?, revision_note = ?, updated_at = ? WHERE id = ?`
    ).run(next.status, next.revisionNote ?? null, timestamp, next.id);
    events.push(
      appendEvent(db, card.orgId, "card_updated", actorUserId, { card: next })
    );
    return next;
  };

  const expect = (statuses: DecisionCard["status"][]) => {
    if (!statuses.includes(card.status)) {
      throw new CardError(
        "invalid_transition",
        `Cannot ${action} a ${card.status} card.`
      );
    }
  };

  let result: DecisionCard | null = card;
  db.transaction(() => {
    switch (action) {
      case "approve": {
        expect(["pending"]);
        result = update({ status: "approved" });
        break;
      }
      case "reject": {
        expect(["pending"]);
        result = update({ status: "rejected", revisionNote: options.note ?? null });
        break;
      }
      case "request_revision": {
        expect(["pending"]);
        result = update({ status: "revised", revisionNote: options.note ?? null });
        break;
      }
      case "complete": {
        expect(["approved"]);
        result = update({ status: "completed" });
        break;
      }
      case "delegate": {
        expect(["pending"]);
        const delegateTo = options.delegateToUserId;
        if (!delegateTo || delegateTo === card.recipientUserId) {
          throw new CardError(
            "invalid_delegate",
            "delegateToUserId must name another org member."
          );
        }
        result = update({ status: "delegated" });
        const child: DecisionCard = {
          ...card,
          id: newId("card"),
          recipientUserId: delegateTo,
          senderUserId: actorUserId,
          type: "delegation",
          status: "pending",
          parentCardId: card.id,
          revisionNote: options.note ?? null,
          watcherUserIds: [],
          escalatedAt: null,
          externalRefs: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        insertCard(db, child);
        events.push(
          appendEvent(db, card.orgId, "card_created", actorUserId, {
            card: child,
          })
        );
        break;
      }
      case "delete": {
        if (
          card.recipientUserId !== actorUserId &&
          card.senderUserId !== actorUserId
        ) {
          throw new CardError(
            "not_allowed",
            "Only the sender or recipient can delete a card."
          );
        }
        expect(["rejected", "completed"]);
        db.prepare("DELETE FROM cards WHERE id = ?").run(card.id);
        events.push(
          appendEvent(db, card.orgId, "card_deleted", actorUserId, {
            cardId: card.id,
            recipientUserId: card.recipientUserId,
            senderUserId: card.senderUserId,
          })
        );
        result = null;
        break;
      }
    }
  })();

  return { card: result, events };
}

// Applies async AI refinement on top of the fast local routing that
// created the card. Refuses to touch a card that is no longer pending or
// already has thread activity — by then humans have seen and acted on the
// fast version, and swapping it out from under them would be worse than
// keeping the rougher copy.
export function applyRefinement(
  db: Db,
  cardId: string,
  routing: RoutingResult,
  dueAtForPriority?: string
): { card: DecisionCard; events: OrgEvent[] } | null {
  const card = getCard(db, cardId);
  if (!card || card.status !== "pending") return null;
  const messageCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM card_messages WHERE card_id = ?")
      .get(cardId) as { n: number }
  ).n;
  if (messageCount > 0) return null;

  const unchanged =
    routing.recipientUserId === card.recipientUserId &&
    routing.title === card.title &&
    routing.summary === card.summary &&
    routing.context === card.context &&
    routing.priority === card.priority;
  if (unchanged) return null;

  const previousRecipientUserId =
    routing.recipientUserId !== card.recipientUserId
      ? card.recipientUserId
      : null;
  const timestamp = now();
  // The SLA clock follows the priority the AI settled on.
  const nextDueAt =
    routing.priority !== card.priority && dueAtForPriority
      ? dueAtForPriority
      : card.dueAt;
  const next: DecisionCard = {
    ...card,
    recipientUserId: routing.recipientUserId,
    type: routing.cardType,
    title: routing.title,
    summary: routing.summary,
    context: routing.context,
    priority: routing.priority,
    labels: routing.labels,
    agentRoute: routing.agentRoute,
    routingReason: routing.routingReason,
    dueAt: nextDueAt,
    updatedAt: timestamp,
  };
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      `UPDATE cards SET recipient_user_id = ?, type = ?, title = ?, summary = ?,
         context = ?, priority = ?, labels = ?, agent_route = ?,
         routing_reason = ?, due_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      next.recipientUserId,
      next.type,
      next.title,
      next.summary,
      next.context,
      next.priority,
      JSON.stringify(next.labels),
      next.agentRoute ?? null,
      next.routingReason ?? null,
      next.dueAt ?? null,
      timestamp,
      cardId
    );
    events.push(
      appendEvent(db, card.orgId, "card_updated", null, {
        card: next,
        previousRecipientUserId,
      })
    );
  })();
  return { card: next, events };
}

export function setExternalRef(
  db: Db,
  cardId: string,
  ref: ExternalRef
): { card: DecisionCard; events: OrgEvent[] } {
  const card = getCard(db, cardId);
  if (!card) {
    throw new CardError("card_not_found", "Card not found.");
  }
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO external_refs (card_id, integration, external_id, url, state)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (card_id, integration) DO UPDATE SET
         external_id = excluded.external_id,
         url = excluded.url,
         state = excluded.state`
    ).run(cardId, ref.integration, ref.externalId, ref.url ?? null, ref.state ?? null);
    db.prepare("UPDATE cards SET updated_at = ? WHERE id = ?").run(now(), cardId);
    const next = getCard(db, cardId)!;
    events.push(
      appendEvent(db, card.orgId, "card_updated", null, { card: next })
    );
  })();
  return { card: getCard(db, cardId)!, events };
}

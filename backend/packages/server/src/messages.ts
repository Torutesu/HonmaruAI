import type { CardMessage, MessageKind, OrgEvent } from "@honmaru/protocol";
import { CardError, getCard, isCardVisibleTo } from "./cards.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { newId, now } from "./ids.js";

interface MessageRow {
  id: string;
  card_id: string;
  org_id: string;
  author_user_id: string;
  kind: MessageKind;
  text: string;
  created_at: string;
}

function toMessage(row: MessageRow): CardMessage {
  return {
    id: row.id,
    cardId: row.card_id,
    orgId: row.org_id,
    authorUserId: row.author_user_id,
    kind: row.kind,
    text: row.text,
    createdAt: row.created_at,
  };
}

export function listMessages(db: Db, cardId: string): CardMessage[] {
  const rows = db
    .prepare("SELECT * FROM card_messages WHERE card_id = ? ORDER BY created_at ASC")
    .all(cardId) as MessageRow[];
  return rows.map(toMessage);
}

export function countMessages(db: Db, cardId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM card_messages WHERE card_id = ?")
      .get(cardId) as { n: number }
  ).n;
}

// The rally path. Deliberately synchronous and AI-free: a reply must land
// on the other participant's screen in one round-trip.
export function createMessage(
  db: Db,
  authorUserId: string,
  cardId: string,
  text: string,
  kind: MessageKind = "comment"
): { message: CardMessage; events: OrgEvent[] } {
  const card = getCard(db, cardId);
  if (!card) {
    throw new CardError("card_not_found", "Card not found.");
  }
  if (kind !== "system" && !isCardVisibleTo(card, authorUserId)) {
    throw new CardError(
      "not_allowed",
      "Only the card's participants can reply."
    );
  }
  const message: CardMessage = {
    id: newId("msg"),
    cardId,
    orgId: card.orgId,
    authorUserId,
    kind,
    text,
    createdAt: now(),
  };
  const events: OrgEvent[] = [];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO card_messages (id, card_id, org_id, author_user_id, kind, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.cardId,
      message.orgId,
      message.authorUserId,
      message.kind,
      message.text,
      message.createdAt
    );
    events.push(
      appendEvent(db, card.orgId, "message_created", authorUserId, {
        message,
        cardSenderUserId: card.senderUserId,
        cardRecipientUserId: card.recipientUserId,
      })
    );
  })();
  return { message, events };
}

import type { CardMessage, Member, MessageKind, OrgEvent } from "@honmaru/protocol";
import { addWatcher, CardError, getCard, isCardVisibleTo } from "./cards.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { newId, now } from "./ids.js";
import { listMembers } from "./orgs.js";

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

// Slack-style @mentions: "@Alice" (first name) or "@Alice Kato" pulls that
// member in. Case-insensitive, author excluded.
export function parseMentions(
  text: string,
  members: Member[],
  authorUserId: string
): string[] {
  const lower = text.toLowerCase();
  const mentioned: string[] = [];
  for (const member of members) {
    if (member.userId === authorUserId) continue;
    const first = member.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first) continue;
    const candidates = [first, member.name.toLowerCase()];
    if (
      candidates.some((candidate) => {
        const index = lower.indexOf(`@${candidate}`);
        if (index === -1) return false;
        const after = lower[index + candidate.length + 1];
        return after === undefined || !/[a-z0-9]/.test(after);
      })
    ) {
      mentioned.push(member.userId);
    }
  }
  return mentioned;
}

// The rally path. Deliberately synchronous and AI-free: a reply must land
// on the other participant's screen in one round-trip. @mentions pull the
// mentioned member into the card as a watcher and trigger a dedicated
// notification.
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

  const mentionedUserIds = parseMentions(
    text,
    listMembers(db, card.orgId),
    authorUserId
  );
  const events: OrgEvent[] = [];
  // Watcher events first so a newly mentioned member receives the card
  // before the message that pulled them in.
  for (const userId of mentionedUserIds) {
    const added = addWatcher(db, cardId, userId, authorUserId);
    if (added) events.push(...added.events);
  }
  const updatedCard = getCard(db, cardId)!;

  const message: CardMessage = {
    id: newId("msg"),
    cardId,
    orgId: card.orgId,
    authorUserId,
    kind,
    text,
    createdAt: now(),
  };
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
        cardSenderUserId: updatedCard.senderUserId,
        cardRecipientUserId: updatedCard.recipientUserId,
        watcherUserIds: updatedCard.watcherUserIds,
        mentionedUserIds,
      })
    );
  })();
  return { message, events };
}

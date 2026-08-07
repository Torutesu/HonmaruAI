import type { Notification, OrgEvent } from "@honmaru/protocol";
import type { Db } from "./db.js";
import { newId, now } from "./ids.js";
import type { Logger } from "./log.js";

// ---------------------------------------------------------------------------
// Notification engine. Consumes committed org events, derives per-user
// notifications, persists them (unread inbox), and fans them out to
// delivery channels: in-app WS frames (always, instant) plus any
// configured external channels. External delivery is best-effort and
// never blocks the write path.
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  org_id: string;
  user_id: string;
  kind: Notification["kind"];
  card_id: string | null;
  channel_id: string | null;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    kind: row.kind,
    cardId: row.card_id,
    channelId: row.channel_id,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function listNotifications(
  db: Db,
  orgId: string,
  userId: string,
  limit = 50
): { notifications: Notification[]; unreadCount: number } {
  const rows = db
    .prepare(
      `SELECT * FROM notifications WHERE org_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(orgId, userId, limit) as NotificationRow[];
  const unreadCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications
         WHERE org_id = ? AND user_id = ? AND read_at IS NULL`
      )
      .get(orgId, userId) as { n: number }
  ).n;
  return { notifications: rows.map(toNotification), unreadCount };
}

export function markNotificationsRead(
  db: Db,
  userId: string,
  options: { ids?: string[]; all?: boolean }
): number {
  const timestamp = now();
  if (options.all) {
    return db
      .prepare(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"
      )
      .run(timestamp, userId).changes;
  }
  const ids = options.ids ?? [];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `UPDATE notifications SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`
    )
    .run(timestamp, userId, ...ids).changes;
}

export function registerDevice(
  db: Db,
  userId: string,
  platform: string,
  token: string
): void {
  db.prepare(
    `INSERT INTO device_tokens (user_id, platform, token, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, token) DO NOTHING`
  ).run(userId, platform, token, now());
}

export interface DeliveryChannel {
  kind: string;
  deliver(notification: Notification): Promise<void>;
}

// Bridge channel: POSTs every notification to a configured URL. This is
// the integration point for real push providers (APNs/FCM relays, ntfy,
// Slack webhooks) without baking any one provider into the core.
export function webhookChannel(url: string): DeliveryChannel {
  return {
    kind: "webhook",
    async deliver(notification) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "notification", notification }),
      });
      if (!response.ok) {
        throw new Error(`webhook delivery failed: ${response.status}`);
      }
    },
  };
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Pure derivation: which users must hear about these events, and what
// should the notification say. The actor never notifies themselves.
export function deriveNotifications(events: OrgEvent[]): Omit<
  Notification,
  "id" | "createdAt" | "readAt"
>[] {
  const out: Omit<Notification, "id" | "createdAt" | "readAt">[] = [];
  for (const event of events) {
    switch (event.type) {
      case "card_created": {
        const card = event.payload.card;
        if (card.recipientUserId !== event.actorUserId) {
          out.push({
            orgId: event.orgId,
            userId: card.recipientUserId,
            kind: "card_assigned",
            cardId: card.id,
            title: `New ${card.type}: ${card.title}`,
            body: truncate(card.summary),
          });
        }
        break;
      }
      case "card_updated": {
        const card = event.payload.card;
        const previous = event.payload.previousRecipientUserId;
        if (previous) {
          // Re-route: the new recipient gains a card.
          out.push({
            orgId: event.orgId,
            userId: card.recipientUserId,
            kind: "card_rerouted",
            cardId: card.id,
            title: `Routed to you: ${card.title}`,
            body: truncate(card.summary),
          });
          break;
        }
        // Status change: tell the other party.
        const target =
          event.actorUserId === card.recipientUserId
            ? card.senderUserId
            : card.recipientUserId;
        if (target !== event.actorUserId && event.actorUserId) {
          out.push({
            orgId: event.orgId,
            userId: target,
            kind: "card_status",
            cardId: card.id,
            title: `${card.title}: ${card.status}`,
            body: card.revisionNote
              ? truncate(card.revisionNote)
              : truncate(card.summary),
          });
        }
        break;
      }
      case "message_created": {
        const {
          message,
          cardSenderUserId,
          cardRecipientUserId,
          watcherUserIds,
          mentionedUserIds,
        } = event.payload;
        const mentioned = new Set(mentionedUserIds);
        const audience = new Set([
          cardSenderUserId,
          cardRecipientUserId,
          ...watcherUserIds,
          ...mentionedUserIds,
        ]);
        for (const target of audience) {
          if (target === message.authorUserId) continue;
          out.push(
            mentioned.has(target)
              ? {
                  orgId: event.orgId,
                  userId: target,
                  kind: "card_mention",
                  cardId: message.cardId,
                  title: "You were mentioned",
                  body: truncate(message.text),
                }
              : {
                  orgId: event.orgId,
                  userId: target,
                  kind: "card_message",
                  cardId: message.cardId,
                  title: "New reply",
                  body: truncate(message.text),
                }
          );
        }
        break;
      }
      case "chat_message_created": {
        const { message, channelKind, channelName, memberUserIds, mentionedUserIds } =
          event.payload;
        const mentioned = new Set(mentionedUserIds);
        for (const target of mentioned) {
          if (target === message.authorUserId) continue;
          out.push({
            orgId: event.orgId,
            userId: target,
            kind: "chat_mention",
            cardId: null,
            channelId: message.channelId,
            title:
              channelKind === "channel"
                ? `You were mentioned in #${channelName}`
                : "You were mentioned",
            body: truncate(message.text),
          });
        }
        // Slack semantics: DMs always notify; channel messages only on
        // mention.
        if (channelKind === "dm") {
          for (const target of memberUserIds) {
            if (target === message.authorUserId || mentioned.has(target)) continue;
            out.push({
              orgId: event.orgId,
              userId: target,
              kind: "chat_message",
              cardId: null,
              channelId: message.channelId,
              title: "New direct message",
              body: truncate(message.text),
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export class NotificationEngine {
  constructor(
    private db: Db,
    private log: Logger,
    private channels: DeliveryChannel[],
    // In-app delivery: push a WS frame to the user if connected.
    private sendToUser: (
      orgId: string,
      userId: string,
      notification: Notification
    ) => void
  ) {}

  handle(events: OrgEvent[]): Notification[] {
    return this.direct(deriveNotifications(events));
  }

  // Persist + deliver notifications that were derived elsewhere (e.g. the
  // SLA sweeper, which targets managers — a relation event derivation
  // can't see).
  direct(
    items: Omit<Notification, "id" | "createdAt" | "readAt">[]
  ): Notification[] {
    const created: Notification[] = [];
    for (const item of items) {
      const notification: Notification = {
        ...item,
        id: newId("ntf"),
        readAt: null,
        createdAt: now(),
      };
      this.db
        .prepare(
          `INSERT INTO notifications (id, org_id, user_id, kind, card_id, channel_id, title, body, read_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(
          notification.id,
          notification.orgId,
          notification.userId,
          notification.kind,
          notification.cardId ?? null,
          notification.channelId ?? null,
          notification.title,
          notification.body,
          notification.createdAt
        );
      created.push(notification);
      this.sendToUser(notification.orgId, notification.userId, notification);
      for (const channel of this.channels) {
        channel.deliver(notification).catch((error) => {
          this.log.warn(
            { err: error, channel: channel.kind, notification: notification.id },
            "notification channel delivery failed"
          );
        });
      }
    }
    return created;
  }
}

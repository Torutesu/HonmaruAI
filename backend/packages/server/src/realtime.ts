import type {
  CardPriority,
  DecisionCard,
  Notification,
  OrgEvent,
  ServerMessage,
} from "@honmaru/protocol";
import { ClientMessage } from "@honmaru/protocol";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { rankCards } from "./analytics.js";
import { authenticate } from "./auth.js";
import {
  applyCardAction,
  CardError,
  isCardVisibleTo,
  listCardsForUser,
} from "./cards.js";
import {
  ChatError,
  createChatMessage,
  ensureDefaultChannel,
  listChannelsForUser,
} from "./chat.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { currentSeq, listEventsSince } from "./events.js";
import type { Logger } from "./log.js";
import { createMessage } from "./messages.js";
import {
  getMember,
  getOrg,
  listEdges,
  listMembers,
  listTeams,
  OrgError,
} from "./orgs.js";

interface SocketSession {
  userId: string;
  orgId: string;
}

export function isEventVisibleTo(event: OrgEvent, userId: string): boolean {
  switch (event.type) {
    case "card_created":
      return isCardVisibleTo(event.payload.card, userId);
    case "card_updated":
      // A re-routed card must also reach its previous recipient so their
      // feed can drop it.
      return (
        isCardVisibleTo(event.payload.card, userId) ||
        event.payload.previousRecipientUserId === userId
      );
    case "card_deleted":
      return (
        event.payload.recipientUserId === userId ||
        event.payload.senderUserId === userId
      );
    case "message_created":
      return (
        event.payload.cardSenderUserId === userId ||
        event.payload.cardRecipientUserId === userId ||
        event.payload.watcherUserIds.includes(userId) ||
        event.payload.mentionedUserIds.includes(userId)
      );
    case "channel_created":
      return (
        event.payload.channel.kind === "channel" ||
        event.payload.channel.memberUserIds.includes(userId)
      );
    case "chat_message_created":
      return (
        event.payload.channelKind === "channel" ||
        event.payload.memberUserIds.includes(userId)
      );
    default:
      return true;
  }
}

export class Hub {
  private sessions = new Map<WebSocket, SocketSession>();
  private wss: WebSocketServer | null = null;

  // Assigned by the app composer: fan events out to sockets AND to the
  // integration registry. The hub itself only knows how to broadcast.
  onEventsCommitted: (orgId: string, events: OrgEvent[]) => void = (
    orgId,
    events
  ) => this.broadcastEvents(orgId, events);

  // Assigned by the app composer: fast-path instruction pipeline
  // (sync local routing + async LLM refinement job).
  handleInstruction: (
    orgId: string,
    senderUserId: string,
    text: string,
    priorityOverride?: CardPriority
  ) => { card: DecisionCard; events: OrgEvent[] } = () => {
    throw new Error("handleInstruction not wired");
  };

  constructor(
    private db: Db,
    private config: Config,
    private log: Logger
  ) {}

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        this.handleMessage(ws, String(raw)).catch((error) => {
          this.log.error({ err: error }, "ws message handling failed");
          this.send(ws, {
            type: "error",
            code: "internal",
            message: "Internal error.",
          });
        });
      });
      ws.on("close", () => {
        const session = this.sessions.get(ws);
        if (session) {
          this.sessions.delete(ws);
          this.broadcastPresence(session.orgId, session.userId, "offline");
        }
      });
    });
  }

  close(): void {
    this.wss?.close();
    for (const ws of this.sessions.keys()) ws.close();
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcastEvents(orgId: string, events: OrgEvent[]): void {
    for (const [ws, session] of this.sessions) {
      if (session.orgId !== orgId) continue;
      for (const event of events) {
        if (isEventVisibleTo(event, session.userId)) {
          this.send(ws, { type: "event", event });
        }
      }
    }
  }

  sendNotification(orgId: string, userId: string, notification: Notification): void {
    for (const [ws, session] of this.sessions) {
      if (session.orgId === orgId && session.userId === userId) {
        this.send(ws, { type: "notification", notification });
      }
    }
  }

  private broadcastPresence(
    orgId: string,
    userId: string,
    status: "online" | "offline"
  ): void {
    for (const [ws, session] of this.sessions) {
      if (session.orgId === orgId && session.userId !== userId) {
        this.send(ws, { type: "presence", userId, status });
      }
    }
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "error", code: "bad_json", message: "Invalid JSON." });
      return;
    }
    const result = ClientMessage.safeParse(parsed);
    if (!result.success) {
      this.send(ws, {
        type: "error",
        code: "bad_message",
        message: result.error.issues[0]?.message ?? "Invalid message.",
      });
      return;
    }
    const message = result.data;

    if (message.type === "ping") {
      this.send(ws, { type: "pong" });
      return;
    }

    if (message.type === "hello") {
      const user = authenticate(this.db, message.token);
      if (!user) {
        this.send(ws, {
          type: "error",
          code: "unauthorized",
          message: "Invalid or expired session token.",
        });
        ws.close();
        return;
      }
      const org = getOrg(this.db, message.orgId);
      const member = getMember(this.db, message.orgId, user.id);
      if (!org || !member) {
        this.send(ws, {
          type: "error",
          code: "not_a_member",
          message: "You are not a member of this org.",
        });
        ws.close();
        return;
      }

      this.sessions.set(ws, { userId: user.id, orgId: org.id });
      ensureDefaultChannel(this.db, org.id);
      this.send(ws, {
        type: "welcome",
        self: member,
        org,
        members: listMembers(this.db, org.id),
        teams: listTeams(this.db, org.id),
        edges: listEdges(this.db, org.id),
        channels: listChannelsForUser(this.db, org.id, user.id),
        seq: currentSeq(this.db, org.id),
      });

      if (message.sinceSeq !== undefined) {
        const events = listEventsSince(this.db, org.id, message.sinceSeq);
        for (const event of events) {
          if (isEventVisibleTo(event, user.id)) {
            this.send(ws, { type: "event", event });
          }
        }
      } else {
        // Snapshot is served in feed order: AI-ranked, not chronological.
        this.send(ws, {
          type: "snapshot",
          cards: rankCards(
            listCardsForUser(this.db, org.id, user.id),
            listEdges(this.db, org.id)
          ),
          seq: currentSeq(this.db, org.id),
        });
      }
      this.broadcastPresence(org.id, user.id, "online");
      // Catch the newcomer up on who is already online.
      const seen = new Set<string>();
      for (const session of this.sessions.values()) {
        if (
          session.orgId === org.id &&
          session.userId !== user.id &&
          !seen.has(session.userId)
        ) {
          seen.add(session.userId);
          this.send(ws, { type: "presence", userId: session.userId, status: "online" });
        }
      }
      return;
    }

    // Everything below requires an authenticated session.
    const session = this.sessions.get(ws);
    if (!session) {
      this.send(ws, {
        type: "error",
        code: "hello_required",
        message: "Send hello before other messages.",
      });
      return;
    }

    try {
      if (message.type === "instruction") {
        const { card, events } = this.handleInstruction(
          session.orgId,
          session.userId,
          message.text,
          message.priorityOverride
        );
        this.send(ws, { type: "ack", clientRef: message.clientRef, card });
        this.onEventsCommitted(session.orgId, events);
        return;
      }

      if (message.type === "card_message") {
        const { message: created, events } = createMessage(
          this.db,
          session.userId,
          message.cardId,
          message.text
        );
        this.send(ws, {
          type: "ack",
          clientRef: message.clientRef,
          message: created,
        });
        this.onEventsCommitted(session.orgId, events);
        return;
      }

      if (message.type === "chat_message") {
        const { events } = createChatMessage(
          this.db,
          session.userId,
          message.channelId,
          message.text
        );
        this.send(ws, { type: "ack", clientRef: message.clientRef });
        this.onEventsCommitted(session.orgId, events);
        return;
      }

      if (message.type === "card_action") {
        const { card, events } = applyCardAction(
          this.db,
          session.userId,
          message.cardId,
          message.action,
          { note: message.note, delegateToUserId: message.delegateToUserId }
        );
        this.send(ws, { type: "ack", clientRef: message.clientRef, card });
        this.onEventsCommitted(session.orgId, events);
        return;
      }
    } catch (error) {
      if (
        error instanceof CardError ||
        error instanceof OrgError ||
        error instanceof ChatError
      ) {
        this.send(ws, {
          type: "error",
          clientRef: "clientRef" in message ? message.clientRef : undefined,
          code: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }
}

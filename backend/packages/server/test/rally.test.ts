import { beforeEach, describe, expect, it } from "vitest";
import { computeAnalytics, rankCards } from "../src/analytics.js";
import { devLogin } from "../src/auth.js";
import { applyCardAction, CardError, listCardsForUser } from "../src/cards.js";
import { openDb, type Db } from "../src/db.js";
import { createInstruction, type InstructionDeps } from "../src/instructions.js";
import { JobQueue } from "../src/jobs.js";
import { createLogger } from "../src/log.js";
import { createMessage, listMessages } from "../src/messages.js";
import {
  deriveNotifications,
  listNotifications,
  markNotificationsRead,
  NotificationEngine,
} from "../src/notifications.js";
import { createOrg, listEdges } from "../src/orgs.js";
import { testConfig } from "./helpers.js";

const log = createLogger("silent");

function setup() {
  const db = openDb(":memory:");
  const alice = devLogin(db, "Alice").id;
  const bob = devLogin(db, "Bob").id;
  const carol = devLogin(db, "Carol").id;
  const orgId = createOrg(db, alice, "Acme", "PM").id;
  for (const [userId, title] of [
    [bob, "Engineer"],
    [carol, "Designer"],
  ] as const) {
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
       VALUES (?, ?, ?, 0, ?)`
    ).run(orgId, userId, title, new Date().toISOString());
  }
  const deps: InstructionDeps = {
    db,
    config: testConfig(),
    log,
    emitEvents: () => {},
    queue: new JobQueue(log, {}),
  };
  return { db, alice, bob, carol, orgId, deps };
}

describe("card thread rally", () => {
  let ctx: ReturnType<typeof setup>;
  let db: Db;
  let cardId: string;

  beforeEach(() => {
    ctx = setup();
    db = ctx.db;
    const { card } = createInstruction(
      ctx.deps,
      ctx.orgId,
      ctx.alice,
      "tell Bob to fix the login bug"
    );
    cardId = card.id;
  });

  it("participants can rally back and forth; events carry participants", () => {
    const first = createMessage(db, ctx.bob, cardId, "Which environment?");
    const second = createMessage(db, ctx.alice, cardId, "Production, since 14:00");
    expect(listMessages(db, cardId).map((m) => m.text)).toEqual([
      "Which environment?",
      "Production, since 14:00",
    ]);
    const event = first.events[0]!;
    expect(event.type).toBe("message_created");
    expect(event.payload).toMatchObject({
      cardSenderUserId: ctx.alice,
      cardRecipientUserId: ctx.bob,
    });
    expect(second.events[0]!.seq).toBe(first.events[0]!.seq + 1);
  });

  it("non-participants cannot post to the thread", () => {
    expect(() => createMessage(db, ctx.carol, cardId, "let me in")).toThrow(
      CardError
    );
  });
});

describe("notifications", () => {
  it("derives assigned/status/message notifications, never for the actor", () => {
    const ctx = setup();
    const { card, events: createdEvents } = createInstruction(
      ctx.deps,
      ctx.orgId,
      ctx.alice,
      "tell Bob to fix the login bug"
    );
    const assigned = deriveNotifications(createdEvents);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ userId: ctx.bob, kind: "card_assigned" });

    const { events: approveEvents } = applyCardAction(
      ctx.db,
      ctx.bob,
      card.id,
      "approve"
    );
    const status = deriveNotifications(approveEvents);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ userId: ctx.alice, kind: "card_status" });

    const { events: messageEvents } = createMessage(
      ctx.db,
      ctx.alice,
      card.id,
      "thanks!"
    );
    const reply = deriveNotifications(messageEvents);
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ userId: ctx.bob, kind: "card_message" });
  });

  it("engine persists an unread inbox and supports mark-read", () => {
    const ctx = setup();
    const delivered: string[] = [];
    const engine = new NotificationEngine(ctx.db, log, [], (_org, userId) =>
      delivered.push(userId)
    );
    const { events } = createInstruction(
      ctx.deps,
      ctx.orgId,
      ctx.alice,
      "tell Bob to fix the login bug"
    );
    engine.handle(events);
    expect(delivered).toEqual([ctx.bob]);

    const inbox = listNotifications(ctx.db, ctx.orgId, ctx.bob);
    expect(inbox.unreadCount).toBe(1);
    markNotificationsRead(ctx.db, ctx.bob, { all: true });
    expect(listNotifications(ctx.db, ctx.orgId, ctx.bob).unreadCount).toBe(0);
  });
});

describe("feed ranking + analytics", () => {
  it("ranks pending before decided, urgent before low, and detects bottlenecks", () => {
    const ctx = setup();
    const low = createInstruction(
      ctx.deps,
      ctx.orgId,
      ctx.alice,
      "tell Bob about the docs whenever"
    ).card;
    const urgent = createInstruction(
      ctx.deps,
      ctx.orgId,
      ctx.alice,
      "tell Bob to fix the outage urgently"
    ).card;
    const decided = createInstruction(
      ctx.deps,
      ctx.orgId,
      ctx.alice,
      "tell Bob to review the spec"
    ).card;
    applyCardAction(ctx.db, ctx.bob, decided.id, "approve");

    const feed = rankCards(
      listCardsForUser(ctx.db, ctx.orgId, ctx.bob),
      listEdges(ctx.db, ctx.orgId)
    );
    expect(feed[0]!.id).toBe(urgent.id);
    expect(feed[1]!.id).toBe(low.id);
    expect(feed[2]!.id).toBe(decided.id);

    const analytics = computeAnalytics(ctx.db, ctx.orgId);
    expect(analytics.totalCards).toBe(3);
    expect(analytics.pendingCards).toBe(2);
    expect(analytics.decidedCards).toBe(1);
    expect(analytics.bottlenecks[0]).toBe(ctx.bob);
    const bobRow = analytics.perMember.find((m) => m.userId === ctx.bob)!;
    expect(bobRow.pendingCount).toBe(2);
    expect(bobRow.decidedCount).toBe(1);
  });
});

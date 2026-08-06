import { beforeEach, describe, expect, it } from "vitest";
import { devLogin } from "../src/auth.js";
import {
  applyCardAction,
  CardError,
  createCardFromRouting,
  getCard,
  listCardsForUser,
} from "../src/cards.js";
import { openDb, type Db } from "../src/db.js";
import { currentSeq, listEventsSince } from "../src/events.js";
import { createOrg, getMember } from "../src/orgs.js";
import { routeLocally } from "../src/routing.js";

describe("card lifecycle", () => {
  let db: Db;
  let orgId: string;
  let alice: string;
  let bob: string;
  let carol: string;

  function instruct(sender: string, text: string) {
    const senderMember = getMember(db, orgId, sender)!;
    const routing = routeLocally({
      text,
      sender: senderMember,
      members: [alice, bob, carol].map((id) => getMember(db, orgId, id)!),
      teams: [],
      edges: [],
    });
    return createCardFromRouting(db, orgId, sender, text, routing);
  }

  beforeEach(() => {
    db = openDb(":memory:");
    alice = devLogin(db, "Alice").id;
    bob = devLogin(db, "Bob").id;
    carol = devLogin(db, "Carol").id;
    orgId = createOrg(db, alice, "Acme", "PM").id;
    for (const [userId, title] of [
      [bob, "Engineer"],
      [carol, "Designer"],
    ] as const) {
      db.prepare(
        `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
         VALUES (?, ?, ?, 0, ?)`
      ).run(orgId, userId, title, new Date().toISOString());
    }
  });

  it("creates a pending card and appends card_created to the log", () => {
    const before = currentSeq(db, orgId);
    const { card, events } = instruct(alice, "tell Bob to fix the login bug");
    expect(card.status).toBe("pending");
    expect(card.recipientUserId).toBe(bob);
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBe(before + 1);
    expect(listCardsForUser(db, orgId, bob).map((c) => c.id)).toContain(card.id);
    expect(listCardsForUser(db, orgId, alice).map((c) => c.id)).toContain(card.id);
    expect(listCardsForUser(db, orgId, carol).map((c) => c.id)).not.toContain(card.id);
  });

  it("only lets the recipient approve", () => {
    const { card } = instruct(alice, "tell Bob to fix the login bug");
    expect(() => applyCardAction(db, alice, card.id, "approve")).toThrow(CardError);
    const { card: approved } = applyCardAction(db, bob, card.id, "approve");
    expect(approved?.status).toBe("approved");
  });

  it("rejects invalid transitions", () => {
    const { card } = instruct(alice, "tell Bob to fix the login bug");
    applyCardAction(db, bob, card.id, "approve");
    expect(() => applyCardAction(db, bob, card.id, "approve")).toThrow(
      /Cannot approve/
    );
    expect(() => applyCardAction(db, bob, card.id, "delete")).toThrow(CardError);
    const { card: completed } = applyCardAction(db, bob, card.id, "complete");
    expect(completed?.status).toBe("completed");
  });

  it("delegation spawns a child card and marks the original", () => {
    const { card } = instruct(alice, "tell Bob to fix the login bug");
    const { events } = applyCardAction(db, bob, card.id, "delegate", {
      delegateToUserId: carol,
      note: "Carol owns this area",
    });
    expect(getCard(db, card.id)?.status).toBe("delegated");
    const created = events.find((event) => event.type === "card_created");
    expect(created).toBeDefined();
    const child = (created!.payload as { card: { id: string } }).card;
    const childCard = getCard(db, child.id)!;
    expect(childCard.recipientUserId).toBe(carol);
    expect(childCard.senderUserId).toBe(bob);
    expect(childCard.parentCardId).toBe(card.id);
    expect(childCard.status).toBe("pending");
  });

  it("rejected cards can be deleted by sender or recipient only", () => {
    const { card } = instruct(alice, "tell Bob to fix the login bug");
    applyCardAction(db, bob, card.id, "reject");
    expect(() => applyCardAction(db, carol, card.id, "delete")).toThrow(CardError);
    const { card: gone } = applyCardAction(db, alice, card.id, "delete");
    expect(gone).toBeNull();
    expect(getCard(db, card.id)).toBeNull();
  });

  it("event log supports resume from a cursor", () => {
    const { card } = instruct(alice, "tell Bob to fix the login bug");
    const cursor = currentSeq(db, orgId);
    applyCardAction(db, bob, card.id, "request_revision", { note: "add repro" });
    instruct(alice, "tell Carol the empty state needs a designer pass");
    const events = listEventsSince(db, orgId, cursor);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual([
      "card_updated",
      "card_created",
    ]);
    expect(events[0]!.seq).toBe(cursor + 1);
    expect(events[1]!.seq).toBe(cursor + 2);
  });
});

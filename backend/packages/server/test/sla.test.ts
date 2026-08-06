import { beforeEach, describe, expect, it } from "vitest";
import { devLogin } from "../src/auth.js";
import { getCard } from "../src/cards.js";
import { openDb, type Db } from "../src/db.js";
import { createInstruction, type InstructionDeps } from "../src/instructions.js";
import { JobQueue } from "../src/jobs.js";
import { createLogger } from "../src/log.js";
import { createOrg, replaceGraph } from "../src/orgs.js";
import { DUE_HOURS, dueAtFor, sweepOverdue } from "../src/sla.js";
import { testConfig } from "./helpers.js";

const log = createLogger("silent");

describe("SLA + escalation", () => {
  let db: Db;
  let alice: string; // manager (PM)
  let bob: string; // recipient
  let orgId: string;
  let deps: InstructionDeps;

  beforeEach(() => {
    db = openDb(":memory:");
    alice = devLogin(db, "Alice").id;
    bob = devLogin(db, "Bob").id;
    orgId = createOrg(db, alice, "Acme", "PM").id;
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
       VALUES (?, ?, 'Engineer', 0, ?)`
    ).run(orgId, bob, new Date().toISOString());
    replaceGraph(db, orgId, alice, [], [
      { kind: "manages", fromId: alice, toId: bob },
    ]);
    deps = {
      db,
      config: testConfig(),
      log,
      emitEvents: () => {},
      queue: new JobQueue(log, {}),
    };
  });

  it("assigns a priority-based deadline at creation", () => {
    const { card } = createInstruction(
      deps,
      orgId,
      alice,
      "tell Bob to fix the outage urgently"
    );
    expect(card.priority).toBe("urgent");
    const expected = Date.now() + DUE_HOURS.urgent * 3_600_000;
    expect(Math.abs(Date.parse(card.dueAt!) - expected)).toBeLessThan(5000);
  });

  it("escalates overdue cards once: urgent bump + recipient and manager notified", () => {
    const { card } = createInstruction(
      deps,
      orgId,
      alice,
      "tell Bob about the docs whenever"
    );
    expect(card.priority).toBe("low");

    // Not yet due: nothing happens.
    expect(sweepOverdue(db)).toHaveLength(0);

    // Force the deadline into the past.
    db.prepare("UPDATE cards SET due_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      card.id
    );
    const results = sweepOverdue(db);
    expect(results).toHaveLength(1);
    const escalated = getCard(db, card.id)!;
    expect(escalated.priority).toBe("urgent");
    expect(escalated.escalatedAt).not.toBeNull();
    expect(results[0]!.events[0]!.type).toBe("card_updated");
    expect(results[0]!.notifications.map((n) => [n.userId, n.kind])).toEqual([
      [bob, "card_overdue"],
      [alice, "card_overdue"],
    ]);

    // Second sweep is a no-op (escalate once).
    expect(sweepOverdue(db)).toHaveLength(0);
  });

  it("does not escalate decided cards", () => {
    const { card } = createInstruction(deps, orgId, alice, "tell Bob to fix it");
    db.prepare("UPDATE cards SET due_at = ?, status = 'approved' WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      card.id
    );
    expect(sweepOverdue(db)).toHaveLength(0);
  });

  it("dueAtFor maps priorities to their windows", () => {
    const from = Date.parse("2026-01-01T00:00:00Z");
    expect(dueAtFor("urgent", from)).toBe("2026-01-01T02:00:00.000Z");
    expect(dueAtFor("low", from)).toBe("2026-01-04T00:00:00.000Z");
  });
});

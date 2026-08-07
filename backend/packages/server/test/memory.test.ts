import { beforeEach, describe, expect, it } from "vitest";
import { devLogin } from "../src/auth.js";
import { applyCardAction } from "../src/cards.js";
import { openDb, type Db } from "../src/db.js";
import { createInstruction, type InstructionDeps } from "../src/instructions.js";
import { JobQueue } from "../src/jobs.js";
import { createLogger } from "../src/log.js";
import {
  captureFromEvents,
  CONDENSE_THRESHOLD,
  listMemories,
  memoryContext,
} from "../src/memory.js";
import { createOrg, getMember, listMembers } from "../src/orgs.js";
import { rosterPrompt } from "../src/routing.js";
import { testConfig } from "./helpers.js";

const log = createLogger("silent");

describe("agent memory", () => {
  let db: Db;
  let alice: string;
  let bob: string;
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
    deps = {
      db,
      config: testConfig(),
      log,
      emitEvents: () => {},
      queue: new JobQueue(log, {}),
    };
  });

  function decide(action: "reject" | "approve" | "request_revision", note?: string) {
    const { card } = createInstruction(deps, orgId, alice, "tell Bob to deploy on friday");
    const { events } = applyCardAction(db, bob, card.id, action, { note });
    return captureFromEvents(db, events);
  }

  it("captures observations from the recipient's decisions, with notes", () => {
    decide("reject", "never deploy on Fridays");
    const memories = listMemories(db, orgId, bob);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.kind).toBe("observation");
    expect(memories[0]!.content).toContain("never deploy on Fridays");
    // The sender learns nothing from Bob's decision.
    expect(listMemories(db, orgId, alice)).toHaveLength(0);
  });

  it("signals condensation once the observation count crosses the threshold", () => {
    let crossed: string[] = [];
    for (let i = 0; i < CONDENSE_THRESHOLD; i += 1) {
      crossed = decide("approve");
    }
    expect(crossed).toEqual([`${orgId} ${bob}`]);
  });

  it("injects memory into the routing prompt", () => {
    decide("reject", "never deploy on Fridays");
    const block = memoryContext(db, orgId, [bob], () => "Bob");
    expect(block).toContain("What each person's AI has learned");
    expect(block).toContain("Bob:");
    expect(block).toContain("never deploy on Fridays");
    const prompt = rosterPrompt({
      text: "tell Bob to deploy on friday",
      sender: getMember(db, orgId, alice)!,
      members: listMembers(db, orgId),
      teams: [],
      edges: [],
      memoryContext: block,
    });
    expect(prompt).toContain("never deploy on Fridays");
  });

  it("prefers condensed preferences over raw observations", () => {
    decide("approve");
    db.prepare(
      `INSERT INTO agent_memories (id, org_id, user_id, kind, content, created_at)
       VALUES ('mem_p1', ?, ?, 'preference', 'Blocks all Friday deploys', ?)`
    ).run(orgId, bob, new Date(Date.now() + 1000).toISOString());
    const block = memoryContext(db, orgId, [bob], () => "Bob", 1);
    expect(block).toContain("Blocks all Friday deploys");
    expect(block).not.toContain("Approved");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { OrgEvent } from "@honmaru/protocol";
import { devLogin } from "../src/auth.js";
import { listCardsForUser } from "../src/cards.js";
import {
  createChatMessage,
  ensureDefaultChannel,
  listChannelsForUser,
} from "../src/chat.js";
import { openDb, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { createOrg } from "../src/orgs.js";
import { makeSummarizeHandler } from "../src/summarize.js";
import { testConfig } from "./helpers.js";

describe("channel digest (chat -> decision card)", () => {
  let db: Db;
  let alice: string;
  let bob: string;
  let orgId: string;

  beforeEach(() => {
    db = openDb(":memory:");
    alice = devLogin(db, "Alice").id;
    bob = devLogin(db, "Bob").id;
    orgId = createOrg(db, alice, "Acme", "PM").id;
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, title, is_admin, created_at)
       VALUES (?, ?, 'Engineer', 0, ?)`
    ).run(orgId, bob, new Date().toISOString());
    ensureDefaultChannel(db, orgId);
  });

  it("delivers a fallback digest card to the requester without an LLM", async () => {
    const general = listChannelsForUser(db, orgId, alice).find(
      (ch) => ch.name === "general"
    )!;
    createChatMessage(db, alice, general.id, "we decided to ship Friday");
    createChatMessage(db, bob, general.id, "I will prepare the rollback plan");

    const emitted: OrgEvent[] = [];
    const handler = makeSummarizeHandler({
      db,
      config: testConfig(),
      log: createLogger("silent"),
      emitEvents: (_orgId, events) => emitted.push(...events),
    });
    await handler({ orgId, channelId: general.id, requesterUserId: alice });

    const cards = listCardsForUser(db, orgId, alice);
    const digest = cards.find((card) => card.labels?.includes("digest"));
    expect(digest).toBeDefined();
    expect(digest!.recipientUserId).toBe(alice);
    expect(digest!.title).toContain("#general");
    expect(digest!.summary).toContain("ship Friday");
    expect(digest!.agentRoute).toContain("#general");
    expect(emitted.some((event) => event.type === "card_created")).toBe(true);

    // Bob never sees Alice's digest.
    expect(
      listCardsForUser(db, orgId, bob).some((card) => card.labels?.includes("digest"))
    ).toBe(false);
  });

  it("does nothing for an empty channel", async () => {
    const general = listChannelsForUser(db, orgId, alice).find(
      (ch) => ch.name === "general"
    )!;
    const handler = makeSummarizeHandler({
      db,
      config: testConfig(),
      log: createLogger("silent"),
      emitEvents: () => {},
    });
    await handler({ orgId, channelId: general.id, requesterUserId: alice });
    expect(listCardsForUser(db, orgId, alice)).toHaveLength(0);
  });
});

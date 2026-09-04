import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message } from "./helpers.js";

// A nudge is the sender re-raising a decision the recipient has not answered.
// It moves in the opposite direction to a decision — sender to recipient — so
// it cannot reuse the decision path, which only the recipient may walk.

const ORG = "acme/app";
let aliceToken;
let bobToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "5001", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "5002", login: "bob", name: "Bob", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "5001", "admin");
  await upsertMembership(env.DB, ORG, "5002", "member");
  aliceToken = await createSession(env.DB, "5001", "gho_alice");
  bobToken = await createSession(env.DB, "5002", "gho_bob");
});

async function aliceSendsCardToBob(alice, cardId) {
  alice.ws.send(JSON.stringify({
    type: "card_created",
    payload: {
      card: {
        id: cardId,
        type: "approval",
        status: "pending",
        recipientUserID: "bob",
        title: "Approve the thing",
        summary: "Bob needs to approve the thing.",
        priority: "high",
        createdAt: new Date().toISOString(),
      },
    },
  }));
}

test("a nudge from the sender reaches the recipient", async () => {
  const alice = await joined(ORG, aliceToken);
  const bob = await joined(ORG, bobToken);

  const cardId = "card-nudge-1";
  await aliceSendsCardToBob(alice, cardId);
  expect(await message(bob.messages, (m) => JSON.stringify(m).includes(cardId))).toBeTruthy();

  // Everything Bob has seen so far; the nudge must produce something after it.
  const seenBefore = bob.messages.length;

  alice.ws.send(JSON.stringify({ type: "nudge", payload: { cardId } }));

  // Wait for Bob to receive anything new after the nudge.
  const { until } = await import("./helpers.js");
  const grew = await until(async () => bob.messages.length > seenBefore);
  expect(grew).toBeTruthy();
});

test("a nudge from someone who is not the sender is ignored", async () => {
  const alice = await joined(ORG, aliceToken);
  const bob = await joined(ORG, bobToken);

  const cardId = "card-nudge-2";
  await aliceSendsCardToBob(alice, cardId);
  expect(await message(bob.messages, (m) => JSON.stringify(m).includes(cardId))).toBeTruthy();

  const seenBefore = bob.messages.length;
  // Bob is the recipient, not the sender — his nudge must do nothing.
  bob.ws.send(JSON.stringify({ type: "nudge", payload: { cardId } }));

  // Give it room to (incorrectly) arrive.
  await new Promise((r) => setTimeout(r, 300));
  expect(bob.messages.length).toBe(seenBefore);
});

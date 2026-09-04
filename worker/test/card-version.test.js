import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { saveCard, getCard, getCardWithVersion, CardConflictError } from "../src/db.js";

// Every write to a card is a read, a merge in JavaScript and a write back, with
// awaits on D1 in between — and a Durable Object releases its input gate across
// an external storage await. Two writes racing on one card ended with the
// second silently erasing the first.

const ORG = "acme/app";

const card = (over = {}) => ({
  id: "c-1",
  recipientUserID: "bob",
  senderUserID: "alice",
  type: "approval",
  title: "Ship it",
  summary: "",
  context: "",
  status: "pending",
  priority: "medium",
  createdAt: "2026-09-01T00:00:00Z",
  ...over,
});

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("a new card starts at a version, and every change moves it on", async () => {
  await saveCard(env.DB, ORG, card());
  const first = await getCardWithVersion(env.DB, ORG, "c-1");
  expect(first.card.title).toBe("Ship it");

  await saveCard(env.DB, ORG, card({ title: "Ship it now" }), first.version);
  const second = await getCardWithVersion(env.DB, ORG, "c-1");
  expect(second.version).toBe(first.version + 1);
});

test("a write against a version that has moved on is refused", async () => {
  await saveCard(env.DB, ORG, card({ id: "c-2" }));
  const read = await getCardWithVersion(env.DB, ORG, "c-2");

  // Somebody else decides, using the version they read.
  await saveCard(env.DB, ORG, card({ id: "c-2", status: "approved" }), read.version);

  // Our merge is built on the copy we read before that happened. Without the
  // check this write lands and the approval is gone.
  await expect(
    saveCard(env.DB, ORG, card({ id: "c-2", title: "Renamed" }), read.version)
  ).rejects.toBeInstanceOf(CardConflictError);

  expect((await getCard(env.DB, ORG, "c-2")).status).toBe("approved");
});

test("a card deleted underneath a change is not resurrected by it", async () => {
  await saveCard(env.DB, ORG, card({ id: "c-3" }));
  const read = await getCardWithVersion(env.DB, ORG, "c-3");
  await env.DB.prepare("DELETE FROM cards WHERE org_id = ?1 AND card_id = 'c-3'").bind(ORG).run();

  await expect(
    saveCard(env.DB, ORG, card({ id: "c-3", status: "approved" }), read.version)
  ).rejects.toBeInstanceOf(CardConflictError);
  expect(await getCard(env.DB, ORG, "c-3")).toBeNull();
});

test("a create is unconditional, because there is nothing yet to race with", async () => {
  await saveCard(env.DB, ORG, card({ id: "c-4" }));
  expect((await getCard(env.DB, ORG, "c-4")).id).toBe("c-4");
});

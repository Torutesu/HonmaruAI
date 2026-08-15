import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { listCardEvents } from "../src/events.js";
import { getCard } from "../src/db.js";
import { joined, until } from "./helpers.js";

const ORG = "audit-org";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "3001", login: "octocat", name: null, avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "3002", login: "hubot", name: null, avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "3001", "Admin");
  await upsertMembership(env.DB, ORG, "3002", "Engineer");
  globalThis.__octocat = await createSession(env.DB, "3001", "gho_octo");
  globalThis.__hubot = await createSession(env.DB, "3002", "gho_hubot");
});

// Identity comes off the session, so the tests hold one socket per person rather
// than one socket that claims to be whoever the next message needs.
const asSender = () => joined(ORG, globalThis.__octocat);
const asDecider = () => joined(ORG, globalThis.__hubot);

function card(id) {
  return {
    id, recipientUserID: "hubot", senderUserID: "octocat", status: "pending",
    title: "Ship it?", priority: "high", createdAt: "2026-08-09T00:00:00Z",
  };
}

// Waits for one specific status. `until` returns the first truthy value, and
// "pending" is truthy — so polling for "the status" answers instantly with
// whatever is there rather than with what the test is waiting for.
const cardStatusIs = (id, expected) =>
  until(async () => (await getCard(env.DB, ORG, id))?.status === expected);
const eventOfType = (id, type) =>
  until(async () => (await listCardEvents(env.DB, ORG, id)).find((e) => e.type === type));

test("a decision leaves created + decided, and the snapshot shows the outcome", async () => {
  const { ws: sender } = await asSender();
  const { ws: decider } = await asDecider();

  sender.send(JSON.stringify({ type: "card_created", payload: { card: card("c-audit") } }));
  expect(await cardStatusIs("c-audit", "pending")).toBe(true);

  decider.send(JSON.stringify({
    type: "tool_result",
    payload: { content: { cardId: "c-audit", action: "approve", note: "ok" } },
  }));
  expect(await eventOfType("c-audit", "decided")).toBeTruthy();

  const events = await listCardEvents(env.DB, ORG, "c-audit");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].action).toBe("approve");
  expect(events[1].snapshot.status).toBe("approved");
});

test("a rollback preserves the decision it undid", async () => {
  const { ws: sender } = await asSender();
  const { ws: decider } = await asDecider();

  sender.send(JSON.stringify({ type: "card_created", payload: { card: card("c-rb") } }));
  expect(await cardStatusIs("c-rb", "pending")).toBe(true);

  decider.send(JSON.stringify({
    type: "tool_result",
    payload: { content: { cardId: "c-rb", action: "approve" } },
  }));
  // The rollback is only legal against a card that is already decided. Sleeping
  // a fixed 60ms here is what made this test pass on a laptop and fail on CI.
  expect(await cardStatusIs("c-rb", "approved")).toBe(true);

  decider.send(JSON.stringify({ type: "rollback", payload: { cardId: "c-rb" } }));

  const undone = await eventOfType("c-rb", "rolled_back");
  expect(undone).toBeTruthy();
  expect(undone.snapshot.decision.action).toBe("approve");
  expect(undone.snapshot.status).toBe("approved");
});

test("deleting a card keeps its history", async () => {
  const { ws: sender } = await asSender();
  const { ws: decider } = await asDecider();

  sender.send(JSON.stringify({ type: "card_created", payload: { card: card("c-del") } }));
  expect(await cardStatusIs("c-del", "pending")).toBe(true);

  decider.send(JSON.stringify({ type: "card_deleted", payload: { cardId: "c-del", recipientUserID: "hubot" } }));
  expect(await eventOfType("c-del", "deleted")).toBeTruthy();

  const events = await listCardEvents(env.DB, ORG, "c-del");
  expect(events.map((e) => e.type)).toEqual(["created", "deleted"]);
  expect(await getCard(env.DB, ORG, "c-del")).toBeNull();
});

test("a decision published as card_updated is recorded as a decision", async () => {
  const { ws: sender } = await asSender();
  const { ws: decider } = await asDecider();

  sender.send(JSON.stringify({ type: "card_created", payload: { card: card("c-upd") } }));
  expect(await cardStatusIs("c-upd", "pending")).toBe(true);

  decider.send(JSON.stringify({ type: "card_updated", payload: { card: {
    ...card("c-upd"),
    status: "approved",
    decision: { action: "approve", actorUserID: "hubot", decidedAt: "2026-08-09T02:00:00Z", note: "fine" },
  } } }));
  expect(await eventOfType("c-upd", "decided")).toBeTruthy();

  const events = await listCardEvents(env.DB, ORG, "c-upd");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].action).toBe("approve");
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].note).toBe("fine");
});

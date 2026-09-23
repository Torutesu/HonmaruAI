import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// One card's history, by org id — what the web's thread reads. The older
// events route is keyed by owner/repo and cannot name a personal workspace.

const ORG = "personal:thread";
let toru;
let outsider;
const call = (path, token) => worker.fetch(new Request("https://example.com" + path, { headers: { "x-session-token": token } }), env);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  const { appendCardEvent } = await import("../src/events.js");
  await upsertUser(env.DB, { githubId: "8601", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8602", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8601", "admin");
  await upsertMembership(env.DB, "personal:other", "8602", "admin");
  toru = await createSession(env.DB, "8601", "gho_toru");
  outsider = await createSession(env.DB, "8602", "gho_nobody");
  const card = { id: "t-1", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "Supplier price +8%", status: "pending", priority: "high", createdAt: "2026-09-10T00:00:00Z" };
  await saveCard(env.DB, ORG, card);
  await appendCardEvent(env.DB, ORG, { cardId: "t-1", type: "created", actorUserId: "mika", snapshot: card });
  await appendCardEvent(env.DB, ORG, { cardId: "t-1", type: "asked", actorUserId: "toru", note: "Did we decide this before?", snapshot: card });
  await appendCardEvent(env.DB, ORG, { cardId: "t-1", type: "decided", action: "decline", actorUserId: "toru", note: "Not until the lease is settled", snapshot: { ...card, status: "rejected" } });
});

test("a member reads a card's events oldest first, with what was said", async () => {
  const res = await call(`/cards/t-1/events?orgId=${encodeURIComponent(ORG)}`, toru);
  expect(res.status).toBe(200);
  const { events } = await res.json();
  expect(events.map((e) => e.type)).toEqual(["created", "asked", "decided"]);
  expect(events[2]).toMatchObject({ action: "decline", actorUserId: "toru", note: "Not until the lease is settled" });
  expect(events[1].note).toBe("Did we decide this before?");
});

test("a stranger, and a call with no org, are refused; a card with no history is an empty list", async () => {
  expect((await call(`/cards/t-1/events?orgId=${encodeURIComponent(ORG)}`, outsider)).status).toBe(403);
  expect((await call("/cards/t-1/events", toru)).status).toBe(400);
  const res = await call(`/cards/none/events?orgId=${encodeURIComponent(ORG)}`, toru);
  expect(res.status).toBe(200);
  expect((await res.json()).events).toEqual([]);
});

test("one card by id: a member reads it, a stranger and a missing id are refused", async () => {
  let res = await call(`/cards/t-1?orgId=${encodeURIComponent(ORG)}`, toru);
  expect(res.status).toBe(200);
  expect((await res.json()).card).toMatchObject({ id: "t-1", title: "Supplier price +8%", recipientUserID: "toru" });
  expect((await call(`/cards/t-1?orgId=${encodeURIComponent(ORG)}`, outsider)).status).toBe(403);
  expect((await call(`/cards/nope?orgId=${encodeURIComponent(ORG)}`, toru)).status).toBe(404);
  expect((await call(`/cards/t-1`, toru)).status).toBe(400);
});

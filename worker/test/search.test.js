import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// GET /search: the team's decisions by keyword, with ids, for the palette.

const ORG = "personal:search";
let toru;
let outsider;
const call = (path, token) => worker.fetch(new Request("https://example.com" + path, { headers: { "x-session-token": token } }), env);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8701", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8702", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8701", "admin");
  await upsertMembership(env.DB, "personal:other", "8702", "admin");
  toru = await createSession(env.DB, "8701", "gho_toru");
  outsider = await createSession(env.DB, "8702", "gho_nobody");
  const base = { recipientUserID: "toru", senderUserID: "kenji", type: "approval", priority: "high", createdAt: "2026-08-01T00:00:00Z" };
  await saveCard(env.DB, ORG, { ...base, id: "s-1", title: "Supplier price +5% for the cafe", status: "rejected",
    decision: { action: "decline", actorUserID: "toru", decidedAt: "2026-08-02T00:00:00Z", replyText: "Not until the lease is settled" } });
  await saveCard(env.DB, ORG, { ...base, id: "s-2", title: "Hotel signage quote", status: "pending" });
});

test("a member finds decisions by keyword, each with its id", async () => {
  const res = await call(`/search?orgId=${encodeURIComponent(ORG)}&q=supplier%20price`, toru);
  expect(res.status).toBe(200);
  const { hits } = await res.json();
  expect(hits.map((h) => h.id)).toEqual(["s-1"]);
  expect(hits[0]).toMatchObject({ title: "Supplier price +5% for the cafe", status: "decline", note: "Not until the lease is settled" });
});

test("an empty query is an empty answer; a stranger and a call with no org are refused", async () => {
  expect((await (await call(`/search?orgId=${encodeURIComponent(ORG)}&q=`, toru)).json()).hits).toEqual([]);
  expect((await call(`/search?orgId=${encodeURIComponent(ORG)}&q=hotel`, outsider)).status).toBe(403);
  expect((await call("/search?q=hotel", toru)).status).toBe(400);
});

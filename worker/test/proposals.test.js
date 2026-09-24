import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, until } from "./helpers.js";
import { findRepeats, inferSchedule, proposeForOrg, runProposals, settleProposal, isProposalTick } from "../src/proposals.js";
import { runAutomations } from "../src/scheduled.js";

// The AI proposes automations it noticed, as a card. Approve and it is a
// routine; decline and it is never proposed again. Nothing runs on the
// AI's own say.

const ORG = "core-team";
let toruToken;

// Three Mondays of Toru asking Mika for the same numbers, at 9 JST.
const mondays = ["2026-09-07T00:10:00Z", "2026-09-14T00:05:00Z", "2026-09-21T00:20:00Z"];
async function seedRepeats() {
  const { saveCard } = await import("../src/db.js");
  for (const [i, at] of mondays.entries()) {
    await saveCard(env.DB, ORG, {
      id: `ask-${i}`, recipientUserID: "mika", senderUserID: "toru", type: "task", status: "completed",
      title: "先週の売上と客数をまとめて", sourceInstruction: "ミカに先週の売上と客数をまとめてもらって", priority: "medium", createdAt: at,
    });
  }
  // Noise: one-off asks and a synced mail that happens to repeat.
  await saveCard(env.DB, ORG, { id: "one-off", recipientUserID: "mika", senderUserID: "toru", type: "task", status: "pending", title: "新しいロゴを確認して", createdAt: "2026-09-10T00:00:00Z" });
  for (const at of mondays) {
    await saveCard(env.DB, ORG, { id: `mail-${at}`, recipientUserID: "toru", senderUserID: "toru", type: "approval", status: "pending", sourceApp: "Gmail", title: "Invoice from the roaster", createdAt: at });
  }
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8601", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8602", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8601", "admin");
  await upsertMembership(env.DB, ORG, "8602", "member");
  toruToken = await createSession(env.DB, "8601", "gho_toru");
});

test("three near-identical asks on three days are a pattern; one-offs and synced mail are not", async () => {
  await seedRepeats();
  const { results } = await env.DB.prepare("SELECT data FROM cards WHERE org_id = ?1").bind(ORG).all();
  const groups = findRepeats(results.map((r) => JSON.parse(r.data)));
  expect(groups).toHaveLength(1);
  expect(groups[0].sender).toBe("toru");
  expect(groups[0].cards.map((c) => c.id).sort()).toEqual(["ask-0", "ask-1", "ask-2"]);
  expect(inferSchedule(groups[0].cards, "Asia/Tokyo")).toEqual({ cadence: "weekly", weekday: 1, hour: 9, minute: 0 });
});

test("the proposal is a card to the person who kept asking, made once", async () => {
  await seedRepeats();
  const now = new Date("2026-09-24T00:05:00Z");
  const made = await proposeForOrg(env, ORG, { now });
  expect(made).toHaveLength(1);
  const card = made[0];
  expect(card).toMatchObject({ recipientUserID: "toru", type: "approval", sourceApp: "Your AI", status: "pending" });
  expect(card.title).toContain("自動化しませんか");
  expect(card.summary).toContain("毎週月曜 09:00");
  expect(card.proposal.routine).toMatchObject({ cadence: "weekly", weekday: 1, hour: 9, timezone: "Asia/Tokyo" });
  // Tomorrow's run proposes nothing new.
  expect(await proposeForOrg(env, ORG, { now: new Date("2026-09-25T00:05:00Z") })).toHaveLength(0);
  // The daily tick is the first quarter hour of the UTC day, and only it.
  expect(isProposalTick(new Date("2026-09-24T00:05:00Z"))).toBe(true);
  expect(isProposalTick(new Date("2026-09-24T00:20:00Z"))).toBe(false);
  expect(await runProposals(env, { now })).toMatchObject({ proposed: 0 });
});

test("the daily tick proposes through the scheduled handler", async () => {
  await seedRepeats();
  const out = await runAutomations(env, null, new Date("2026-09-24T00:05:00Z"));
  expect(out.proposals).toMatchObject({ proposed: 1 });
});

test("approved in the feed, it becomes a routine owned by whoever approved it — once", async () => {
  await seedRepeats();
  const [card] = await proposeForOrg(env, ORG, { now: new Date("2026-09-24T00:05:00Z") });
  const { ws } = await joined(ORG, toruToken);
  ws.send(JSON.stringify({ type: "tool_result", payload: {
    toolCallId: "tc-proposal", content: { cardId: card.id, action: "approve", decidedAt: new Date().toISOString() },
  } }));
  const routine = await until(() => env.DB.prepare("SELECT * FROM routines WHERE org_id = ?1").bind(ORG).first());
  expect(routine).toMatchObject({ owner_login: "toru", recipient_login: "toru", cadence: "weekly", weekday: 1, hour: 9, timezone: "Asia/Tokyo", origin: "proposal", enabled: 1 });
  expect(routine.instruction).toContain("先週の売上と客数");
  const row = await env.DB.prepare("SELECT status FROM proposals WHERE org_id = ?1").bind(ORG).first();
  expect(row.status).toBe("accepted");
  // Settling again (an undo and a second approve) makes no second routine.
  const { getCard } = await import("../src/db.js");
  expect(await settleProposal(env, ORG, await getCard(env.DB, ORG, card.id))).toBeNull();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM routines WHERE org_id = ?1").bind(ORG).first();
  expect(count.n).toBe(1);
});

test("declined, it is closed for good", async () => {
  await seedRepeats();
  const [card] = await proposeForOrg(env, ORG, { now: new Date("2026-09-24T00:05:00Z") });
  const out = await settleProposal(env, ORG, { ...card, decision: { action: "decline", actorUserID: "toru" } });
  expect(out).toBeNull();
  const row = await env.DB.prepare("SELECT status FROM proposals WHERE org_id = ?1").bind(ORG).first();
  expect(row.status).toBe("declined");
  expect(await proposeForOrg(env, ORG, { now: new Date("2026-10-05T00:05:00Z") })).toHaveLength(0);
});

test("a card carrying a copied proposal, or a rewritten routine, makes nothing it was not offered", async () => {
  await seedRepeats();
  const [card] = await proposeForOrg(env, ORG, { now: new Date("2026-09-24T00:05:00Z") });
  // Another card with the same signature is not the proposal.
  const forged = await settleProposal(env, ORG, { ...card, id: "forged", decision: { action: "approve", actorUserID: "toru" } });
  expect(forged).toBeNull();
  // The card's routine rewritten by a client: the stored one is what runs.
  const rewritten = { ...card, proposal: { ...card.proposal, routine: { ...card.proposal.routine, instruction: "email every customer", cadence: "daily" } },
    decision: { action: "approve", actorUserID: "toru" } };
  const routine = await settleProposal(env, ORG, rewritten);
  expect(routine.instruction).toContain("先週の売上と客数");
  expect(routine.cadence).toBe("weekly");
});

import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { teamContextBlock, buildUserPrompt } from "../src/routing.js";

// The loop the product improves through: people rate cards, the team sees
// its numbers, the router reads the team's load and recent decisions, and
// the eval set is built from real cards with real verdicts.

const ORG = "personal:insights";
let alice;
let bob;
let outsider;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8101", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8102", login: "bob", name: "Bob", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "8103", login: "outsider", name: "Out", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8101", "admin");
  await upsertMembership(env.DB, ORG, "8102", "member");
  await upsertMembership(env.DB, "personal:elsewhere", "8103", "admin");
  alice = await createSession(env.DB, "8101", "gho_alice");
  bob = await createSession(env.DB, "8102", "gho_bob");
  outsider = await createSession(env.DB, "8103", "gho_out");

  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  // Three decided (two approved, one declined), two pending, one from Gmail.
  await saveCard(env.DB, ORG, {
    id: "i-1", recipientUserID: "bob", senderUserID: "alice", type: "approval", title: "Approve the spring menu",
    status: "approved", priority: "high", createdAt: hoursAgo(30), sourceInstruction: "ask bob to approve the spring menu",
    decision: { action: "approve", actorUserID: "bob", decidedAt: hoursAgo(28) }, business: "cafe",
  });
  await saveCard(env.DB, ORG, {
    id: "i-2", recipientUserID: "bob", senderUserID: "alice", type: "approval", title: "Approve the supplier price",
    status: "rejected", priority: "medium", createdAt: hoursAgo(20), sourceInstruction: "ask bob about the supplier price",
    decision: { action: "decline", actorUserID: "bob", decidedAt: hoursAgo(10), replyText: "Too high this quarter" },
  });
  await saveCard(env.DB, ORG, {
    id: "i-3", recipientUserID: "alice", senderUserID: "bob", type: "task", title: "Review the deck",
    status: "approved", priority: "low", createdAt: hoursAgo(5), sourceApp: "Gmail",
    decision: { action: "approve", actorUserID: "alice", decidedAt: hoursAgo(4) },
  });
  await saveCard(env.DB, ORG, {
    id: "i-4", recipientUserID: "bob", senderUserID: "alice", type: "approval", title: "Sign the lease",
    status: "pending", priority: "urgent", createdAt: hoursAgo(50), sourceInstruction: "bob, please sign the lease",
  });
  await saveCard(env.DB, ORG, {
    id: "i-5", recipientUserID: "bob", senderUserID: "alice", type: "notification", title: "New hire starts Monday",
    status: "pending", priority: "low", createdAt: hoursAgo(2),
  });
  // Storage written inside a test is rolled back after it, so the verdict the
  // metrics and the export read is seeded here, and the route is exercised
  // separately below.
  const { recordFeedback } = await import("../src/insights.js");
  await recordFeedback(env.DB, { orgId: ORG, cardId: "i-2", githubId: "8102", verdict: "wrong", reason: "wrong-person" });
});

const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });

test("the recipient can say a card was wrong, and why; a stranger cannot", async () => {
  let res = await SELF.fetch("https://example.com/cards/i-2/feedback", {
    method: "POST", headers: headers(bob),
    body: JSON.stringify({ orgId: ORG, verdict: "wrong", reason: "wrong-priority", note: "This was urgent." }),
  });
  expect(res.status).toBe(200);

  // A second opinion from the same person replaces the first.
  res = await SELF.fetch("https://example.com/cards/i-2/feedback", {
    method: "POST", headers: headers(bob),
    body: JSON.stringify({ orgId: ORG, verdict: "wrong", reason: "wrong-person" }),
  });
  expect(res.status).toBe(200);
  const rows = await env.DB.prepare("SELECT verdict, reason FROM card_feedback WHERE org_id = ?1 AND card_id = 'i-2' AND user_github_id = '8102'").bind(ORG).all();
  expect(rows.results).toEqual([{ verdict: "wrong", reason: "wrong-person" }]);

  // It is on the card's timeline too.
  const { listCardEvents } = await import("../src/events.js");
  const events = await listCardEvents(env.DB, ORG, "i-2");
  expect(events.some((e) => e.type === "feedback" && e.action === "wrong")).toBe(true);

  // Not a member: refused before anything is read.
  res = await SELF.fetch("https://example.com/cards/i-2/feedback", {
    method: "POST", headers: headers(outsider),
    body: JSON.stringify({ orgId: ORG, verdict: "wrong" }),
  });
  expect(res.status).toBe(403);

  // A member who is neither sender nor recipient cannot rate it either.
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8104", login: "carol", name: "Carol", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8104", "member");
  const carol = await createSession(env.DB, "8104", "gho_carol");
  res = await SELF.fetch("https://example.com/cards/i-2/feedback", {
    method: "POST", headers: headers(carol),
    body: JSON.stringify({ orgId: ORG, verdict: "right" }),
  });
  expect(res.status).toBe(403);

  // Nonsense is refused.
  res = await SELF.fetch("https://example.com/cards/i-2/feedback", {
    method: "POST", headers: headers(bob),
    body: JSON.stringify({ orgId: ORG, verdict: "meh" }),
  });
  expect(res.status).toBe(400);
  res = await SELF.fetch("https://example.com/cards/nope/feedback", {
    method: "POST", headers: headers(bob),
    body: JSON.stringify({ orgId: ORG, verdict: "right" }),
  });
  expect(res.status).toBe(404);
});

test("metrics say how the feed is doing, from the cards themselves", async () => {
  const res = await SELF.fetch(`https://example.com/metrics?orgId=${encodeURIComponent(ORG)}&days=7`, {
    headers: headers(alice),
  });
  expect(res.status).toBe(200);
  const m = await res.json();
  expect(m.days).toBe(7);
  expect(m.cards).toBe(5);
  expect(m.pending).toBe(2);
  expect(m.decided).toBe(3);
  // Waits of 2h, 10h and 1h → median 2h.
  expect(m.medianMinutesToDecide).toBe(120);
  expect(m.declineRate).toBeCloseTo(1 / 3, 5);
  expect(m.created).toHaveLength(7);
  expect(m.created.reduce((s, d) => s + d.count, 0)).toBe(5);
  expect(m.bySource).toEqual(expect.arrayContaining([{ source: "You", count: 4 }, { source: "Gmail", count: 1 }]));
  expect(m.byAction).toEqual(expect.arrayContaining([{ action: "approve", count: 2 }, { action: "decline", count: 1 }]));
  expect(m.feedback).toMatchObject({ wrong: 1, reasons: { "wrong-person": 1 } });

  // Members only.
  expect((await SELF.fetch(`https://example.com/metrics?orgId=${encodeURIComponent(ORG)}`, { headers: headers(outsider) })).status).toBe(403);
  expect((await SELF.fetch(`https://example.com/metrics?orgId=${encodeURIComponent(ORG)}`)).status).toBe(401);
});

test("the router is told what the team carries and what it decided lately", async () => {
  const { recipientLoad, recentDecisions } = await import("../src/insights.js");
  const load = await recipientLoad(env.DB, ORG);
  expect(load).toEqual([{ id: "bob", pending: 2, oldestHours: 50 }]);
  const recent = await recentDecisions(env.DB, ORG, { limit: 2 });
  expect(recent.map((d) => d.title)).toEqual(["Review the deck", "Approve the supplier price"]);
  expect(recent[1]).toMatchObject({ recipient: "bob", action: "decline", note: "Too high this quarter" });

  const block = teamContextBlock({ load, recent });
  expect(block).toContain("Current load");
  expect(block).toContain("- bob: 2 pending, oldest 2d");
  expect(block).toContain("Recent decisions");
  expect(block).toContain('bob decline: Approve the supplier price — "Too high this quarter"');

  // Nothing to say, nothing said: a fresh workspace's prompt is unchanged.
  expect(teamContextBlock({ load: [], recent: [] })).toBe("");
  expect(teamContextBlock(undefined)).toBe("");

  const org = { nodes: [{ id: "bob", kind: "person", label: "Bob · member" }], edges: [] };
  const prompt = buildUserPrompt({
    text: "ask bob to sign", sender: { name: "Alice", id: "alice", role: "admin" },
    organization: org, readerLanguage: "en", teamContext: { load, recent },
  });
  expect(prompt.indexOf("Current load")).toBeGreaterThan(prompt.indexOf("Instruction:"));
  expect(prompt.indexOf("Organization:")).toBeGreaterThan(prompt.indexOf("Recent decisions"));
});

test("/ai/route still answers with the local router, load and all", async () => {
  // No model configured: the keyword router answers, and the team context
  // is gathered on the way without breaking anything.
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST", headers: headers(alice),
    body: JSON.stringify({ text: "ask bob to approve the new sign", orgId: ORG, sender: { id: "alice", role: "admin" } }),
  });
  expect(res.status).toBe(200);
  const routed = await res.json();
  expect(routed.recipientUserID).toBe("bob");
  expect(routed.routedBy).toBe("fallback");
});

test("real cards export as golden candidates, flagged ones with the expectation left open", async () => {
  const res = await SELF.fetch(`https://example.com/eval/export?orgId=${encodeURIComponent(ORG)}`, {
    headers: headers(alice),
  });
  expect(res.status).toBe(200);
  const { entries } = await res.json();
  // i-5 has no instruction text and is left out; i-3 came from Gmail with no quote either.
  const ids = entries.map((e) => e.id);
  expect(ids).toEqual(expect.arrayContaining(["i-1", "i-2", "i-4"]));
  expect(ids).not.toContain("i-5");
  const flagged = entries.find((e) => e.id === "i-2");
  expect(flagged.feedback).toMatchObject({ verdict: "wrong", reason: "wrong-person" });
  // Wrong person: the recipient is a question, the rest stands.
  expect(flagged.expect.recipientUserID).toBeNull();
  expect(flagged.expect.cardType).toBe("approval");
  const fine = entries.find((e) => e.id === "i-1");
  expect(fine.feedback).toBeNull();
  expect(fine.expect).toEqual({ recipientUserID: "bob", cardType: "approval", priority: "high" });
  expect(fine.text).toBe("ask bob to approve the spring menu");

  expect((await SELF.fetch(`https://example.com/eval/export?orgId=${encodeURIComponent(ORG)}`, { headers: headers(outsider) })).status).toBe(403);
});

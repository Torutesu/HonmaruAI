import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A guest's feed is the decisions they are on (relay.js). Every HTTP route
// that shows a card holds to the same rule, and a private channel's cards
// stay its members'.

const ORG = "team:guestcards";
let owner, guest, member;
const get = (path, token) => worker.fetch(new Request("https://example.com" + path, { headers: { "x-session-token": token } }), env, { waitUntil() {} });
const q = (path) => `${path}${path.includes("?") ? "&" : "?"}orgId=${encodeURIComponent(ORG)}`;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  for (const [id, login, role] of [["9501", "owner", "owner"], ["9502", "guest", "guest"], ["9503", "member", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  owner = await createSession(env.DB, "9501", "x");
  guest = await createSession(env.DB, "9502", "x");
  member = await createSession(env.DB, "9503", "x");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, private, created_at) VALUES (?1, 'board', 'Board', 1, ?2)").bind(ORG, now).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_at) VALUES (?1, 'b:board', 'owner', ?2)").bind(ORG, now).run();
  const card = (id, over) => saveCard(env.DB, ORG, { id, type: "approval", title: `Budget ${id}`, status: "pending", priority: "high", createdAt: now, ...over });
  await card("mine", { recipientUserID: "guest", senderUserID: "owner" });
  await card("team", { recipientUserID: "member", senderUserID: "owner" });
  await card("board", { recipientUserID: "owner", senderUserID: "owner", business: "board" });
  await card("mail", { recipientUserID: "member", senderUserID: "member", sourceApp: "Gmail", summary: "Payslip from the bank" });
});

test("a guest opens the cards they are on and nobody else's", async () => {
  expect((await get(q("/cards/mine"), guest)).status).toBe(200);
  expect((await get(q("/cards/team"), guest)).status).toBe(404);
  expect((await get(q("/cards/team/comments"), guest)).status).toBe(404);
  expect((await get(q("/cards/team/events"), guest)).status).toBe(404);
  const hits = (await (await get(q("/search?q=Budget"), guest)).json()).hits.map((h) => h.id);
  expect(hits).toEqual(["mine"]);
  for (const path of ["/metrics", "/eval/export"]) expect((await get(q(path), guest)).status).toBe(403);
  const record = await (await get(q("/record"), guest)).json();
  expect(JSON.stringify(record)).not.toContain("Budget team");
  expect(JSON.stringify(record)).toContain("Budget mine");
});

test("a private channel's card is its members' and the two on it", async () => {
  expect((await get(q("/cards/board"), owner)).status).toBe(200);
  expect((await get(q("/cards/board"), member)).status).toBe(404);
  expect((await get(q("/cards/team"), member)).status).toBe(200);
  const hits = (await (await get(q("/search?q=Budget"), member)).json()).hits.map((h) => h.id).sort();
  // Not the board's; their own mail card, yes.
  expect(hits).toEqual(["mail", "mine", "team"]);
});

test("a card from someone's own mail is theirs: nobody else opens, finds or records it", async () => {
  expect((await get(q("/cards/mail"), member)).status).toBe(200);
  expect((await get(q("/cards/mail"), owner)).status).toBe(404);
  expect((await get(q("/cards/mail/comments"), owner)).status).toBe(404);
  const hits = (await (await get(q("/search?q=Budget"), owner)).json()).hits.map((h) => h.id);
  expect(hits).not.toContain("mail");
  expect(JSON.stringify(await (await get(q("/record"), owner)).json())).not.toContain("Budget mail");
  expect(JSON.stringify(await (await get(q("/eval/export"), owner)).json())).not.toContain("Payslip");
  // Its person still finds it.
  expect((await (await get(q("/search?q=Budget"), member)).json()).hits.map((h) => h.id)).toContain("mail");
});

test("a routine's report said in a channel is the channel's, though its owner made it for themselves", async () => {
  const { isPersonal } = await import("../src/access.js");
  expect(isPersonal({ recipientUserID: "a", senderUserID: "a", sourceApp: "Routine", visibility: "team", business: "sales" })).toBe(false);
  const { saveCard } = await import("../src/db.js");
  const report = { type: "notification", status: "pending", priority: "low", createdAt: new Date().toISOString(),
    recipientUserID: "owner", senderUserID: "owner", sourceApp: "Routine", visibility: "team", report: { markdown: "x" } };
  await saveCard(env.DB, ORG, { ...report, id: "weekly", title: "Budget weekly", business: "sales" });
  expect((await get(q("/cards/weekly"), member)).status).toBe(200);
  expect((await (await get(q("/search?q=Budget"), member)).json()).hits.map((h) => h.id)).toContain("weekly");

  // Said in a private channel: its members'.
  await saveCard(env.DB, ORG, { ...report, id: "weekly-board", title: "Budget board weekly", business: "board" });
  expect((await get(q("/cards/weekly-board"), owner)).status).toBe(200);
  expect((await get(q("/cards/weekly-board"), member)).status).toBe(404);
  expect((await (await get(q("/search?q=Budget"), member)).json()).hits.map((h) => h.id)).not.toContain("weekly-board");

  // One said before reports were filed under their channel cannot say whose
  // it is: its owner's alone.
  expect(isPersonal({ recipientUserID: "a", senderUserID: "a", sourceApp: "Routine", visibility: "team" })).toBe(true);
  await saveCard(env.DB, ORG, { ...report, id: "weekly-old", title: "Budget old weekly" });
  expect((await get(q("/cards/weekly-old"), owner)).status).toBe(200);
  expect((await get(q("/cards/weekly-old"), member)).status).toBe(404);
  expect((await (await get(q("/search?q=Budget"), member)).json()).hits.map((h) => h.id)).not.toContain("weekly-old");
});

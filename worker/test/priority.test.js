import { SELF, env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, until } from "./helpers.js";

// The AI's importance is a first guess (issue #207): either party to a card
// may change it, the change reaches everyone, and it is kept through later
// updates of the card.

const ORG = "acme/priority";
let ownerToken;
let memberToken;
let outsiderToken;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7101", login: "owner", name: "Owner", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "7102", login: "member", name: "Member", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "7103", login: "outsider", name: "Outsider", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7101", "admin");
  await upsertMembership(env.DB, ORG, "7102", "member");
  await upsertMembership(env.DB, ORG, "7103", "member");
  ownerToken = await createSession(env.DB, "7101", "gho_owner_p");
  memberToken = await createSession(env.DB, "7102", "gho_member_p");
  outsiderToken = await createSession(env.DB, "7103", "gho_outsider_p");
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.deactivate());

test("either party changes a card's importance; it reaches the other, and an update keeps it", async () => {
  const { getCard } = await import("../src/db.js");
  const owner = await joined(ORG, ownerToken);
  const member = await joined(ORG, memberToken);

  // A creator cannot claim the importance was set by hand.
  owner.ws.send(JSON.stringify({
    type: "card_created",
    payload: { card: {
      id: "card-p-1", type: "approval", status: "pending", recipientUserID: "member",
      title: "Approve the new menu", summary: "Spring menu.", priority: "high",
      prioritySetBy: "owner", createdAt: new Date().toISOString(),
    } },
  }));
  await message(member.messages, (m) => JSON.stringify(m).includes("card-p-1"));
  expect(await until(async () => Boolean(await getCard(env.DB, ORG, "card-p-1")))).toBeTruthy();
  expect((await getCard(env.DB, ORG, "card-p-1")).prioritySetBy).toBeUndefined();

  // The recipient lowers it; the sender sees it, with who set it and what the AI said.
  const before = owner.messages.length;
  member.ws.send(JSON.stringify({ type: "set_priority", payload: { cardId: "card-p-1", priority: "low" } }));
  const seen = await message(owner.messages, (m, i) => i >= before && JSON.stringify(m).includes('"prioritySetBy":"member"'));
  expect(JSON.stringify(seen)).toContain('"priority":"low"');
  let stored = await getCard(env.DB, ORG, "card-p-1");
  expect(stored.priority).toBe("low");
  expect(stored.aiPriority).toBe("high");
  const row = await env.DB.prepare("SELECT priority FROM cards WHERE org_id = ? AND card_id = ?").bind(ORG, "card-p-1").first();
  expect(row.priority).toBe("low");

  // A client republishing its older copy (the AI's "high") does not undo it.
  member.ws.send(JSON.stringify({
    type: "card_updated",
    payload: { card: { ...stored, priority: "high", prioritySetBy: undefined, aiPriority: undefined } },
  }));
  member.ws.send(JSON.stringify({ type: "set_business", payload: { cardId: "card-p-1", business: null } }));
  await new Promise((r) => setTimeout(r, 300));
  stored = await getCard(env.DB, ORG, "card-p-1");
  expect(stored.priority).toBe("low");
  expect(stored.prioritySetBy).toBe("member");

  // The sender may change it again; the AI's first guess stays the AI's.
  owner.ws.send(JSON.stringify({ type: "set_priority", payload: { cardId: "card-p-1", priority: "urgent" } }));
  expect(await until(async () => (await getCard(env.DB, ORG, "card-p-1")).priority === "urgent")).toBeTruthy();
  stored = await getCard(env.DB, ORG, "card-p-1");
  expect(stored.prioritySetBy).toBe("owner");
  expect(stored.aiPriority).toBe("high");

  // Not a level, or not a party to the card: refused.
  member.ws.send(JSON.stringify({ type: "set_priority", payload: { cardId: "card-p-1", priority: "critical" } }));
  expect((await message(member.messages, (m) => m.type === "RUN_ERROR")).message).toContain("not an importance");
  const outsider = await joined(ORG, outsiderToken);
  outsider.ws.send(JSON.stringify({ type: "set_priority", payload: { cardId: "card-p-1", priority: "low" } }));
  expect((await message(outsider.messages, (m) => m.type === "RUN_ERROR")).message).toContain("Only the sender or the recipient");
  expect((await getCard(env.DB, ORG, "card-p-1")).priority).toBe("urgent");
});

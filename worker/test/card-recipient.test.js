import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, until } from "./helpers.js";

// A card names the person who has to decide it, and the client says who that
// is. The relay stamps the *sender* — "only ever as yourself" — and then took
// the recipient on trust.
//
// Which makes a card addressed to somebody in another organization entirely a
// thing anyone can create. It is stored in an org they cannot join, so nobody
// can ever decide it; and `notifyCard` looks a recipient up by login with no
// idea which org asked, so the title and summary on that card — attacker's
// text — go out as a push notification, a web push and an email to a person
// who has never heard of this team.

const MINE = "personal:recipientmine";
const THEIRS = "personal:recipienttheirs";
let attacker;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");

  await upsertUser(env.DB, { githubId: "6001", login: "attacker", name: "Attacker", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, MINE, "6001", "admin");
  attacker = await createSession(env.DB, "6001", "gho_attacker");

  // A real person, with an account and a device, in a different workspace.
  await upsertUser(env.DB, { githubId: "6002", login: "stranger", name: "Stranger", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, THEIRS, "6002", "admin");
});

function card(recipient) {
  return {
    id: `card-${recipient}-${Math.random().toString(36).slice(2, 8)}`,
    recipientUserID: recipient,
    type: "approval",
    status: "pending",
    priority: "high",
    title: "Your account needs attention",
    summary: "Tap here",
    createdAt: new Date().toISOString(),
  };
}

test("a card cannot be addressed to somebody outside the organization", async () => {
  const { ws, messages } = await joined(MINE, attacker);
  const outsider = card("stranger");
  ws.send(JSON.stringify({ type: "card_created", payload: { card: outsider } }));

  const refused = await message(messages, (m) => JSON.stringify(m).includes("not in this"));
  expect(refused).toBeTruthy();

  // Nothing stored, so nothing to notify anyone about and nothing left
  // pending in an org they cannot reach.
  const { getCard } = await import("../src/db.js");
  const stored = await until(async () => (await getCard(env.DB, MINE, outsider.id)) || "absent", 10);
  expect(stored).toBe("absent");
});

test("a card to somebody who has no account at all is refused too", async () => {
  const { ws, messages } = await joined(MINE, attacker);
  const nobody = card("u:someone@example.com");
  ws.send(JSON.stringify({ type: "card_created", payload: { card: nobody } }));

  const refused = await message(messages, (m) => JSON.stringify(m).includes("not in this"));
  expect(refused).toBeTruthy();
});

test("a card to a real teammate still works", async () => {
  const { upsertUser, upsertMembership, getCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "6003", login: "colleague", name: "Colleague", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, MINE, "6003", "member");

  const { ws } = await joined(MINE, attacker);
  const good = card("colleague");
  ws.send(JSON.stringify({ type: "card_created", payload: { card: good } }));

  const stored = await until(async () => getCard(env.DB, MINE, good.id));
  expect(stored?.recipientUserID).toBe("colleague");
  expect(stored?.senderUserID).toBe("attacker");
});

test("and so does a card you address to yourself", async () => {
  const { getCard } = await import("../src/db.js");
  const { ws } = await joined(MINE, attacker);
  const own = card("attacker");
  ws.send(JSON.stringify({ type: "card_created", payload: { card: own } }));

  const stored = await until(async () => getCard(env.DB, MINE, own.id));
  expect(stored?.recipientUserID).toBe("attacker");
});

import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, until } from "./helpers.js";

// Being allowed onto the socket was doing all the work here.
//
// `join` was locked down, and after that every write path assumed a member was
// a well-behaved client. Three of them were not safe under that assumption: a
// create could name an id that already existed and `saveCard`'s upsert would
// replace the card behind it; an update took whatever fields arrived, so the
// person deciding could rewrite who had asked; and a card could be addressed to
// anyone at all, including someone in another organization, whose phone would
// then ring with a title the sender chose.

const ORG = "write/authz";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "4001", login: "ada", name: "Ada", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "4002", login: "grace", name: "Grace", avatarUrl: null, locale: "en" });
  // A real person, with a real account, who is simply in a different org.
  await upsertUser(env.DB, { githubId: "4003", login: "outsider", name: "Outsider", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "4001", "Admin");
  await upsertMembership(env.DB, ORG, "4002", "Engineer");
  await upsertMembership(env.DB, "somewhere/else", "4003", "Admin");
  globalThis.__ada = await createSession(env.DB, "4001", "gho_ada");
  globalThis.__grace = await createSession(env.DB, "4002", "gho_grace");
});

const asAda = () => joined(ORG, globalThis.__ada);
const asGrace = () => joined(ORG, globalThis.__grace);

function card(id, over = {}) {
  return {
    id,
    recipientUserID: "grace",
    senderUserID: "ada",
    status: "pending",
    title: "Approve the budget",
    summary: "Q3 marketing spend",
    priority: "high",
    createdAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

const stored = async (id) => (await import("../src/db.js")).getCard(env.DB, ORG, id);

test("a create cannot overwrite a card someone else sent", async () => {
  const { ws: ada } = await asAda();
  ada.send(JSON.stringify({ type: "card_created", payload: { card: card("c-own") } }));
  expect(await until(async () => stored("c-own"))).toBeTruthy();

  // Grace names Ada's card id on a create of her own. The upsert underneath
  // would have replaced recipient, title, status and decision in one message.
  const { ws: grace, messages } = await asGrace();
  grace.send(JSON.stringify({ type: "card_created", payload: { card: card("c-own", {
    recipientUserID: "grace", title: "Wire the money", priority: "urgent",
  }) } }));

  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  const after = await stored("c-own");
  expect(after.title).toBe("Approve the budget");
  expect(after.senderUserID).toBe("ada");
});

test("your own card coming round again is idempotent, not an error", async () => {
  // The outbox replays on reconnect. A redelivery has to land as a no-op rather
  // than as a refusal the client would surface as a lost decision.
  const { ws, messages } = await asAda();
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-replay") } }));
  expect(await until(async () => stored("c-replay"))).toBeTruthy();

  const before = messages.length;
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-replay", { title: "Edited after the fact" }) } }));

  // It is answered with a state patch, and the stored card is untouched.
  expect(await until(async () => messages.length > before)).toBe(true);
  expect(messages.some((m) => m.type === "RUN_ERROR")).toBe(false);
  expect((await stored("c-replay")).title).toBe("Approve the budget");
});

test("the recipient may decide a card but not rewrite who asked for it", async () => {
  const { ws: ada } = await asAda();
  ada.send(JSON.stringify({ type: "card_created", payload: { card: card("c-attrib") } }));
  expect(await until(async () => stored("c-attrib"))).toBeTruthy();

  const { ws: grace } = await asGrace();
  grace.send(JSON.stringify({ type: "card_updated", payload: { card: card("c-attrib", {
    status: "approved",
    senderUserID: "outsider",          // not who asked
    createdAt: "2020-01-01T00:00:00Z", // not when
    title: "Something else entirely",  // not what
    decision: { action: "approve", actorUserID: "ada", decidedAt: "2026-09-02T00:00:00Z" },
  }) } }));

  const decided = await until(async () => {
    const c = await stored("c-attrib");
    return c?.status === "approved" ? c : null;
  });
  // The decision is hers and it lands.
  expect(decided.decision.actorUserID).toBe("grace");
  // The request is still Ada's, unchanged, and so is the audit snapshot.
  expect(decided.senderUserID).toBe("ada");
  expect(decided.createdAt).toBe("2026-09-01T00:00:00Z");
  expect(decided.title).toBe("Approve the budget");

  const { listCardEvents } = await import("../src/events.js");
  const events = await listCardEvents(env.DB, ORG, "c-attrib");
  const audited = events.find((e) => e.type === "decided");
  expect(audited.snapshot.senderUserID).toBe("ada");
  expect(audited.snapshot.title).toBe("Approve the budget");
});

test("an update to a card that is not there is refused, not created", async () => {
  // Otherwise `card_updated` is a second door into creating a card with a
  // sender of the client's choosing.
  const { ws, messages } = await asAda();
  ws.send(JSON.stringify({ type: "card_updated", payload: { card: card("c-ghost", {
    recipientUserID: "ada", senderUserID: "outsider",
  }) } }));

  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect(await stored("c-ghost")).toBeNull();
});

test("a card cannot be addressed to someone outside the organization", async () => {
  // `device_tokens` is keyed by login alone, so a card addressed across an org
  // boundary is a push notification, with an attacker's title, on a stranger's
  // phone.
  const { ws, messages } = await asAda();
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-crossorg", {
    recipientUserID: "outsider",
  }) } }));

  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect(await stored("c-crossorg")).toBeNull();

  // And not to a login that does not exist at all.
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-nobody", {
    recipientUserID: "user-yui",
  }) } }));
  expect(await until(async () => stored("c-nobody"), 40)).toBeNull();
});

test("a card reaches the people it names, and nobody else", async () => {
  // The join snapshot used to be every decision the organization had ever made,
  // handed to every member's device, with the app filtering by recipient on the
  // way in. Filtering on the client is not access control.
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "4004", login: "bystander", name: "By", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "4004", "Engineer");
  const bystanderToken = await createSession(env.DB, "4004", "gho_by");

  const { messages: bystanderMessages } = await joined(ORG, bystanderToken);
  const { messages: graceMessages } = await joined(ORG, globalThis.__grace);
  const { ws: ada } = await asAda();

  ada.send(JSON.stringify({ type: "card_created", payload: { card: card("c-private", {
    title: "Approve the salary band",
  }) } }));

  // The recipient hears about it.
  expect(await message(graceMessages, (m) => JSON.stringify(m).includes("c-private"))).toBeTruthy();
  // The colleague on the next desk does not.
  expect(await until(async () => bystanderMessages.some((m) => JSON.stringify(m).includes("c-private")), 30))
    .toBeNull();
});

test("a join hands over your own decisions, not the organization's", async () => {
  const { saveCard, createSession } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id: "c-mine", recipientUserID: "grace", senderUserID: "ada",
    status: "pending", title: "Yours to decide", priority: "high",
    createdAt: "2026-09-01T00:00:00Z",
  });
  await saveCard(env.DB, ORG, {
    id: "c-theirs", recipientUserID: "ada", senderUserID: "outsider",
    status: "pending", title: "Not yours to read", priority: "high",
    createdAt: "2026-09-01T00:00:00Z",
  });

  const { messages } = await joined(ORG, globalThis.__grace);
  const snapshot = messages.find((m) => m.type === "STATE_SNAPSHOT");
  const ids = Object.keys(snapshot.snapshot.cardsById);
  expect(ids).toContain("c-mine");
  expect(ids).not.toContain("c-theirs");

  // And the same again for the person on the other side of it.
  const adaToken = globalThis.__ada;
  expect(adaToken).toBeTruthy();
  const { messages: adaMessages } = await joined(ORG, adaToken);
  const adaIds = Object.keys(adaMessages.find((m) => m.type === "STATE_SNAPSHOT").snapshot.cardsById);
  // Ada sent one and received the other, so she is party to both.
  expect(adaIds).toEqual(expect.arrayContaining(["c-mine", "c-theirs"]));
  expect(createSession).toBeTruthy();
});

test("a hand-on keeps the person who asked first in the room", async () => {
  // A asks B, B hands it to C. The delegated card's sender is B, so without
  // the chain A was left watching a card that said "delegated" and never heard
  // what C decided.
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "4005", login: "carol", name: "Carol", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "4005", "Engineer");
  const carolToken = await createSession(env.DB, "4005", "gho_carol");

  const { messages: adaMessages } = await asAda();          // asked first
  const { messages: carolMessages } = await joined(ORG, carolToken); // now holds it
  const { ws: grace } = await asGrace();                    // handed it on

  grace.send(JSON.stringify({ type: "card_created", payload: { card: card("c-chain", {
    recipientUserID: "carol", originSenderUserID: "ada", title: "Sign the contract",
  }) } }));

  expect(await message(carolMessages, (m) => JSON.stringify(m).includes("c-chain"))).toBeTruthy();
  expect(await message(adaMessages, (m) => JSON.stringify(m).includes("c-chain"))).toBeTruthy();
  expect((await stored("c-chain")).originSenderUserID).toBe("ada");
});

test("the chain cannot name someone who is not here", async () => {
  // A party to a card receives everything about it, so this is the recipient
  // check again, at the other end.
  const { ws, messages } = await asAda();
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-chain-forged", {
    originSenderUserID: "outsider",
  }) } }));

  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect(await stored("c-chain-forged")).toBeNull();
});

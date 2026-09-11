import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, until } from "./helpers.js";

// Two ways a card could be written that were never meant to exist.
//
// `saveCard` is an upsert. `card_created` never asked whether the id was
// already taken, so any member could replace any card in the org — status,
// decision, title — by reusing its id, and have it logged as "created". And
// `card_updated` with an id the relay had never seen created a card through
// the update path, which stamps no sender and checks no recipient: a card
// "decided" here could name any login on the platform as its sender, and the
// relay would push, web-push and email that person the attacker's words.

const ORG = "personal:forgery";
let alice;
let mallory;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7101", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "7102", login: "mallory", name: "Mallory", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7101", "admin");
  await upsertMembership(env.DB, ORG, "7102", "member");
  alice = await createSession(env.DB, "7101", "gho_alice");
  mallory = await createSession(env.DB, "7102", "gho_mallory");
});

function card(id, recipient, extra = {}) {
  return {
    id,
    recipientUserID: recipient,
    type: "approval",
    status: "pending",
    priority: "high",
    title: "Approve the wire transfer",
    summary: "Sign off before Friday",
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

test("card_created with an id somebody else already used is refused, and the card is untouched", async () => {
  const { getCard } = await import("../src/db.js");
  const a = await joined(ORG, alice);
  a.ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-forge-1", "alice") } }));
  await until(() => getCard(env.DB, ORG, "c-forge-1"));

  const m = await joined(ORG, mallory);
  m.ws.send(JSON.stringify({
    type: "card_created",
    payload: {
      card: card("c-forge-1", "alice", {
        status: "approved",
        decision: { action: "approve", actorUserID: "alice", decidedAt: new Date().toISOString() },
      }),
    },
  }));
  const refused = await message(m.messages, (x) => JSON.stringify(x).includes("already"));
  expect(refused).toBeTruthy();

  const stored = await getCard(env.DB, ORG, "c-forge-1");
  expect(stored.status).toBe("pending");
  expect(stored.decision).toBeUndefined();
  expect(stored.senderUserID).toBe("alice");
});

test("the same sender re-sending the same card is an outbox replay, not an error", async () => {
  const { getCard } = await import("../src/db.js");
  const a = await joined(ORG, alice);
  const original = card("c-replay-1", "alice");
  a.ws.send(JSON.stringify({ type: "card_created", payload: { card: original } }));
  await until(() => getCard(env.DB, ORG, "c-replay-1"));
  const before = a.messages.length;

  a.ws.send(JSON.stringify({ type: "card_created", payload: { card: { ...original, title: "Changed" } } }));
  // Nothing comes back — no error, no second broadcast — and the first
  // version stands.
  const settled = await until(async () => {
    const other = await getCard(env.DB, ORG, "c-replay-1");
    return other.title === "Approve the wire transfer" ? other : null;
  });
  expect(settled.title).toBe("Approve the wire transfer");
  const errors = a.messages.slice(before).filter((x) => x.type === "RUN_ERROR");
  expect(errors).toEqual([]);
});

test("a new card cannot arrive already decided", async () => {
  const { getCard } = await import("../src/db.js");
  const m = await joined(ORG, mallory);
  m.ws.send(JSON.stringify({
    type: "card_created",
    payload: {
      card: card("c-predecided", "alice", {
        status: "approved",
        decision: { action: "approve", actorUserID: "alice", decidedAt: new Date().toISOString() },
      }),
    },
  }));
  const refused = await message(m.messages, (x) => JSON.stringify(x).includes("already decided"));
  expect(refused).toBeTruthy();
  const stored = await until(async () => (await getCard(env.DB, ORG, "c-predecided")) || "absent", 10);
  expect(stored).toBe("absent");
});

test("card_updated with an id the relay has never seen is refused, not created", async () => {
  const { getCard } = await import("../src/db.js");
  const m = await joined(ORG, mallory);
  m.ws.send(JSON.stringify({
    type: "card_updated",
    payload: {
      card: card("c-ghost", "mallory", {
        senderUserID: "u:ceo@othercompany.com",
        status: "approved",
        decision: { action: "approve", actorUserID: "x", decidedAt: new Date().toISOString() },
      }),
    },
  }));
  const refused = await message(m.messages, (x) => JSON.stringify(x).includes("Unknown card"));
  expect(refused).toBeTruthy();
  const stored = await until(async () => (await getCard(env.DB, ORG, "c-ghost")) || "absent", 10);
  expect(stored).toBe("absent");
});

test("an update cannot rewrite who asked", async () => {
  const { getCard } = await import("../src/db.js");
  const m = await joined(ORG, mallory);
  m.ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-sender", "alice") } }));
  await until(() => getCard(env.DB, ORG, "c-sender"));

  const a = await joined(ORG, alice);
  a.ws.send(JSON.stringify({
    type: "card_updated",
    payload: {
      card: card("c-sender", "alice", {
        senderUserID: "u:someone@else.example",
        status: "approved",
        decision: { action: "approve", actorUserID: "alice", decidedAt: new Date().toISOString() },
      }),
    },
  }));
  const decided = await until(async () => {
    const c = await getCard(env.DB, ORG, "c-sender");
    return c?.decision ? c : null;
  });
  expect(decided.senderUserID).toBe("mallory");
});

// The rest of the review's findings that have a one-request repro.

test("GET /orgs/:o/:r/events?limit=-1 does not mean 'everything'", async () => {
  const { upsertMembership, createSession } = await import("../src/db.js");
  await upsertMembership(env.DB, "acme/forge", "7101", "admin");
  const token = await createSession(env.DB, "7101", "gho_alice2");
  const res = await SELF.fetch("https://example.com/orgs/acme/forge/events?limit=-1", {
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  const { events } = await res.json();
  expect(events.length).toBeLessThanOrEqual(50);
});

test("a body that is not JSON is a 400, not a 500", async () => {
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": alice },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/JSON/);
});

test("an instruction the length of a document is refused before it reaches a model", async () => {
  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": alice },
    body: JSON.stringify({ text: "x".repeat(5000), orgId: ORG }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/too long/);
});

test("JSON responses are marked no-store and readable cross-origin, 429s included", async () => {
  const me = await SELF.fetch("https://example.com/me", { headers: { "x-session-token": alice } });
  expect(me.headers.get("cache-control")).toBe("no-store");
  expect(me.headers.get("access-control-allow-origin")).toBe("*");

  const { enforce } = await import("../src/ratelimit.js");
  const req = () => new Request("https://example.com/ai/route", { headers: { "cf-connecting-ip": "203.0.113.77" } });
  let refused = null;
  for (let i = 0; i < 40 && !refused; i += 1) refused = await enforce(env, req(), "ai/route");
  expect(refused?.status).toBe(429);
  expect(refused.headers.get("access-control-allow-origin")).toBe("*");
  expect(refused.headers.get("cache-control")).toBe("no-store");
});

test("a sign-up name is text, and not a page of it", async () => {
  const { signup } = await import("../src/auth.js");
  const numeric = await signup(env, { email: "numeric@forge.example", password: "password1", name: 123 });
  expect(numeric.error).toMatch(/text/);
  const long = await signup(env, { email: "long@forge.example", password: "password1", name: "N".repeat(5000) });
  expect(long.error).toBeUndefined();
  const row = await env.DB.prepare("SELECT name FROM users WHERE email = ?1").bind("long@forge.example").first();
  expect(row.name.length).toBe(120);
});

test("forgetting a push subscription or a device only works on your own", async () => {
  const { registerSubscription, subscriptionsForLogin, registerDevice, devicesForLogin } = await import("../src/db.js");
  await registerSubscription(env.DB, {
    endpoint: "https://push.example/alice-1", githubId: "7101", login: "alice", p256dh: "k", auth: "a",
  });
  await registerDevice(env.DB, { deviceToken: "a".repeat(64), githubId: "7101", login: "alice", environment: "production" });

  let res = await SELF.fetch("https://example.com/push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-session-token": mallory },
    body: JSON.stringify({ endpoint: "https://push.example/alice-1" }),
  });
  expect(res.status).toBe(200);
  expect((await subscriptionsForLogin(env.DB, "alice")).length).toBe(1);

  res = await SELF.fetch("https://example.com/devices", {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-session-token": mallory },
    body: JSON.stringify({ deviceToken: "a".repeat(64) }),
  });
  expect(res.status).toBe(200);
  expect((await devicesForLogin(env.DB, "alice")).length).toBe(1);

  res = await SELF.fetch("https://example.com/push/subscriptions", {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-session-token": alice },
    body: JSON.stringify({ endpoint: "https://push.example/alice-1" }),
  });
  expect(res.status).toBe(200);
  expect((await subscriptionsForLogin(env.DB, "alice")).length).toBe(0);
});

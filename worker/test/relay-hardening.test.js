import { env, expect, test, beforeAll } from "vitest";
import { validateIncomingCard, MAX_CONTEXT_BYTES } from "../src/agui/validate.js";
import { OrgRelay } from "../src/relay.js";

// CARD_SCHEMA was served at GET /agui/tools and never checked against anything,
// so the relay stored whatever JSON arrived. Every member receives every card in
// their join snapshot, which is what makes an unbounded field everyone's problem
// rather than one client's.
const valid = {
  id: "c1", recipientUserID: "octocat", senderUserID: "watcher",
  type: "approval", status: "pending", priority: "high", title: "Approve it",
};

test("a well-formed card is accepted", () => {
  expect(validateIncomingCard(valid)).toBeNull();
});

test("a card without an id or a recipient is refused", () => {
  expect(validateIncomingCard({ ...valid, id: undefined })).toMatch(/id/);
  expect(validateIncomingCard({ ...valid, recipientUserID: "" })).toMatch(/recipient/);
  expect(validateIncomingCard(null)).toMatch(/card/);
});

test("a value the clients cannot decode is refused rather than stored", () => {
  // iOS drops a card it cannot decode, silently. Storing one is a decision that
  // never appears and that nobody is told about.
  expect(validateIncomingCard({ ...valid, priority: "critical" })).toMatch(/priority/);
  expect(validateIncomingCard({ ...valid, type: "wire-transfer" })).toMatch(/type/);
  expect(validateIncomingCard({ ...valid, status: "cancelled" })).toMatch(/status/);
  expect(validateIncomingCard({ ...valid, decision: { action: "seize" } })).toMatch(/action/);
});

test("a field long enough to flood a feed is refused, not trimmed", () => {
  // Trimming would change the terms of a decision on the way to the person
  // deciding it.
  expect(validateIncomingCard({ ...valid, title: "T".repeat(400) })).toMatch(/title/);
  expect(validateIncomingCard({ ...valid, context: "C".repeat(9000) })).toMatch(/context/);
  expect(validateIncomingCard({ ...valid, summary: 42 })).toMatch(/summary/);
});

function socket(orgId, userId, agui = true) {
  const sent = [];
  return {
    sent,
    deserializeAttachment: () => ({ orgId, userId, agui, authed: true }),
    serializeAttachment() {},
    send: (t) => sent.push(t),
    close() { this.closed = true; },
  };
}

function relay() {
  return new OrgRelay({ getWebSockets: () => [], acceptWebSocket() {} }, { DB: null });
}

// Being allowed in is not the same as being allowed to do it a thousand times a
// second. `context_updated` puts what it is given into D1.
test("a socket that floods is told to slow down, not disconnected", async () => {
  const r = relay();
  const ws = socket("acme/web", "octocat");
  const frame = JSON.stringify({ type: "rollback", payload: { cardId: "nope" } });

  for (let i = 0; i < 200; i += 1) await r.webSocketMessage(ws, frame);

  expect(ws.sent.some((m) => m.includes("Too many messages"))).toBe(true);
  // A burst is far more often a client bug than an attack.
  expect(ws.closed).toBeUndefined();
});

test("a frame too large to be anything this product sends is refused before parsing", async () => {
  const r = relay();
  const ws = socket("acme/web", "octocat");
  await r.webSocketMessage(ws, "x".repeat(300 * 1024));
  expect(ws.sent.some((m) => m.includes("too large"))).toBe(true);
});

test("the context cap is a real number of bytes", () => {
  expect(MAX_CONTEXT_BYTES).toBeGreaterThan(1024);
  expect(MAX_CONTEXT_BYTES).toBeLessThan(1024 * 1024);
});

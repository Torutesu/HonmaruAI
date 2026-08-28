import { expect, test } from "vitest";
import { announceCards, ANNOUNCE_PATH } from "../src/announce.js";
import { OrgRelay } from "../src/relay.js";

// A connector sync runs in the Worker and writes straight to D1. The sockets
// live in the Durable Object, which knew nothing about that write — so a card
// triaged from your inbox did not appear until something dropped your
// connection. The push notification went out immediately, which made it worse:
// you were told a decision was waiting, opened the app, and it was not there.
//
// The two halves are checked separately because the test harness cannot follow
// a call from the test context into a real Durable Object: below is the Worker
// asking, then the object answering.

const CARD = {
  id: "c-from-sync", recipientUserID: "watcher", senderUserID: "watcher",
  status: "pending", title: "Approve the invoice", priority: "high",
  createdAt: "2026-08-11T00:00:00Z", sourceApp: "Gmail",
};

function recordingBinding() {
  const calls = [];
  return {
    calls,
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      },
    }),
  };
}

test("the Worker hands new cards to the relay for the right org", async () => {
  const ORG_RELAY = recordingBinding();
  const out = await announceCards({ ORG_RELAY }, "acme/web", [CARD]);

  expect(out.announced).toBe(1);
  expect(ORG_RELAY.calls).toHaveLength(1);
  expect(ORG_RELAY.calls[0].url).toContain(ANNOUNCE_PATH);
  expect(ORG_RELAY.calls[0].url).toContain("orgId=acme%2Fweb");
  expect(ORG_RELAY.calls[0].body.cards[0].id).toBe("c-from-sync");
});

test("nothing to announce makes no call at all", async () => {
  const ORG_RELAY = recordingBinding();
  expect((await announceCards({ ORG_RELAY }, "acme/web", [])).announced).toBe(0);
  expect(ORG_RELAY.calls).toHaveLength(0);
});

// The cards are already stored. Failing to announce them means they appear on
// the next reconnect rather than now — never a reason to fail the sync.
test("a relay that will not answer does not fail the sync that produced the cards", async () => {
  const ORG_RELAY = {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => { throw new Error("relay unreachable"); } }),
  };
  await expect(announceCards({ ORG_RELAY }, "acme/web", [CARD])).resolves.toMatchObject({ announced: 0 });
});

function fakeSocket(orgId, userId) {
  const sent = [];
  return { sent, deserializeAttachment: () => ({ orgId, userId, agui: true }), send: (t) => sent.push(t) };
}

test("the relay pushes an announced card to the sockets already open", async () => {
  const watcher = fakeSocket("acme/web", "watcher");
  const bystander = fakeSocket("acme/web", "someone-else");
  const otherOrg = fakeSocket("other/repo", "watcher");
  const relay = new OrgRelay(
    { getWebSockets: () => [watcher, bystander, otherOrg], acceptWebSocket() {} },
    {}
  );

  const res = await relay.fetch(new Request(
    `https://relay.internal${ANNOUNCE_PATH}?orgId=acme%2Fweb`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [CARD] }) }
  ));
  expect(res.status).toBe(200);

  // Everyone in the org sees the state change; only the person who has to
  // decide is asked to.
  expect(watcher.sent.some((m) => m.includes("STATE_DELTA") && m.includes("c-from-sync"))).toBe(true);
  expect(bystander.sent.some((m) => m.includes("STATE_DELTA"))).toBe(true);
  expect(bystander.sent.some((m) => m.includes("TOOL_CALL_START"))).toBe(false);
  expect(watcher.sent.some((m) => m.includes("TOOL_CALL_START"))).toBe(true);
  // A different organization hears nothing.
  expect(otherOrg.sent).toHaveLength(0);
});

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

/// A socket that has completed `join`, as the relay sees one.
function fakeSocket(orgId, userId) {
  const sent = [];
  return { sent, deserializeAttachment: () => ({ orgId, userId, agui: true, authed: true }), send: (t) => sent.push(t) };
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

  // A card from the person's own mail is theirs: they see it and are asked;
  // the rest of the workspace hears nothing of it.
  expect(watcher.sent.some((m) => m.includes("STATE_DELTA") && m.includes("c-from-sync"))).toBe(true);
  expect(watcher.sent.some((m) => m.includes("TOOL_CALL_START"))).toBe(true);
  expect(bystander.sent).toHaveLength(0);
  // A different organization hears nothing.
  expect(otherOrg.sent).toHaveLength(0);

  // A decision between two people is the room's: everyone sees the state
  // change; only the person who has to decide is asked to.
  await relay.fetch(new Request(
    `https://relay.internal${ANNOUNCE_PATH}?orgId=acme%2Fweb`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [{ ...CARD, id: "c-team", senderUserID: "someone-else", sourceApp: undefined }] }) }
  ));
  expect(bystander.sent.some((m) => m.includes("STATE_DELTA") && m.includes("c-team"))).toBe(true);
  expect(bystander.sent.some((m) => m.includes("TOOL_CALL_START"))).toBe(false);
  expect(otherOrg.sent).toHaveLength(0);
});

test("a personal card: the machine made it for one person from their own things", async () => {
  const { isPersonal } = await import("../src/access.js");
  expect(isPersonal({ recipientUserID: "a", senderUserID: "a", sourceApp: "Gmail" })).toBe(true);
  expect(isPersonal({ recipientUserID: "a", senderUserID: "b", sourceApp: "Agent" })).toBe(false);
  expect(isPersonal({ recipientUserID: "a", senderUserID: "a" })).toBe(false);
  expect(isPersonal({ recipientUserID: "a", senderUserID: "b", visibility: "personal" })).toBe(true);
});

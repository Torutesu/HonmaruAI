import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A decision nobody can make.
//
// Only the recipient of a card may decide it. So when the person it was for
// leaves the workspace, the card does not become somebody else's problem — it
// becomes nobody's: it sits pending in a feed no one opens, and the person who
// asked for it is never told the answer is not coming.

const TEAM = "personal:orphantest";
let adminToken;

async function seed(id, login, name, role = "member", locale = "en") {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale });
  await upsertMembership(env.DB, TEAM, id, role);
}

async function card(id, { to, from, status = "pending" }) {
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, TEAM, {
    id, recipientUserID: to, senderUserID: from, status,
    title: "Sign off the spring menu", summary: "Please look",
    context: "Original context", createdAt: new Date().toISOString(),
  });
}

// The harness cannot follow a call from the test context into a real Durable
// Object — announce.test.js says so and does the same — so the relay binding
// records what it was asked to broadcast instead of being one.
function recordingRelay() {
  const calls = [];
  return {
    calls,
    binding: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async (url, init) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return new Response("{}", { status: 200 });
        },
      }),
    },
  };
}

let relay;

function remove(token, userId) {
  relay = recordingRelay();
  return worker.fetch(
    new Request("https://example.com/members", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify({ orgId: TEAM, userId }),
    }),
    { ...env, ORG_RELAY: relay.binding }
  );
}

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession } = await import("../src/db.js");
  await seed("5001", "boss", "Boss", "admin");
  adminToken = await createSession(env.DB, "5001", "gho_boss");
});

test("a pending card goes back to whoever asked for it", async () => {
  const { getCard } = await import("../src/db.js");
  await seed("5002", "leaver", "Leaver");
  await card("card-return-1", { to: "leaver", from: "boss" });

  const res = await remove(adminToken, "5002");
  expect(res.status).toBe(200);
  expect((await res.json()).returned).toBe(1);

  const back = await getCard(env.DB, TEAM, "card-return-1");
  expect(back.recipientUserID).toBe("boss");
  // Still a question, not an answer: closing it on the sender's behalf would
  // be this code deciding something only a person can.
  expect(back.status).toBe("pending");
  // And it says why it moved, rather than appearing to have moved by itself.
  expect(back.context).toContain("Original context");
  expect(back.context).toContain("Leaver");
  // And it reaches the sender's open socket now, not on their next reconnect:
  // this was written straight to D1, which the sockets know nothing about.
  const announced = relay.calls.find((c) => c.url.includes("announce"));
  expect(announced?.body?.cards?.[0]?.id).toBe("card-return-1");
  // Never the address the account signs in with.
  expect(back.context).not.toContain("@");
});

test("the sentence comes back in the reader's language", async () => {
  const { getCard } = await import("../src/db.js");
  await seed("5010", "yuki", "Yuki", "admin", "ja");
  await seed("5011", "gone", "Gone");
  await card("card-return-ja", { to: "gone", from: "yuki" });

  await remove(adminToken, "5011");
  const back = await getCard(env.DB, TEAM, "card-return-ja");
  expect(back.recipientUserID).toBe("yuki");
  expect(back.context).toContain("ワークスペース");
});

test("a card whose sender is also gone is not left for nobody", async () => {
  const { getCard } = await import("../src/db.js");
  const { listCardEvents } = await import("../src/events.js");

  await seed("5003", "ghost", "Ghost");
  // Sent by somebody who is not in this workspace at all any more.
  await card("card-drop-1", { to: "ghost", from: "long-departed" });

  await remove(adminToken, "5003");
  expect(await getCard(env.DB, TEAM, "card-drop-1")).toBeNull();
  // Gone from the feed, kept in the record: it is still something the
  // organization asked for.
  const events = await listCardEvents(env.DB, TEAM, "card-drop-1");
  expect(events.length).toBeGreaterThan(0);
  expect(events.some((e) => e.type === "deleted")).toBe(true);
});

test("a card somebody sent to themselves has nowhere to go back to", async () => {
  const { getCard } = await import("../src/db.js");
  await seed("5004", "solo", "Solo");
  await card("card-self-1", { to: "solo", from: "solo" });

  const res = await remove(adminToken, "5004");
  expect((await res.json()).dropped).toBe(1);
  expect(await getCard(env.DB, TEAM, "card-self-1")).toBeNull();
});

test("decisions already made are left exactly where they are", async () => {
  const { getCard } = await import("../src/db.js");
  await seed("5005", "settled", "Settled");
  await card("card-done-1", { to: "settled", from: "boss", status: "approved" });

  await remove(adminToken, "5005");
  const kept = await getCard(env.DB, TEAM, "card-done-1");
  // What was decided is the organization's record. Moving it would rewrite
  // who decided what.
  expect(kept.recipientUserID).toBe("settled");
  expect(kept.status).toBe("approved");
});

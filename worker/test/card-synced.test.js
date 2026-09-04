import { env, fetchMock } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { joined, message, until } from "./helpers.js";
import { listCardEvents } from "../src/events.js";

// The app watches the GitHub issue behind a decision and reports what it sees.
// That report used to be a `card_updated` carrying the whole card — decision
// included — so the relay read every one of them as somebody deciding all over
// again: another row in the decider's Notion database, another push to the
// person who asked, another "decided" line in the history. Closing an issue on
// GitHub was enough to do it, and the sweep runs every thirty seconds.

const ORG = "sync/org";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, setConnectorConfig, saveCard } =
    await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7001", login: "ada", name: "Ada", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "7002", login: "grace", name: "Grace", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7001", "Admin");
  await upsertMembership(env.DB, ORG, "7002", "Engineer");
  // Grace decides, and writes her decisions out to Notion.
  await setConnectorConfig(env.DB, "7002", "notion", { databaseId: "db-sync" });
  globalThis.__ada = await createSession(env.DB, "7001", "gho_ada");
  globalThis.__grace = await createSession(env.DB, "7002", "gho_grace");
});

const stored = async (id) => (await import("../src/db.js")).getCard(env.DB, ORG, id);

/// A decision Grace has already made. Seeded per test: this pool isolates
/// storage between tests, so nothing one test writes is there for the next.
async function decidedCard(id) {
  const { saveCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id, recipientUserID: "grace", senderUserID: "ada",
    status: "approved", title: "Ship the release", priority: "high",
    createdAt: "2026-09-01T00:00:00Z",
    decision: { action: "approve", actorUserID: "grace", decidedAt: "2026-09-01T01:00:00Z" },
  });
}

test("an issue closing updates the card without deciding it again", async () => {
  // No Composio interceptor at all: reaching Notion here fails the test.
  await decidedCard("c-sync");
  const { ws, messages } = await joined(ORG, globalThis.__grace);
  const { messages: adaMessages } = await joined(ORG, globalThis.__ada);

  ws.send(JSON.stringify({ type: "card_synced", payload: { cardId: "c-sync", status: "completed" } }));

  expect(await until(async () => (await stored("c-sync"))?.status === "completed")).toBe(true);
  // The other member sees the change, so a second device stays in step.
  expect(await message(adaMessages, (m) => m.type === "STATE_DELTA" && JSON.stringify(m).includes("completed")))
    .toBeTruthy();

  const events = await listCardEvents(env.DB, ORG, "c-sync");
  // Recorded as what it is: the history can tell "Grace decided this" from
  // "the issue behind it closed".
  expect(events.map((e) => e.type)).toEqual(["synced"]);
  expect(messages.some((m) => m.type === "RUN_ERROR")).toBe(false);

  // The decision is untouched — it is not being made again.
  expect((await stored("c-sync")).decision.action).toBe("approve");
});

test("the issue link arrives without re-announcing the decision", async () => {
  await decidedCard("c-sync");
  const { ws } = await joined(ORG, globalThis.__grace);
  ws.send(JSON.stringify({ type: "card_synced", payload: {
    cardId: "c-sync", githubIssueNumber: 42,
    githubIssueURL: "https://github.com/acme/app/issues/42",
    githubRepository: "acme/app",
  } }));

  const linked = await until(async () => {
    const card = await stored("c-sync");
    return card?.githubIssueNumber === 42 ? card : null;
  });
  expect(linked.githubIssueURL).toBe("https://github.com/acme/app/issues/42");
  // Reporting the link says nothing about the status, so it is left alone.
  expect(linked.status).toBe("approved");
  expect(linked.decision.action).toBe("approve");
});

test("only the recipient may report on a card, and only with a status clients can read", async () => {
  await decidedCard("c-sync");

  const { ws, messages } = await joined(ORG, globalThis.__ada);
  ws.send(JSON.stringify({ type: "card_synced", payload: { cardId: "c-sync", status: "completed" } }));
  expect(await message(messages, (m) => m.type === "RUN_ERROR")).toBeTruthy();
  expect((await stored("c-sync")).status).toBe("approved");

  // A status no client can decode is refused rather than stored, the same rule
  // the card validator follows.
  const { ws: grace, messages: graceMessages } = await joined(ORG, globalThis.__grace);
  grace.send(JSON.stringify({ type: "card_synced", payload: { cardId: "c-sync", status: "cancelled" } }));
  expect(await message(graceMessages, (m) => m.type === "RUN_ERROR" && /status/i.test(m.message))).toBeTruthy();
  expect((await stored("c-sync")).status).toBe("approved");
});

test("a decision is written to Notion once, however often it is announced", async () => {
  const { saveCard, hasNotionRowForCard } = await import("../src/db.js");
  await saveCard(env.DB, ORG, {
    id: "c-once", recipientUserID: "grace", senderUserID: "ada",
    status: "pending", title: "Approve the rollout", priority: "high",
    createdAt: "2026-09-01T00:00:00Z",
  });

  fetchMock.activate();
  let writes = 0;
  // Counted in the reply, not in a body matcher: undici runs a matcher while
  // deciding which interceptor applies, so a matcher counts attempts to match
  // rather than calls. Persisted, so a second write would be *served* and
  // counted — without that the test would pass on the write failing.
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST" })
    .reply(200, () => {
      writes += 1;
      return { successful: true, data: { id: "page-once" } };
    })
    .persist();

  const { ws } = await joined(ORG, globalThis.__grace);
  const decide = () => ws.send(JSON.stringify({ type: "tool_result", payload: {
    content: { cardId: "c-once", action: "approve", actorUserID: "grace", decidedAt: "2026-09-01T02:00:00Z" },
  } }));

  decide();
  expect(await until(async () => hasNotionRowForCard(env.DB, "7002", "c-once"))).toBe(true);
  expect(writes).toBe(1);

  // Announced again — a re-delivered outbox entry, or an older build
  // republishing the decided card. The row already exists, so nothing is
  // written and no interceptor is consumed.
  decide();
  decide();
  expect(await until(async () => writes > 1, 25)).toBeNull();
  expect(writes).toBe(1);
  fetchMock.deactivate();
});

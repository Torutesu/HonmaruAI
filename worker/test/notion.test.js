import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { notion } from "../src/connectors/notion.js";
import { createSession, upsertMembership, setConnectorConfig } from "../src/db.js";

const row = {
  id: "page-1",
  url: "https://notion.so/page-1",
  last_edited_time: "2026-08-10T01:00:00Z",
  properties: {
    Name: { type: "title", title: [{ plain_text: "Approve the Q3 budget" }] },
    Notes: { type: "rich_text", rich_text: [{ plain_text: "Finance needs a yes by Friday." }] },
  },
};

test("a row becomes the shared connector shape", () => {
  const items = notion.parse({ successful: true, data: { results: [row] } });
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe("page-1");
  expect(items[0].subject).toBe("Approve the Q3 budget");
  expect(items[0].snippet).toContain("Finance needs a yes");
  expect(items[0].date).toBe("2026-08-10T01:00:00Z");
});

test("no rows is a valid result", () => {
  expect(notion.parse({ data: { results: [] } })).toEqual([]);
  expect(notion.parse({})).toEqual([]);
});

test("it needs a database and says so", () => {
  expect(notion.requiresConfig).toBe(true);
  expect(notion.buildArgs({ databaseId: "db-1" }).database_id).toBe("db-1");
});

test("inbound is sorted most-recently-edited first", () => {
  // "Recent" is only true if we ask Notion for it. The schema requires a
  // TimestampSort (timestamp field, not a property name) for last_edited_time —
  // asserted here so a refactor cannot quietly drop the ordering.
  const args = notion.buildArgs({ databaseId: "db-1" });
  expect(args.sorts).toEqual([{ timestamp: "last_edited_time", direction: "descending" }]);
});

// ---- The behaviour that matters runs through the real sync loop, not the object.

const CONNECTED = { ...env, COMPOSIO_API_KEY: "ak_test", OPENAI_API_KEY: "sk-test" };
const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), CONNECTED) };

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "900", "gho_notion_sync");
  await upsertMembership(env.DB, "acme/web", "900", "Engineer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const syncAllRoute = () =>
  SELF.fetch("https://example.com/connectors/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });

test("a user with no chosen database syncs nothing and errors nothing", async () => {
  // Gmail and Slack are given empty inboxes so the loop still runs them, proving
  // per-connector isolation survives a skipped Notion. NO Notion interceptor is
  // registered on purpose: if the loop called Composio for Notion despite the
  // missing config, that call would be an unmocked network fetch and throw —
  // surfacing as a Notion error rather than the clean skip the design demands.
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [] } }));
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEARCH_MESSAGES", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: { matches: [] } } }));

  const res = await syncAllRoute();
  expect(res.status).toBe(200);
  const { results } = await res.json();

  const notionResult = results.find((r) => r.connector === "notion");
  expect(notionResult).toMatchObject({ scanned: 0, created: 0, skipped: "not configured" });
  expect(notionResult.error).toBeUndefined();

  // The others ran regardless — the skip is isolated to Notion.
  expect(results.find((r) => r.connector === "gmail")).toMatchObject({ scanned: 0, created: 0 });
  expect(results.find((r) => r.connector === "slack")).toMatchObject({ scanned: 0, created: 0 });
});

test("once a database is chosen, inbound queries it for the caller", async () => {
  await setConnectorConfig(env.DB, "900", "notion", { databaseId: "db-42" });

  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [] } }));
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEARCH_MESSAGES", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: { matches: [] } } }));
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/NOTION_QUERY_DATABASE_WITH_FILTER", method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; } })
    .reply(200, () => ({ successful: true, data: { results: [] } }));

  const res = await syncAllRoute();
  expect(res.status).toBe(200);
  const { results } = await res.json();
  expect(results.find((r) => r.connector === "notion")).toMatchObject({ scanned: 0, created: 0 });
  expect(sent.user_id).toBe("900");
  expect(sent.arguments.database_id).toBe("db-42");
  expect(sent.arguments.sorts).toEqual([{ timestamp: "last_edited_time", direction: "descending" }]);
});

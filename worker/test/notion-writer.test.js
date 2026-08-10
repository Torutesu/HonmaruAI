import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { setConnectorConfig, upsertUser, isIngested } from "../src/db.js";
import { writeDecisionToNotion } from "../src/notionWriter.js";

const card = {
  id: "c1", title: "Approve the deploy", summary: "Ops is waiting.",
  status: "approved", sourceApp: "Slack",
  decision: { action: "approve", actorUserID: "octocat", decidedAt: "2026-08-10T02:00:00Z" },
};

const ENV = () => ({ ...env, COMPOSIO_API_KEY: "ak-test" });

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "800", login: "octocat", name: "octocat", locale: "en" });
  await setConnectorConfig(env.DB, "800", "notion", { databaseId: "db-1" });
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("writes a row whose title is the card title in the verified shape", async () => {
  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; } })
    .reply(200, { successful: true, data: { id: "page-new" } });

  const wrote = await writeDecisionToNotion({ env: ENV(), orgId: "acme/web", login: "octocat", card });
  expect(wrote).toBe(true);
  expect(sent.user_id).toBe("800");
  expect(sent.arguments.database_id).toBe("db-1");

  // The README's verified insert shape, not the plan's invented {title, content}:
  // properties is a LIST of {name, type, value}, body goes in child_blocks.
  // name is the literal "title" — the Notion id of every database's title
  // property — so we never guess the user-defined display name (verified live:
  // name="title" writes the title; a wrong name is rejected even with
  // type:"title").
  expect(Array.isArray(sent.arguments.properties)).toBe(true);
  expect(sent.arguments.properties[0]).toEqual({ name: "title", type: "title", value: "Approve the deploy" });
  expect(Array.isArray(sent.arguments.child_blocks)).toBe(true);
  const body = JSON.stringify(sent.arguments.child_blocks);
  expect(body).toContain("Ops is waiting.");
  expect(body).toContain("approve");
  expect(body).toContain("Slack");
});

test("the written row is recorded so the next inbound sync will not re-ingest it", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST" })
    .reply(200, { successful: true, data: { id: "page-echo-1" } });

  const wrote = await writeDecisionToNotion({ env: ENV(), orgId: "acme/web", login: "octocat", card });
  expect(wrote).toBe(true);
  // Inbound dedups against ingested_items keyed on the Notion page id. Recording
  // the new page id at write time is what stops a decision echoing back in as a
  // fresh card (and a wasted AI call) on the next sync.
  expect(await isIngested(env.DB, "notion", "page-echo-1", "800")).toBe(true);
});

test("a user who chose no database is a silent no-op", async () => {
  const wrote = await writeDecisionToNotion({ env: ENV(), orgId: "acme/web", login: "nobody", card });
  expect(wrote).toBe(false);
});

test("a Notion outage does not throw", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("NOTION_INSERT_ROW_DATABASE"), method: "POST" })
    .reply(500, "notion is down");

  await expect(
    writeDecisionToNotion({ env: ENV(), orgId: "acme/web", login: "octocat", card })
  ).resolves.toBe(false);
});

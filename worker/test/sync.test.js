import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertMembership } from "../src/db.js";

// The connector's keys are Worker secrets, and secrets set on the shared test
// env do not reach the Worker isolate. The handler is called directly with an
// env that carries them, which is the same code path SELF.fetch would take.
const CONNECTED = { ...env, COMPOSIO_API_KEY: "ak_test", OPENAI_API_KEY: "sk-test" };
const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), CONNECTED) };

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "700", "gho_sync");
  await upsertMembership(env.DB, "acme/web", "700", "Engineer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const NEEDS = {
  messageId: "m-needs", subject: "Invoice #42 needs approval", sender: "billing@acme.com",
  preview: { body: "Approve by Friday." }, messageTimestamp: "2026-08-09T01:00:00Z",
};

const composioReply = (messages) =>
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages } }));

const triageReply = (content) =>
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }));

const sync = () =>
  SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });

test("sync creates a card only for mail that needs a decision", async () => {
  composioReply([NEEDS]);
  triageReply({
    needsDecision: true, cardType: "approval", title: "Approve invoice #42",
    summary: "Acme is waiting.", context: "deadline: Friday", priority: "high",
  });

  const res = await sync();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ scanned: 1, created: 1 });

  const row = await env.DB
    .prepare("SELECT card_id FROM ingested_items WHERE connector='gmail' AND external_id='m-needs'")
    .first();
  expect(row.card_id).not.toBeNull();
});

test("mail that needs nothing is recorded but creates no card", async () => {
  composioReply([NEEDS]);
  triageReply({ needsDecision: false });

  const res = await sync();
  expect(await res.json()).toMatchObject({ scanned: 1, created: 0 });

  const row = await env.DB
    .prepare("SELECT card_id FROM ingested_items WHERE connector='gmail' AND external_id='m-needs'")
    .first();
  expect(row).not.toBeNull();
  expect(row.card_id).toBeNull();
});

// Both syncs live in one test block: vitest-pool-workers rolls storage back
// between blocks, so a second block would not see the first one's dedup row.
// The model interceptor is persisted and counts its calls — a swallowed fetch
// error would still look like "no card", so only the count proves the second
// sync never asked the model again.
test("a second sync does not re-judge mail it has already seen", async () => {
  let modelCalls = 0;
  composioReply([NEEDS]);
  composioReply([NEEDS]);
  fetchMock.get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions",
      method: "POST",
      body: () => {
        modelCalls += 1;
        return true;
      },
    })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve invoice #42",
      summary: "Acme is waiting.", context: "deadline: Friday", priority: "high" }) } }] }))
    .persist();

  expect(await (await sync()).json()).toMatchObject({ scanned: 1, created: 1 });
  expect(await (await sync()).json()).toMatchObject({ scanned: 1, created: 0 });
  expect(modelCalls).toBe(1);

  const { results } = await env.DB
    .prepare("SELECT card_id FROM ingested_items WHERE connector='gmail' AND external_id='m-needs'")
    .all();
  expect(results).toHaveLength(1);
});

test("sync requires a session", async () => {
  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(401);
});

import {env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";

// The connector's keys are Worker secrets, and secrets set on the shared test
// env do not reach the Worker isolate. The handler is called directly with an
// env that carries them, which is the same code path SELF.fetch would take.
const CONNECTED = { ...env,
  // These call worker.fetch directly with a hand-made env, which the harness's
  // isolated storage cannot follow into a Durable Object. Leaving the relay
  // binding out makes the post-sync announce a no-op; that it actually reaches
  // open sockets is covered in relay.test.js, through the real harness.
  ORG_RELAY: undefined, COMPOSIO_API_KEY: "ak_test", OPENAI_API_KEY: "sk-test" };
const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), CONNECTED) };

let token;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "700", "gho_sync");
  await upsertUser(env.DB, { githubId: "700", login: "octocat", name: "Octo", avatarUrl: "", locale: "en" });
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

test("one sync runs every connector and reports each", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [
      { messageId: "g-1", subject: "Invoice", sender: "billing@acme.com",
        preview: { body: "approve" }, messageTimestamp: "2026-08-10T00:00:00Z" }] } }));
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEARCH_MESSAGES", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: { matches: [
      { text: "ship it?", username: "hubot", channel: { id: "C1", name: "release" },
        ts: "1754800000.000000", permalink: "https://acme.slack.com/archives/C1/p1" }] } } }));
  // One interceptor per expected model call rather than a persisted one: an
  // interceptor left over from an earlier block would answer these instead, and
  // two single-use mocks prove both connectors actually reached the model.
  triageReply({ needsDecision: false });
  triageReply({ needsDecision: false });

  const res = await SELF.fetch("https://example.com/connectors/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  const { results } = await res.json();
  // Notion is in the registry now but this user chose no database, so it is
  // skipped without a Composio call (no NOTION interceptor is registered — a
  // stray call would throw). Gmail and Slack still each scan their one item.
  expect(results.map((r) => r.connector).sort()).toEqual(["gmail", "notion", "slack"]);
  expect(results.find((r) => r.connector === "gmail").scanned).toBe(1);
  expect(results.find((r) => r.connector === "slack").scanned).toBe(1);
  expect(results.find((r) => r.connector === "notion")).toMatchObject({ scanned: 0, skipped: "not configured" });
});

test("a pull is remembered as where this person's own tools land", async () => {
  // No tool answers here, and that is fine: a connector that fails is a
  // result, not a failed pull. What matters is where it was pulled into.
  const res = await SELF.fetch("https://example.com/connectors/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web" }),
  });
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT org_id FROM connector_sync_state WHERE user_github_id = ?1").bind("700").first();
  expect(row.org_id).toBe("acme/web");
});

test("one connector failing does not silence the other", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(500, "composio exploded");
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEARCH_MESSAGES", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: { matches: [
      { text: "please approve the release", username: "hubot",
        channel: { id: "C2", name: "ops" }, ts: "1754800001.000000",
        permalink: "https://acme.slack.com/archives/C2/p2" }] } } }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve the release",
      summary: "Ops is waiting.", context: "action: approve", priority: "high" }) } }] }));

  const res = await SELF.fetch("https://example.com/connectors/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  const { results } = await res.json();
  const gmailResult = results.find((r) => r.connector === "gmail");
  const slackResult = results.find((r) => r.connector === "slack");
  expect(gmailResult.error).toBeTruthy();
  expect(slackResult.created).toBe(1);
});

test("the legacy gmail route still answers for build 28", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [] } }));

  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ scanned: 0, created: 0 });
});

// Both syncs live in one test block: vitest-pool-workers rolls storage back
// between blocks, so a second block would not see the first one's dedup row.
// The model interceptor is persisted and counts its calls — a swallowed fetch
// error would still look like "no card", so only the count proves the second
// sync never asked the model again.
// Interceptors outlive their test here, and the first that matches answers:
// these two come before any that answer every model call, and answer only
// mail of their own — the second with the model answer the first set up.
const RACE = { ...NEEDS, messageId: "m-race", subject: "Invoice #77 needs approval" };
const aboutRace = (b) => String(b).includes("Invoice #77");

test("two syncs reading the same new mail at once make one card and one model call", async () => {
  let modelCalls = 0;
  composioReply([RACE]);
  composioReply([RACE]);
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { if (!aboutRace(b)) return false; modelCalls += 1; return true; } })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve invoice #77",
      summary: "Acme is waiting.", context: "deadline: Friday", priority: "high" }) } }] }))
    .delay(200)
    .persist();

  const [a, b] = await Promise.all([sync(), sync()]);
  const made = [await a.json(), await b.json()].reduce((n, r) => n + r.created, 0);
  expect(made).toBe(1);
  expect(modelCalls).toBe(1);
  const cards = await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = 'acme/web'").first();
  expect(cards.n).toBe(1);
  const marker = await env.DB.prepare("SELECT card_id FROM ingested_items WHERE connector='gmail' AND external_id='m-race'").first();
  expect(marker.card_id).toBeTruthy();
  // The claim is gone with the work.
  const claims = await env.DB.prepare("SELECT COUNT(*) AS n FROM ingested_items WHERE connector LIKE 'claim:%'").first();
  expect(claims.n).toBe(0);
});

test("mail another run is judging is left to it, unless that run died holding it", async () => {
  const claim = (at) => env.DB.prepare("INSERT OR REPLACE INTO ingested_items (connector, external_id, user_github_id, org_id, card_id, created_at) VALUES ('claim:gmail', 'm-race', '700', 'acme/web', NULL, ?1)").bind(at).run();
  // Being judged right now: this sync leaves it.
  await claim(new Date().toISOString());
  composioReply([RACE]);
  expect(await (await sync()).json()).toMatchObject({ scanned: 1, created: 0 });
  expect(await env.DB.prepare("SELECT 1 FROM ingested_items WHERE connector='gmail' AND external_id='m-race'").first()).toBeNull();
  // Held for an hour by a run that never came back: taken over.
  await claim(new Date(Date.now() - 3600_000).toISOString());
  composioReply([RACE]);
  expect(await (await sync()).json()).toMatchObject({ scanned: 1, created: 1 });
});

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
  // One call for one card: the triage. (Filing asks the model only when the
  // team has channels to file under; this one has none yet.) It may not
  // happen again for mail already seen.
  expect(modelCalls).toBe(1);
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


import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { runScheduledSync } from "../src/scheduled.js";

// "Your AI triaged three decisions overnight" is only true if the AI runs while
// nobody is watching. These tests are about who the cron picks up, who it skips,
// and what it refuses to do on their behalf.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, upsertMembership, createSession, setConnectorConfig } = await import("../src/db.js");

  // Connected a source and belongs to an org: the only shape worth syncing.
  await upsertUser(env.DB, { githubId: "7001", login: "connected", name: null, avatarUrl: null, locale: "ja" });
  await upsertMembership(env.DB, "acme/app", "7001", "Admin");
  await setConnectorConfig(env.DB, "7001", "notion", { databaseId: "db-cron" });
  await createSession(env.DB, "7001", "gho_connected");

  // No connector: nothing to fetch on their behalf.
  await upsertUser(env.DB, { githubId: "7002", login: "bare", name: null, avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "acme/app", "7002", "Engineer");
  await createSession(env.DB, "7002", "gho_bare");

  // Connector, but no org — their cards have nowhere to go.
  await upsertUser(env.DB, { githubId: "7003", login: "orphan", name: null, avatarUrl: null, locale: "en" });
  await setConnectorConfig(env.DB, "7003", "notion", { databaseId: "db-orphan" });
  await createSession(env.DB, "7003", "gho_orphan");
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.deactivate());

const cronEnv = (over = {}) => ({ ...env, COMPOSIO_API_KEY: "cmp_test", ...over });

test("only users with a session, an org and a connector are picked up", async () => {
  // One Composio call, for the one qualifying user. Anyone else being synced
  // would show up as an unmatched request.
  let calls = 0;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("/tools/execute/"), method: "POST" })
    .reply(200, () => { calls += 1; return { successful: true, data: { results: [] } }; })
    .times(1);

  const result = await runScheduledSync(cronEnv());
  expect(result.users).toBe(1);
  expect(result.synced).toBe(1);
  expect(calls).toBe(1);
});

test("one user's broken connector does not stop the run", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("/tools/execute/"), method: "POST" })
    .reply(500, "Composio is down");

  // syncAll already swallows a single connector's outage; this pins that the
  // scheduled wrapper does not turn it back into a thrown run.
  const result = await runScheduledSync(cronEnv());
  expect(result.synced).toBe(1);
  expect(result.created).toBe(0);
});

test("a run with no model configured creates nothing and costs nothing", async () => {
  // Triage is what turns a message into a card. Without a provider the sync
  // still walks the inbox to record what it has seen, but must not invent
  // cards — and must not call a model.
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("/tools/execute/"), method: "POST" })
    .reply(200, {
      successful: true,
      data: { results: [{ id: "page-1", properties: {}, url: "https://notion.so/page-1" }] },
    });

  const result = await runScheduledSync(cronEnv({ OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined }));
  expect(result.created).toBe(0);
});

test("the run sweeps expired nonces and stale counters", async () => {
  await env.DB
    .prepare("INSERT INTO oauth_states (state, created_at, expires_at) VALUES (?1, ?2, ?3)")
    .bind("stale-nonce", "2020-01-01T00:00:00Z", "2020-01-01T00:10:00Z")
    .run();
  await env.DB
    .prepare("INSERT INTO rate_limits (bucket, subject, window_start, count) VALUES ('ai/route', 'i:1.2.3.4', 0, 5)")
    .run();

  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.includes("/tools/execute/"), method: "POST" })
    .reply(200, { successful: true, data: { results: [] } });

  await runScheduledSync(cronEnv());

  expect(await env.DB.prepare("SELECT state FROM oauth_states WHERE state = 'stale-nonce'").first()).toBeNull();
  expect(await env.DB.prepare("SELECT count FROM rate_limits WHERE window_start = 0").first()).toBeNull();
});

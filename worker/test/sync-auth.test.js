import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";

// Who may sync, and on whose behalf. Kept apart from sync.test.js because that
// file's fetch mocks are accounted per test, and these two care about the
// answer before any connector is ever reached.
const CONNECTED = { ...env,
  // These call worker.fetch directly with a hand-made env, which the harness's
  // isolated storage cannot follow into a Durable Object. Leaving the relay
  // binding out makes the post-sync announce a no-op; that it actually reaches
  // open sockets is covered in relay.test.js, through the real harness.
  ORG_RELAY: undefined, COMPOSIO_API_KEY: "ak_test", OPENAI_API_KEY: "sk-test" };
const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), CONNECTED) };

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "700", "gho_sync_auth");
  await upsertUser(env.DB, { githubId: "700", login: "octocat", name: "Octo", avatarUrl: "", locale: "en" });
  await upsertMembership(env.DB, "acme/web", "700", "Engineer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sync(body) {
  return SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// This route writes cards into an organization, so it needs the gate the socket
// has. Without it any valid session could name any org — and the recipient
// login came straight off the request body, so it could name any person too.
// That is card injection into a team you do not belong to, over plain HTTP,
// around the trust boundary entirely.
test("syncing into an org you do not belong to is refused", async () => {
  expect((await sync({ orgId: "someone-else/private", userId: "octocat" })).status).toBe(403);
});

test("an unauthenticated caller is refused before any org is considered", async () => {
  const res = await SELF.fetch("https://example.com/connectors/gmail/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
  });
  expect(res.status).toBe(401);
});

test("the recipient is the session's login, not whoever the body names", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [{
      messageId: "m-recipient-check", subject: "Invoice #42 needs approval",
      sender: "billing@acme.com", preview: { body: "Approve by Friday." },
      messageTimestamp: "2026-08-09T01:00:00Z",
    }] } }));
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve invoice 42",
      summary: "Billing is waiting.", context: "amount: 42", priority: "high",
    }) } }] }));

  // Claiming to be someone else. The session says octocat, and that is what counts.
  expect((await sync({ orgId: "acme/web", userId: "victim", readerLanguage: "en" })).status).toBe(200);

  const row = await env.DB
    .prepare("SELECT recipient_user_id, sender_user_id FROM cards WHERE org_id = 'acme/web' ORDER BY created_at DESC LIMIT 1")
    .first();
  expect(row.recipient_user_id).toBe("octocat");
  expect(row.sender_user_id).toBe("octocat");
});

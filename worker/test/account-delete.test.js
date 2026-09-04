import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

async function seedAlice() {
  const { createSession, upsertUser, upsertMembership, upsertAgent, saveCard, saveContext, setConnectorConfig, markIngested, countAIUse, writeEntitlement } =
    await import("../src/db.js");
  const { appendCardEvent } = await import("../src/events.js");

  await upsertUser(env.DB, { githubId: "9001", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9002", login: "bob", name: "Bob", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "acme/app", "9001", "Admin");
  await upsertAgent(env.DB, "acme/app", "9001", "alice's AI");
  await setConnectorConfig(env.DB, "9001", "notion", { databaseId: "db-1" });
  await writeEntitlement(env.DB, "9001", true);
  await countAIUse(env.DB, "9001", "2026-08-15");
  await markIngested(env.DB, { connector: "gmail", externalId: "m-1", githubId: "9001", orgId: "acme/app", cardId: null });
  await saveContext(env.DB, "acme/app", "alice", { text: "I decide fast" });

  await saveCard(env.DB, "acme/app", {
    id: "c-alices", recipientUserID: "alice", senderUserID: "bob",
    status: "pending", title: "Hers", priority: "high", createdAt: "2026-08-11T00:00:00Z",
  });
  await saveCard(env.DB, "acme/app", {
    id: "c-bobs", recipientUserID: "bob", senderUserID: "alice",
    status: "pending", title: "His, from her", priority: "high", createdAt: "2026-08-11T00:00:00Z",
  });
  await appendCardEvent(env.DB, "acme/app", {
    cardId: "c-bobs", type: "created", actorUserId: "alice", snapshot: { id: "c-bobs" },
  });

  return createSession(env.DB, "9001", "gho_alice");
}

test("deleting an account takes the account with it", async () => {
  const token = await seedAlice();

  const res = await SELF.fetch("https://example.com/account", {
    method: "DELETE",
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);

  const gone = async (sql, ...binds) =>
    expect(await env.DB.prepare(sql).bind(...binds).first()).toBeNull();

  await gone("SELECT github_id FROM users WHERE github_id = ?1", "9001");
  await gone("SELECT token FROM sessions WHERE github_id = ?1", "9001");
  await gone("SELECT org_id FROM memberships WHERE user_github_id = ?1", "9001");
  await gone("SELECT id FROM agents WHERE user_github_id = ?1", "9001");
  await gone("SELECT connector FROM connector_config WHERE user_github_id = ?1", "9001");
  await gone("SELECT user_github_id FROM entitlements WHERE user_github_id = ?1", "9001");
  await gone("SELECT day FROM ai_usage WHERE user_github_id = ?1", "9001");
  await gone("SELECT external_id FROM ingested_items WHERE user_github_id = ?1", "9001");
  await gone("SELECT user_id FROM contexts WHERE user_id = 'alice'");
  await gone("SELECT card_id FROM cards WHERE card_id = 'c-alices'");

  // The session is dead the moment the account is.
  const after = await SELF.fetch("https://example.com/connectors", {
    headers: { "x-session-token": token },
  });
  expect(after.status).toBe(401);
});

test("someone else's pending decision survives, with the name taken off it", async () => {
  const token = await seedAlice();
  await SELF.fetch("https://example.com/account", {
    method: "DELETE",
    headers: { "x-session-token": token },
  });

  // Bob still has to decide this. Deleting it would be deleting his work, not
  // hers — so the card stays and the sender becomes anonymous.
  const card = await env.DB.prepare("SELECT sender_user_id FROM cards WHERE card_id = 'c-bobs'").first();
  expect(card).toMatchObject({ sender_user_id: "deleted-user" });

  // Audit history is the org's record of what happened, not the individual's.
  const event = await env.DB
    .prepare("SELECT actor_user_id FROM card_events WHERE card_id = 'c-bobs'")
    .first();
  expect(event).toMatchObject({ actor_user_id: "deleted-user" });
});

test("deletion needs a session", async () => {
  const res = await SELF.fetch("https://example.com/account", { method: "DELETE" });
  expect(res.status).toBe(401);
});

test("the name comes off the JSON everyone actually reads, not just the columns", async () => {
  // `cards.data` and `card_events.snapshot` are what every client renders; the
  // columns beside them are for querying. Anonymizing only the columns left the
  // login in every teammate's feed and every line of the history — and the test
  // that guarded this asserted on the columns, so it passed while the name
  // stayed exactly where it was.
  const { saveCard, upsertUser, upsertMembership, createSession, setOrgProfile } =
    await import("../src/db.js");
  const { appendCardEvent } = await import("../src/events.js");

  await upsertUser(env.DB, { githubId: "9101", login: "carol", name: "Carol", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9102", login: "dave", name: "Dave", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "acme/json", "9101", "Admin");
  await upsertMembership(env.DB, "acme/json", "9102", "Engineer");
  // Dave reports to Carol, and Carol is about to leave.
  await setOrgProfile(env.DB, "acme/json", "9102", { title: null, responsibilities: null, managerLogin: "carol" });

  await saveCard(env.DB, "acme/json", {
    id: "c-daves", recipientUserID: "dave", senderUserID: "carol",
    originSenderUserID: "carol",
    status: "pending", title: "Sign the contract", priority: "high",
    createdAt: "2026-09-01T00:00:00Z",
  });
  await appendCardEvent(env.DB, "acme/json", {
    cardId: "c-daves", type: "decided", action: "approve", actorUserId: "carol",
    snapshot: {
      id: "c-daves", recipientUserID: "dave", senderUserID: "carol",
      decision: { action: "approve", actorUserID: "carol" },
    },
  });

  const token = await createSession(env.DB, "9101", "gho_carol");
  const res = await SELF.fetch("https://example.com/account", {
    method: "DELETE", headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);

  // Dave still has the decision he has to make, and the record of the one he
  // made — with nobody's name on them.
  const card = await env.DB.prepare("SELECT data FROM cards WHERE card_id = 'c-daves'").first();
  const parsed = JSON.parse(card.data);
  expect(parsed.senderUserID).toBe("deleted-user");
  expect(parsed.originSenderUserID).toBe("deleted-user");
  expect(card.data).not.toContain("carol");

  const event = await env.DB
    .prepare("SELECT actor_user_id, snapshot FROM card_events WHERE card_id = 'c-daves'")
    .first();
  expect(event.actor_user_id).toBe("deleted-user");
  expect(JSON.parse(event.snapshot).decision.actorUserID).toBe("deleted-user");
  expect(event.snapshot).not.toContain("carol");

  // And nobody reports to someone who has left, which would keep routing
  // escalations at an account that no longer exists.
  const profile = await env.DB
    .prepare("SELECT manager_login FROM org_profiles WHERE user_github_id = '9102'")
    .first();
  expect(profile.manager_login).toBeNull();
});

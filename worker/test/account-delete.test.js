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

test("nothing the account minted or is named on outlives it", async () => {
  // The rule this module writes down is: what is *about* this person goes,
  // what is someone else's record of a shared event stays with the name off.
  // Three tables were named by neither half and so by nothing.
  const { createInvite, acceptInvite } = await import("../src/auth.js");
  const { upsertBusiness, listBusinesses, upsertUser, upsertMembership, createSession } =
    await import("../src/db.js");
  const { requestCode } = await import("../src/otp.js");

  await upsertUser(env.DB, {
    githubId: "email:leaving@honmaru.test", login: "u:leaving@honmaru.test",
    name: "Leaving", avatarUrl: null, locale: "en",
  });
  await env.DB.prepare("UPDATE users SET email = ?1 WHERE github_id = ?2")
    .bind("leaving@honmaru.test", "email:leaving@honmaru.test").run();
  await upsertMembership(env.DB, "acme/app", "email:leaving@honmaru.test", "admin");
  const token = await createSession(env.DB, "email:leaving@honmaru.test", "email-auth");

  const { code } = await createInvite(env, {
    orgId: "acme/app", createdBy: "email:leaving@honmaru.test", role: "member",
  });
  await upsertBusiness(env.DB, "acme/app", { name: "Hotel Honmaru", createdBy: "email:leaving@honmaru.test" });
  // An outstanding sign-in code, keyed by the address rather than the account.
  await requestCode({ ...env, RESEND_API_KEY: "" }, { email: "leaving@honmaru.test", locale: "en" })
    .catch(() => {});
  await env.DB.prepare(
    "INSERT OR REPLACE INTO login_codes (email, code_hash, code_salt, expires_at, attempts, created_at) VALUES (?1,'h','s',?2,0,?2)"
  ).bind("leaving@honmaru.test", new Date(Date.now() + 600000).toISOString()).run();

  const res = await SELF.fetch("https://example.com/account", {
    method: "DELETE", headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);

  // A credential minted by an account that no longer exists must not go on
  // letting people in — it had seven days left on it.
  expect((await acceptInvite(env, { code, userId: "9002" })).error).toBeTruthy();

  // The business is the organization's, so it stays; the name on it does not.
  const businesses = await listBusinesses(env.DB, "acme/app");
  const hotel = businesses.find((b) => b.name === "Hotel Honmaru");
  expect(hotel).toBeTruthy();
  expect(hotel.createdBy).toBe("deleted-user");

  const codeRow = await env.DB
    .prepare("SELECT email FROM login_codes WHERE email = ?1").bind("leaving@honmaru.test").first();
  expect(codeRow).toBeNull();

  // And the point of all three: the address is not left anywhere a teammate
  // can still read it.
  const { listInvites } = await import("../src/team.js");
  const left = JSON.stringify({
    businesses,
    invites: await listInvites(env, { orgId: "acme/app", viewerId: "9002" }),
  });
  expect(left).not.toContain("leaving@honmaru.test");
});

test("deletion needs a session", async () => {
  const res = await SELF.fetch("https://example.com/account", { method: "DELETE" });
  expect(res.status).toBe(401);
});

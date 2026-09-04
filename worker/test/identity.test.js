import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import {
  createSession, getSession, upsertUser, getUserByGithubId,
  upsertMembership,
} from "../src/db.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("getSession returns the github id and access token for a token", async () => {
  const token = await createSession(env.DB, "42", "gho_abc");
  const s = await getSession(env.DB, token);
  expect(s.github_id).toBe("42");
  expect(s.github_access_token).toBe("gho_abc");
  expect(await getSession(env.DB, "no-such-token")).toBeNull();
});

test("upsertUser then getUserByGithubId round-trips and updates", async () => {
  await upsertUser(env.DB, { githubId: "7", login: "octocat", name: "The Octocat", avatarUrl: "http://a", locale: "en" });
  let u = await getUserByGithubId(env.DB, "7");
  expect(u.login).toBe("octocat");
  await upsertUser(env.DB, { githubId: "7", login: "octocat", name: "Mona", avatarUrl: "http://b", locale: "ja" });
  u = await getUserByGithubId(env.DB, "7");
  expect(u.name).toBe("Mona");
  expect(u.locale).toBe("ja");
});

test("expired sessions are rejected, legacy and fresh ones are not", async () => {
  await env.DB
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at)
       VALUES ('tok-expired', '901', 'gho_x', '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z')`
    )
    .run();
  expect(await getSession(env.DB, "tok-expired")).toBeNull();

  await env.DB
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at)
       VALUES ('tok-legacy', '902', 'gho_y', '2020-01-01T00:00:00Z')`
    )
    .run();
  expect((await getSession(env.DB, "tok-legacy")).github_id).toBe("902");

  const fresh = await createSession(env.DB, "903", "gho_z");
  expect((await getSession(env.DB, fresh)).github_id).toBe("903");
});

test("upsertMembership is idempotent", async () => {
  await upsertMembership(env.DB, "acme/web", "7", "Admin");
  await upsertMembership(env.DB, "acme/web", "7", "Engineer"); // update role
  const { results: mem } = await env.DB.prepare(
    "SELECT role FROM memberships WHERE org_id=?1 AND user_github_id=?2"
  ).bind("acme/web", "7").all();
  expect(mem).toHaveLength(1);
  expect(mem[0].role).toBe("Engineer");
});

// device_tokens is keyed by login and a card names its recipient by login, so
// two rows claiming one login is a card delivered to the wrong phone.
test("a login freed on GitHub and taken by someone else does not collide", async () => {
  await upsertUser(env.DB, { githubId: "9101", login: "drifter", name: "One", avatarUrl: null, locale: "en" });
  // Someone else now holds the name. The old row is stale by definition.
  await upsertUser(env.DB, { githubId: "9102", login: "drifter", name: "Two", avatarUrl: null, locale: "en" });

  const holder = await env.DB.prepare("SELECT github_id FROM users WHERE login = 'drifter'").first();
  expect(holder.github_id).toBe("9102");
  // And the old account is still there, under a name that cannot collide.
  const old = await env.DB.prepare("SELECT login FROM users WHERE github_id = '9101'").first();
  expect(old.login).toBe("drifter+stale-9101");
});

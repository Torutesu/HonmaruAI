import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import {
  createSession, getSession, upsertUser, getUserByGithubId,
  upsertMembership, upsertAgent,
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

test("upsertMembership and upsertAgent are idempotent", async () => {
  await upsertMembership(env.DB, "acme/web", "7", "Admin");
  await upsertMembership(env.DB, "acme/web", "7", "Engineer"); // update role
  await upsertAgent(env.DB, "acme/web", "7", "octocat's AI");
  await upsertAgent(env.DB, "acme/web", "7", "octocat's AI"); // no duplicate
  const { results: mem } = await env.DB.prepare(
    "SELECT role FROM memberships WHERE org_id=?1 AND user_github_id=?2"
  ).bind("acme/web", "7").all();
  expect(mem).toHaveLength(1);
  expect(mem[0].role).toBe("Engineer");
  const { results: ag } = await env.DB.prepare(
    "SELECT id FROM agents WHERE org_id=?1 AND user_github_id=?2"
  ).bind("acme/web", "7").all();
  expect(ag).toHaveLength(1);
});

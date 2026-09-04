import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The org graph route refreshes membership from GitHub's collaborator list and
// prunes anything not on it. That list is authoritative for GitHub users and
// silent about everyone else, so pruning against it wholesale removed every
// invited member — as a side effect of someone else opening a screen.

const ORG = "acme/app";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("a refresh from GitHub does not evict members who joined by invite", async () => {
  const { upsertMembership, upsertAgent, retainMemberships, isMember } = await import("../src/db.js");

  // Two GitHub collaborators and one person who joined with an invite code.
  await upsertMembership(env.DB, ORG, "111", "admin");
  await upsertMembership(env.DB, ORG, "222", "member");
  await upsertMembership(env.DB, ORG, "email:dana@example.com", "designer");
  await upsertAgent(env.DB, ORG, "email:dana@example.com", "Dana's AI");

  // GitHub reports only its own collaborators — it has never heard of Dana.
  await retainMemberships(env.DB, ORG, ["111", "222"]);

  expect(await isMember(env.DB, ORG, "email:dana@example.com")).toBe(true);
  const agent = await env.DB
    .prepare("SELECT 1 AS ok FROM agents WHERE org_id = ?1 AND user_github_id = ?2")
    .bind(ORG, "email:dana@example.com").first();
  expect(agent).toBeTruthy();
});

test("a GitHub user removed from the repository is still pruned", async () => {
  const { upsertMembership, retainMemberships, isMember } = await import("../src/db.js");

  await upsertMembership(env.DB, ORG, "333", "member");
  // 333 is gone from the collaborator list, so the authority that added them
  // has withdrawn them.
  await retainMemberships(env.DB, ORG, ["111", "222"]);

  expect(await isMember(env.DB, ORG, "333")).toBe(false);
});

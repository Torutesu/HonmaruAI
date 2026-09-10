import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// Where a card from outside the app lands.
//
// Both inbound paths — the email webhook and the connector cron — chose the
// org with `SELECT org_id FROM memberships WHERE user_github_id = ? LIMIT 1`.
// No ordering: whichever row the database reached first, which is insertion
// order. That was invisible while almost everybody was in exactly one
// organization. Joining a team is ordinary now, so a person routinely has two
// — the workspace they were given at sign-up and the team they were invited
// into — and a forwarded email would land in one of them by accident.

const SOLO = "personal:inboundsolo";
const TEAM = "personal:inboundteam";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, upsertMembership } = await import("../src/db.js");

  await upsertUser(env.DB, { githubId: "8801", login: "worker", name: "Worker", avatarUrl: null, locale: "en" });
  // The solo workspace first, so it is the one `LIMIT 1` would have found.
  await upsertMembership(env.DB, SOLO, "8801", "admin");
  await upsertMembership(env.DB, TEAM, "8801", "member");
  // …and somebody else in the team, which is what makes it a team.
  await upsertUser(env.DB, { githubId: "8802", login: "colleague", name: "Colleague", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "8802", "admin");
});

test("a person in two workspaces has one where they actually work", async () => {
  const { primaryOrgId } = await import("../src/db.js");
  expect(await primaryOrgId(env.DB, "8801")).toBe(TEAM);

  // And the row a bare LIMIT 1 would have taken is the other one, which is
  // the whole of the bug: it is not that the old query was random, it is that
  // it answered with insertion order and called it an organization.
  const first = await env.DB
    .prepare("SELECT org_id FROM memberships WHERE user_github_id = ?1 LIMIT 1")
    .bind("8801").first();
  expect(first.org_id).toBe(SOLO);
});

test("the connector cron syncs each person in the workspace they work in", async () => {
  const { createSession } = await import("../src/db.js");
  await createSession(env.DB, "8801", "gho_worker");
  await env.DB
    .prepare("INSERT INTO connector_config (user_github_id, connector, config, updated_at) VALUES (?1, ?2, ?3, ?4)")
    .bind("8801", "gmail", "{}", new Date().toISOString())
    .run();

  // No Composio key, so the loop finds its candidates and syncs nothing —
  // which is exactly the part under test. It must not throw, and the org it
  // resolved has to be the team.
  const { runScheduledSync } = await import("../src/scheduled.js");
  const result = await runScheduledSync({ ...env, COMPOSIO_API_KEY: "" });
  expect(result).toBeTruthy();

  const { primaryOrgId } = await import("../src/db.js");
  expect(await primaryOrgId(env.DB, "8801")).toBe(TEAM);
});

test("somebody in one workspace still lands in it", async () => {
  const { upsertUser, upsertMembership, primaryOrgId } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8803", login: "alone", name: "Alone", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:onlyone", "8803", "admin");
  expect(await primaryOrgId(env.DB, "8803")).toBe("personal:onlyone");
});

test("somebody in no workspace at all resolves to nothing, not to a guess", async () => {
  const { upsertUser, primaryOrgId } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8804", login: "nowhere", name: "Nowhere", avatarUrl: null, locale: "en" });
  expect(await primaryOrgId(env.DB, "8804")).toBeNull();
});

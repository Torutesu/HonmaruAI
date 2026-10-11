import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { orgsInTurn } from "../src/orgCursor.js";
import { pruneMessages } from "../src/governance.js";

// The daily sweeps read `LIMIT 50` with no order and no memory: the same
// fifty workspaces every day, and the fifty-first never pruned at all.

const now = new Date().toISOString();
const old = new Date(Date.now() - 400 * 86400000).toISOString();
const org = (i) => `team:${String(i).padStart(4, "0")}`;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM kv; DELETE FROM org_governance; DELETE FROM channel_messages;");
  const rows = Array.from({ length: 120 }, (_, i) => env.DB.prepare(
    "INSERT INTO org_governance (org_id, retention_public_days, updated_by, updated_at) VALUES (?1, 30, 'x', ?2)"
  ).bind(org(i), now));
  await env.DB.batch(rows);
});

const page = (after, limit) => env.DB.prepare("SELECT org_id FROM org_governance WHERE org_id > ?1 ORDER BY org_id LIMIT ?2").bind(after, limit);

test("each run picks up where the last stopped, and after the last workspace starts again", async () => {
  const first = await orgsInTurn(env.DB, "t", page, { perRun: 70 });
  const second = await orgsInTurn(env.DB, "t", page, { perRun: 70 });
  const third = await orgsInTurn(env.DB, "t", page, { perRun: 70 });
  expect(first.map((r) => r.org_id)).toEqual(Array.from({ length: 70 }, (_, i) => org(i)));
  expect(second.map((r) => r.org_id)).toEqual(Array.from({ length: 50 }, (_, i) => org(70 + i)));
  expect(third[0].org_id).toBe(org(0));
});

test("retention reaches the workspaces past the first fifty", async () => {
  await env.DB.prepare(
    "INSERT INTO channel_messages (id, org_id, channel, author_login, body, kind, created_at) VALUES ('m-late', ?1, 'b:general', 'ann', 'old news', 'message', ?2)"
  ).bind(org(99), old).run();
  await pruneMessages(env);
  expect(await env.DB.prepare("SELECT 1 FROM channel_messages WHERE id = 'm-late'").first()).toBeNull();
});

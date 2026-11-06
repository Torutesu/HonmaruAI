import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { purgeDueWorkspaces } from "../src/workspaceDeletion.js";

test("empty org-scoped tables do not exhaust the bounded workspace purge budget", async () => {
  const emptyTables = Array.from({ length: 210 }, (_, index) =>
    `CREATE TABLE purge_budget_empty_${String(index).padStart(3, "0")} (org_id TEXT)`);
  await env.DB.exec(emptyTables.join("; "));

  const orgId = "team:going";
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO orgs (id,name,created_at) VALUES (?1,'Going Co',?2)")
    .bind(orgId, now).run();
  await env.DB.prepare("INSERT INTO workspace_deletions (org_id,due_at,requested_by,requested_at) VALUES (?1,?2,'owner',?3)")
    .bind(orgId, "2000-01-01T00:00:00.000Z", now).run();
  await env.DB.prepare("INSERT INTO org_icons (org_id,media_id,content_type,updated_at) VALUES (?1,'marker','image/png',?2)")
    .bind(orgId, now).run();

  // Avoid object storage work so the single real marker tests the database
  // table scan after more than one 200-table budget of empty tables.
  const completed = await purgeDueWorkspaces({ ...env, MEDIA: undefined }, {
    now: Date.now() + 31 * 24 * 60 * 60 * 1000,
  });

  expect(completed).toEqual([orgId]);
  expect(await env.DB.prepare("SELECT 1 FROM org_icons WHERE org_id=?1").bind(orgId).first()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM orgs WHERE id=?1").bind(orgId).first()).toBeNull();
});

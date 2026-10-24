import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";

// schema.sql is replayed on every deploy, so anything it must guarantee has to
// survive that replay. The previous arrangement put the indexes behind ALTERs
// that fail on a database schema.sql itself had built, so D1 aborted the file
// and the constraints were never created — while the deploy reported success.

// The deploy runs schema.sql, then migrations.sql statement by statement,
// tolerating "duplicate column name" per statement. Asserting against schema
// alone is what let an index land in a file that could not create it.

// Exactly what .github/workflows/deploy-worker.yml greps for. Reproduced here
// rather than approximated, because a test that extracts statements its own way
// can pass while the deploy silently skips one — which is the shape of the bug
// this file exists to prevent.
const DEPLOY_STATEMENT = /^(ALTER TABLE|CREATE )/;

function deployStatements(sql) {
  return sql.split("\n").filter((line) => DEPLOY_STATEMENT.test(line)).map((l) => l.trim());
}

async function applyDeploy(db) {
  await db.exec(schemaSql.replace(/\n/g, " "));
  for (const sql of deployStatements(migrationsSql)) {
    try {
      await db.exec(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
}

test("a deploy leaves both user indexes in place", async () => {
  await applyDeploy(env.DB);
  const { results } = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'")
    .all();
  const names = results.map((r) => r.name);
  expect(names).toContain("idx_users_email");
  expect(names).toContain("idx_users_login");
});

test("a deploy onto a database predating the auth columns still succeeds", async () => {
  // Production: users exists without email/password columns. schema.sql is a
  // no-op for the table, so anything depending on those columns has to come
  // after the ALTER, not before it.
  await env.DB.exec("DROP TABLE IF EXISTS users");
  await env.DB.exec(
    "CREATE TABLE users (github_id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT, avatar_url TEXT, locale TEXT DEFAULT 'en', created_at TEXT NOT NULL)"
  );
  await applyDeploy(env.DB);
  const { results } = await env.DB.prepare("PRAGMA table_info(users)").all();
  expect(results.map((r) => r.name)).toContain("email");
  const idx = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_email'")
    .first();
  expect(idx).toBeTruthy();
});

test("a deploy onto a database predating the invite ref still succeeds", async () => {
  // The same shape as the users case above, and the reason this one exists:
  // the index for `ref` was written into schema.sql first, where it would have
  // been built against a column the deployed database does not have yet. D1
  // aborts a file at its first error, so that would have taken every statement
  // below it in schema.sql with it — while the deploy reported success.
  await env.DB.exec("DROP TABLE IF EXISTS invites");
  await env.DB.exec(
    "CREATE TABLE invites (code TEXT PRIMARY KEY, org_id TEXT NOT NULL, created_by TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL)"
  );
  await applyDeploy(env.DB);

  const { results } = await env.DB.prepare("PRAGMA table_info(invites)").all();
  const columns = results.map((r) => r.name);
  expect(columns).toContain("ref");
  expect(columns).toContain("max_uses");
  const idx = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_invites_ref'")
    .first();
  expect(idx).toBeTruthy();
});

test("adding webhook execution attribution preserves existing teammate runs", async () => {
  await env.DB.exec("DROP TABLE IF EXISTS ai_teammate_runs");
  await env.DB.exec("CREATE TABLE ai_teammate_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, provider TEXT NOT NULL, channel TEXT NOT NULL, thread_id TEXT NOT NULL, remote_id TEXT NOT NULL, remote_turn TEXT, status TEXT NOT NULL, cost_cents INTEGER NOT NULL DEFAULT 0, last_event_at TEXT, started_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, on_behalf_of TEXT)");
  await env.DB.exec("INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,cost_cents,created_at,updated_at) VALUES ('existing-run','existing-org','test','general','thread','remote','running',17,'before','before')");
  await applyDeploy(env.DB);
  await applyDeploy(env.DB);
  expect(await env.DB.prepare("SELECT status,cost_cents,room_hook_source FROM ai_teammate_runs WHERE id='existing-run'").first())
    .toEqual({ status: "running", cost_cents: 17, room_hook_source: null });
  const { results } = await env.DB.prepare("PRAGMA index_info(idx_teammate_runs_hook)").all();
  expect(results.map((row) => row.name)).toEqual(["org_id", "room_hook_source", "channel", "status"]);
});

test("schema.sql builds no index on a column migrations.sql adds", () => {
  // The order a deploy runs them in: an index here on a column an ALTER adds
  // there fails on every database older than the column, and D1 drops the
  // rest of schema.sql with it.
  const added = [...migrationsSql.matchAll(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/gm)].map(([, table, column]) => ({ table, column }));
  const indexes = [...schemaSql.matchAll(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)\(([^)]*)\)(.*)$/gm)];
  const wrong = [];
  for (const [, name, table, cols, rest] of indexes) {
    for (const { table: t, column } of added) {
      if (t === table && new RegExp(`\\b${column}\\b`).test(cols + rest)) wrong.push(`${name} (${table}.${column})`);
    }
  }
  expect(wrong).toEqual([]);
});

test("replaying the deploy is safe", async () => {
  // It runs on every push, so a second pass must not throw.
  await applyDeploy(env.DB);
  await expect(applyDeploy(env.DB)).resolves.not.toThrow();
});

test("the email index is a real constraint, not just a name", async () => {
  await applyDeploy(env.DB);
  const { upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "e1", login: "e1", name: "E1", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "e2", login: "e2", name: "E2", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = ?1 WHERE github_id = ?2").bind("dup@x.com", "e1").run();
  await expect(
    env.DB.prepare("UPDATE users SET email = ?1 WHERE github_id = ?2").bind("dup@x.com", "e2").run()
  ).rejects.toThrow();
});

test("every statement in migrations.sql is one the deploy will actually run", () => {
  // The workflow reads the file with a line-anchored grep, so an indented or
  // line-wrapped statement is not skipped loudly — it is skipped silently, and
  // everything depending on it is simply absent. Counting terminators against
  // extracted statements catches that before it ships.
  const withoutComments = migrationsSql.replace(/\/\*[\s\S]*?\*\//g, "");
  const terminators = (withoutComments.match(/;/g) || []).length;
  expect(deployStatements(migrationsSql)).toHaveLength(terminators);
});

test("an existing complimentary grant survives adding provider synchronization columns", async () => {
  await env.DB.exec("DROP TABLE IF EXISTS complimentary_access");
  await env.DB.exec("CREATE TABLE complimentary_access (user_github_id TEXT PRIMARY KEY, granted_at TEXT NOT NULL)");
  await env.DB.prepare("INSERT INTO complimentary_access VALUES (?1, ?2)")
    .bind("existing-account", "2026-09-22T00:00:00Z").run();
  await applyDeploy(env.DB);
  expect(await env.DB.prepare("SELECT * FROM complimentary_access WHERE user_github_id = ?1")
    .bind("existing-account").first()).toMatchObject({
      granted_at: "2026-09-22T00:00:00Z", rc_synced_at: null, rc_attempted_at: null,
      rc_operation_until: 0, deletion_requested_at: null,
    });
});

test('adding skill ownership preserves legacy creator attribution and content',async()=>{
  await env.DB.exec('DROP TABLE IF EXISTS hx_skills');
  await env.DB.exec("CREATE TABLE hx_skills (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT,body TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}')");
  await env.DB.prepare("INSERT INTO hx_skills(id,org_id,name,body,created_by,created_at,updated_at) VALUES ('legacy-skill','legacy-team','Legacy method','Keep this method','original','before','before')").run();
  await applyDeploy(env.DB);
  await applyDeploy(env.DB);
  expect(await env.DB.prepare("SELECT body,created_by,owner_id,COALESCE(owner_id,created_by) AS effective_owner FROM hx_skills WHERE id='legacy-skill'").first())
    .toEqual({body:'Keep this method',created_by:'original',owner_id:null,effective_owner:'original'});
});

test('follow-up origin migration preserves existing standalone reservations',async()=>{
 await env.DB.exec('DROP TABLE IF EXISTS hx_followups');
 await env.DB.exec("CREATE TABLE hx_followups (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,channel TEXT NOT NULL,thread_id TEXT,agent_id TEXT,instruction TEXT NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',created_by TEXT NOT NULL,created_at TEXT NOT NULL,done_at TEXT,result TEXT)");
 await env.DB.exec("INSERT INTO hx_followups(id,org_id,channel,instruction,due_at,created_by,created_at) VALUES ('existing','org','b:ops','Keep this reminder','2099-01-01','user','2026-01-01')");
 await applyDeploy(env.DB);
 expect(await env.DB.prepare('SELECT instruction,status,origin_workflow_id,origin_release_id FROM hx_followups WHERE id=?1').bind('existing').first()).toEqual({instruction:'Keep this reminder',status:'scheduled',origin_workflow_id:null,origin_release_id:null});
 await applyDeploy(env.DB);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_followups WHERE id=?1').bind('existing').first()).n).toBe(1);
});

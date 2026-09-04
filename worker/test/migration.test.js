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
async function applyDeploy(db) {
  await db.exec(schemaSql.replace(/\n/g, " "));
  for (const stmt of migrationsSql.split(";")) {
    const sql = stmt.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!sql) continue;
    try {
      await db.exec(sql.replace(/\n/g, " "));
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

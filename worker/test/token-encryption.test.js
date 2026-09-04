import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, getSession, upsertUser } from "../src/db.js";
import { seal, open, isPlaintext } from "../src/secretbox.js";

// The GitHub token carries the `repo` scope, and it sat in D1 in the clear. A
// leak of the database was therefore a leak of every user's source, not just of
// this app's data.

const KEYED = { ...env, TOKEN_ENCRYPTION_KEY: "a-key-long-enough-to-count" };

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "7001", login: "ada", name: "Ada", avatarUrl: "", locale: "en" });
});

async function storedToken(token) {
  const row = await env.DB
    .prepare("SELECT github_access_token FROM sessions WHERE token = ?1")
    .bind(token)
    .first();
  return row?.github_access_token ?? null;
}

test("the token in the database is not the token", async () => {
  const session = await createSession(env.DB, "7001", "gho_secret_value", KEYED);
  const stored = await storedToken(session);
  expect(stored).not.toContain("gho_secret_value");
  expect(stored.startsWith("v1.")).toBe(true);
});

test("and comes back out intact for the code that needs it", async () => {
  const session = await createSession(env.DB, "7001", "gho_round_trip", KEYED);
  const read = await getSession(env.DB, session, KEYED);
  expect(read.github_access_token).toBe("gho_round_trip");
});

test("a row written before encryption existed still works, and is upgraded in place", async () => {
  await env.DB
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at)
       VALUES ('legacy', '7001', 'gho_plaintext', '2026-09-01T00:00:00Z', '2099-01-01T00:00:00Z')`
    )
    .run();

  const read = await getSession(env.DB, "legacy", KEYED);
  expect(read.github_access_token).toBe("gho_plaintext");
  // Read once, and the plaintext is gone from the table. No backfill needed.
  expect(isPlaintext(await storedToken("legacy"))).toBe(false);
});

test("a token sealed with a different key does not decrypt to garbage", async () => {
  const sealed = await seal(KEYED, "gho_other_org");
  const wrongKey = { ...env, TOKEN_ENCRYPTION_KEY: "a-completely-different-key" };
  // Null, not ciphertext dressed as a bearer token and sent to GitHub.
  expect(await open(wrongKey, sealed)).toBeNull();
});

test("with no key configured nothing breaks, it is just not encrypted", async () => {
  const bare = { DB: env.DB };
  const session = await createSession(env.DB, "7001", "gho_dev_mode", bare);
  expect(await storedToken(session)).toBe("gho_dev_mode");
  expect((await getSession(env.DB, session, bare)).github_access_token).toBe("gho_dev_mode");
});

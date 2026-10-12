import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, getSession, sessionKey, upsertUser } from "../src/db.js";
import { sealSessionToken, useSecretKey } from "../src/secrets.js";

// Session tokens were the sessions table's primary key, in the clear: anyone
// who could read the table — a leaked backup, an export, a query bug — could
// sign in as anybody. The table now keeps each token's SHA-256.

const me = (token) => worker.fetch(new Request("https://example.com/me", { headers: { "x-session-token": token } }), env, { waitUntil() {} });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM sessions; DELETE FROM session_workspaces; DELETE FROM users;");
  await upsertUser(env.DB, { githubId: "u1", login: "ann", name: "Ann", avatarUrl: null, locale: "en" });
});

test("the table holds the token's hash, and the hash is not a way in", async () => {
  const token = await createSession(env.DB, "u1", "email-auth");
  const { results } = await env.DB.prepare("SELECT token FROM sessions").all();
  expect(results).toHaveLength(1);
  const stored = results[0].token;
  expect(stored).toBe(await sessionKey(token));
  expect(stored).not.toContain(token);

  expect((await me(token)).status).toBe(200);
  // What a leaked table would give someone: refused.
  expect(await getSession(env.DB, stored)).toBeNull();
  expect((await me(stored)).status).toBe(401);
});

test("a session from before hashing keeps working, and leaves the table on first use", async () => {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  useSecretKey({ DATA_KEY: key });
  const legacy = crypto.randomUUID();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86400000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at) VALUES (?1, 'u1', ?2, ?3, ?4)")
    .bind(legacy, await sealSessionToken(legacy, "gho_legacy"), now, later).run();
  await env.DB.prepare("INSERT INTO session_workspaces (token, org_id, last_seen_at) VALUES (?1, 'team:a', ?2)").bind(legacy, now).run();

  const session = await getSession(env.DB, legacy);

  expect(session).toBeTruthy();
  expect(session.token).toBe(await sessionKey(legacy));
  // Its GitHub token, sealed for the old row, opens on the new one.
  expect(session.github_access_token).toBe("gho_legacy");
  expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE token = ?1").bind(legacy).first()).toBeNull();
  expect((await env.DB.prepare("SELECT token FROM session_workspaces").first()).token).toBe(session.token);
  // And again, now by its hash.
  expect((await getSession(env.DB, legacy)).github_access_token).toBe("gho_legacy");
  useSecretKey({});
});

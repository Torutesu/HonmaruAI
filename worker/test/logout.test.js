import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser, getSession, registerDevice } from "../src/db.js";

// Signing out unregistered the device and dropped the session on the phone.
// The session — and the GitHub access token behind it — stayed valid on the
// server for thirty days, sliding forward every time anything used it. There
// was no endpoint that ended one.

const SELF = { fetch: (url, init) => worker.fetch(new Request(url, init), env) };

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "6001", login: "ada", name: "Ada", avatarUrl: "", locale: "en" });
});

test("signing out ends the session, and the device with it", async () => {
  const token = await createSession(env.DB, "6001", "gho_ada");
  await registerDevice(env.DB, { deviceToken: "dev-1", githubId: "6001", login: "ada" });

  const res = await SELF.fetch("https://example.com/logout", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: "dev-1" }),
  });
  expect(res.status).toBe(200);

  expect(await getSession(env.DB, token)).toBeNull();
  expect(await env.DB.prepare("SELECT device_token FROM device_tokens WHERE device_token='dev-1'").first())
    .toBeNull();
});

test("the token stops working everywhere, not just on the phone that used it", async () => {
  const token = await createSession(env.DB, "6001", "gho_ada");
  await SELF.fetch("https://example.com/logout", {
    method: "POST", headers: { "x-session-token": token },
  });

  const after = await SELF.fetch("https://example.com/orgs/acme/web/graph", {
    headers: { "x-session-token": token },
  });
  expect(after.status).toBe(401);
});

test("signing out twice is not an error", async () => {
  // A session that is already gone is the outcome the caller wanted.
  const res = await SELF.fetch("https://example.com/logout", {
    method: "POST", headers: { "x-session-token": "never-existed" },
  });
  expect(res.status).toBe(200);
});

test("an expired session is swept rather than left holding a GitHub token", async () => {
  const { sweepRateLimits } = await import("../src/ratelimit.js");
  await env.DB
    .prepare(
      `INSERT INTO sessions (token, github_id, github_access_token, created_at, expires_at)
       VALUES ('stale', '6001', 'gho_stale', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`
    )
    .run();

  await sweepRateLimits(env);
  expect(await env.DB.prepare("SELECT token FROM sessions WHERE token='stale'").first()).toBeNull();
});

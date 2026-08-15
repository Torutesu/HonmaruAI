import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession, getSession } from "../src/db.js";

// A fixed 30-day window signed out someone who used the app every single
// morning, on day 31, with no warning and nothing to distinguish it from a bug.
// Absence should expire a session; use should not.

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

const daysFromNow = (days) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

async function setExpiry(token, iso) {
  await env.DB.prepare("UPDATE sessions SET expires_at = ?1 WHERE token = ?2").bind(iso, token).run();
}

async function expiryOf(token) {
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token = ?1").bind(token).first();
  return row?.expires_at ?? null;
}

test("a session past halfway is extended by using it", async () => {
  const token = await createSession(env.DB, "8001", "gho_a");
  await setExpiry(token, daysFromNow(3));

  expect(await getSession(env.DB, token)).toBeTruthy();

  const extended = Date.parse(await expiryOf(token));
  expect(extended).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
});

test("a session with most of its window left is not rewritten", async () => {
  const token = await createSession(env.DB, "8002", "gho_b");
  const original = daysFromNow(25);
  await setExpiry(token, original);

  await getSession(env.DB, token);

  // An UPDATE on every request, for a deadline still weeks away, is a write we
  // would pay for on every call.
  expect(await expiryOf(token)).toBe(original);
});

test("an expired session is refused and not resurrected", async () => {
  const token = await createSession(env.DB, "8003", "gho_c");
  await setExpiry(token, daysFromNow(-1));

  expect(await getSession(env.DB, token)).toBeNull();
  // Sliding an expired session would make expiry unreachable.
  expect(Date.parse(await expiryOf(token))).toBeLessThan(Date.now());
});

test("a session minted before expiry existed is adopted rather than dropped", async () => {
  const token = await createSession(env.DB, "8004", "gho_d");
  await setExpiry(token, null);

  expect(await getSession(env.DB, token)).toBeTruthy();
  expect(Date.parse(await expiryOf(token))).toBeGreaterThan(Date.now());
});

test("failing to extend is not failing to authenticate", async () => {
  // The question asked was "is this session valid right now", and it is.
  const broken = {
    prepare(sql) {
      if (sql.startsWith("UPDATE")) throw new Error("D1 unavailable");
      return {
        bind: () => ({ first: async () => ({ token: "t", github_id: "1", github_access_token: "gho", expires_at: daysFromNow(1) }) }),
      };
    },
  };
  expect(await getSession(broken, "t")).toBeTruthy();
});

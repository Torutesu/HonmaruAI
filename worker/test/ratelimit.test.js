import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { LIMITS, enforce, subjectFor } from "../src/ratelimit.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

function requestFrom(ip, token) {
  const headers = { "CF-Connecting-IP": ip };
  if (token) headers["x-session-token"] = token;
  return new Request("https://example.com/ai/route", { method: "POST", headers });
}

test("the budget runs out and the caller is told when to come back", async () => {
  const req = requestFrom("203.0.113.1");
  const max = LIMITS["ai/route"].max;

  for (let i = 0; i < max; i += 1) {
    expect(await enforce(env, req, "ai/route")).toBeNull();
  }

  const refused = await enforce(env, req, "ai/route");
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("one caller's exhausted budget does not touch another's", async () => {
  const max = LIMITS["ai/route"].max;
  const noisy = requestFrom("203.0.113.2");
  for (let i = 0; i <= max; i += 1) await enforce(env, noisy, "ai/route");
  expect((await enforce(env, noisy, "ai/route")).status).toBe(429);

  expect(await enforce(env, requestFrom("203.0.113.3"), "ai/route")).toBeNull();
});

test("budgets are per route, not shared", async () => {
  const req = requestFrom("203.0.113.4");
  for (let i = 0; i <= LIMITS.media.max; i += 1) await enforce(env, req, "media");
  expect((await enforce(env, req, "media")).status).toBe(429);
  // Filling the upload budget must not stop the same person routing a decision.
  expect(await enforce(env, req, "ai/route")).toBeNull();
});

test("a signed-in caller is counted by session, not by network", async () => {
  // Otherwise moving from wifi to cellular hands you a fresh allowance.
  expect(subjectFor(requestFrom("203.0.113.5", "tok-1"), "tok-1")).toBe("s:tok-1");
  expect(subjectFor(requestFrom("203.0.113.6", "tok-1"), "tok-1")).toBe("s:tok-1");
  expect(subjectFor(requestFrom("203.0.113.5"), null)).toBe("i:203.0.113.5");
});

// The header is attacker controlled. Keying the bucket on it unverified let a
// caller mint a fresh allowance per request by sending a different random
// string — every budget here, defeated by a for-loop.
test("an unverified session token cannot buy a fresh allowance", async () => {
  const max = LIMITS["ai/route"].max;
  const ip = "203.0.113.9";
  for (let i = 0; i <= max; i += 1) {
    await enforce(env, requestFrom(ip, `forged-${i}`), "ai/route");
  }
  const refused = await enforce(env, requestFrom(ip, "forged-and-another"), "ai/route");
  expect(refused?.status).toBe(429);
});

test("a real session token is counted separately from the IP it arrives on", async () => {
  const { createSession, upsertUser } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9101", login: "limited", name: "L", avatarUrl: "", locale: "en" });
  const token = await createSession(env.DB, "9101", "gho_limited");

  const max = LIMITS["ai/route"].max;
  for (let i = 0; i <= max; i += 1) await enforce(env, requestFrom("203.0.113.10", token), "ai/route");
  expect((await enforce(env, requestFrom("203.0.113.10", token), "ai/route")).status).toBe(429);
  // A different network, same session: still spent.
  expect((await enforce(env, requestFrom("203.0.113.11", token), "ai/route")).status).toBe(429);
});

test("the limiter fails open when the database does not answer", async () => {
  // A limiter outage taking the product down with it would be the worse
  // failure. This is a deliberate choice, so it is pinned.
  const broken = { DB: { prepare() { throw new Error("D1 unavailable"); } } };
  expect(await enforce(broken, requestFrom("203.0.113.7"), "ai/route")).toBeNull();
});

test("a rate-limited route answers 429 over HTTP", async () => {
  const headers = { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.8" };
  const body = JSON.stringify({ text: "ship it", sender: { id: "a" } });
  let last;
  for (let i = 0; i <= LIMITS["ai/route"].max; i += 1) {
    last = await SELF.fetch("https://example.com/ai/route", { method: "POST", headers, body });
  }
  expect(last.status).toBe(429);
  expect((await last.json()).message).toMatch(/too many/i);
});

import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { LIMITS, enforce, subjectOf } from "../src/ratelimit.js";

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
  expect(subjectOf(requestFrom("203.0.113.5", "tok-1"))).toBe("s:tok-1");
  expect(subjectOf(requestFrom("203.0.113.6", "tok-1"))).toBe("s:tok-1");
  expect(subjectOf(requestFrom("203.0.113.5"))).toBe("i:203.0.113.5");
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

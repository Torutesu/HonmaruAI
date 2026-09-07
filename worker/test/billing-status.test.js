import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";

// The plan screen reads this. With billing switched off it must still answer —
// showing the catalog and saying nothing can be bought — rather than 503ing
// and leaving the screen blank.

let token;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { signup } = await import("../src/auth.js");
  const result = await signup(env, { email: "buyer@example.com", password: "password123", name: "Buyer" });
  token = result.token;
});

test("an anonymous caller gets nothing", async () => {
  const res = await SELF.fetch("https://example.com/billing/status");
  expect(res.status).toBe(401);
});

test("with billing unconfigured the catalog is still readable and honestly unbuyable", async () => {
  const res = await SELF.fetch("https://example.com/billing/status", {
    headers: { "x-session-token": token },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.plan).toBe("free");
  expect(body.purchasable).toBe(false);
  expect(body.trialDays).toBe(3);
  // With nothing to sell, the ceiling in force is the unbilled one, not the
  // free tier's — the screen must not warn about a limit nobody is enforcing.
  const { UNBILLED_DAILY_ROUTES } = await import("../src/gate.js");
  expect(body.dailyLimit).toBe(UNBILLED_DAILY_ROUTES);
  expect(body.remainingToday).toBe(UNBILLED_DAILY_ROUTES);
  expect(body.plans.map((p) => p.id)).toEqual(["free", "pro", "business"]);
  // Annual is cheaper per month than monthly, on every paid plan.
  for (const plan of body.plans.filter((p) => p.monthly > 0)) {
    expect(plan.annualMonthly).toBeLessThan(plan.monthly);
  }
});

test("routing a decision spends the free allowance the screen reports", async () => {
  const { countAIUse } = await import("../src/db.js");
  const { getSession } = await import("../src/db.js");
  const session = await getSession(env.DB, token);
  await countAIUse(env.DB, session.github_id, new Date().toISOString().slice(0, 10));

  const body = await (await SELF.fetch("https://example.com/billing/status", {
    headers: { "x-session-token": token },
  })).json();
  expect(body.usedToday).toBe(1);
  expect(body.remainingToday).toBe(body.dailyLimit - 1);
});

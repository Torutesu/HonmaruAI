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

test("a plan the screen offers is a plan somebody can actually buy", async () => {
  // There is one entitlement in RevenueCat — `honmaruai Pro` — and one pair of
  // store products behind it. Business was priced at $12 a seat, listed beside
  // Pro and selectable, and choosing it put its price under a "start your free
  // trial" button that could not have sold it. A tier nothing sells says so.
  const body = await (await SELF.fetch("https://example.com/billing/status", {
    headers: { "x-session-token": token },
  })).json();
  const buyable = body.plans.filter((p) => p.monthly > 0 && p.available !== false);
  expect(buyable.map((p) => p.id)).toEqual(["pro"]);
  expect(body.plans.find((p) => p.id === "business").available).toBe(false);
  // Free is not bought, but it is offered, and it is real.
  expect(body.plans.find((p) => p.id === "free").available).toBe(true);
});

test("no plan sells a feature the Worker does not implement", async () => {
  // Pro advertised "Priority notification delivery". Nothing anywhere reads a
  // subscriber's plan when sending one: notify.js picks urgency off the card's
  // own priority and APNs gets the same headers for everybody. A paid feature
  // that exists only on the price list is the one bug a customer pays for.
  const body = await (await SELF.fetch("https://example.com/billing/status", {
    headers: { "x-session-token": token },
  })).json();
  const features = body.plans.flatMap((p) => p.features).join(" ").toLowerCase();
  expect(features).not.toContain("priority notification");
});

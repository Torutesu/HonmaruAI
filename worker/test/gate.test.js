import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { countAIUse, usedToday, readEntitlement, writeEntitlement } from "../src/db.js";

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

test("usage counts per user per day", async () => {
  expect(await usedToday(env.DB, "1", "2026-08-10")).toBe(0);
  await countAIUse(env.DB, "1", "2026-08-10");
  await countAIUse(env.DB, "1", "2026-08-10");
  expect(await usedToday(env.DB, "1", "2026-08-10")).toBe(2);
  // A different day starts over, and a different user is unaffected.
  expect(await usedToday(env.DB, "1", "2026-08-11")).toBe(0);
  expect(await usedToday(env.DB, "2", "2026-08-10")).toBe(0);
});

test("the entitlement cache round-trips with its timestamp", async () => {
  expect(await readEntitlement(env.DB, "9")).toBeNull();
  await writeEntitlement(env.DB, "9", true);
  const row = await readEntitlement(env.DB, "9");
  expect(row.is_pro).toBe(1);
  expect(typeof row.checked_at).toBe("string");
});

import { fetchMock } from "cloudflare:test";
import { beforeEach, afterEach } from "vitest";
import { checkAIAllowance, FREE_DAILY_ROUTES } from "../src/gate.js";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a caller-supplied key is never metered", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: "600", userKey: "sk-user" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});

test("with no billing configured nothing is metered", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: "601" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});

test("a free user is allowed up to the limit and degraded after it", async () => {
  const e = { ...env, REVENUECAT_SECRET_KEY: "sk-rc" };
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/602") })
    .reply(200, { subscriber: { entitlements: {} } })
    .persist();

  for (let i = 0; i < FREE_DAILY_ROUTES; i += 1) {
    const ok = await checkAIAllowance(e, { githubId: "602" });
    expect(ok).toMatchObject({ allowed: true, metered: true });
    await ok.consume();
  }
  const over = await checkAIAllowance(e, { githubId: "602" });
  expect(over).toMatchObject({ allowed: false, quotaExceeded: true });
});

test("a Pro subscriber is never metered", async () => {
  const e = { ...env, REVENUECAT_SECRET_KEY: "sk-rc" };
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/603") })
    .reply(200, { subscriber: { entitlements: { "honmaruai Pro": { expires_date: "2099-01-01T00:00:00Z" } } } });

  const decision = await checkAIAllowance(e, { githubId: "603" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});

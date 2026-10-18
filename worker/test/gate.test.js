import {env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { countAIUse, usedToday, readEntitlement, writeEntitlement } from "../src/db.js";

beforeEach(async () => {
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

import { afterEach } from "vitest";
import { checkAIAllowance, FREE_DAILY_ROUTES, UNBILLED_DAILY_ROUTES } from "../src/gate.js";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a caller-supplied key is never metered", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: "600", userKey: "sk-user" });
  expect(decision).toMatchObject({ allowed: true, metered: false });
});

// With no billing there is no paywall to enforce, so a signed-in caller is not
// held to the three-a-day free tier. They are still counted: "nothing to sell
// them" is not "spend as much of our model budget as you like".
test("with no billing configured a signed-in caller is allowed, and still counted", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: "601" });
  expect(decision).toMatchObject({ allowed: true, quotaExceeded: false });
  expect(decision.metered).toBe(true);
});

// This is the hole this ordering exists to close: with billing off, an
// anonymous caller used to be handed the model key with nothing counting the
// calls — an unauthenticated route that spends money, on the public internet.
test("with no billing configured an anonymous caller is still refused", async () => {
  const decision = await checkAIAllowance({ ...env }, { githubId: null });
  expect(decision.allowed).toBe(false);
});

test("with no billing configured the unbilled ceiling still applies", async () => {
  const e = { ...env };
  for (let i = 0; i < UNBILLED_DAILY_ROUTES; i += 1) {
    const d = await checkAIAllowance(e, { githubId: "603" });
    expect(d.allowed).toBe(true);
    await d.consume();
  }
  expect((await checkAIAllowance(e, { githubId: "603" })).allowed).toBe(false);
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

test("checks made at once cannot all take the day's last call", async () => {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO ai_usage (user_github_id, day, used) VALUES ('604', ?1, ?2)").bind(day, UNBILLED_DAILY_ROUTES - 1).run();
  const checks = await Promise.all([1, 2, 3].map(() => checkAIAllowance({ ...env }, { githubId: "604" })));
  expect(checks.filter((c) => c.allowed)).toHaveLength(1);
  const [winner] = checks.filter((c) => c.allowed);
  expect(winner.remaining).toBe(1);
  // While its call runs, nobody else gets in; once it is counted, the day is spent.
  expect((await checkAIAllowance({ ...env }, { githubId: "604" })).allowed).toBe(false);
  await winner.consume();
  expect(await usedToday(env.DB, "604", day)).toBe(UNBILLED_DAILY_ROUTES);
  expect((await checkAIAllowance({ ...env }, { githubId: "604" })).allowed).toBe(false);
});

test("a checked call that never happened gives its place back, by release or when it lapses", async () => {
  const { reserveAIUse, AI_RESERVATION_MS } = await import("../src/db.js");
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO ai_usage (user_github_id, day, used) VALUES ('605', ?1, ?2)").bind(day, UNBILLED_DAILY_ROUTES - 1).run();
  const first = await checkAIAllowance({ ...env }, { githubId: "605" });
  expect((await checkAIAllowance({ ...env }, { githubId: "605" })).allowed).toBe(false);
  await first.release();
  await first.release();
  const second = await checkAIAllowance({ ...env }, { githubId: "605" });
  expect(second.allowed).toBe(true);
  await second.consume();
  await second.release();
  expect(await usedToday(env.DB, "605", day)).toBe(UNBILLED_DAILY_ROUTES);

  // One neither counted nor let go holds its place only for a while.
  const now = Date.now();
  expect(await reserveAIUse(env.DB, "606", day, 1, now)).toMatchObject({ remaining: 1 });
  expect(await reserveAIUse(env.DB, "606", day, 1, now + 1000)).toBeNull();
  expect(await reserveAIUse(env.DB, "606", day, 1, now + AI_RESERVATION_MS + 1)).toMatchObject({ remaining: 1 });
});

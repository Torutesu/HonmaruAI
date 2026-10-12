import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import { braked, checkSpend, forgetBrake } from "../src/spendGuard.js";

// Workers Paid bills D1 by the row with no ceiling: a runaway writer was a
// bill found at the end of the month.

const NOW = Date.parse("2026-10-12T09:00:00Z");
const keyed = { ...env, CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "acct", D1_DATABASE_ID: "db1", ALERT_WEBHOOK_URL: "https://hooks.example.com/ops" };
const sent = [];
const ctx = { waitUntil: (p) => sent.push(p) };
const analytics = (written, read = 0) => fetchMock.get("https://api.cloudflare.com")
  .intercept({ path: "/client/v4/graphql", method: "POST" })
  .reply(200, { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: written, rowsRead: read } }] }] } } });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM kv;");
  forgetBrake();
  fetchMock.activate();
  sent.length = 0;
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("under the lines nothing happens; past the warning someone is told; past the stop line background work waits for tomorrow", async () => {
  analytics(100_000);
  expect(await checkSpend(keyed, ctx, { now: NOW })).toMatchObject({ checked: true, warned: false, braked: false });
  expect(await braked(keyed, NOW)).toBe(false);

  analytics(4_000_000);
  fetchMock.get("https://hooks.example.com").intercept({ path: "/ops", method: "POST", body: (b) => /spend-warning/.test(b) }).reply(200, "");
  expect(await checkSpend(keyed, ctx, { now: NOW })).toMatchObject({ warned: true, braked: false });
  await Promise.all(sent);

  analytics(12_000_000);
  fetchMock.get("https://hooks.example.com").intercept({ path: "/ops", method: "POST", body: (b) => /spend-brake/.test(b) }).reply(200, "");
  expect(await checkSpend(keyed, ctx, { now: NOW + 120_000 })).toMatchObject({ braked: true });
  await Promise.all(sent);
  expect(await braked(keyed, NOW)).toBe(true);
  // The next UTC day, off again.
  expect(await braked(keyed, NOW + 86_400_000)).toBe(false);
  // SPEND_GUARD=off: never braked.
  expect(await braked({ ...keyed, SPEND_GUARD: "off" }, NOW)).toBe(false);
});

test("without the analytics token it does nothing", async () => {
  expect(await checkSpend(env, ctx, { now: NOW })).toEqual({ checked: false });
});

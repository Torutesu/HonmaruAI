import {env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { writeEntitlement } from "../src/db.js";
import { isPro, proSubscription } from "../src/entitlements.js";

const ENV = () => ({ ...env, REVENUECAT_SECRET_KEY: "sk-rc" });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

function subscriber(active) {
  return {
    subscriber: {
      entitlements: active
        ? { "honmaruai Pro": { expires_date: "2099-01-01T00:00:00Z" } }
        : {},
    },
  };
}

test("an active entitlement is read from RevenueCat and cached", async () => {
  let seenPath;
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => { seenPath = p; return true; } })
    .reply(200, subscriber(true));

  expect(await isPro(ENV(), "500")).toBe(true);
  expect(seenPath).toContain("/v1/subscribers/500");

  // Second call inside the hour must not hit the network — an unmatched
  // interceptor would make assertNoPendingInterceptors fail if it did.
  expect(await isPro(ENV(), "500")).toBe(true);
});

test("the plans view receives bounded current trial, cancellation, and billing issue details", async () => {
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: "/v1/subscribers/510" })
    .reply(200, { subscriber: {
      entitlements: { "honmaruai Pro": {
        product_identifier: "pro.monthly", period_type: "trial", purchase_date: "2099-01-01T00:00:00Z",
        expires_date: "2099-01-08T00:00:00Z", billing_issue_detected_at: "2099-01-07T00:00:00Z",
      } },
      subscriptions: { "pro.monthly": {
        unsubscribe_detected_at: "2099-01-06T00:00:00Z", grace_period_expires_date: "2099-01-10T00:00:00Z", is_sandbox: true,
        store_transaction_id: "private-transaction-id",
      } },
    } });

  await expect(proSubscription(ENV(), "510")).resolves.toEqual({
    pro: true,
    subscription: {
      periodType: "trial", expiresAt: "2099-01-08T00:00:00.000Z", purchaseDate: "2099-01-01T00:00:00.000Z",
      cancellationDetectedAt: "2099-01-06T00:00:00.000Z", billingIssueDetectedAt: "2099-01-07T00:00:00.000Z",
      gracePeriodExpiresAt: "2099-01-10T00:00:00.000Z", sandbox: true,
    },
  });
  const cached = await env.DB.prepare("SELECT is_pro FROM entitlements WHERE user_github_id='510'").first();
  expect(cached.is_pro).toBe(1);
});

test("plans retain last-known Pro access but omit stale lifecycle details during a RevenueCat outage", async () => {
  await writeEntitlement(env.DB, "511", true);
  fetchMock.get("https://api.revenuecat.com").intercept({ path: "/v1/subscribers/511" }).reply(503, "unavailable");
  await expect(proSubscription(ENV(), "511")).resolves.toEqual({ pro: true, subscription: null });
});

test("a stale cache is refreshed", async () => {
  await env.DB
    .prepare("INSERT INTO entitlements (user_github_id, is_pro, checked_at) VALUES ('501', 0, '2020-01-01T00:00:00Z')")
    .run();
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/501") })
    .reply(200, subscriber(true));

  expect(await isPro(ENV(), "501")).toBe(true);
});

test("RevenueCat being down means free, never blocked", async () => {
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/502") })
    .reply(500, "revenuecat is down");

  expect(await isPro(ENV(), "502")).toBe(false);
});

test("no secret configured means we never ask", async () => {
  // No interceptor registered: a network call here would throw.
  expect(await isPro({ ...env }, "503")).toBe(false);
});

test("a purchase or restore bypasses a fresh free cache on the next request", async () => {
  const userID = "email:billing-regression";
  await writeEntitlement(env.DB, userID, false);
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: `/v1/subscribers/${encodeURIComponent(userID)}` })
    .reply(200, subscriber(true));

  expect(await isPro(ENV(), userID)).toBe(true);
  expect(await isPro(ENV(), userID)).toBe(true);
});

test("a failed lookup does not delay a subsequent successful purchase lookup", async () => {
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: "/v1/subscribers/504" }).reply(500, "unavailable");
  expect(await isPro(ENV(), "504")).toBe(false);
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: "/v1/subscribers/504" }).reply(200, subscriber(true));
  expect(await isPro(ENV(), "504")).toBe(true);
});

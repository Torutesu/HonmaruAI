import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { writeEntitlement } from "../src/db.js";
import { isPro } from "../src/entitlements.js";

const ENV = () => ({ ...env, REVENUECAT_SECRET_KEY: "sk-rc" });

beforeAll(async () => {
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

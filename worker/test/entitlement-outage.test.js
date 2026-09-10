import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { isPro } from "../src/entitlements.js";

// What a billing outage costs the person paying.
//
// `isPro` asks RevenueCat and caches the answer for an hour. The comment says
// a billing outage must never block the product — and the code, on catching
// one, wrote `false` into that cache. So one failed request downgraded a
// paying subscriber to the free tier's three routes a day, for an hour, and
// the cache write was what stopped it retrying sooner.
//
// "RevenueCat says no" and "RevenueCat did not answer" are different answers
// and only one of them is about the subscriber.

const billing = () => ({ ...env, REVENUECAT_SECRET_KEY: "sk_test" });
const realFetch = globalThis.fetch;
let respond;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
});

beforeEach(() => {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("api.revenuecat.com")) return respond();
    return realFetch(input, init);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const active = () => new Response(JSON.stringify({
  subscriber: { entitlements: { "honmaruai Pro": { expires_date: null } } },
}), { status: 200 });

test("an outage does not downgrade somebody who is paying", async () => {
  respond = active;
  expect(await isPro(billing(), "pro-1")).toBe(true);

  // Age the cache past its hour so the next call really asks.
  await env.DB.prepare("UPDATE entitlements SET checked_at = ?1 WHERE user_github_id = ?2")
    .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), "pro-1").run();

  respond = () => new Response("upstream is having a bad day", { status: 503 });
  // The last thing RevenueCat actually said about this person was yes.
  expect(await isPro(billing(), "pro-1")).toBe(true);

  // And the outage did not write itself into the cache, so the next request
  // asks again instead of being locked to the wrong answer for an hour.
  respond = active;
  expect(await isPro(billing(), "pro-1")).toBe(true);
  const row = await env.DB
    .prepare("SELECT is_pro FROM entitlements WHERE user_github_id = ?1").bind("pro-1").first();
  expect(row.is_pro).toBe(1);
});

test("a subscriber RevenueCat has never heard of is not Pro", async () => {
  // 404 is an answer about the subscriber, not an outage.
  respond = () => new Response(JSON.stringify({ subscriber: { entitlements: {} } }), { status: 200 });
  expect(await isPro(billing(), "free-1")).toBe(false);

  respond = () => new Response("not found", { status: 404 });
  expect(await isPro(billing(), "free-2")).toBe(false);
});

test("an expired entitlement is not Pro", async () => {
  respond = () => new Response(JSON.stringify({
    subscriber: { entitlements: { "honmaruai Pro": { expires_date: "2020-01-01T00:00:00Z" } } },
  }), { status: 200 });
  expect(await isPro(billing(), "lapsed-1")).toBe(false);
});

test("with no billing configured nobody is Pro and nothing is asked", async () => {
  respond = () => { throw new Error("RevenueCat must not be called"); };
  expect(await isPro(env, "anyone")).toBe(false);
});

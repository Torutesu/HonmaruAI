import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { signup } from "../src/auth.js";
import { getSession } from "../src/db.js";
import { deleteAccount } from "../src/account.js";
import { COMPLIMENTARY_PROMO_END_MS, redeemComplimentaryAccess, ensureComplimentarySynced,
  prepareComplimentaryDeletion, hasComplimentaryAccess } from "../src/complimentary.js";

const CODE = "OnlyForLocalTests";
const PRO = "honmaruai Pro";
const PRODUCT = "rc_promo_honmaruai_pro_custom";
const EXPIRES = new Date(COMPLIMENTARY_PROMO_END_MS).toISOString();
const configured = (extra = {}) => ({ ...env, COMPLIMENTARY_ACCESS_CODE: CODE, REVENUECAT_SECRET_KEY: "sk-test", ...extra });
let account, id, path;
const customer = (promotional = false, paid = false) => ({ subscriber: {
  entitlements: promotional ? { [PRO]: { product_identifier: PRODUCT, expires_date: EXPIRES } }
    : paid ? { [PRO]: { product_identifier: "monthly", expires_date: "2099-01-01T00:00:00Z" } } : {},
  subscriptions: {
    ...(paid ? { monthly: { store: "app_store", expires_date: "2099-01-01T00:00:00Z", unsubscribe_detected_at: null } } : {}),
    ...(promotional ? { [PRODUCT]: { store: "promotional", expires_date: EXPIRES, refunded_at: null } } : {}),
  },
} });
const mockGet = (body, status = 200) => fetchMock.get("https://api.revenuecat.com")
  .intercept({ path, method: "GET" }).reply(status, body);
const mockGrant = (body = customer(true), status = 201) => fetchMock.get("https://api.revenuecat.com")
  .intercept({ path: `${path}/entitlements/${encodeURIComponent(PRO)}/promotional`, method: "POST",
    body: JSON.stringify({ end_time_ms: COMPLIMENTARY_PROMO_END_MS }) }).reply(status, body);
const mockRevoke = (body = customer(), status = 200) => fetchMock.get("https://api.revenuecat.com")
  .intercept({ path: `${path}/entitlements/${encodeURIComponent(PRO)}/revoke_promotionals`, method: "POST", body: "{}" }).reply(status, body);
const request = (route, method = "GET", body, config = configured()) => worker.fetch(new Request(`https://example.com${route}`, {
  method, headers: { "x-session-token": account.token, "content-type": "application/json", "CF-Connecting-IP": "192.0.2.2" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), config, {});
const redeem = () => request("/billing/redeem", "POST", { code: CODE, userId: "victim" });
const record = () => env.DB.prepare("SELECT * FROM complimentary_access WHERE user_github_id = ?1").bind(id).first();
const seedGrant = async (synced = false) => {
  await redeemComplimentaryAccess({ ...env, COMPLIMENTARY_ACCESS_CODE: CODE }, id, CODE);
  if (synced) await env.DB.prepare("UPDATE complimentary_access SET rc_attempted_at = ?2, rc_synced_at = ?2 WHERE user_github_id = ?1")
    .bind(id, new Date().toISOString()).run();
};

beforeAll(async () => { await env.DB.exec(schemaSql.replace(/\n/g, " ")); });
beforeEach(async () => {
  fetchMock.activate();
  account = await signup(env, { email: "promo+test@example.com", password: "password123", name: "Promo" });
  id = account.userId;
  path = `/v1/subscribers/${encodeURIComponent(id)}`;
});
afterEach(() => { fetchMock.assertNoPendingInterceptors(); vi.restoreAllMocks(); });

test("authenticated redemption bridges the exact account and entitlement once", async () => {
  mockGet(customer(), 201); mockGrant();
  const response = await redeem();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ pro: true, complimentary: true, complimentarySyncPending: false });
  expect((await record()).rc_synced_at).toBeTruthy();
  expect((await redeem()).status).toBe(200); // No second provider call.
  expect(await hasComplimentaryAccess(env, "victim")).toBe(false);
  expect(path).toContain("email%3Apromo%2Btest%40example.com");
});

test("an active paid subscription still needs a promo and is never cancelled", async () => {
  mockGet(customer(false, true)); mockGrant(customer(true, true));
  expect((await redeem()).status).toBe(200);
  expect((await record()).rc_synced_at).toBeTruthy();
});

test("a provider outage saves the grant and status refresh recovers without the code", async () => {
  mockGet({}, 503);
  const failed = await redeem();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ complimentary: true, complimentarySyncPending: true });
  expect(await hasComplimentaryAccess(env, id)).toBe(true);
  expect((await record()).rc_synced_at).toBeNull();
  mockGet(customer()); mockGrant();
  expect(await (await request("/billing/status")).json()).toMatchObject({ complimentarySyncPending: false });
});

test("an uncertain POST is recognized on retry instead of granted twice", async () => {
  mockGet(customer()); mockGrant({}, 500);
  expect((await redeem()).status).toBe(503);
  expect((await record()).rc_attempted_at).toBeTruthy();
  mockGet(customer(true));
  expect(await (await request("/billing/status")).json()).toMatchObject({ complimentarySyncPending: false });
});

test("a database failure after provider success is retryable without another grant", async () => {
  await seedGrant();
  let failOnce = true;
  const DB = { prepare(sql) {
    if (failOnce && sql.includes("SET rc_synced_at = ?2")) { failOnce = false; throw new Error("test storage outage"); }
    return env.DB.prepare(sql);
  } };
  mockGet(customer()); mockGrant();
  expect(await ensureComplimentarySynced(configured({ DB }), id)).toBe(false);
  expect((await record()).rc_synced_at).toBeNull();
  mockGet(customer(true));
  expect(await ensureComplimentarySynced(configured(), id)).toBe(true);
});

test.each(["paid", "other-entitlement", "short-expiry", "wrong-store"])("a 201 with %s is not a confirmed promotional grant", async (variant) => {
  const body = customer(true);
  if (variant === "paid") {
    Object.assign(body, customer(false, true));
  } else if (variant === "other-entitlement") {
    body.subscriber.entitlements.other = body.subscriber.entitlements[PRO];
    delete body.subscriber.entitlements[PRO];
  } else if (variant === "short-expiry") {
    body.subscriber.entitlements[PRO].expires_date = "2099-01-01T00:00:00Z";
  } else {
    body.subscriber.subscriptions[PRODUCT].store = "app_store";
  }
  mockGet(customer()); mockGrant(body);
  expect((await redeem()).status).toBe(503);
  expect((await record()).rc_synced_at).toBeNull();
});

test("network failure leaves an honest pending state and never stores remote error text", async () => {
  fetchMock.get("https://api.revenuecat.com").intercept({ path, method: "GET" }).replyWithError(new Error("private provider detail"));
  const response = await redeem();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private provider detail");
  expect((await record()).rc_synced_at).toBeNull();
});

test("does not adopt an identical pre-existing promo without a recorded attempt", async () => {
  mockGet(customer(true));
  expect((await redeem()).status).toBe(503);
  expect((await record()).rc_synced_at).toBeNull();
});

test("concurrent synchronization has a single provider writer", async () => {
  await seedGrant();
  const requests = vi.spyOn(globalThis, "fetch");
  mockGet(customer()).delay(30); mockGrant();
  const results = await Promise.all([ensureComplimentarySynced(configured(), id), ensureComplimentarySynced(configured(), id)]);
  expect(results).toContain(true);
  expect(requests).toHaveBeenCalledTimes(2);
  expect((await record()).rc_synced_at).toBeTruthy();
});

test("deletion waits for an in-flight synchronization lease", async () => {
  await seedGrant();
  await env.DB.prepare("UPDATE complimentary_access SET rc_operation_until = ?2 WHERE user_github_id = ?1")
    .bind(id, Date.now() + 30_000).run();
  expect(await prepareComplimentaryDeletion(configured(), id)).toBe(false);
  expect(await getSession(env.DB, account.token)).toBeTruthy();
});

test("deletion revokes our promo first and preserves an existing paid subscription", async () => {
  await seedGrant(true);
  mockGet(customer(true, true)); mockRevoke(customer(false, true));
  expect((await request("/account", "DELETE")).status).toBe(200);
  expect(await record()).toBeNull();
  expect(await getSession(env.DB, account.token)).toBeNull();
});

test("revocation failure cannot report completed deletion and a retry completes it", async () => {
  await seedGrant(true);
  mockGet(customer(true)); mockRevoke({}, 503);
  expect((await request("/account", "DELETE")).status).toBe(503);
  expect(await getSession(env.DB, account.token)).toBeTruthy();
  expect((await record()).deletion_requested_at).toBeTruthy();
  expect(await ensureComplimentarySynced(configured(), id)).toBe(false);
  mockGet(customer(true)); mockRevoke();
  expect((await request("/account", "DELETE")).status).toBe(200);
});

test("does not revoke a different promotion alongside ours", async () => {
  await seedGrant(true);
  const mixed = customer(true);
  mixed.subscriber.subscriptions.other = { store: "promotional", expires_date: "2099-01-01T00:00:00Z" };
  mockGet(mixed);
  expect((await request("/account", "DELETE")).status).toBe(503);
  expect(await getSession(env.DB, account.token)).toBeTruthy();
});

test("deletion tombstone blocks a previously authenticated redemption with no prior grant", async () => {
  expect(await prepareComplimentaryDeletion(configured(), id)).toBe(true);
  expect(await hasComplimentaryAccess(env, id)).toBe(false);
  expect(await redeemComplimentaryAccess(configured(), id, CODE)).toBe(false);
  expect(await ensureComplimentarySynced(configured(), id)).toBe(false);
});

test("missing provider credentials cannot skip cleanup of a previously synced grant", async () => {
  await seedGrant(true);
  expect(await prepareComplimentaryDeletion(env, id)).toBe(false);
  expect(await getSession(env.DB, account.token)).toBeTruthy();
});

test("newly registered same email does not recover a revoked complimentary grant", async () => {
  await seedGrant(true);
  mockGet(customer(true)); mockRevoke();
  expect((await request("/account", "DELETE")).status).toBe(200);
  account = await signup(env, { email: "promo+test@example.com", password: "password456", name: "New" });
  mockGet(customer());
  expect(await (await request("/billing/status")).json()).toMatchObject({ pro: false, complimentary: false });
});


test("missing provider credentials stay pending and status recovers after configuration", async () => {
  const response = await request("/billing/redeem", "POST", { code: CODE }, configured({ REVENUECAT_SECRET_KEY: undefined }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ pro: true, complimentary: true, complimentarySyncPending: true });
  expect((await record()).rc_synced_at).toBeNull();
  expect(await ensureComplimentarySynced(env, id)).toBe(false);
  mockGet(customer()); mockGrant();
  expect(await (await request("/billing/status")).json()).toMatchObject({ complimentarySyncPending: false });
  // A previously verified grant stays confirmed if configuration later disappears.
  expect(await ensureComplimentarySynced(env, id)).toBe(true);
});

test("deletion preserves its tombstone until the user row is removed", async () => {
  await seedGrant();
  expect(await prepareComplimentaryDeletion(configured(), id)).toBe(true);
  let reachedUserDeletion, resumeDeletion;
  const reached = new Promise(resolve => { reachedUserDeletion = resolve; });
  const release = new Promise(resolve => { resumeDeletion = resolve; });
  const DB = { prepare(sql) {
    const statement = env.DB.prepare(sql);
    if (sql !== "DELETE FROM users WHERE github_id = ?1") return statement;
    return { bind(...values) {
      const bound = statement.bind(...values);
      return { async run() {
        reachedUserDeletion();
        await release;
        return bound.run();
      } };
    } };
  } };
  const deleting = deleteAccount(DB, id, account.login);
  await reached;
  try {
    expect((await record())?.deletion_requested_at).toBeTruthy();
    expect(await redeemComplimentaryAccess(configured(), id, CODE)).toBe(false);
    expect(await ensureComplimentarySynced(configured(), id)).toBe(false);
  } finally {
    resumeDeletion();
    await deleting;
  }
  expect(await record()).toBeNull();
  // Requests authenticated before deletion cannot recreate a grant afterward.
  expect(await redeemComplimentaryAccess(configured(), id, CODE)).toBe(false);
  expect(await record()).toBeNull();
});

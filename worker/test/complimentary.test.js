import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { signup } from "../src/auth.js";
import { createSession, getSession, countAIUse } from "../src/db.js";
import { hasComplimentaryAccess } from "../src/complimentary.js";
import { checkAIAllowance, UNBILLED_DAILY_ROUTES } from "../src/gate.js";
import { deleteAccount } from "../src/account.js";

const TEST_CODE = "PrivateTestOnly2026";
const configured = () => ({ ...env, COMPLIMENTARY_ACCESS_CODE: TEST_CODE });
let account, identity;

beforeAll(async () => { await env.DB.exec(schemaSql.replace(/\n/g, " ")); });
beforeEach(async () => {
  fetchMock.activate();
  account = await signup(env, { email: "access@example.com", password: "password123", name: "Access" });
  identity = await getSession(env.DB, account.token);
});
afterEach(() => { fetchMock.assertNoPendingInterceptors(); vi.restoreAllMocks(); });

const redeem = (code = TEST_CODE, token = account.token, e = configured(), extra = {}) => worker.fetch(
  new Request("https://example.com/billing/redeem", {
    method: "POST", headers: { "content-type": "application/json", "x-session-token": token, "CF-Connecting-IP": "192.0.2.1" },
    body: JSON.stringify({ code, ...extra }),
  }), e, {}
);
const status = (token, e = configured()) => worker.fetch(new Request("https://example.com/billing/status", {
  headers: { "x-session-token": token },
}), e, {});

test("requires a real session and never lets caller grant another account", async () => {
  expect((await redeem(TEST_CODE, "fake")).status).toBe(401);
  expect((await redeem(TEST_CODE, account.token, configured(), { userId: "victim", pro: true })).status).toBe(503);
  expect(await hasComplimentaryAccess(env, identity.github_id)).toBe(true);
  expect(await hasComplimentaryAccess(env, "victim")).toBe(false);
});

test("wrong code, wrong case and malformed bodies cannot grant access", async () => {
  for (const code of ["wrong", TEST_CODE.toLowerCase(), null, { code: TEST_CODE }, "x".repeat(1100)]) {
    expect((await redeem(code)).status).toBe(400);
  }
  const malformed = await worker.fetch(new Request("https://example.com/billing/redeem", {
    method: "POST", headers: { "x-session-token": account.token }, body: "{",
  }), configured(), {});
  expect(malformed.status).toBe(400);
  expect(await hasComplimentaryAccess(env, identity.github_id)).toBe(false);
});

test("private code saves permanent access but reports iOS activation pending without provider credentials", async () => {
  const logs = vi.spyOn(console, "log");
  const res = await redeem(` ${TEST_CODE} `);
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toMatchObject({ pro: true, plan: "pro", complimentary: true, complimentarySyncPending: true, accessSource: "complimentary", remainingToday: null });
  expect(JSON.stringify(logs.mock.calls)).not.toContain(TEST_CODE);
  expect((await redeem()).status).toBe(503);
  const rows = await env.DB.prepare("SELECT * FROM complimentary_access").all();
  expect(rows.results).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(TEST_CODE);
  // Secret removal stops new redemptions, not previously granted access.
  expect((await redeem(TEST_CODE, account.token, env)).status).toBe(503);
  const next = await status(account.token, env);
  expect(next.headers.get("cache-control")).toBe("no-store");
  expect(await next.json()).toMatchObject({ complimentary: true, pro: true, complimentarySyncPending: true, complimentaryAvailable: false });
});

test("grant follows the same account across sessions and never another account", async () => {
  await redeem();
  const nextToken = await createSession(env.DB, identity.github_id, "");
  expect(await (await status(nextToken)).json()).toMatchObject({ complimentary: true, pro: true });
  const other = await signup(env, { email: "other-access@example.com", password: "password123", name: "Other" });
  expect(await (await status(other.token)).json()).toMatchObject({ complimentary: false, pro: false });
});

test("complimentary routing bypasses daily quota with or without RevenueCat", async () => {
  await redeem();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < UNBILLED_DAILY_ROUTES; i++) await countAIUse(env.DB, identity.github_id, day);
  for (const e of [env, { ...env, REVENUECAT_SECRET_KEY: "sk-test-unreachable" }]) {
    expect(await checkAIAllowance(e, { githubId: identity.github_id })).toMatchObject({ allowed: true, metered: false, quotaExceeded: false });
  }
  expect(await checkAIAllowance(env, { githubId: null })).toMatchObject({ allowed: false });
});

test("account rate limit survives session rotation", async () => {
  for (let i = 0; i < 10; i++) expect((await redeem("wrong")).status).toBe(400);
  const newToken = await createSession(env.DB, identity.github_id, "");
  const limited = await redeem(TEST_CODE, newToken);
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await hasComplimentaryAccess(env, identity.github_id)).toBe(false);
});

test("rate-limit storage failure does not grant access", async () => {
  const db = { prepare(sql) {
    if (sql.includes("rate_limits")) throw new Error("rate limiter unavailable");
    return env.DB.prepare(sql);
  } };
  expect((await redeem(TEST_CODE, account.token, { ...configured(), DB: db })).status).toBe(500);
  expect(await hasComplimentaryAccess(env, identity.github_id)).toBe(false);
});

test("account deletion removes free access and invalidates its session", async () => {
  await redeem();
  await deleteAccount(env.DB, identity.github_id, account.login);
  expect(await hasComplimentaryAccess(env, identity.github_id)).toBe(false);
  expect((await status(account.token)).status).toBe(401);
});

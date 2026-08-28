import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertMembership, upsertUser, countAIUse, writeEntitlement } from "../src/db.js";
import { FREE_DAILY_ROUTES } from "../src/gate.js";

// A separate file from sync.test.js on purpose: that file's last block leaves a
// persisted api.openai.com interceptor registered, which would answer these
// calls ahead of the counting one below and hide exactly what this test exists
// to measure. This env also carries REVENUECAT_SECRET_KEY, which is what turns
// metering on at all.
const METERED = {
  ...env,
  COMPOSIO_API_KEY: "ak_test",
  OPENAI_API_KEY: "sk-test",
  REVENUECAT_SECRET_KEY: "sk-rc",
};

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "800", "gho_sync_gate");
  await upsertUser(env.DB, { githubId: "800", login: "octocat", name: "Octo", avatarUrl: "", locale: "en" });
  await upsertMembership(env.DB, "acme/web", "800", "Engineer");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const mail = (id) => ({
  messageId: id,
  subject: `Invoice ${id} needs approval`,
  sender: "billing@acme.com",
  preview: { body: "Approve by Friday." },
  messageTimestamp: "2026-08-10T01:00:00Z",
});

const sync = () =>
  worker.fetch(
    new Request("https://example.com/connectors/gmail/sync", {
      method: "POST",
      headers: { "x-session-token": token, "content-type": "application/json" },
      body: JSON.stringify({ orgId: "acme/web", userId: "octocat" }),
    }),
    METERED
  );

const usedToday = async () => {
  const row = await env.DB
    .prepare("SELECT used FROM ai_usage WHERE user_github_id = '800' AND day = ?1")
    .bind(new Date().toISOString().slice(0, 10))
    .first();
  return row ? Number(row.used) : 0;
};

test("a sync stops asking the model once the day's allowance runs out", async () => {
  // One route left today, and three messages waiting.
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FREE_DAILY_ROUTES - 1; i += 1) await countAIUse(env.DB, "800", day);

  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [mail("m-1"), mail("m-2"), mail("m-3")] } }));

  // Free, and persisted because the entitlement is asked for once per sync and
  // then served from the D1 cache.
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/800") })
    .reply(200, { subscriber: { entitlements: {} } })
    .persist();

  // The model would happily answer all three. Counting the calls is the only
  // thing that proves the gate stopped the loop rather than the triage merely
  // declining to make cards.
  // Persisted, because a single-use interceptor would make the bug invisible:
  // an unmatched call throws inside triageMessage's catch and comes back
  // looking exactly like "we never called the model". It must also match only
  // THIS block's messages — a persisted interceptor stays registered for the
  // rest of the file and would otherwise answer the later blocks too.
  let modelCalls = 0;
  fetchMock.get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions",
      method: "POST",
      body: (b) => {
        if (!b.includes("Invoice m-")) return false;
        modelCalls += 1;
        return true;
      },
    })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({
      needsDecision: true, cardType: "approval", title: "Approve the invoice",
      summary: "Acme is waiting.", context: "deadline: Friday", priority: "high" }) } }] }))
    .persist();

  const res = await sync();
  expect(res.status).toBe(200);

  // Asserted before the card count, because this is the claim: the spend is
  // bounded by the allowance, not by the number of messages. A sync that made
  // three calls and merely declined to file two cards would still be paying.
  expect(modelCalls).toBe(1);
  expect(await res.json()).toMatchObject({ scanned: 3, created: 1 });
  expect(await usedToday()).toBe(FREE_DAILY_ROUTES);

  // Every message is recorded either way, so the two we could not afford today
  // are not re-judged on the next sync.
  const { results } = await env.DB
    .prepare("SELECT external_id, card_id FROM ingested_items WHERE connector='gmail' ORDER BY external_id")
    .all();
  expect(results.map((r) => r.external_id)).toEqual(["m-1", "m-2", "m-3"]);
  expect(results.filter((r) => r.card_id !== null)).toHaveLength(1);
  expect(results.filter((r) => r.card_id === null).map((r) => r.external_id)).toEqual(["m-2", "m-3"]);
});

// The hole: metering card creations rather than model calls let an inbox of
// noise — which is most inboxes, and exactly what the triage prompt is designed
// to say "no" to — run the model for free.
test("mail the model judges as needing nothing is still metered", async () => {
  // Free, seeded straight into the entitlement cache rather than with a second
  // persisted RevenueCat interceptor: the one in the first block stays
  // registered for the whole file and would be matched ahead of it, leaving the
  // new one uninvoked and failing assertNoPendingInterceptors.
  await writeEntitlement(env.DB, "800", false);
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [mail("n-1"), mail("n-2")] } }));

  let modelCalls = 0;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST",
      body: (b) => { if (!b.includes("Invoice n-")) return false; modelCalls += 1; return true; } })
    .reply(200, () => ({ choices: [{ message: { content: JSON.stringify({ needsDecision: false }) } }] }))
    .persist();

  expect(await (await sync()).json()).toMatchObject({ scanned: 2, created: 0 });
  expect(modelCalls).toBe(2);
  // Zero cards, two paid-for calls, two consumed.
  expect(await usedToday()).toBe(2);
});

test("a model call that never lands is not charged to the user", async () => {
  // Free, seeded straight into the entitlement cache rather than with a second
  // persisted RevenueCat interceptor: the one in the first block stays
  // registered for the whole file and would be matched ahead of it, leaving the
  // new one uninvoked and failing assertNoPendingInterceptors.
  await writeEntitlement(env.DB, "800", false);
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_FETCH_EMAILS", method: "POST" })
    .reply(200, () => ({ successful: true, data: { messages: [mail("f-1"), mail("f-2")] } }));

  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST",
      body: (b) => b.includes("Invoice f-") })
    .reply(500, "openai is down")
    .persist();

  expect(await (await sync()).json()).toMatchObject({ scanned: 2, created: 0 });
  // An outage on our side must not spend the user's allowance.
  expect(await usedToday()).toBe(0);
});

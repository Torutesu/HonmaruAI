import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// A card in the reader's language, on request. The relay translates for the
// recipient; everyone else asks here, once per language, and the answer is
// kept on the card.

const ORG = "personal:l10n";
let toru;
let outsider;
const ENV = (over = {}) => ({ ...env, OPENAI_API_KEY: "sk-test", ...over });
const ctx = { waitUntil() {} };
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over), ctx);
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const localize = (token, cardId, locale, over) => call(`/cards/${cardId}/localize`, {
  method: "POST", headers: headers(token), body: JSON.stringify({ orgId: ORG, locale }),
}, over);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8901", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8902", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8901", "admin");
  await upsertMembership(env.DB, "personal:other", "8902", "admin");
  toru = await createSession(env.DB, "8901", "gho_toru");
  outsider = await createSession(env.DB, "8902", "gho_nobody");
  await saveCard(env.DB, ORG, {
    id: "l-1", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "Approve the supplier price +8%",
    summary: "Mika wants the Ethiopian supplier.", context: "deadline: Friday", status: "pending", priority: "high", createdAt: "2026-09-10T00:00:00Z",
  });
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a member gets the card in their language, it is kept, and the second reader pays nothing", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ title: "仕入価格の8%値上げを承認", summary: "美香はエチオピアの仕入先に変えたい。", context: "期限: 金曜" }) } }] })
    .times(1);
  let res = await localize(toru, "l-1", "ja");
  expect(res.status).toBe(200);
  expect((await res.json()).localized.title).toBe("仕入価格の8%値上げを承認");

  // Kept on the card: the next ask for Japanese is answered from it.
  res = await localize(toru, "l-1", "ja");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ already: true, localized: { title: "仕入価格の8%値上げを承認" } });
  const { getCard } = await import("../src/db.js");
  expect((await getCard(env.DB, ORG, "l-1")).localized.ja.context).toBe("期限: 金曜");
});

test("a card already in the reader's language is left alone; a stranger, an unknown language and a deployment without a model are refused", async () => {
  let res = await localize(toru, "l-1", "en");
  expect(res.status).toBe(200);
  expect((await res.json()).already).toBe(true);
  expect((await localize(outsider, "l-1", "ja")).status).toBe(403);
  expect((await localize(toru, "l-1", "xx")).status).toBe(400);
  expect((await localize(toru, "nope", "ja")).status).toBe(404);
  res = await localize(toru, "l-1", "ja", { OPENAI_API_KEY: undefined });
  expect(res.status).toBe(503);
});

test("a decision made while the model was translating survives the translation", async () => {
  const { getCard, saveCard } = await import("../src/db.js");
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, async () => {
      // The recipient decides while the model is still writing.
      const now = await getCard(env.DB, ORG, "l-1");
      await saveCard(env.DB, ORG, { ...now, status: "approved", decision: { action: "approve", decidedAt: "2026-09-11T00:00:00Z", by: "toru" } });
      return { choices: [{ message: { content: JSON.stringify({ title: "仕入価格の8%値上げを承認", summary: "美香はエチオピアの仕入先に変えたい。" }) } }] };
    })
    .times(1);
  const res = await localize(toru, "l-1", "ja");
  expect(res.status).toBe(200);
  const after = await getCard(env.DB, ORG, "l-1");
  expect(after.status).toBe("approved");
  expect(after.decision.action).toBe("approve");
  expect(after.localized.ja.title).toBe("仕入価格の8%値上げを承認");
});

test("the last of a metered day's allowance is kept for the person's own instruction", async () => {
  const { countAIUse } = await import("../src/db.js");
  const { FREE_DAILY_ROUTES } = await import("../src/gate.js");
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/8901") })
    .reply(200, { subscriber: { entitlements: {} } }).persist();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FREE_DAILY_ROUTES - 1; i += 1) await countAIUse(env.DB, "8901", day);
  // No OpenAI interceptor: reaching the model here would fail the test.
  const res = await localize(toru, "l-1", "ja", { REVENUECAT_SECRET_KEY: "sk-rc" });
  expect(res.status).toBe(429);
  expect((await res.json()).quotaExceeded).toBe(true);
});

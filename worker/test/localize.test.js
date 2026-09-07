import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { detectLanguage, needsLocalizing, localizeCard } from "../src/localize.js";
import { joined, message } from "./helpers.js";

// The router writes a card in the sender's language. The relay is the first
// place that knows the recipient too, so it is where the card is put into the
// language of the person who has to decide it.

const ORG = "acme/app";
let taroToken;

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "5201", login: "taro", name: "Taro", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "5202", login: "alice", name: "Alice", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "5201", "admin");
  await upsertMembership(env.DB, ORG, "5202", "member");
  taroToken = await createSession(env.DB, "5201", "gho_taro");
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const provider = { endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "gpt-4o-mini" };

test("the language of a card is read off its script", () => {
  expect(detectLanguage("Approve the Q3 budget")).toBe("en");
  expect(detectLanguage("Q3予算を承認してください")).toBe("ja");
  expect(detectLanguage("예산 승인")).toBe("ko");
  expect(detectLanguage("   ")).toBeNull();
});

test("a card already in the reader's language, or already translated for them, is left alone", () => {
  expect(needsLocalizing({ title: "Approve the lease" }, "en")).toBe(false);
  expect(needsLocalizing({ title: "Approve the lease" }, "ja")).toBe(true);
  expect(needsLocalizing({ title: "賃貸契約の承認" }, "ja")).toBe(false);
  expect(needsLocalizing({ title: "Approve the lease", localized: { ja: { title: "賃貸契約の承認" } } }, "ja")).toBe(false);
  expect(needsLocalizing({ title: "Approve the lease" }, null)).toBe(false);
});

test("localizeCard asks the model once, stores the answer under the locale, and spends the allowance", async () => {
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { prompt = JSON.parse(b); return true; } })
    .reply(200, {
      choices: [{ message: { content: JSON.stringify({
        title: "オフィス賃貸契約の承認", summary: "2フロア、5年契約。", context: "期限: 金曜 · 金額: 400万円",
      }) } }],
    });

  let consumed = 0;
  const card = { id: "c-1", recipientUserID: "taro", title: "Approve the office lease", summary: "Two floors, five years.", context: "deadline: Friday · amount: 4M yen" };
  const out = await localizeCard(card, {
    provider, locale: "ja", allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  });
  expect(out.localized.ja).toEqual({ title: "オフィス賃貸契約の承認", summary: "2フロア、5年契約。", context: "期限: 金曜 · 金額: 400万円" });
  // The original is untouched: the sender still reads their own words.
  expect(out.title).toBe("Approve the office lease");
  expect(consumed).toBe(1);
  expect(prompt.messages[1].content).toContain("Reader language: ja");
});

test("no provider, no allowance, or a model that does not answer means no translation and no charge", async () => {
  const card = { id: "c-2", recipientUserID: "taro", title: "Approve the lease" };
  expect(await localizeCard(card, { provider: undefined, locale: "ja" })).toBeNull();
  expect(await localizeCard(card, { provider, locale: "ja", allowance: { allowed: false } })).toBeNull();

  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(500, {});
  let consumed = 0;
  const out = await localizeCard(card, {
    provider, locale: "ja", allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  });
  expect(out).toBeNull();
  expect(consumed).toBe(0);

  // A model that answered nonsense was still paid for.
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: "sorry, no" } }] });
  expect(await localizeCard(card, {
    provider, locale: "ja", allowance: { allowed: true, metered: true, consume: async () => { consumed += 1; } },
  })).toBeNull();
  expect(consumed).toBe(1);
});

test("a card still arrives, unchanged, when the relay has no model to translate with", async () => {
  // The DO under test has no provider key, and taro reads Japanese: the
  // localizer must step aside rather than stall or drop the card.
  const taro = await joined(ORG, taroToken);
  taro.ws.send(JSON.stringify({
    type: "card_created",
    payload: { card: {
      id: "card-plain", type: "task", status: "pending", recipientUserID: "taro",
      title: "Approve the lease", summary: "Two floors.", priority: "medium", createdAt: new Date().toISOString(),
    } },
  }));
  const seen = await message(taro.messages, (m) => JSON.stringify(m).includes("card-plain"));
  expect(seen).toBeTruthy();
  const { getCard } = await import("../src/db.js");
  const stored = await getCard(env.DB, ORG, "card-plain");
  expect(stored.title).toBe("Approve the lease");
  expect(stored.localized).toBeUndefined();
});

import {env} from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { detectLanguage, needsLocalizing, localizeCard, localizeForRecipient, localizeStored } from "../src/localize.js";
import { joined, message } from "./helpers.js";

// The router writes a card in the sender's language. The relay is the first
// place that knows the recipient too, so it is where the card is put into the
// language of the person who has to decide it.

const ORG = "acme/app";
let taroToken;

beforeEach(async () => {
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

test("the language of a card is placed whatever it was written in, and a guess is not an answer", () => {
  expect(detectLanguage("¿Aprobamos el presupuesto de marketing?")).toBe("es");
  expect(detectLanguage("Merci de valider le budget avant vendredi")).toBe("fr");
  expect(detectLanguage("Bitte genehmigen Sie das Budget für Q3")).toBe("de");
  expect(detectLanguage("Bạn có duyệt ngân sách không?")).toBe("vi");
  expect(detectLanguage("Mohon setujui anggaran untuk Q3")).toBe("id");
  expect(detectLanguage("อนุมัติงบประมาณไหม")).toBe("th");
  expect(detectLanguage("هل نوافق على الميزانية؟")).toBe("ar");
  expect(detectLanguage("बजट को मंज़ूरी दें")).toBe("hi");
  expect(detectLanguage("批准第三季度预算")).toBe("zh");
  expect(detectLanguage("Затвердити бюджет і план")).toBe("uk");
  // A Japanese sentence with an English word in it is Japanese; an English
  // one with a Japanese name in it is not Chinese.
  expect(detectLanguage("田中さんの予算 Q3 budget approval")).toBe("ja");
  expect(detectLanguage("Approve 田中 budget?")).not.toBe("zh");
  // Too little to tell: the translator decides, not a guess.
  expect(detectLanguage("Presupuesto Q3")).toBe("und");
  expect(detectLanguage("12345")).toBeNull();
});

test("a card in any other language is translated for its reader, and only a card known to be theirs is not", () => {
  // The bug this replaces: every Latin-script language read as English.
  expect(needsLocalizing({ title: "¿Aprobamos el presupuesto de marketing?" }, "en")).toBe(true);
  expect(needsLocalizing({ title: "Bạn có duyệt ngân sách không?" }, "en")).toBe(true);
  expect(needsLocalizing({ title: "อนุมัติงบประมาณไหม" }, "en")).toBe(true);
  expect(needsLocalizing({ title: "Approve the lease" }, "vi")).toBe(true);
  expect(needsLocalizing({ title: "¿Aprobamos el presupuesto de marketing?" }, "es")).toBe(false);
  // Undetermined goes to the model, which returns it unchanged if it was theirs.
  expect(needsLocalizing({ title: "Presupuesto Q3" }, "es")).toBe(true);
  // A region is not a language, and the model's own report for this reader is theirs.
  expect(needsLocalizing({ title: "賃貸契約の承認" }, "ja-JP")).toBe(false);
  expect(needsLocalizing({ title: "Presupuesto Q3", originalLanguage: "es" }, "es")).toBe(false);
  expect(needsLocalizing({ title: "Approve the lease", localized: { vi: { title: "Phê duyệt hợp đồng thuê" } } }, "vi-VN")).toBe(false);
});

test("a stored card reaches a reader of any language in theirs, is kept, and is asked for once", async () => {
  const { upsertUser, saveCard, getCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "5203", login: "linh", name: "Linh", avatarUrl: null, locale: "vi" });
  const card = {
    id: "c-vi", recipientUserID: "linh", senderUserID: "taro", type: "approval", status: "pending", priority: "high",
    title: "Q3予算を承認してください", summary: "マーケティングが400万円を追加で希望", createdAt: "2026-09-10T00:00:00Z",
  };
  await saveCard(env.DB, ORG, card);
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { prompt = JSON.parse(b); return true; } })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ title: "Vui lòng phê duyệt ngân sách Q3", summary: "Marketing muốn thêm 4 triệu yên" }) } }] })
    .times(1);
  const withKey = { ...env, OPENAI_API_KEY: "sk-test" };
  const out = await localizeForRecipient(withKey, ORG, card, { payerGithubId: "5201" });
  expect(out.localized.vi.title).toBe("Vui lòng phê duyệt ngân sách Q3");
  expect(prompt.messages[1].content).toContain("Reader language: vi (Vietnamese)");
  expect((await getCard(env.DB, ORG, "c-vi")).localized.vi.title).toBe("Vui lòng phê duyệt ngân sách Q3");
  // The second time is read off the card: no model call is mocked for it.
  expect((await localizeForRecipient(withKey, ORG, out)).localized.vi.title).toBe("Vui lòng phê duyệt ngân sách Q3");
  // Billed to whoever caused it.
  const row = await env.DB.prepare("SELECT user_github_id, purpose FROM ai_calls WHERE org_id = ?1").bind(ORG).first();
  expect(row).toMatchObject({ user_github_id: "5201", purpose: "localize" });
});

test("without a model the card is handed back as it was, never lost", async () => {
  const card = { id: "c-none", recipientUserID: "alice", title: "Q3予算を承認してください" };
  expect(await localizeStored({ ...env, OPENAI_API_KEY: undefined }, ORG, card, { locale: "en" })).toBe(card);
  expect(await localizeStored(env, ORG, card, { locale: null })).toBe(card);
});

test("a translation is the relay's to write: a sender cannot supply one, and a republished copy cannot drop one", async () => {
  const taro = await joined(ORG, taroToken);
  const base = {
    id: "card-forged", type: "task", status: "pending", recipientUserID: "taro", priority: "medium",
    title: "Approve the $100 refund", summary: "One customer.", createdAt: new Date().toISOString(),
  };
  taro.ws.send(JSON.stringify({
    type: "card_created",
    payload: { card: { ...base, localized: { ja: { title: "1万ドルの返金を承認" } } } },
  }));
  await message(taro.messages, (m) => JSON.stringify(m).includes("card-forged"));
  const { getCard, saveCardLocalization } = await import("../src/db.js");
  expect((await getCard(env.DB, ORG, "card-forged")).localized).toBeUndefined();

  // Somebody asked for Vietnamese since; the phone republishes the copy it
  // loaded before that, with a decision on it.
  await saveCardLocalization(env.DB, ORG, "card-forged", "vi", { title: "Phê duyệt hoàn tiền 100 đô" });
  taro.messages.length = 0;
  taro.ws.send(JSON.stringify({
    type: "card_updated",
    payload: { card: { ...base, status: "approved", localized: { ja: { title: "1万ドルの返金を承認" } },
      decision: { action: "approve", actorUserID: "taro", decidedAt: new Date().toISOString() } } },
  }));
  await message(taro.messages, (m) => JSON.stringify(m).includes("card-forged"));
  const stored = await getCard(env.DB, ORG, "card-forged");
  expect(stored.status).toBe("approved");
  expect(stored.localized).toEqual({ vi: { title: "Phê duyệt hoàn tiền 100 đô" } });
});

import { fetchMock } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { triageMessage } from "../src/triage.js";

const OPENAI = { endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "gpt-4o-mini" };
const message = {
  id: "m1", from: "billing@acme.com", subject: "Invoice #42 needs approval",
  snippet: "Please approve the attached invoice by Friday.", date: "2026-08-09T01:00:00Z",
};
const reply = (content) => ({ choices: [{ message: { content: JSON.stringify(content) } }] });

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a message that needs a decision becomes a card", async () => {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => reply({ needsDecision: true, cardType: "approval", title: "Approve invoice #42",
      summary: "Acme is waiting on approval for invoice #42.", context: "deadline: Friday", priority: "high" }));
  const card = await triageMessage(message, { provider: OPENAI, readerLanguage: "en" });
  expect(card).not.toBeNull();
  expect(card.title).toBe("Approve invoice #42");
  expect(card.priority).toBe("high");
});

test("a message that needs nothing produces no card", async () => {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => reply({ needsDecision: false }));
  expect(await triageMessage(message, { provider: OPENAI, readerLanguage: "en" })).toBeNull();
});

test("an unusable model reply is treated as no card, not a crash", async () => {
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, () => ({ choices: [{ message: { content: "not json" } }] }));
  expect(await triageMessage(message, { provider: OPENAI, readerLanguage: "en" })).toBeNull();
});

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { createSession, upsertUser, countAIUse } from "../src/db.js";
import { FREE_DAILY_ROUTES } from "../src/gate.js";

// "Give additional instructions to the AI" is one of the seven things the brief
// says a person can do with a card, and it was one of the two that did not
// exist. Your AI, your card: it reworks the one in front of you rather than
// sending anything to anyone.

const ENV = () => ({ ...env, OPENAI_API_KEY: "sk-server" });
const SELF = (init) => worker.fetch(new Request("https://example.com/ai/refine", init), ENV());

const CARD = {
  id: "c-1", recipientUserID: "grace", senderUserID: "ada",
  title: "Approve the vendor invoice", summary: "Ada needs the Q3 invoice paid.",
  context: "amount: 12400 · deadline: Friday", priority: "medium",
};

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: "900", login: "grace", name: "Grace", avatarUrl: "", locale: "en" });
  token = await createSession(env.DB, "900", "gho_grace");
});
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.deactivate());

const post = (body, headers = {}) => SELF({
  method: "POST",
  headers: { "content-type": "application/json", "x-session-token": token, ...headers },
  body: JSON.stringify(body),
});

test("your AI reworks the card in front of you, and is told what you asked", async () => {
  let sent;
  fetchMock.get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions", method: "POST",
      body: (b) => { sent = JSON.parse(b); return true; },
    })
    .reply(200, { choices: [{ message: { content: JSON.stringify({
      title: "Pay 12,400 to the vendor",
      summary: "One number, one date: 12,400 by Friday.",
      context: "amount: 12400 · deadline: Friday",
      priority: "high",
    }) } }] });

  const res = await post({ card: CARD, instruction: "Just give me the numbers." });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    title: "Pay 12,400 to the vendor",
    priority: "high",
  });
  expect(sent.messages.map((m) => m.content).join("\n")).toContain("Just give me the numbers.");
});

test("an empty instruction is refused before it costs anything", async () => {
  // No interceptor: reaching the model here fails the test.
  const blank = await post({ card: CARD, instruction: "   " });
  expect(blank.status).toBe(400);

  const noCard = await post({ instruction: "shorten it" });
  expect(noCard.status).toBe(400);

  const tooLong = await post({ card: CARD, instruction: "x".repeat(1001) });
  expect(tooLong.status).toBe(400);
});

test("asking your AI about a card requires being someone", async () => {
  const res = await SELF({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card: CARD, instruction: "shorten it" }),
  });
  expect(res.status).toBe(401);
});

test("out of allowance says so, rather than answering something else", async () => {
  // Routing degrades to a keyword router. There is no keyword version of "do
  // what I just asked", so pretending would be worse than saying no.
  const billed = { ...ENV(), REVENUECAT_SECRET_KEY: "sk-rc" };
  fetchMock.get("https://api.revenuecat.com")
    .intercept({ path: (p) => p.includes("/v1/subscribers/900") })
    .reply(200, { subscriber: { entitlements: {} } }).persist();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < FREE_DAILY_ROUTES; i += 1) await countAIUse(env.DB, "900", day);

  const res = await worker.fetch(new Request("https://example.com/ai/refine", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": token },
    body: JSON.stringify({ card: CARD, instruction: "shorten it" }),
  }), billed);

  expect(res.status).toBe(429);
  expect((await res.json()).quotaExceeded).toBe(true);
});

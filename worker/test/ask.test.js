import { env, SELF, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { searchTermsFor } from "../src/ask.js";

// "Ask anything" answers. It used to route the question to somebody as a new
// card — a question is not a decision, and the person asking wanted to know,
// not to delegate the knowing.

const ORG = "personal:ask";
let toru;
let outsider;
const ENV = (over = {}) => ({ ...env, OPENAI_API_KEY: "sk-test", ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over));
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8301", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8302", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8301", "admin");
  await upsertMembership(env.DB, "personal:other", "8302", "admin");
  toru = await createSession(env.DB, "8301", "gho_toru");
  outsider = await createSession(env.DB, "8302", "gho_nobody");
  await saveCard(env.DB, ORG, {
    id: "a-1", recipientUserID: "toru", senderUserID: "toru", type: "approval", title: "Approve the supplier price +8%",
    summary: "Kenji wants to move to the Ethiopian supplier.", status: "pending", priority: "high", createdAt: "2026-09-10T00:00:00Z",
  });
  await saveCard(env.DB, ORG, {
    id: "a-0", recipientUserID: "toru", senderUserID: "kenji", type: "approval", title: "Supplier price +5% for the cafe",
    status: "rejected", priority: "high", createdAt: "2026-08-01T00:00:00Z",
    decision: { action: "decline", actorUserID: "toru", decidedAt: "2026-08-02T00:00:00Z", replyText: "Not until the lease is settled" },
  });
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a question is answered from the card and what the team decided before", async () => {
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      prompt = JSON.parse(opts.body);
      return { choices: [{ message: { content: "You declined +5% on 2026-08-02 until the lease was settled. If the lease is signed now, +8% is the same question with a higher number." } }] };
    });

  const res = await call("/ai/ask", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ orgId: ORG, cardId: "a-1", question: "Did we decide something like this before?", readerLanguage: "en" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.answer).toContain("declined +5%");
  expect(body.related.map((r) => r.title)).toContain("Supplier price +5% for the cafe");

  // What the model was given: the card, and the earlier decision with its note.
  const user = prompt.messages.find((m) => m.role === "user").content;
  expect(user).toContain("Approve the supplier price +8%");
  expect(user).toContain("2026-08-02 toru decline: Supplier price +5% for the cafe");
  expect(user).toContain("Not until the lease is settled");
  expect(user).toContain("Reader language: en");
  expect(prompt.tools).toBeUndefined();

  // Asked, on the record.
  const { listCardEvents } = await import("../src/events.js");
  const events = await listCardEvents(env.DB, ORG, "a-1");
  expect(events.find((e) => e.type === "asked")?.note).toBe("Did we decide something like this before?");
});

test("a stranger, a missing card and an empty question are refused; no model is said out loud", async () => {
  let res = await call("/ai/ask", {
    method: "POST", headers: headers(outsider),
    body: JSON.stringify({ orgId: ORG, cardId: "a-1", question: "hi" }),
  });
  expect(res.status).toBe(403);
  res = await call("/ai/ask", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ orgId: ORG, cardId: "nope", question: "hi" }),
  });
  expect(res.status).toBe(404);
  res = await call("/ai/ask", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ orgId: ORG, cardId: "a-1", question: "   " }),
  });
  expect(res.status).toBe(400);
  // No key at all: the deployment says so rather than pretending.
  res = await call("/ai/ask", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ orgId: ORG, cardId: "a-1", question: "hi" }),
  }, { OPENAI_API_KEY: undefined });
  expect(res.status).toBe(503);
});

test("a model that says nothing is a 502, not an empty answer", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: "" } }] });
  const res = await call("/ai/ask", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ orgId: ORG, cardId: "a-1", question: "Why?" }),
  });
  expect(res.status).toBe(502);
});

test("search terms are the specific words, not the function words", () => {
  expect(searchTermsFor("Did we decide something like this before?", { title: "Approve the supplier price" }).split(" "))
    .toEqual(expect.arrayContaining(["supplier", "price"]));
  expect(searchTermsFor("前に仕入価格で決めたことはありますか？", { title: "" })).toContain("前に仕入価格で決めたことはありますか");
  expect(searchTermsFor("", { title: "" })).toBe("");
});

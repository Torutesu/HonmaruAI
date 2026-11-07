import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { draftLanguageFor } from "../src/draft.js";

// The reply back to whoever asked, drafted from the decision. A decision is
// one tap; the message telling the person who asked was still typed by hand.

const ORG = "personal:draft";
let toru;
let kenji;
let outsider;
const ENV = (over = {}) => ({ ...env, OPENAI_API_KEY: "sk-test", ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over));
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const draft = (token, cardId, over) => call("/ai/draft", {
  method: "POST", headers: headers(token), body: JSON.stringify({ orgId: ORG, cardId, readerLanguage: "en" }),
}, over);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8401", login: "toru", name: "Toru Tesu", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8402", login: "kenji", name: "Kenji", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8403", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8401", "admin");
  await upsertMembership(env.DB, ORG, "8402", "member");
  await upsertMembership(env.DB, "personal:other", "8403", "admin");
  toru = await createSession(env.DB, "8401", "gho_toru");
  kenji = await createSession(env.DB, "8402", "gho_kenji");
  outsider = await createSession(env.DB, "8403", "gho_nobody");
  await saveCard(env.DB, ORG, {
    id: "d-1", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "Approve the supplier price +8%",
    summary: "Mika wants to move to the Ethiopian supplier.", context: "deadline: Friday · amount: +8%",
    sourceApp: "Gmail",
    status: "rejected", priority: "high", createdAt: "2026-09-10T00:00:00Z",
    requestedBy: { name: "Mika", quote: "仕入価格を8%上げてもいいですか？" }, originalLanguage: "ja",
    decision: { action: "decline", actorUserID: "toru", decidedAt: "2026-09-11T00:00:00Z", replyText: "Not until the lease is settled" },
  });
  await env.DB.prepare(`INSERT INTO custom_agents (org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
    VALUES (?1,'agent-1','writer','Writer','Draft replies', 'personal','toru','2026-09-10T00:00:00Z','2026-09-10T00:00:00Z')`).bind(ORG).run();
  await saveCard(env.DB, ORG, {
    id: "d-agent", recipientUserID: "toru", senderUserID: "mika", type: "approval", title: "Reply from Agent",
    sourceApp: "Agent", sourceDetail: "Writer", sourceAgentId: "agent-1", status: "approved", priority: "medium",
    createdAt: "2026-09-10T00:00:00Z", decision: { action: "approve", actorUserID: "toru", decidedAt: "2026-09-11T00:00:00Z" },
  });
  await saveCard(env.DB, ORG, {
    id: "d-2", recipientUserID: "toru", senderUserID: "kenji", type: "approval", title: "Sign the hotel signage quote",
    status: "pending", priority: "medium", createdAt: "2026-09-11T00:00:00Z",
  });
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("the reply is drafted from the decision, in the request's language, signed by the decider", async () => {
  let prompt;
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      prompt = JSON.parse(opts.body);
      return { choices: [{ message: { content: "美香さん\n\n仕入価格の8%値上げは、今回は見送ります。賃貸契約が固まるまでは判断できないためです。\n\nToru Tesu" } }] };
    });

  const res = await draft(toru, "d-1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.draft).toContain("見送ります");
  expect(body.language).toBe("ja");

  const user = prompt.messages.find((m) => m.role === "user").content;
  expect(user).toContain("Write in: ja");
  expect(user).toContain("Decider (sign with this name): Toru Tesu");
  expect(user).toContain('"action":"decline"');
  expect(user).toContain("Not until the lease is settled");
  expect(user).toContain('"askedBy":"Mika"');
  expect(user).toContain("仕入価格を8%上げてもいいですか");
  expect(prompt.tools).toBeUndefined();

  // Drafted, on the record, so the thread shows a reply was written.
  const { listCardEvents } = await import("../src/events.js");
  const events = await listCardEvents(env.DB, ORG, "d-1");
  expect(events.find((e) => e.type === "drafted")?.note).toContain("見送ります");
});

test("a pending card, a stranger, a bystander and a deployment without a model are refused", async () => {
  expect((await draft(toru, "d-2")).status).toBe(409);
  expect((await draft(outsider, "d-1")).status).toBe(403);
  // Kenji is on the team but on neither end of this card.
  expect((await draft(kenji, "d-1")).status).toBe(403);
  expect((await draft(toru, "nope")).status).toBe(404);
  const res = await draft(toru, "d-1", { OPENAI_API_KEY: undefined });
  expect(res.status).toBe(503);
  expect((await res.json()).message).toMatch(/no model/);
});

test("a model that says nothing is a 502, not an empty draft", async () => {
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: "  " } }] });
  expect((await draft(toru, "d-1")).status).toBe(502);
});

test("edited Agent drafts are queued privately and attached once to the next message for that Agent", async () => {
  const original = "Hello team, here is the long update. Thanks!";
  const revised = "Team, short update.";
  const headersWithToken = { ...headers(toru), "x-session-token": toru };
  const queued = await call("/ai/draft-edits", {
    method: "POST", headers: headersWithToken,
    body: JSON.stringify({ orgId: ORG, cardId: "d-agent", original, revised }),
  });
  expect(queued.status).toBe(200);
  expect((await queued.json()).queued).toBe(true);
  const state = await call(`/ai/draft-edits?orgId=${encodeURIComponent(ORG)}&cardId=d-agent`, { headers: { "x-session-token": toru } });
  expect((await state.json()).queued).toBe(true);

  const { attachDraftEditsToMessage, consumeDraftEditContext, draftEditPrompt } = await import("../src/draftEdits.js");
  await attachDraftEditsToMessage(env.DB, { orgId: ORG, githubId: "8401", agentId: "agent-1", messageId: "msg-next" });
  const edits = await consumeDraftEditContext(env.DB, { orgId: ORG, messageId: "msg-next", agentId: "agent-1" });
  expect(edits).toHaveLength(1);
  expect(edits[0].removed_text).toBe("Hello team, here is the long update. Thanks!");
  expect(edits[0].added_text).toBe("Team, short update.");
  expect(draftEditPrompt(edits)).toContain("ask the user whether they want you to remember it");
  expect(await consumeDraftEditContext(env.DB, { orgId: ORG, messageId: "msg-next", agentId: "agent-1" })).toHaveLength(0);

  const queuedAgain = await call("/ai/draft-edits", {
    method: "POST", headers: headersWithToken,
    body: JSON.stringify({ orgId: ORG, cardId: "d-agent", original, revised }),
  });
  expect(queuedAgain.status).toBe(200);
  const removed = await call(`/ai/draft-edits?orgId=${encodeURIComponent(ORG)}&cardId=d-agent`, { method: "DELETE", headers: { "x-session-token": toru } });
  expect((await removed.json()).removed).toBe(1);
});

test("draft edit sharing refuses cards with no stable Agent identity and outsiders", async () => {
  const noOrigin = await call("/ai/draft-edits", {
    method: "POST", headers: headers(toru),
    body: JSON.stringify({ orgId: ORG, cardId: "d-1", original: "Hello", revised: "Hi" }),
  });
  expect(noOrigin.status).toBe(409);
  const outsiderResponse = await call("/ai/draft-edits", {
    method: "POST", headers: headers(outsider),
    body: JSON.stringify({ orgId: ORG, cardId: "d-agent", original: "Hello", revised: "Hi" }),
  });
  expect(outsiderResponse.status).toBe(403);
});

test("the draft speaks the request's language when the card remembers one, else the reader's", () => {
  expect(draftLanguageFor({ originalLanguage: "ja" }, "en")).toBe("ja");
  expect(draftLanguageFor({}, "en")).toBe("en");
  expect(draftLanguageFor({}, undefined)).toBe("en");
});

test("a person explicitly saves style signals from an edited draft and only their later drafts receive them", async () => {
  const original = `Hello Mika,\n\n${"The supplier price increase is being declined until we have confirmed the lease agreement and checked the related delivery schedule. ".repeat(2)}\n\nBest regards,\nToru`;
  const revised = "The supplier increase is declined until the lease is settled.";
  const learned = await call("/ai/draft-preferences", {
    method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, cardId: "d-1", original, revised }),
  });
  expect(learned.status).toBe(200);
  expect((await learned.json()).learned).toContainEqual(expect.objectContaining({ key: "concise" }));
  const stored = await env.DB.prepare("SELECT preference_text FROM hx_user_draft_style_preferences WHERE org_id=?1 AND user_github_id=?2").bind(ORG, "8401").all();
  expect(stored.results.map((r) => r.preference_text)).toContain("Prefer concise replies; remove unnecessary wording.");
  expect(JSON.stringify(stored.results)).not.toContain("supplier increase is declined");

  const otherMember = await (await call(`/ai/draft-preferences?orgId=${encodeURIComponent(ORG)}&sourceApp=Gmail`, { headers: headers(kenji) })).json();
  expect(otherMember.preferences).toEqual([]);
  expect((await call(`/ai/draft-preferences?orgId=${encodeURIComponent(ORG)}`, { headers: headers(outsider) })).status).toBe(403);

  let prompt;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => { prompt = JSON.parse(opts.body); return { choices: [{ message: { content: "Short reply" } }] }; });
  expect((await draft(toru, "d-1")).status).toBe(200);
  expect(prompt.messages.find((m) => m.role === "user").content).toContain("Prefer concise replies");

  const erased = await call(`/ai/draft-preferences?orgId=${encodeURIComponent(ORG)}&sourceApp=Gmail&key=concise`, { method: "DELETE", headers: headers(toru) });
  expect((await erased.json()).removed).toBeGreaterThan(0);
  const afterErase = await (await call(`/ai/draft-preferences?orgId=${encodeURIComponent(ORG)}&sourceApp=Gmail`, { headers: headers(toru) })).json();
  expect(afterErase.preferences.map((p) => p.key)).not.toContain("concise");
});



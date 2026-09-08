import { env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { OrgRelay } from "../src/relay.js";
import { ANNOUNCE_PATH } from "../src/announce.js";
import { getCard, saveCard, removeCard, upsertUser, upsertMembership, createSession } from "../src/db.js";
import { joined, message, until } from "./helpers.js";

const ORG = "release/integrity";
const tokens = {};
const original = (id) => ({
  id, recipientUserID: "reader", senderUserID: "author", type: "approval",
  status: "pending", priority: "high", title: "Approve the release",
  summary: "The team is ready.", business: "honmaru", createdAt: "2026-09-08T00:00:00Z",
});

function socket(userId, authed = true) {
  return {
    sent: [],
    deserializeAttachment: () => ({ orgId: ORG, userId, githubId: userId, sessionToken: tokens[userId], agui: true, authed }),
    send(text) { this.sent.push(JSON.parse(text)); },
    close() {},
  };
}

function relay(sockets = [], overrides = {}) {
  const work = [];
  const value = new OrgRelay({
    getWebSockets: () => sockets,
    waitUntil(task) { work.push(task); },
  }, { DB: env.DB, ...overrides });
  return { value, work };
}

beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  for (const login of ["reader", "author"]) {
    await upsertUser(env.DB, { githubId: login, login, name: login, locale: login === "reader" ? "ja" : "en" });
    await upsertMembership(env.DB, ORG, login, "member");
    tokens[login] = await createSession(env.DB, login, "email-auth");
  }
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

test("an open socket receives no organization broadcasts until its join is authenticated", async () => {
  const member = socket("reader");
  const anonymous = socket(null, false);
  const claimed = socket("reader", false);
  const { value } = relay([member, anonymous, claimed]);
  const res = await value.fetch(new Request(`https://relay.internal${ANNOUNCE_PATH}?orgId=${encodeURIComponent(ORG)}`, {
    method: "POST", body: JSON.stringify({ cards: [original("private-announcement")] }),
  }));
  expect(res.status).toBe(200);
  expect(member.sent.some((event) => event.type === "STATE_DELTA")).toBe(true);
  expect(member.sent.some((event) => event.type === "TOOL_CALL_START")).toBe(true);
  expect(anonymous.sent).toEqual([]);
  expect(claimed.sent).toEqual([]);
});

test("a hibernating socket from an older release reconnects without receiving private data", async () => {
  const legacy = socket("reader");
  const attachment = legacy.deserializeAttachment();
  delete attachment.sessionToken;
  legacy.deserializeAttachment = () => attachment;
  legacy.close = (code) => { legacy.closeCode = code; };
  const { value } = relay([legacy]);
  await value.broadcast(ORG, { secret: "new decision" });
  expect(legacy.closeCode).toBe(1012);
  expect(legacy.sent).toEqual([]);
});

test("card_created cannot overwrite another recipient's existing decision", async () => {
  const card = original("collision");
  await saveCard(env.DB, ORG, card);
  const author = socket("author");
  const { value, work } = relay([author]);
  await value.webSocketMessage(author, JSON.stringify({ type: "card_created", payload: {
    card: { ...card, recipientUserID: "author", title: "Replaced", business: "injected-business" },
  } }));
  await Promise.all(work);
  expect(author.sent.some((event) => event.type === "RUN_ERROR")).toBe(true);
  expect(await getCard(env.DB, ORG, card.id)).toEqual(card);
  expect(await env.DB.prepare("SELECT slug FROM businesses WHERE org_id = ?1 AND slug = 'injected-business'").bind(ORG).first()).toBeNull();
});

test("a stale card_updated cannot recreate a deleted card", async () => {
  const reader = socket("reader");
  const { value, work } = relay([reader]);
  await value.webSocketMessage(reader, JSON.stringify({ type: "card_updated", payload: { card: original("deleted-update") } }));
  await Promise.all(work);
  expect(reader.sent.some((event) => event.type === "RUN_ERROR")).toBe(true);
  expect(await getCard(env.DB, ORG, "deleted-update")).toBeNull();
});

test("an authorized recipient update preserves the original sender and creation time", async () => {
  const card = original("sender-integrity");
  await saveCard(env.DB, ORG, card);
  const reader = socket("reader");
  const { value, work } = relay([reader]);
  await value.webSocketMessage(reader, JSON.stringify({ type: "card_updated", payload: { card: {
    ...card, senderUserID: "someone-else", createdAt: "1990-01-01T00:00:00Z", status: "approved",
    decision: { action: "approve", actorUserID: "someone-else" },
  } } }));
  await Promise.all(work);
  const stored = await getCard(env.DB, ORG, card.id);
  expect(stored.senderUserID).toBe("author");
  expect(stored.createdAt).toBe(card.createdAt);
  expect(stored.decision.actorUserID).toBe("reader");
});

test("concurrent creates with one id store and announce exactly one decision", async () => {
  const author = socket("author");
  const reader = socket("reader");
  const { value, work } = relay([author, reader]);
  await Promise.all([author, reader].map((sender) => value.webSocketMessage(sender, JSON.stringify({
    type: "card_created", payload: { card: original("concurrent-create") },
  }))));
  await Promise.all(work);
  const created = await env.DB.prepare("SELECT COUNT(*) AS n FROM card_events WHERE org_id = ?1 AND card_id = ?2 AND type = 'created'")
    .bind(ORG, "concurrent-create").first();
  expect(created.n).toBe(1);
  expect(author.sent.filter((event) => event.type === "STATE_DELTA")).toHaveLength(1);
  expect(reader.sent.filter((event) => event.type === "STATE_DELTA")).toHaveLength(1);
});

test("an update cannot erase a decision committed while its filing step was running", async () => {
  const pending = original("concurrent-update");
  const decided = { ...pending, status: "approved", decision: { action: "approve", actorUserID: "reader" } };
  await saveCard(env.DB, ORG, pending);
  const reader = socket("reader");
  const { value, work } = relay([reader]);
  value.fileUnder = async () => {
    await saveCard(env.DB, ORG, decided);
    return "another-business";
  };
  await value.webSocketMessage(reader, JSON.stringify({ type: "card_updated", payload: { card: pending } }));
  await Promise.all(work);
  expect(await getCard(env.DB, ORG, pending.id)).toEqual(decided);
  expect(reader.sent.some((event) => event.type === "RUN_ERROR")).toBe(true);
});

function translation() {
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: JSON.stringify({ title: "リリースを承認", summary: "準備ができました。", context: "" }) } }] });
}

const delivery = { kind: "created", excludeLogin: "author", translate: true };

test("a delayed translation enriches the current decision without undoing approval", async () => {
  const pending = original("translation-approval");
  const approved = { ...pending, status: "approved", decision: { action: "approve", actorUserID: "reader", decidedAt: "2026-09-08T01:00:00Z" } };
  await saveCard(env.DB, ORG, approved);
  translation();
  const { value } = relay([], { OPENAI_API_KEY: "sk-test" });
  await value.deliver(ORG, pending, delivery);
  const stored = await getCard(env.DB, ORG, pending.id);
  expect(stored.status).toBe("approved");
  expect(stored.decision).toEqual(approved.decision);
  expect(stored.localized.ja.title).toBe("リリースを承認");
});

test("a delayed translation never resurrects a deleted decision", async () => {
  const pending = original("translation-deleted");
  await saveCard(env.DB, ORG, pending);
  await removeCard(env.DB, ORG, pending.id);
  translation();
  const reader = socket("reader");
  const { value } = relay([reader], { OPENAI_API_KEY: "sk-test" });
  await value.deliver(ORG, pending, delivery);
  expect(await getCard(env.DB, ORG, pending.id)).toBeNull();
  expect(reader.sent).toEqual([]);
});

test("a delayed translation does not attach outdated words to an edited decision", async () => {
  const pending = original("translation-edited");
  const revised = { ...pending, title: "Do not ship until Friday" };
  await saveCard(env.DB, ORG, revised);
  translation();
  const { value } = relay([], { OPENAI_API_KEY: "sk-test" });
  await value.deliver(ORG, pending, delivery);
  expect(await getCard(env.DB, ORG, pending.id)).toEqual(revised);
});

const revocations = [
  ["deleted session", (token) => env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run()],
  ["expired session", (token) => env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE token = ?1").bind(token).run()],
  ["revoked membership", (_token, userId) => env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(ORG, userId).run()],
];

test.each(revocations)("a connected socket with a %s cannot receive subsequent private events", async (name, revoke) => {
  const userId = `read-${name.replaceAll(" ", "-")}`;
  await upsertUser(env.DB, { githubId: userId, login: userId });
  await upsertMembership(env.DB, ORG, userId, "member");
  const token = await createSession(env.DB, userId, "email-auth");
  const former = await joined(ORG, token);
  const author = await joined(ORG, tokens.author);
  await revoke(token, userId);
  author.ws.send(JSON.stringify({ type: "context_updated", payload: { context: { secret: userId } } }));
  expect(await message(author.messages, (event) => event.type === "STATE_DELTA" && JSON.stringify(event).includes(userId))).toBeTruthy();
  expect(await message(former.messages, (event) => event.type === "RUN_ERROR")).toBeTruthy();
  expect(former.messages.some((event) => event.type === "STATE_DELTA" && JSON.stringify(event).includes(userId))).toBe(false);
  expect(await until(() => former.ws.readyState !== WebSocket.OPEN)).toBe(true);
});

test.each(revocations)("a connected socket with a %s cannot create decisions", async (name, revoke) => {
  const userId = `write-${name.replaceAll(" ", "-")}`;
  await upsertUser(env.DB, { githubId: userId, login: userId });
  await upsertMembership(env.DB, ORG, userId, "member");
  const token = await createSession(env.DB, userId, "email-auth");
  const former = await joined(ORG, token);
  await revoke(token, userId);
  former.ws.send(JSON.stringify({ type: "card_created", payload: { card: original(userId) } }));
  expect(await message(former.messages, (event) => event.type === "RUN_ERROR")).toBeTruthy();
  expect(await getCard(env.DB, ORG, userId)).toBeNull();
  expect(await until(() => former.ws.readyState !== WebSocket.OPEN)).toBe(true);
});

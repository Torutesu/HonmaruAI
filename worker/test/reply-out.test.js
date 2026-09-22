import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { sourceOf } from "../src/sync.js";
import { gmail, addressIn } from "../src/connectors/gmail.js";
import { slack } from "../src/connectors/slack.js";
import { validateIncomingCard } from "../src/agui/validate.js";

// The reply, sent back the way the request came. A decision is one tap and
// the reply is drafted; sending it was still a copy, a switch of apps and a
// paste. For a card the person's own sync made from a message, it goes
// back on that thread from here.

const ORG = "personal:replyout";
let toru;
let outsider;
const ENV = (over = {}) => ({ ...env, COMPOSIO_API_KEY: "ck_test", ...over });
const call = (path, init, over) => worker.fetch(new Request("https://example.com" + path, init), ENV(over));
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (token, cardId, text = "Mika, not this time — not until the lease is settled.\n\nToru", over) =>
  call(`/cards/${cardId}/reply`, { method: "POST", headers: headers(token), body: JSON.stringify({ orgId: ORG, text }) }, over);

const decided = { action: "decline", actorUserID: "toru", decidedAt: "2026-09-11T00:00:00Z", replyText: "Not until the lease is settled" };

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, saveCard, markIngested } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "8501", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "8502", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "8501", "admin");
  await upsertMembership(env.DB, "personal:other", "8502", "admin");
  toru = await createSession(env.DB, "8501", "gho_toru");
  outsider = await createSession(env.DB, "8502", "gho_nobody");
  const base = { recipientUserID: "toru", senderUserID: "toru", type: "approval", priority: "high", createdAt: "2026-09-10T00:00:00Z" };
  // From Gmail, decided.
  await saveCard(env.DB, ORG, { ...base, id: "o-1", title: "Approve the supplier price +8%", status: "rejected", decision: decided,
    sourceApp: "Gmail", sourceDetail: "Mika <mika@cafe.jp> · Supplier price",
    source: { connector: "gmail", id: "m-1", threadId: "t-1", from: "Mika <mika@cafe.jp>" } });
  await markIngested(env.DB, { connector: "gmail", externalId: "m-1", githubId: "8501", orgId: ORG, cardId: "o-1" });
  // From Slack, decided.
  await saveCard(env.DB, ORG, { ...base, id: "o-2", title: "Sign off the menu photos", status: "approved",
    decision: { ...decided, action: "approve", replyText: null }, sourceApp: "Slack",
    source: { connector: "slack", id: "https://slack/p1", channel: "C123", ts: "1726000000.000100", from: "kenji" } });
  await markIngested(env.DB, { connector: "slack", externalId: "https://slack/p1", githubId: "8501", orgId: ORG, cardId: "o-2" });
  // Decided, but typed into the app — no thread to go back to. A client
  // wrote a `source` on it; the ingested record is what counts.
  await saveCard(env.DB, ORG, { ...base, id: "o-3", title: "Renew the lease", status: "approved", decision: { ...decided, action: "approve" },
    source: { connector: "gmail", threadId: "t-forged", from: "victim@example.com" } });
  // From Gmail, still pending.
  await saveCard(env.DB, ORG, { ...base, id: "o-4", title: "Hotel signage quote", status: "pending", sourceApp: "Gmail",
    source: { connector: "gmail", id: "m-4", threadId: "t-4", from: "sign@example.com" } });
  await markIngested(env.DB, { connector: "gmail", externalId: "m-4", githubId: "8501", orgId: ORG, cardId: "o-4" });
});

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a reply goes back on the Gmail thread, as the person, in their words", async () => {
  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_REPLY_TO_THREAD", method: "POST" })
    .reply(200, (opts) => { sent = JSON.parse(opts.body); return { successful: true, data: { id: "sent-1" } }; });

  const res = await send(toru, "o-1");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sent: true, via: "Gmail" });
  expect(sent.user_id).toBe("8501");
  expect(sent.arguments).toMatchObject({ thread_id: "t-1", recipient_email: "mika@cafe.jp", is_html: false });
  expect(sent.arguments.message_body).toContain("not until the lease is settled");

  const { listCardEvents } = await import("../src/events.js");
  const events = await listCardEvents(env.DB, ORG, "o-1");
  expect(events.find((e) => e.type === "replied")?.note).toContain("Mika, not this time");
});

test("a reply goes back in the Slack thread", async () => {
  let sent;
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/SLACK_SEND_MESSAGE", method: "POST" })
    .reply(200, (opts) => { sent = JSON.parse(opts.body); return { successful: true, data: { ok: true } }; });
  const res = await send(toru, "o-2", "Approved — go ahead with the photos.");
  expect(res.status).toBe(200);
  expect((await res.json()).via).toBe("Slack");
  expect(sent.arguments).toEqual({ channel: "C123", text: "Approved — go ahead with the photos.", thread_ts: "1726000000.000100" });
});

test("a card that no sync made, a pending one, a stranger, an empty reply and a deployment without apps are refused", async () => {
  // A forged `source` on a typed card does not make a thread to reply on.
  let res = await send(toru, "o-3");
  expect(res.status).toBe(409);
  expect((await res.json()).message).toMatch(/did not come from a connected app/);
  expect((await send(toru, "o-4")).status).toBe(409);
  expect((await send(outsider, "o-1")).status).toBe(403);
  expect((await send(toru, "nope")).status).toBe(404);
  expect((await send(toru, "o-1", "   ")).status).toBe(400);
  res = await send(toru, "o-1", "Hi", { COMPOSIO_API_KEY: undefined });
  expect(res.status).toBe(503);
});

test("when the app does not take the reply, the person is told to send it themselves", async () => {
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: "/api/v3/tools/execute/GMAIL_REPLY_TO_THREAD", method: "POST" })
    .reply(200, { successful: false, error: "insufficient scope" });
  const res = await send(toru, "o-1");
  expect(res.status).toBe(502);
  expect((await res.json()).message).toMatch(/Gmail did not take the reply/);
});

test("a synced card remembers where it came from, and each connector knows how to reply there", () => {
  const mail = gmail.parse({ data: { messages: [{ messageId: "m-9", threadId: "t-9", sender: "Mika <mika@cafe.jp>", subject: "Price", preview: { body: "…" } }] } })[0];
  expect(sourceOf(gmail, mail)).toEqual({ connector: "gmail", id: "m-9", threadId: "t-9", from: "Mika <mika@cafe.jp>" });
  expect(gmail.replyTool(sourceOf(gmail, mail), "Yes.")).toMatchObject({ slug: "GMAIL_REPLY_TO_THREAD", args: { thread_id: "t-9", recipient_email: "mika@cafe.jp", message_body: "Yes." } });
  expect(gmail.replyTool({ connector: "gmail", threadId: "t-9", from: "no address here" }, "Yes.")).toBeNull();

  const msg = slack.parse({ data: { messages: { matches: [{ permalink: "https://s/p", channel: { id: "C1", name: "ops" }, ts: "1.2", username: "kenji", text: "hi" }] } } })[0];
  expect(sourceOf(slack, msg)).toEqual({ connector: "slack", id: "https://s/p", from: "kenji", channel: "C1", ts: "1.2" });
  expect(slack.replyTool(sourceOf(slack, msg), "ok")).toEqual({ slug: "SLACK_SEND_MESSAGE", args: { channel: "C1", text: "ok", thread_ts: "1.2" } });

  expect(addressIn("mika@cafe.jp")).toBe("mika@cafe.jp");
  expect(addressIn("Mika")).toBeNull();
  // The relay accepts a source of text fields, and nothing else.
  expect(validateIncomingCard({ id: "x", recipientUserID: "toru", source: { connector: "gmail", threadId: "t" } })).toBeNull();
  expect(validateIncomingCard({ id: "x", recipientUserID: "toru", source: "gmail" })).toMatch(/source must be an object/);
  expect(validateIncomingCard({ id: "x", recipientUserID: "toru", source: { threadId: 42 } })).toMatch(/source.threadId must be text/);
});

import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { emitMessage, emitCard, sign, validEndpoint } from "../src/webhooks.js";

// A workspace's events, posted to a service of its own: made by a member,
// signed with a secret shown once, and hearing only what that member could.

const ORG = "personal:hooks";
let toru; let mika; let outsider;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, {
    method, headers: { "x-session-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM org_webhooks; DELETE FROM rate_limits;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9801", login: "u:toru@x.jp", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "9802", login: "u:mika@x.jp", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9803", login: "u:eve@x.jp", name: "Eve", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9801", "admin");
  await upsertMembership(env.DB, ORG, "9802", "member");
  await upsertMembership(env.DB, "personal:eve", "9803", "admin");
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9801" });
  toru = await createSession(env.DB, "9801", "gho_t");
  mika = await createSession(env.DB, "9802", "gho_m");
  outsider = await createSession(env.DB, "9803", "gho_e");
});
afterEach(() => fetchMock.deactivate?.());

const make = (token, over = {}) => call("/webhooks", token, {
  method: "POST",
  body: { orgId: ORG, url: "https://hooks.example.com/in", name: "Ops", events: ["message.created", "card.decided"], ...over },
});

test("a member makes one, sees the secret once, and the list never shows it again", async () => {
  const res = await make(mika);
  expect(res.status).toBe(201);
  const made = await res.json();
  expect(made.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  expect(made.webhook).toMatchObject({ name: "Ops", url: "https://hooks.example.com/in", events: ["message.created", "card.decided"], includeDms: false, mine: true });

  const listed = await (await call(`/webhooks?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(listed.webhooks).toHaveLength(1);
  expect(listed.webhooks[0]).toMatchObject({ createdBy: "Mika", mine: false });
  expect(JSON.stringify(listed)).not.toContain(made.secret);
  expect(JSON.stringify(listed)).not.toContain("mika@x.jp");
  expect(listed.events).toContain("call.started");
});

test("only a public https address, and a real event, are taken; strangers are refused", async () => {
  expect((await make(toru, { url: "http://hooks.example.com/in" })).status).toBe(400);
  expect((await make(toru, { url: "https://localhost/in" })).status).toBe(400);
  expect((await make(toru, { url: "https://10.0.0.1/in" })).status).toBe(400);
  expect((await make(toru, { events: ["everything"] })).status).toBe(400);
  expect((await make(outsider)).status).toBe(403);
  expect(validEndpoint("https://user:pw@hooks.example.com")).toBe(null);
});

test("a delivery is signed, names people rather than logins, and is recorded on the webhook", async () => {
  const { secret, webhook } = await (await make(toru)).json();
  const got = {};
  fetchMock.activate();
  fetchMock.get("https://hooks.example.com")
    .intercept({ path: "/in", method: "POST", headers: (h) => { got.headers = h; return true; }, body: (b) => { got.body = b; return true; } })
    .reply(204, "");
  const row = { id: "m1", channel: "b:cafe", author_login: "u:mika@x.jp", body: "Supplier moved to Friday", created_at: "2026-09-25T10:00:00Z" };
  expect(await emitMessage(env, ORG, row)).toBe(1);
  fetchMock.assertNoPendingInterceptors();

  const event = JSON.parse(got.body);
  expect(event).toMatchObject({ type: "message.created", workspaceId: ORG, data: { message: { id: "m1", text: "Supplier moved to Friday", author: { name: "Mika" }, channel: { kind: "channel", slug: "cafe", name: "Cafe" } } } });
  expect(got.body).not.toContain("mika@x.jp");
  const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(got.headers["honmaru-signature"]);
  expect(v1).toBe(await sign(secret, Number(t), got.body));
  expect(got.headers["honmaru-event"]).toBe("message.created");

  const listed = await (await call(`/webhooks?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(listed.webhooks.find((w) => w.id === webhook.id).lastStatus).toBe(204);
});

test("a direct conversation reaches only its own people's webhooks, and only when asked for", async () => {
  // The mock keeps its interceptors between tests: this one has a host of its own.
  const url = "https://dm-hooks.example.com/in";
  await make(toru, { url });                         // Toru's, no DMs
  await make(mika, { url, includeDms: true });       // Mika's, with DMs
  let deliveries = 0;
  fetchMock.activate();
  fetchMock.get("https://dm-hooks.example.com")
    .intercept({ path: "/in", method: "POST" })
    .reply(200, () => { deliveries += 1; return "ok"; })
    .persist();
  // Between Mika and Eve's old login: Toru is not in it.
  const dm = { id: "m2", channel: "dm:u:mika@x.jp|u:zed@x.jp", author_login: "u:mika@x.jp", body: "psst", created_at: "2026-09-25T10:00:00Z" };
  expect(await emitMessage(env, ORG, dm)).toBe(1);
  expect(deliveries).toBe(1);
  // A channel's decision reaches everyone's that asked for decisions.
  const card = { id: "c1", title: "Approve", senderUserID: "u:toru@x.jp", recipientUserID: "u:mika@x.jp", business: "cafe", status: "approved",
    decision: { action: "approve", actorUserID: "u:mika@x.jp" } };
  expect(await emitCard(env, ORG, card, "card.decided")).toBe(2);
  // Nobody asked for card.created.
  expect(await emitCard(env, ORG, card, "card.created")).toBe(0);
});

test("a test delivery says how it went; only the maker or an admin deletes", async () => {
  const { webhook } = await (await make(mika)).json();
  fetchMock.activate();
  fetchMock.get("https://hooks.example.com").intercept({ path: "/in", method: "POST" }).reply(500, "nope");
  const tested = await (await call(`/webhooks/${webhook.id}/test`, mika, { method: "POST", body: { orgId: ORG } })).json();
  expect(tested).toMatchObject({ ok: false, status: 500 });

  const other = await (await make(toru)).json();
  expect((await call(`/webhooks/${other.webhook.id}?orgId=${encodeURIComponent(ORG)}`, mika, { method: "DELETE" })).status).toBe(403);
  // Toru is an admin: he may remove Mika's.
  expect((await call(`/webhooks/${webhook.id}?orgId=${encodeURIComponent(ORG)}`, toru, { method: "DELETE" })).status).toBe(200);
  const listed = await (await call(`/webhooks?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(listed.webhooks.map((w) => w.id)).toEqual([other.webhook.id]);
});

test("the inbound email hook is not one of these", async () => {
  // /webhooks/email belongs to inbound mail; this module must let it pass.
  const { handleWebhooks } = await import("../src/webhooks.js");
  const req = new Request("https://example.com/webhooks/email", { method: "POST", body: "{}" });
  expect(await handleWebhooks(req, env, new URL(req.url))).toBe(null);
});

import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { myNumberValid, luhnValid, cleanPattern, scan, DETECTORS } from "../src/dlp.js";

// Data rules (docs/enterprise-audit-log.md §10): a message is read against
// the workspace's rules before it is kept. A warning can be sent through; a
// block cannot. What matched is never stored — only which rule.

const ORG = "personal:dlp";
let toru; let mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, {
    method, headers: { "content-type": "application/json", "x-session-token": token }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, OPENAI_API_KEY: undefined }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const post = (token, text, extra = {}) => call("/channels/messages", token, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: text, ...extra } });
const rule = (token, body) => call("/orgs/dlp", token, { method: "POST", body: { orgId: ORG, ...body } });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM dlp_rules; DELETE FROM audit_events; DELETE FROM rate_limits;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9101", "toru", "Toru", "admin"], ["9102", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9101" });
  toru = await createSession(env.DB, "9101", "x");
  mika = await createSession(env.DB, "9102", "y");
});

test("the detectors: check digits, not just digits", () => {
  expect(myNumberValid("123456789018")).toBe(true);
  expect(myNumberValid("123456789012")).toBe(false);
  expect(DETECTORS.my_number.test("マイナンバーは 1234-5678-9018 です")).toBe(true);
  expect(DETECTORS.my_number.test("注文番号 1234-5678-9012")).toBe(false);
  expect(luhnValid("4111111111111111")).toBe(true);
  expect(DETECTORS.credit_card.test("card 4111 1111 1111 1111 exp 12/29")).toBe(true);
  expect(DETECTORS.credit_card.test("tracking 4111 1111 1111 1112")).toBe(false);
  expect(DETECTORS.secret_key.test("key AKIAABCDEFGHIJKLMNOP here")).toBe(true);
  expect(DETECTORS.secret_key.test("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
  expect(DETECTORS.secret_key.test("the ghost in the shell")).toBe(false);
  // Full-width digits are read as digits.
  expect(scan([{ id: "r", name: "My Number", kind: "builtin", detector: "my_number", action: "block" }], "１２３４５６７８９０１８")).toHaveLength(1);
});

test("a pattern that could run forever, or is not one, is refused", () => {
  expect(cleanPattern("(a+)+$").error).toBeTruthy();
  expect(cleanPattern("(x*)*").error).toBeTruthy();
  expect(cleanPattern("[").error).toBeTruthy();
  expect(cleanPattern("PRJ-\\d{4}").pattern).toBe("PRJ-\\d{4}");
  expect(cleanPattern("(\\d{4}-){3}\\d{4}").pattern).toBeTruthy();
});

test("only an admin makes rules; a member cannot see them", async () => {
  expect((await rule(mika, { kind: "builtin", detector: "credit_card", action: "block" })).status).toBe(403);
  expect((await call(`/orgs/dlp?orgId=${encodeURIComponent(ORG)}`, mika)).status).toBe(403);
  const made = await rule(toru, { kind: "builtin", detector: "credit_card", action: "block" });
  expect(made.status).toBe(201);
  // The web app calls from its own origin; so does the composer's warning.
  expect(made.headers.get("access-control-allow-origin")).toBe("*");
  const warned = await post(mika, "4111 1111 1111 1111");
  expect(warned.headers.get("access-control-allow-origin")).toBe("*");
  expect((await made.json()).rule).toMatchObject({ name: "Card number", action: "block", enabled: true });
  const list = await (await call(`/orgs/dlp?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(list.rules).toHaveLength(1);
  expect(list.detectors.map((d) => d.id)).toContain("my_number");
  const logged = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'dlp.rule_created'").bind(ORG).first();
  expect(logged.severity).toBe("warning");
});

test("a block stops the message and logs which rule, never the number", async () => {
  await rule(toru, { kind: "builtin", detector: "credit_card", action: "block" });
  const res = await post(mika, "my card is 4111 1111 1111 1111");
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.code).toBe("dlp-blocked");
  expect(body.rules).toEqual(["Card number"]);
  // Not even with the acknowledgement a warning takes.
  expect((await post(mika, "my card is 4111 1111 1111 1111", { dlpAck: true })).status).toBe(422);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id = ?1").bind(ORG).first()).n).toBe(0);
  const { results } = await env.DB.prepare("SELECT * FROM audit_events WHERE org_id = ?1 AND action = 'dlp.blocked'").bind(ORG).all();
  expect(results).toHaveLength(2);
  expect(JSON.stringify(results)).not.toContain("4111");
  // A message without it goes as ever.
  expect((await post(mika, "lunch at noon?")).status).toBe(201);
});

test("a warning is asked about, and goes when the person sends it anyway", async () => {
  await rule(toru, { kind: "keywords", name: "Project names", keywords: "Bluebird, 極秘", action: "warn" });
  const first = await post(mika, "The BLUEBIRD launch moved");
  expect(first.status).toBe(409);
  expect((await first.json())).toMatchObject({ code: "dlp-warning", rules: ["Project names"] });
  expect((await post(mika, "The BLUEBIRD launch moved", { dlpAck: true })).status).toBe(201);
  const logged = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'dlp.warning_overridden'").bind(ORG).first();
  expect(logged).toBeTruthy();
});

test("an edit is read too, and a rule turned off stops applying", async () => {
  const sent = await (await post(mika, "hello")).json();
  const made = await (await rule(toru, { kind: "regex", name: "Tickets", pattern: "SECRET-\\d{3}", action: "block" })).json();
  const edit = await call("/channels/messages", mika, { method: "PUT", body: { orgId: ORG, channel: "b:cafe", messageId: sent.message.id, body: "see SECRET-123" } });
  expect(edit.status).toBe(422);
  const off = await call(`/orgs/dlp/${made.rule.id}`, toru, { method: "PATCH", body: { orgId: ORG, enabled: false } });
  expect((await off.json()).rule.enabled).toBe(false);
  expect((await post(mika, "see SECRET-123")).status).toBe(201);
  // The test box tells an admin what would match, rules on or off.
  const tried = await (await call("/orgs/dlp/test", toru, { method: "POST", body: { orgId: ORG, text: "SECRET-999" } })).json();
  expect(tried.hits.map((h) => h.name)).toEqual(["Tickets"]);
  expect((await call(`/orgs/dlp/${made.rule.id}?orgId=${encodeURIComponent(ORG)}`, toru, { method: "DELETE" })).status).toBe(200);
});

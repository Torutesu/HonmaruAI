import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { forgetGovernance, pruneMessages } from "../src/governance.js";
import { forgetPolicies } from "../src/policy.js";

// A company's rules for its workspace (docs/enterprise-audit-log.md §10):
// how long messages and files are kept, legal holds that keep them anyway,
// compliance exports, the networks it may be used from, and who may be
// invited. Owners only, each change in the audit log.

const ORG = "team:gov";
let owner; let admin; let member;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body, ip = "203.0.113.5" } = {}) => {
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
    method, headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(token ? { "x-session-token": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, OPENAI_API_KEY: undefined }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const q = `orgId=${encodeURIComponent(ORG)}`;
const put = (token, body, ip) => call("/orgs/governance", token, { method: "PUT", body: { orgId: ORG, ...body }, ip });
const post = (token, channel, text) => call("/channels/messages", token, { method: "POST", body: { orgId: ORG, channel, body: text } });
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM users; DELETE FROM org_governance; DELETE FROM message_holds; DELETE FROM message_history; DELETE FROM compliance_exports; DELETE FROM channel_messages; DELETE FROM businesses; DELETE FROM invites; DELETE FROM join_requests; DELETE FROM org_domains;");
  forgetGovernance(); forgetPolicies();
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role, email] of [["9501", "u:toru@gov.jp", "Toru", "owner", "toru@gov.jp"], ["9502", "u:mika@gov.jp", "Mika", "admin", "mika@gov.jp"], ["9503", "u:ken@gov.jp", "Ken", "member", "ken@gov.jp"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind(id, email, new Date().toISOString()).run();
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9501" });
  await upsertBusiness(env.DB, ORG, { name: "Board", createdBy: "9501" });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'board'").bind(ORG).run();
  owner = await createSession(env.DB, "9501", "a");
  admin = await createSession(env.DB, "9502", "b");
  member = await createSession(env.DB, "9503", "c");
});

test("only an owner changes the rules; an admin can read them; each change is logged", async () => {
  expect((await call(`/orgs/governance?${q}`, member)).status).toBe(403);
  const read = await (await call(`/orgs/governance?${q}`, admin)).json();
  expect(read).toMatchObject({ retention: { publicDays: null }, network: { enforce: false }, invites: { policy: "open" }, canEdit: false, yourIp: "203.0.113.5" });
  expect((await put(admin, { retention: { publicDays: 90 } })).status).toBe(403);
  expect((await put(owner, { retention: { publicDays: 91 } })).status).toBe(400);
  const saved = await (await put(owner, { retention: { publicDays: 90, dmDays: 30, filesDays: 365 } })).json();
  expect(saved.retention).toEqual({ publicDays: 90, privateDays: null, dmDays: 30, filesDays: 365 });
  const logged = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'governance.retention_changed'").bind(ORG).first();
  expect(logged.severity).toBe("critical");
});

test("retention deletes what is past it, by kind of conversation, but never what a hold covers or a thread still in use", async () => {
  await put(owner, { retention: { publicDays: 30, privateDays: 365 } });
  const insert = (id, channel, login, created, parent = null) => env.DB.prepare(
    "INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at, parent_id) VALUES (?1, ?2, ?3, ?4, 'message', ?5, ?6, ?7)"
  ).bind(id, ORG, channel, login, `text ${id}`, created, parent).run();
  await insert("old-public", "b:cafe", "u:ken@gov.jp", ago(40));
  await insert("new-public", "b:cafe", "u:ken@gov.jp", ago(5));
  await insert("old-private", "b:board", "u:ken@gov.jp", ago(40));
  await insert("old-held", "b:cafe", "u:mika@gov.jp", ago(40));
  await insert("old-parent", "b:cafe", "u:ken@gov.jp", ago(50));
  await insert("new-reply", "b:cafe", "u:ken@gov.jp", ago(2), "old-parent");
  await insert("old-dm", "dm:u:ken@gov.jp|u:toru@gov.jp", "u:ken@gov.jp", ago(4000));
  const members = await (await call(`/members?${q}`, owner)).json();
  const mika = members.members.find((m) => m.name === "Mika");
  expect((await call("/orgs/holds", owner, { method: "POST", body: { orgId: ORG, kind: "person", ref: mika.ref, reason: "Matter 42" } })).status).toBe(201);
  await pruneMessages(env);
  const left = (await env.DB.prepare("SELECT id FROM channel_messages WHERE org_id = ?1 ORDER BY id").bind(ORG).all()).results.map((r) => r.id);
  // DMs have no retention set: kept for ever.
  expect(left).toEqual(["new-public", "new-reply", "old-dm", "old-held", "old-parent", "old-private"]);
  expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE org_id = ?1 AND action = 'retention.pruned'").bind(ORG).first()).toBeTruthy();
});

test("a hold keeps a held person's words through an edit and an unsend, and the export has them", async () => {
  const members = (await (await call(`/members?${q}`, owner)).json()).members;
  const ken = members.find((m) => m.name === "Ken");
  expect((await call("/orgs/holds", owner, { method: "POST", body: { orgId: ORG, kind: "person", ref: ken.ref } })).status).toBe(400);
  expect((await call("/orgs/holds", admin, { method: "POST", body: { orgId: ORG, kind: "person", ref: ken.ref, reason: "x" } })).status).toBe(403);
  await call("/orgs/holds", owner, { method: "POST", body: { orgId: ORG, kind: "person", ref: ken.ref, reason: "Matter 7" } });
  const sent = await (await post(member, "b:cafe", "the numbers were wrong")).json();
  await call("/channels/messages", member, { method: "PUT", body: { orgId: ORG, channel: "b:cafe", messageId: sent.message.id, body: "all fine" } });
  await call("/channels/messages", member, { method: "DELETE", body: { orgId: ORG, channel: "b:cafe", messageId: sent.message.id } });
  const kept = (await env.DB.prepare("SELECT body, reason FROM message_history WHERE org_id = ?1 ORDER BY recorded_at").bind(ORG).all()).results;
  expect(kept).toEqual([{ body: "the numbers were wrong", reason: "edit" }, { body: "all fine", reason: "delete" }]);
  // Somebody not held: nothing kept.
  const mine = await (await post(owner, "b:cafe", "hello")).json();
  await call("/channels/messages", owner, { method: "DELETE", body: { orgId: ORG, channel: "b:cafe", messageId: mine.message.id } });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM message_history WHERE org_id = ?1").bind(ORG).first()).n).toBe(2);

  // The export: owners only, with a reason; everything, earlier words included.
  const range = { from: ago(1), to: new Date(Date.now() + 60_000).toISOString() };
  expect((await call("/orgs/compliance/exports", owner, { method: "POST", body: { orgId: ORG, ...range } })).status).toBe(400);
  expect((await call("/orgs/compliance/exports", admin, { method: "POST", body: { orgId: ORG, ...range, reason: "x" } })).status).toBe(403);
  const made = await call("/orgs/compliance/exports", owner, { method: "POST", body: { orgId: ORG, ...range, people: [ken.ref], reason: "Matter 7" } });
  expect(made.status).toBe(201);
  const exp = (await made.json()).export;
  expect(exp).toMatchObject({ status: "ready", counts: { messages: 1, earlier: 2 } });
  const file = await call(`/orgs/compliance/exports/${exp.id}/download?${q}`, owner);
  expect(file.headers.get("content-disposition")).toContain(".jsonl.gz");
  const text = await new Response(file.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type).sort()).toEqual(["earlier_version", "earlier_version", "message"]);
  expect(lines.find((l) => l.type === "earlier_version" && l.before === "edit").text).toBe("the numbers were wrong");
  expect(await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'compliance.downloaded'").bind(ORG).first()).toMatchObject({ severity: "critical" });
});

test("the allowed networks: nobody locks themselves out, and everything else is refused from outside", async () => {
  const lockOut = await put(owner, { network: { enforce: true, allowlist: ["198.51.100.0/24"] } });
  expect(lockOut.status).toBe(409);
  expect((await put(owner, { network: { enforce: true, allowlist: ["not an ip"] } })).status).toBe(400);
  expect((await put(owner, { network: { enforce: true, allowlist: ["203.0.113.0/24", "2001:db8::/32"] } })).status).toBe(200);
  expect((await call(`/members?${q}`, member, { ip: "203.0.113.77" })).status).toBe(200);
  const outside = await call(`/members?${q}`, member, { ip: "192.0.2.9" });
  expect(outside.status).toBe(403);
  expect((await outside.json()).code).toBe("ip-not-allowed");
  expect((await call(`/channels/messages?${q}&channel=b:cafe`, owner, { ip: "192.0.2.9" })).status).toBe(403);
  expect((await call(`/members?${q}`, member, { ip: "2001:db8::5" })).status).toBe(200);
});

test("invitations: company only, or held for an admin's approval; guests may be let through", async () => {
  const { createInvite } = await import("../src/auth.js");
  await env.DB.prepare("INSERT INTO org_domains (domain, org_id, verify_token, verified_at, created_by, created_at) VALUES ('gov.jp', ?1, 't', ?2, '9501', ?2)").bind(ORG, new Date().toISOString()).run();
  const { createSession, upsertUser } = await import("../src/db.js");
  const newcomer = async (id, email) => {
    await upsertUser(env.DB, { githubId: id, login: `u:${email}`, name: email.split("@")[0], avatarUrl: null, locale: "en" });
    await env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE github_id = ?1").bind(id, email, new Date().toISOString()).run();
    return createSession(env.DB, id, "z");
  };
  const accept = (token, code) => call("/invites/accept", token, { method: "POST", body: { code } });

  await put(owner, { invites: { policy: "company", guestsExempt: true } });
  const outsider = await newcomer("9601", "sam@elsewhere.com");
  const memberInvite = await createInvite(env, { orgId: ORG, createdBy: "9501", role: "member", uses: 5 });
  const refused = await accept(outsider, memberInvite.code);
  expect(refused.status).toBe(403);
  const guestInvite = await createInvite(env, { orgId: ORG, createdBy: "9501", role: "guest", uses: 5, channels: ["cafe"] });
  expect((await accept(outsider, guestInvite.code)).status).toBe(200);
  const insider = await newcomer("9602", "yuki@gov.jp");
  expect((await accept(insider, memberInvite.code)).status).toBe(200);

  await put(owner, { invites: { policy: "approval", guestsExempt: false } });
  const other = await newcomer("9603", "lee@partner.com");
  const held = await accept(other, memberInvite.code);
  expect(held.status).toBe(202);
  expect((await held.json()).pending).toBe(true);
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id = ?1 AND user_github_id = '9603'").bind(ORG).first()).toBeNull();
  const asks = (await (await call(`/orgs/join-requests?${q}`, admin)).json()).requests;
  expect(asks).toHaveLength(1);
  expect((await call("/orgs/join-requests", admin, { method: "POST", body: { orgId: ORG, ref: asks[0].ref, approve: true } })).status).toBe(200);
  const joined = await env.DB.prepare("SELECT role, joined_via FROM memberships WHERE org_id = ?1 AND user_github_id = '9603'").bind(ORG).first();
  expect(joined).toEqual({ role: "member", joined_via: "invite" });
});

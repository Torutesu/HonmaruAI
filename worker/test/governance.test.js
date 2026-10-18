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
const call = async (path, token, { method = "GET", body, ip = "203.0.113.5", withEnv = env } = {}) => {
  const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
    method, headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(token ? { "x-session-token": token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...withEnv, OPENAI_API_KEY: undefined }, ctx);
  while (pending.length) await pending.shift();
  return res;
};
/// The database, but every statement matching `pattern` fails.
const failing = (pattern) => ({
  ...env,
  DB: new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql) => {
          if (!pattern.test(sql)) return target.prepare(sql);
          const down = async () => { throw new Error("D1 is down"); };
          return { bind: () => ({ all: down, first: down, run: down }) };
        };
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
});
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

// A failed read of the earlier words was taken for none: the export was
// marked ready, complete to look at, without what the hold had kept.
test("an export whose earlier words cannot be read fails, and a retry has them", async () => {
  const ken = (await (await call(`/members?${q}`, owner)).json()).members.find((m) => m.name === "Ken");
  await call("/orgs/holds", owner, { method: "POST", body: { orgId: ORG, kind: "person", ref: ken.ref, reason: "Matter 8" } });
  const sent = await (await post(member, "b:cafe", "first words")).json();
  await call("/channels/messages", member, { method: "PUT", body: { orgId: ORG, channel: "b:cafe", messageId: sent.message.id, body: "second words" } });
  const ask = { orgId: ORG, from: ago(1), to: new Date(Date.now() + 60_000).toISOString(), reason: "Matter 8" };
  const failed = await call("/orgs/compliance/exports", owner, { method: "POST", body: ask, withEnv: failing(/FROM message_history/) });
  expect(failed.status).toBe(500);
  const rows = (await env.DB.prepare("SELECT status FROM compliance_exports WHERE org_id = ?1").bind(ORG).all()).results;
  expect(rows).toEqual([{ status: "failed" }]);
  const made = await call("/orgs/compliance/exports", owner, { method: "POST", body: ask });
  expect((await made.json()).export).toMatchObject({ status: "ready", counts: { messages: 1, earlier: 1 } });
});

// A failed read of the holds was taken for none, and of the private channels
// for none private: an edit lost the held words, and retention deleted
// what a hold or a longer private retention kept.
test("when the holds or the private channels cannot be read, nothing held is changed or deleted", async () => {
  const members = (await (await call(`/members?${q}`, owner)).json()).members;
  const ken = members.find((m) => m.name === "Ken");
  await call("/orgs/holds", owner, { method: "POST", body: { orgId: ORG, kind: "person", ref: ken.ref, reason: "Matter 3" } });
  const sent = await (await post(member, "b:cafe", "as it was")).json();
  const edit = (withEnv) => call("/channels/messages", member, { method: "PUT", body: { orgId: ORG, channel: "b:cafe", messageId: sent.message.id, body: "as it is" }, withEnv });
  expect((await edit(failing(/FROM message_holds/))).status).toBe(500);
  const body = async () => (await env.DB.prepare("SELECT body FROM channel_messages WHERE org_id = ?1 AND id = ?2").bind(ORG, sent.message.id).first()).body;
  expect(await body()).toBe("as it was");
  expect((await edit(env)).status).toBe(200);
  expect((await env.DB.prepare("SELECT body FROM message_history WHERE org_id = ?1").bind(ORG).first()).body).toBe("as it was");

  await put(owner, { retention: { publicDays: 30, privateDays: 365 } });
  const insert = (id, channel, login) => env.DB.prepare(
    "INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'message', 'x', ?5)"
  ).bind(id, ORG, channel, login, ago(40)).run();
  await insert("old-held", "b:cafe", "u:ken@gov.jp");
  await insert("old-private", "b:board", "u:mika@gov.jp");
  await insert("old-public", "b:cafe", "u:mika@gov.jp");
  const left = async () => (await env.DB.prepare("SELECT id FROM channel_messages WHERE org_id = ?1 AND id LIKE 'old-%' ORDER BY id").bind(ORG).all()).results.map((r) => r.id);
  expect(await pruneMessages(failing(/FROM message_holds/))).toEqual([]);
  expect(await pruneMessages(failing(/FROM businesses WHERE org_id = \?1 AND private = 1/))).toEqual([]);
  expect(await left()).toEqual(["old-held", "old-private", "old-public"]);
  // Read again: only what nothing keeps goes.
  await pruneMessages(env);
  expect(await left()).toEqual(["old-held", "old-private"]);
});

// The oldest 500 rows were read before holds, each conversation's retention
// and threads in use were checked: 500 that must stay filled every run, and
// what had expired behind them was never reached.
test("retention reaches expired messages and files behind more than a batch of ones that must stay", async () => {
  await put(owner, { retention: { publicDays: 30, privateDays: 365, filesDays: 30 } });
  const ken = (await (await call(`/members?${q}`, owner)).json()).members.find((m) => m.name === "Ken");
  await call("/orgs/holds", owner, { method: "POST", body: { orgId: ORG, kind: "person", ref: ken.ref, reason: "Matter 5" } });
  const at = (days, i = 0) => new Date(Date.now() - days * 86_400_000 + i).toISOString();
  const msg = (id, channel, login, created, parent = null) => env.DB.prepare(
    "INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at, parent_id) VALUES (?1, ?2, ?3, ?4, 'message', 'x', ?5, ?6)"
  ).bind(id, ORG, channel, login, created, parent);
  const file = (id, login, created) => env.DB.prepare(
    "INSERT INTO message_files (id, org_id, channel, uploader, name, type, size, created_at) VALUES (?1, ?2, 'b:cafe', ?3, 'f.txt', 'text/plain', 1, ?4)"
  ).bind(id, ORG, login, created);
  const rows = [];
  for (let i = 0; i < 520; i += 1) {
    rows.push(msg(`held-${i}`, "b:cafe", "u:ken@gov.jp", at(90, i)));
    rows.push(msg(`private-${i}`, "b:board", "u:mika@gov.jp", at(80, i)));
    rows.push(msg(`parent-${i}`, "b:cafe", "u:mika@gov.jp", at(70, i)));
    rows.push(msg(`reply-${i}`, "b:cafe", "u:mika@gov.jp", at(1, i), `parent-${i}`));
    rows.push(file(`heldfile-${i}`, "u:ken@gov.jp", at(90, i)));
  }
  rows.push(msg("expired", "b:cafe", "u:mika@gov.jp", at(40)));
  rows.push(file("expiredfile", "u:mika@gov.jp", at(40)));
  for (let i = 0; i < rows.length; i += 200) await env.DB.batch(rows.slice(i, i + 200));
  const has = async (table, id) => Boolean(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE org_id = ?1 AND id = ?2`).bind(ORG, id).first());
  for (let run = 0; run < 3; run += 1) await pruneMessages(env);
  expect(await has("channel_messages", "expired")).toBe(false);
  expect(await has("message_files", "expiredfile")).toBe(false);
  const count = async (sql) => (await env.DB.prepare(sql).bind(ORG).first()).n;
  expect(await count("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id = ?1 AND (id LIKE 'held-%' OR id LIKE 'private-%' OR id LIKE 'parent-%')")).toBe(3 * 520);
  expect(await count("SELECT COUNT(*) AS n FROM message_files WHERE org_id = ?1 AND id LIKE 'heldfile-%'")).toBe(520);
});

// A person chosen who had left by the time the export was made was dropped,
// and with nobody left in the choice the export was of everyone.
test("an export for people who are no longer members is refused, not widened to everyone", async () => {
  const members = (await (await call(`/members?${q}`, owner)).json()).members;
  const ken = members.find((m) => m.name === "Ken");
  const mika = members.find((m) => m.name === "Mika");
  await post(member, "b:cafe", "from Ken");
  await post(admin, "b:cafe", "from Mika");
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9503'").bind(ORG).run();
  const ask = (extra) => call("/orgs/compliance/exports", owner, { method: "POST", body: { orgId: ORG, from: ago(1), to: new Date(Date.now() + 60_000).toISOString(), reason: "Matter 9", ...extra } });
  for (const people of [[ken.ref], [mika.ref, ken.ref], ["not-a-ref"]]) {
    const res = await ask({ people });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("unknown-people");
  }
  expect((await ask({ channels: ["Cafe"] })).status).toBe(400);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM compliance_exports WHERE org_id = ?1").bind(ORG).first()).n).toBe(0);
  // One still here: theirs alone. None chosen: everyone.
  const one = (await (await ask({ people: [mika.ref] })).json()).export;
  expect(one).toMatchObject({ status: "ready", filters: { people: ["Mika"] }, counts: { messages: 1 } });
  const all = (await (await ask({ people: [] })).json()).export;
  expect(all).toMatchObject({ status: "ready", filters: { people: [] }, counts: { messages: 2 } });
});

// A guest invitation held for approval kept only its role: the guest an
// admin let in was in no channel at all, public ones included, which are
// the only ones a guest can see.
test("a guest invitation held for approval lets the guest into the channels it named once approved, and no others", async () => {
  const { createInvite } = await import("../src/auth.js");
  const { createSession, upsertUser, upsertBusiness } = await import("../src/db.js");
  await upsertBusiness(env.DB, ORG, { name: "Lobby", createdBy: "9501" });
  await put(owner, { invites: { policy: "approval", guestsExempt: false } });
  await upsertUser(env.DB, { githubId: "9604", login: "u:val@partner.com", name: "Val", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email = 'val@partner.com', email_verified_at = ?1 WHERE github_id = '9604'").bind(new Date().toISOString()).run();
  const val = await createSession(env.DB, "9604", "v");
  await upsertBusiness(env.DB, ORG, { name: "Gone", createdBy: "9501" });
  const { addMembers } = await import("../src/access.js");
  await addMembers(env.DB, { orgId: ORG, key: "b:board", logins: ["u:toru@gov.jp"], addedBy: null });
  const invite = await createInvite(env, { orgId: ORG, createdBy: "9501", role: "guest", uses: 1, channels: ["cafe", "board", "gone"] });
  expect((await env.DB.prepare("SELECT channels FROM invites WHERE code = ?1").bind(invite.code).first()).channels).toContain("gone");
  const held = await call("/invites/accept", val, { method: "POST", body: { code: invite.code } });
  expect(held.status).toBe(202);
  // Taken away while the invitation waited.
  await env.DB.prepare("DELETE FROM businesses WHERE org_id = ?1 AND slug = 'gone'").bind(ORG).run();
  const asks = (await (await call(`/orgs/join-requests?${q}`, admin)).json()).requests;
  expect((await call("/orgs/join-requests", admin, { method: "POST", body: { orgId: ORG, ref: asks[0].ref, approve: true } })).status).toBe(200);
  expect((await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = '9604'").bind(ORG).first()).role).toBe("guest");
  const into = (await env.DB.prepare("SELECT channel FROM conversation_members WHERE org_id = ?1 AND login = 'u:val@partner.com' ORDER BY channel").bind(ORG).all()).results.map((r) => r.channel);
  expect(into).toEqual(["b:board", "b:cafe"]);
});

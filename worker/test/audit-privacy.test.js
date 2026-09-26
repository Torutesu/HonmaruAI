import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { audit, verifyChain, migrateOrgAudit } from "../src/audit.js";
import { principalOf, forgetCachedKeys } from "../src/auditCrypto.js";
import { memberRef } from "../src/team.js";

// The people in the audit log, each under a key of their own
// (docs/audit-log-phase2.md §2). Nothing that names a person is stored in
// the clear; deleting an account throws its key away, and its rows stay and
// still verify, known only by a pseudonym.

const ORG = "team:private";
let toru; let mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body, headers = {} } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...(token ? { "x-session-token": token } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const rows = async () => (await env.DB.prepare("SELECT * FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all()).results;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM audit_principal_keys; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM businesses; DELETE FROM conversation_members;");
  forgetCachedKeys();
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["7401", "u:toru@corp.jp", "Toru Tanaka", "owner"], ["7402", "u:mika@corp.jp", "Mika Sato", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await env.DB.prepare("UPDATE users SET email = 'mika@corp.jp' WHERE github_id = '7402'").run();
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "7401" });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'cafe'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:cafe', 'u:toru@corp.jp', 'u:toru@corp.jp', ?2)").bind(ORG, new Date().toISOString()).run();
  toru = await createSession(env.DB, "7401", "x");
  mika = await createSession(env.DB, "7402", "x");
});

test("nothing that names a person is stored in the clear, and the log reads back by name", async () => {
  const mRef = await memberRef(ORG, "7402");
  expect((await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: mRef, role: "admin" } })).status).toBe(200);
  await audit(env, new Request("https://x", { headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mika's browser" } }), {
    orgId: ORG, action: "emoji.added", actor: { type: "user", id: "u:mika@corp.jp", name: "Mika Sato" }, entity: { type: "emoji", id: "tada", name: ":tada:" },
  });
  const stored = await rows();
  expect(stored.length).toBeGreaterThanOrEqual(2);
  for (const r of stored) {
    const all = JSON.stringify(r);
    for (const secret of ["toru@corp.jp", "mika@corp.jp", "Toru Tanaka", "Mika Sato", "203.0.113", "Mika's browser"]) expect(all).not.toContain(secret);
    expect(r.enc).toBe(1);
  }
  // Pseudonyms, the same person the same one.
  const mikaP = await principalOf(env, ORG, "u:mika@corp.jp");
  expect(stored.find((r) => r.action === "member.role_changed").entity_id).toBe(mikaP);
  expect(stored.find((r) => r.action === "emoji.added").actor_id).toBe(mikaP);
  // Non-personal things stay readable, for filtering: an emoji's name.
  expect(stored.find((r) => r.action === "emoji.added").body).toContain(":tada:");

  const res = await call(`/audit/logs?orgId=${ORG}`, toru);
  expect(res.status).toBe(200);
  const { entries } = await res.json();
  const changed = entries.find((e) => e.action === "member.role_changed");
  expect(changed.actor).toMatchObject({ type: "user", name: "Toru Tanaka" });
  expect(changed.entity).toMatchObject({ type: "user", name: "Mika Sato", ref: mRef });
  expect(changed.context.ip_address).toBe("203.0.113.7");
  const emoji = entries.find((e) => e.action === "emoji.added");
  expect(emoji.context.ip_address).toBe("203.0.113.9");
  // Filtered by a person, as the screen asks.
  const byMika = await (await call(`/audit/logs?orgId=${ORG}&actor=${mRef}`, toru)).json();
  expect(byMika.entries.map((e) => e.action)).toEqual(["emoji.added"]);
  expect((await verifyChain(env.DB, ORG)).ok).toBe(true);
});

test("deleting an account throws its key away: the rows stay, still verify, and say only 'a deleted user'", async () => {
  await audit(env, null, { orgId: ORG, action: "emoji.added", actor: { type: "user", id: "u:mika@corp.jp", name: "Mika Sato" }, entity: { type: "emoji", id: "tada", name: ":tada:" } });
  const before = (await rows()).length;
  const gone = await call("/account", mika, { method: "DELETE" });
  expect(gone.status).toBe(200);
  const after = await rows();
  expect(after.length).toBe(before + 1);
  const shred = after.find((r) => r.action === "audit.principal_shredded");
  const mikaP = await principalOf(env, ORG, "u:mika@corp.jp");
  expect(JSON.parse(shred.body).details).toEqual({ principal: mikaP });
  const key = await env.DB.prepare("SELECT wrapped_key, shredded_at FROM audit_principal_keys WHERE org_id = ?1 AND principal = ?2").bind(ORG, mikaP).first();
  expect(key.wrapped_key).toBe(null);
  expect(key.shredded_at).toBeTruthy();
  expect((await verifyChain(env.DB, ORG)).ok).toBe(true);

  forgetCachedKeys();
  const { entries } = await (await call(`/audit/logs?orgId=${ORG}`, toru)).json();
  const emoji = entries.find((e) => e.action === "emoji.added");
  expect(emoji.actor).toEqual({ type: "user", name: null, deleted: true, principal: mikaP });
  // Still followable by pseudonym.
  const trail = await (await call(`/audit/logs?orgId=${ORG}&actor=${mikaP}`, toru)).json();
  expect(trail.entries.map((e) => e.action)).toContain("emoji.added");
  // And the CSV says the same, never the address.
  const csv = await (await call(`/audit/logs?orgId=${ORG}&format=csv`, toru)).text();
  expect(csv).toContain(`deleted user (${mikaP})`);
  expect(csv).not.toContain("mika@corp.jp");
  expect(csv).not.toContain("Mika Sato");
});

test("phase 1 rows are moved: encrypted, chained again, the old chain's end recorded — and someone already gone is unreadable", async () => {
  const plain = { ...env, AUDIT_MASTER_KEY: undefined, AUDIT_PSEUDONYM_KEY: undefined };
  await audit(plain, null, { orgId: ORG, action: "member.role_changed", actor: { type: "user", id: "u:toru@corp.jp", name: "Toru Tanaka" }, entity: { type: "user", id: "u:mika@corp.jp", name: "Mika Sato" }, details: { from: "member", to: "admin" } });
  await audit(plain, null, { orgId: ORG, action: "emoji.added", actor: { type: "user", id: "u:gone@corp.jp", name: "Gone Person" }, entity: { type: "emoji", id: "x", name: ":x:" } });
  const legacy = await rows();
  expect(legacy.every((r) => r.enc === 0)).toBe(true);
  expect(JSON.stringify(legacy)).toContain("mika@corp.jp");
  const lastHash = legacy[legacy.length - 1].hash;
  // One written since the deploy, already encrypted, chained to the plaintext.
  await audit(env, null, { orgId: ORG, action: "workspace.renamed", actor: { type: "user", id: "u:toru@corp.jp", name: "Toru Tanaka" }, entity: { type: "workspace", id: ORG, name: "Private" } });

  const out = await migrateOrgAudit(env, ORG);
  expect(out).toMatchObject({ orgId: ORG, rows: 2, shredded: 1 });
  const moved = await rows();
  expect(moved.every((r) => r.enc === 1)).toBe(true);
  for (const secret of ["mika@corp.jp", "toru@corp.jp", "Mika Sato", "gone@corp.jp", "Gone Person"]) expect(JSON.stringify(moved)).not.toContain(secret);
  const marker = moved[moved.length - 1];
  expect(marker.action).toBe("audit.chain_migrated");
  expect(JSON.parse(marker.body).details).toEqual({ legacy_last_seq: 2, legacy_last_hash: lastHash, rows: 2 });
  expect((await verifyChain(env.DB, ORG)).ok).toBe(true);
  // Nothing left to move.
  expect(await migrateOrgAudit(env, ORG)).toBe(null);

  forgetCachedKeys();
  const { entries } = await (await call(`/audit/logs?orgId=${ORG}`, toru)).json();
  expect(entries.find((e) => e.action === "member.role_changed").entity).toMatchObject({ name: "Mika Sato" });
  expect(entries.find((e) => e.action === "emoji.added").actor).toMatchObject({ deleted: true });
});

test("no route puts a name or an address into an entry's details", async () => {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "7403", login: "u:aya@corp.jp", name: "Aya Ito", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "7403", "member");
  const aRef = await memberRef(ORG, "7403");
  expect((await call("/channels/members", toru, { method: "POST", body: { orgId: ORG, channel: "b:cafe", refs: [aRef] } })).status).toBe(200);
  expect((await call("/channels/members", toru, { method: "DELETE", body: { orgId: ORG, channel: "b:cafe", ref: aRef } })).status).toBe(200);
  await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: aRef, role: "guest", channels: ["cafe"] } });
  await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "member" } });
  const stored = await rows();
  expect(stored.map((r) => r.action)).toEqual(expect.arrayContaining(["channel.member_added", "channel.member_removed", "member.role_changed", "invite.created"]));
  for (const r of stored) {
    const details = JSON.stringify(JSON.parse(r.body).details || {});
    for (const secret of ["Aya Ito", "aya@corp.jp", "Toru Tanaka", "toru@corp.jp", "@corp.jp"]) expect(details).not.toContain(secret);
  }
});

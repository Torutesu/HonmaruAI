import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { PERMISSIONS, can, ensureOwner } from "../src/permissions.js";
import { memberRef } from "../src/team.js";

// Owners and admins (docs/admin-controls.md §4): one table decides who may do
// what; a workspace always has an owner; admins are the owners' to make; and
// a workspace is handed on only when the person named says yes.

const ORG = "team:owners";
let toru; let mika; let aya; let gus;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const roleOf = async (id) => (await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(ORG, id).first())?.role;
const actions = async () => (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all()).results.map((r) => r.action);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM rate_limits; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM memberships; DELETE FROM owner_transfers; DELETE FROM invites;");
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  // Made before owners existed: two admins, the earlier of them first in.
  for (const [id, login, name, role] of [["7301", "toru", "Toru", "admin"], ["7302", "mika", "Mika", "admin"], ["7303", "aya", "Aya", "member"], ["7304", "gus", "Gus", "guest"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
    await env.DB.prepare("UPDATE memberships SET created_at = ?3 WHERE org_id = ?1 AND user_github_id = ?2").bind(ORG, id, `2026-01-0${Number(id) - 7300}T00:00:00.000Z`).run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO orgs (id, name, created_at) VALUES (?1, 'Owners Inc', ?2)").bind(ORG, new Date().toISOString()).run();
  toru = await createSession(env.DB, "7301", "x");
  mika = await createSession(env.DB, "7302", "x");
  aya = await createSession(env.DB, "7303", "x");
  gus = await createSession(env.DB, "7304", "x");
});

test("the table: each action names the lowest role that may take it, and an unknown action is refused", () => {
  const roles = ["guest", "member", "admin", "owner"];
  const row = (action) => roles.filter((r) => can(r, action));
  expect(row("workspace.rename")).toEqual(["admin", "owner"]);
  expect(row("workspace.delete")).toEqual(["owner"]);
  expect(row("member.invite")).toEqual(["member", "admin", "owner"]);
  expect(row("member.invite_admin")).toEqual(["owner"]);
  expect(row("sso.manage")).toEqual(["owner"]);
  expect(row("org_key.manage")).toEqual(["owner"]);
  expect(row("session_policy.manage")).toEqual(["owner"]);
  expect(row("audit.read")).toEqual(["admin", "owner"]);
  expect(row("audit.stream.manage")).toEqual(["owner"]);
  expect(row("no.such.action")).toEqual([]);
  // Every action a guest may take is none; every action is taken by an owner.
  for (const action of Object.keys(PERMISSIONS)) {
    expect(can("guest", action)).toBe(false);
    expect(can("owner", action)).toBe(true);
  }
});

test("a workspace from before owners gets one — its longest-standing admin — and the log says so", async () => {
  const res = await call(`/members?orgId=${ORG}`, aya);
  expect(res.status).toBe(200);
  const { members } = await res.json();
  expect(members.find((m) => m.name === "Toru").role).toBe("owner");
  expect(members.find((m) => m.name === "Mika").role).toBe("admin");
  expect(await actions()).toContain("owner.assigned");
  // Once, however many times anyone looks.
  expect(await ensureOwner(env.DB, ORG)).toBe(null);
  await call(`/members?orgId=${ORG}`, aya);
  expect((await actions()).filter((a) => a === "owner.assigned")).toHaveLength(1);
});

test("admins are the owners' to make and unmake; an admin runs everyone below", async () => {
  await ensureOwner(env.DB, ORG);
  const aRef = await memberRef(ORG, "7303");
  const mRef = await memberRef(ORG, "7302");
  // An admin can make a guest a member, but not a member an admin.
  expect((await call("/members/role", mika, { method: "PUT", body: { orgId: ORG, ref: aRef, role: "admin" } })).status).toBe(403);
  // Nor remove another admin.
  expect((await call("/members", mika, { method: "DELETE", body: { orgId: ORG, ref: await memberRef(ORG, "7301") } })).status).toBe(403);
  // The owner can.
  const made = await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: aRef, role: "admin" } });
  expect(made.status).toBe(200);
  expect(await roleOf("7303")).toBe("admin");
  // Nor can an admin mint an admin invitation; nobody mints an owner one.
  expect((await call("/invites/create", mika, { method: "POST", body: { orgId: ORG, role: "admin" } })).status).toBe(400);
  expect((await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "owner" } })).status).toBe(400);
  expect((await call("/invites/create", toru, { method: "POST", body: { orgId: ORG, role: "admin" } })).status).toBe(200);
  // Another owner, directly: critical in the log.
  expect((await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: mRef, role: "owner" } })).status).toBe(200);
  expect(await roleOf("7302")).toBe("owner");
  expect(await actions()).toContain("owner.added");
  const added = await env.DB.prepare("SELECT severity FROM audit_events WHERE org_id = ?1 AND action = 'owner.added'").bind(ORG).first();
  expect(added.severity).toBe("critical");
});

test("the last owner cannot step down, leave, or delete their account while others are there", async () => {
  await ensureOwner(env.DB, ORG);
  const tRef = await memberRef(ORG, "7301");
  const down = await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: tRef, role: "admin" } });
  expect(down.status).toBe(409);
  expect((await down.json()).code).toBe("last-owner");
  const leave = await call("/members", toru, { method: "DELETE", body: { orgId: ORG, ref: tRef } });
  expect(leave.status).toBe(409);
  const gone = await call("/account", toru, { method: "DELETE" });
  expect(gone.status).toBe(409);
  const said = await gone.json();
  expect(said.code).toBe("last-owner");
  expect(said.workspaces).toEqual([{ id: ORG, name: "Owners Inc" }]);
  expect(await roleOf("7301")).toBe("owner");

  // With a second owner, the first may step down themselves.
  await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: await memberRef(ORG, "7302"), role: "owner" } });
  expect((await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: tRef, role: "admin" } })).status).toBe(200);
  expect(await roleOf("7301")).toBe("admin");
  expect(await actions()).toContain("owner.removed");
  // Nobody raises themselves.
  expect((await call("/members/role", toru, { method: "PUT", body: { orgId: ORG, ref: tRef, role: "owner" } })).status).toBe(400);
});

test("handing it on: offered, seen by the one named, accepted — and the one who offered steps down", async () => {
  await ensureOwner(env.DB, ORG);
  const aRef = await memberRef(ORG, "7303");
  // Only an owner offers, and never to a guest.
  expect((await call("/members/owner-transfer", mika, { method: "POST", body: { orgId: ORG, ref: aRef } })).status).toBe(403);
  expect((await call("/members/owner-transfer", toru, { method: "POST", body: { orgId: ORG, ref: await memberRef(ORG, "7304") } })).status).toBe(400);
  const offered = await call("/members/owner-transfer", toru, { method: "POST", body: { orgId: ORG, ref: aRef, stepDown: true } });
  expect(offered.status).toBe(200);
  // Aya sees it as hers to answer; nobody else can accept it.
  const seen = (await (await call(`/members?orgId=${ORG}`, aya)).json()).ownerTransfer;
  expect(seen).toMatchObject({ mine: "to", stepDown: true, from: { name: "Toru" }, to: { name: "Aya" } });
  expect((await call("/members/owner-transfer/accept", mika, { method: "POST", body: { orgId: ORG } })).status).toBe(404);
  expect(await roleOf("7303")).toBe("member");
  const yes = await call("/members/owner-transfer/accept", aya, { method: "POST", body: { orgId: ORG } });
  expect(yes.status).toBe(200);
  expect(await roleOf("7303")).toBe("owner");
  expect(await roleOf("7301")).toBe("admin");
  expect((await (await call(`/members?orgId=${ORG}`, aya)).json()).ownerTransfer).toBe(null);
  expect(await actions()).toEqual(expect.arrayContaining(["owner.transfer_offered", "owner.transferred"]));
});

test("an offer can be declined, and a workspace someone makes is theirs to own", async () => {
  await ensureOwner(env.DB, ORG);
  await call("/members/owner-transfer", toru, { method: "POST", body: { orgId: ORG, ref: await memberRef(ORG, "7303") } });
  expect((await call("/members/owner-transfer", aya, { method: "DELETE", body: { orgId: ORG } })).status).toBe(200);
  expect((await call("/members/owner-transfer/accept", aya, { method: "POST", body: { orgId: ORG } })).status).toBe(404);
  expect(await roleOf("7303")).toBe("member");

  const made = await call("/orgs", aya, { method: "POST", body: { name: "Aya's shop" } });
  expect(made.status).toBe(200);
  const { orgId } = await made.json();
  const row = await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = '7303'").bind(orgId).first();
  expect(row.role).toBe("owner");
});

test("routes ask the table: a member cannot change what the AI runs on; an admin can", async () => {
  await ensureOwner(env.DB, ORG);
  expect((await call("/orgs/ai", aya, { method: "PUT", body: { orgId: ORG, model: "gpt-4.1-mini" } })).status).toBe(403);
  const ok = await call("/orgs/ai", mika, { method: "PUT", body: { orgId: ORG, model: "gpt-4.1-mini" } });
  expect(ok.status).not.toBe(403);
  expect((await call(`/audit/logs?orgId=${ORG}`, aya)).status).toBe(403);
  expect((await call(`/audit/logs?orgId=${ORG}`, mika)).status).toBe(200);
  expect(gus).toBeTruthy();
});

test("the one-off script settles every workspace at once, and leaves one that has an owner alone", async () => {
  const script = (await import("../scripts/assign-owners.mjs?raw")).default;
  const sql = script.match(/const SQL = `([\s\S]*?)`;/)[1].replace(/\n/g, " ");
  const { upsertMembership } = await import("../src/db.js");
  await upsertMembership(env.DB, "acme/app", "7301", "admin");
  await upsertMembership(env.DB, "team:held", "7302", "owner");
  await upsertMembership(env.DB, "team:held", "7301", "admin");
  await env.DB.exec(sql);
  await env.DB.exec(sql);
  expect(await roleOf("7301")).toBe("owner");
  expect(await roleOf("7302")).toBe("admin");
  const role = async (org, id) => (await env.DB.prepare("SELECT role FROM memberships WHERE org_id = ?1 AND user_github_id = ?2").bind(org, id).first()).role;
  expect(await role("acme/app", "7301")).toBe("admin");
  expect(await role("team:held", "7301")).toBe("admin");
});

import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { forgetDeletions, purgeDueWorkspaces } from "../src/workspaceDeletion.js";

// A workspace could not be deleted at all: `workspace.delete` was a
// permission nothing used. An owner now asks, has thirty days to take it
// back, and then everything stored under it goes.

const ORG = "team:going";
const DAY = 86_400_000;
let owner; let member;
const post = (path, token, body) => worker.fetch(new Request(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-session-token": token }, body: JSON.stringify(body),
}), env, { waitUntil() {} });
const get = (path, token) => worker.fetch(new Request(`https://example.com${path}`, { headers: { "x-session-token": token } }), env, { waitUntil() {} });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  forgetDeletions();
  const { createSession, upsertUser, upsertMembership, saveCard } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9501", login: "own", name: "Own", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9502", login: "mem", name: "Mem", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9501", "owner");
  await upsertMembership(env.DB, ORG, "9502", "member");
  await upsertMembership(env.DB, "team:stays", "9502", "owner");
  await env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?1, 'Going Co', ?2)").bind(ORG, new Date().toISOString()).run();
  const now = new Date().toISOString();
  await saveCard(env.DB, ORG, { id: "c1", recipientUserID: "own", senderUserID: "mem", type: "approval", title: "x", status: "pending", createdAt: now });
  await saveCard(env.DB, "team:stays", { id: "c2", recipientUserID: "mem", senderUserID: "mem", type: "approval", title: "y", status: "pending", createdAt: now });
  await env.MEDIA.put(`org/${encodeURIComponent(ORG)}/files/f_1`, "bytes");
  await env.MEDIA.put(`org/${encodeURIComponent("team:stays")}/files/f_2`, "bytes");
  owner = await createSession(env.DB, "9501", "x");
  member = await createSession(env.DB, "9502", "x");
});

test("only an owner, typing its name, asks; the workspace closes to everyone else, and the owner can take it back", async () => {
  expect((await post("/orgs/delete", member, { orgId: ORG, confirm: "Going Co" })).status).toBe(403);
  const wrong = await post("/orgs/delete", owner, { orgId: ORG, confirm: "going" });
  expect(wrong.status).toBe(400);
  expect((await wrong.json()).code).toBe("confirm-name");
  const asked = await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  expect(asked.status).toBe(202);
  expect(Date.parse((await asked.json()).dueAt) - Date.now()).toBeGreaterThan(29 * DAY);

  const closed = await get(`/members?orgId=${encodeURIComponent(ORG)}`, member);
  expect(closed.status).toBe(410);
  expect((await closed.json()).code).toBe("workspace-deleting");
  expect((await get(`/members?orgId=${encodeURIComponent(ORG)}`, owner)).status).toBe(200);
  // Their other workspace is untouched.
  expect((await get(`/members?orgId=${encodeURIComponent("team:stays")}`, member)).status).toBe(200);

  expect((await post("/orgs/delete/cancel", owner, { orgId: ORG })).status).toBe(200);
  forgetDeletions();
  expect((await get(`/members?orgId=${encodeURIComponent(ORG)}`, member)).status).toBe(200);
  const actions = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id = ?1 ORDER BY seq").bind(ORG).all()).results.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(["workspace.deletion_scheduled", "workspace.deletion_cancelled"]));
});

test("after thirty days everything under the workspace goes, the audit log stays, and a tombstone says when", async () => {
  await post("/orgs/delete", owner, { orgId: ORG, confirm: "Going Co" });
  // Not yet.
  expect(await purgeDueWorkspaces(env, { now: Date.now() + 29 * DAY })).toEqual([]);
  expect(await purgeDueWorkspaces(env, { now: Date.now() + 31 * DAY })).toEqual([ORG]);

  const left = async (sql) => (await env.DB.prepare(sql).bind(ORG).first()).n;
  expect(await left("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1")).toBe(0);
  expect(await left("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1")).toBe(0);
  expect(await left("SELECT COUNT(*) AS n FROM orgs WHERE id = ?1")).toBe(0);
  expect(await left("SELECT COUNT(*) AS n FROM workspace_tombstones WHERE org_id = ?1")).toBe(1);
  expect(await left("SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?1")).toBeGreaterThan(0);
  expect(await env.MEDIA.get(`org/${encodeURIComponent(ORG)}/files/f_1`)).toBeNull();
  // Nobody else's.
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = 'team:stays'").first()).n).toBe(1);
  expect(await env.MEDIA.get(`org/${encodeURIComponent("team:stays")}/files/f_2`)).not.toBeNull();
});

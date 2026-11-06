import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";
import { setMode } from "../src/harness/mode.js";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";

const suffix = () => crypto.randomUUID().replaceAll("-", "");
const migrationLines = migrationsSql.split("\n");
const grantMigrations = [
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_resource_grants /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_resource_grants_/.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_send_requests /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_thread_send_requests_/.test(line)),
  migrationLines.find((line) => /^ALTER TABLE hx_external_resource_grants ADD COLUMN suspended_at /.test(line)),
  migrationLines.find((line) => /^UPDATE hx_external_resource_grants SET suspended_at=/.test(line)),
  migrationLines.find((line) => /^CREATE TRIGGER IF NOT EXISTS hx_external_resource_grants_suspend_on_membership /.test(line)),
].filter(Boolean);

async function setup() {
  const tag = suffix();
  const orgId = `external-thread-${tag}`;
  const ids = {
    owner: `external-owner-${tag}`,
    editor: `external-editor-${tag}`,
    guest: `external-guest-${tag}`,
    otherOrg: `external-other-org-${tag}`,
  };
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  if (!grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_resource_grants ")) ||
      !grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_thread_send_requests ")) ||
      !grantMigrations.some((line) => line.startsWith("ALTER TABLE hx_external_resource_grants ADD COLUMN suspended_at ")) ||
      !grantMigrations.some((line) => line.startsWith("CREATE TRIGGER IF NOT EXISTS hx_external_resource_grants_suspend_on_membership "))) {
    throw new Error("external Thread sharing migration is missing");
  }
  for (const sql of grantMigrations) await env.DB.exec(sql);
  for (const [key, id] of Object.entries(ids)) {
    await upsertUser(env.DB, { githubId: id, login: id, name: key, avatarUrl: null, locale: "en" });
  }
  await env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)")
    .bind(orgId, orgId, new Date().toISOString()).run();
  await upsertMembership(env.DB, orgId, ids.owner, "member");
  await upsertMembership(env.DB, orgId, ids.editor, "member");
  await env.DB.prepare("UPDATE users SET email = ?1, email_verified_at = ?2 WHERE github_id = ?3")
    .bind(`guest-${tag}@example.test`, new Date().toISOString(), ids.guest).run();
  await setMode(env.DB, orgId, "harness", ids.owner);
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, created_by, created_at, private) VALUES (?1, 'private-room', 'Private Room', ?2, ?3, 1)")
    .bind(orgId, ids.owner, new Date().toISOString()).run();
  for (const id of [ids.owner, ids.editor]) {
    const login = (await env.DB.prepare("SELECT login FROM users WHERE github_id=?1").bind(id).first()).login;
    await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:private-room', ?2, ?3, ?4)")
      .bind(orgId, login, ids.owner, new Date().toISOString()).run();
  }
  const rootId = `thread-root-${tag}`;
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, 'b:private-room', ?3, 'message', 'Private launch plan', ?4)")
    .bind(rootId, orgId, ids.owner, new Date().toISOString()).run();
  const sessions = {};
  for (const [key, id] of Object.entries(ids)) sessions[key] = await createSession(env.DB, id, "external-thread-test");
  return { orgId, rootId, ids, sessions };
}

const context = { waitUntil() {} };
async function call(path, token, method = "GET", body = undefined) {
  const response = await import("../src/index.js").then(({ default: worker }) => worker.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { "x-session-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, context,
  ));
  return response;
}

test("owners can list only active named grants and revoke them without adding membership", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  expect((await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner)).status).toBe(200);
  const created = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "edit" });
  expect(created.status).toBe(201);
  const path = `/external/threads/${orgId}/${rootId}/shares`;
  const listed = await call(path, sessions.owner);
  expect((await listed.json()).shares).toMatchObject([{
    permission: "edit", recipient: { name: "guest", email }, expiresAt: null,
  }]);
  expect((await call(path, sessions.editor)).status).toBe(404);
  expect((await call(path, sessions.guest)).status).toBe(404);
  expect((await call(`/external/threads/${orgId}/missing/shares`, sessions.owner)).status).toBe(404);

  const grantedAt = new Date(Date.now() - 60_000).toISOString();
  const expiredAt = new Date(Date.now() - 30_000).toISOString();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET granted_at=?1, expires_at=?2 WHERE org_id=?3 AND resource_type='thread' AND resource_id=?4 AND recipient_github_id=?5 AND revoked_at IS NULL")
    .bind(grantedAt, expiredAt, orgId, rootId, ids.guest).run();
  expect((await (await call(path,sessions.owner)).json()).shares).toEqual([]);

  const second = await call(path, sessions.owner, "POST", { email, permission: "view" });
  expect(second.status).toBe(201);
  expect((await call(path,sessions.owner,"DELETE",{email})).status).toBe(200);
  expect((await (await call(path,sessions.owner)).json()).shares).toEqual([]);
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId,ids.guest).first()).toBeNull();
});

test("a verified non-member can read and reply only to an explicitly shared Thread", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const share = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", {
    email: `guest-${orgId.split("-").at(-1)}@example.test`, permission: "view",
  });
  expect(share.status).toBe(201);
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId, ids.guest).first()).toBeNull();

  const read = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ permission: "view", thread: { parent: { id: rootId, body: "Private launch plan" }, replies: [] } });
  expect((await call(`/channels/messages?orgId=${orgId}&channel=b%3Aprivate-room`, sessions.guest)).status).toBe(403);

  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: "send without approval" })).status).toBe(403);
  const request = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: "Please confirm the launch date.", requestSend: true });
  expect(request.status).toBe(201);
  const sendRequest = await request.json();
  expect((await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.editor)).status).toBe(404);
  const pending = await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.owner);
  expect((await pending.json()).requests).toMatchObject([{ id: sendRequest.requestId, body: "Please confirm the launch date." }]);
  const approved = await call(`/external/threads/${orgId}/${rootId}/requests/approve`, sessions.owner, "POST", { requestId: sendRequest.requestId });
  expect(approved.status).toBe(200);

  const refreshed = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  expect(refreshed.thread.replies).toMatchObject([{ body: "Please confirm the launch date.", authorName: "guest", mine: true }]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND kind='agent'").bind(orgId, rootId).first()).toMatchObject({ n: 0 });
});

test("sharing authority is resource-owner/Admin scoped and grants do not cross workspaces", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const guestEmail = `guest-${orgId.split("-").at(-1)}@example.test`;
  const nonOwner = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.editor, "POST", { email: guestEmail, permission: "edit" });
  expect(nonOwner.status).toBe(404);

  const created = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email: guestEmail, permission: "edit" });
  expect(created.status).toBe(201);
  const otherOrgId = `external-empty-${suffix()}`;
  await env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)").bind(otherOrgId, otherOrgId, new Date().toISOString()).run();
  await setMode(env.DB, otherOrgId, "harness", ids.owner);
  const otherRootId = `${rootId}-other`;
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, 'b:other-room', ?3, 'message', 'Other workspace', ?4)")
    .bind(otherRootId, otherOrgId, ids.owner, new Date().toISOString()).run();
  expect((await call(`/external/threads/${otherOrgId}/${otherRootId}`, sessions.guest)).status).toBe(404);
  const reply = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: "Approved edit" });
  expect(reply.status).toBe(201);
});

test("revocation and expiry are rechecked on every read and write; Simple stays closed", async () => {
  const { orgId, rootId, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  const expiresAt = new Date(Date.now() + 5_000).toISOString();
  expect((await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "edit", expiresAt })).status).toBe(201);
  await new Promise(resolve => setTimeout(resolve, 5_200));
  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).status).toBe(404);
  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: "expired" })).status).toBe(404);

  const second = await setup();
  const secondEmail = `guest-${second.orgId.split("-").at(-1)}@example.test`;
  expect((await call(`/external/threads/${second.orgId}/${second.rootId}/shares`, second.sessions.owner, "POST", { email: secondEmail, permission: "edit" })).status).toBe(201);
  expect((await call(`/external/threads/${second.orgId}/${second.rootId}/shares`, second.sessions.editor, "DELETE", { email: secondEmail })).status).toBe(404);
  expect((await call(`/external/threads/${second.orgId}/${second.rootId}/shares`, second.sessions.owner, "DELETE", { email: secondEmail })).status).toBe(200);
  expect((await call(`/external/threads/${second.orgId}/${second.rootId}`, second.sessions.guest)).status).toBe(404);
  expect((await call(`/external/threads/${second.orgId}/${second.rootId}`, second.sessions.guest, "POST", { body: "after revoke" })).status).toBe(404);

  await setMode(env.DB, second.orgId, "simple", second.ids.owner);
  expect((await call(`/external/threads/${second.orgId}/${second.rootId}`, second.sessions.guest)).status).toBe(404);
}, 15_000);


test("membership transition pauses external Thread access, keeps the grant visible, and allows owner revoke", async () => {
  const {orgId,rootId,ids,sessions}=await setup();
  const email=`guest-${orgId.split("-").at(-1)}@example.test`;
  const path=`/external/threads/${orgId}/${rootId}/shares`;
  expect((await call(path,sessions.owner,"POST",{email,permission:"edit"})).status).toBe(201);
  expect((await call(`/external/threads/${orgId}/${rootId}`,sessions.guest)).status).toBe(200);

  await upsertMembership(env.DB,orgId,ids.guest,"member");
  const listed=await call(path,sessions.owner);
  const shares=(await listed.json()).shares;
  expect(shares).toMatchObject([{
    recipient:{email},recipientIsMember:true,suspended:true,permission:"edit",
  }]);
  expect((await call(`/external/threads/${orgId}/${rootId}`,sessions.guest)).status).toBe(404);

  expect((await call(path,sessions.owner,"DELETE",{grantId:shares[0].id})).status).toBe(200);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId,ids.guest).run();
  expect((await call(`/external/threads/${orgId}/${rootId}`,sessions.guest)).status).toBe(404);
  expect(await env.DB.prepare("SELECT suspended_at,revoked_at FROM hx_external_resource_grants WHERE org_id=?1 AND resource_id=?2 AND recipient_github_id=?3").bind(orgId,rootId,ids.guest).first())
    .toMatchObject({suspended_at:expect.any(String),revoked_at:expect.any(String)});
});

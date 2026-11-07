import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";
import { setMode } from "../src/harness/mode.js";
import { createApp } from "../src/harness/apps.js";
import { createTable, addRow, updateRow, deleteRow } from "../src/harness/tables.js";
import { grantExternalResource, revokeExternalResource } from "../src/harness/externalCollaborators.js";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";
import worker from "../src/index.js";
import { externalAppWriteGuard } from "../src/externalApps.js";

const tag = () => crypto.randomUUID().replaceAll("-", "");
const context = { waitUntil() {} };
const grantMigration = migrationsSql.split("\n").filter((line) =>
  /^CREATE TABLE IF NOT EXISTS hx_external_resource_grants /.test(line) ||
  /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_resource_grants_/.test(line) ||
  /^CREATE TABLE IF NOT EXISTS hx_external_app_invites /.test(line) ||
  /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_app_invites_/.test(line) ||
  /^CREATE TABLE IF NOT EXISTS hx_external_app_send_requests /.test(line) ||
  /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_app_send_requests_/.test(line)
);

async function setup() {
  const id = tag();
  const orgId = `external-app-${id}`;
  const ownerId = `external-app-owner-${id}`;
  const guestId = `external-app-guest-${id}`;
  const memberId = `external-app-member-${id}`;
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  if (!grantMigration.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_resource_grants "))) {
    throw new Error("external App grants require the external resource grant migration");
  }
  for (const sql of grantMigration) await env.DB.exec(sql);
  for (const [githubId, name] of [[ownerId, "Owner"], [guestId, "Guest"], [memberId, "Member"]]) {
    await upsertUser(env.DB, { githubId, login: githubId, name, avatarUrl: null, locale: "en" });
  }
  await env.DB.prepare("INSERT INTO orgs (id,name,created_at) VALUES (?1,?2,?3)")
    .bind(orgId, orgId, new Date().toISOString()).run();
  await upsertMembership(env.DB, orgId, ownerId, "admin");
  await upsertMembership(env.DB, orgId, memberId, "member");
  await setMode(env.DB, orgId, "harness", ownerId);

  const primary = await createApp(env.DB, {
    orgId, by: ownerId, name: "Shared app", tableName: "Primary table",
    columns: [{ id: "title", name: "Title", type: "text" }], definition: {},
  });
  if (primary.error) throw new Error(primary.error);
  const app = primary.app;
  const linked = await createTable(env.DB, { orgId, by: ownerId, name: "Linked table", columns: [{ id: "secret", name: "Secret", type: "text" }] });
  const unlinked = await createTable(env.DB, { orgId, by: ownerId, name: "Unlinked table", columns: [{ id: "private", name: "Private", type: "text" }] });
  if (linked.error || unlinked.error) throw new Error("table fixture could not be created");
  await env.DB.prepare("INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) VALUES (?1,?2,'linked',?3)")
    .bind(orgId, app.id, linked.table.id).run();
  const now = new Date().toISOString();
  const primaryRowId = `row-primary-${id}`;
  const linkedRowId = `row-linked-${id}`;
  await env.DB.prepare("INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,0,?5,?6,?6)")
    .bind(primaryRowId, app.tableId, orgId, JSON.stringify({ title: "visible row", removed_column: "must not leak" }), ownerId, now).run();
  await env.DB.prepare("INSERT INTO hx_rows (id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,0,?5,?6,?6)")
    .bind(linkedRowId, linked.table.id, orgId, JSON.stringify({ secret: "linked row" }), ownerId, now).run();
  const other = await createApp(env.DB, { orgId, by: ownerId, name: "Other app", columns: [{ id: "name", name: "Name", type: "text" }], definition: {} });
  if (other.error) throw new Error(other.error);
  await grantExternalResource(env.DB, { orgId, resourceType: "app", resourceId: app.id, recipientGithubId: guestId, permission: "edit", grantedBy: ownerId });
  const sessions = {
    owner: await createSession(env.DB, ownerId, "external-app-guest-test"),
    guest: await createSession(env.DB, guestId, "external-app-guest-test"),
    member: await createSession(env.DB, memberId, "external-app-guest-test"),
  };
  return { orgId, ownerId, guestId, app, otherApp: other.app, primaryRowId, linkedTable: linked.table, unlinkedTable: unlinked.table, linkedRowId, sessions };
}

async function call(path, token, method = "GET", body = undefined, database = env.DB) {
  return worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "x-session-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), database === env.DB ? env : { ...env, DB: database }, context);
}

function removeManagerImmediatelyAfterAccess(db, orgId, managerId) {
  const managerQuery = "SELECT a.id,a.org_id,a.created_by,a.definition,m.role FROM hx_apps";
  const wrapStatement = (statement, revokeAfterFirst) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values) => wrapStatement(target.bind(...values), revokeAfterFirst);
      if (property === "first") return async (...args) => {
        const row = await target.first(...args);
        if (row && revokeAfterFirst) {
          revokeAfterFirst = false;
          await db.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2")
            .bind(orgId, managerId).run();
        }
        return row;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql) =>
        wrapStatement(target.prepare(sql), String(sql).startsWith(managerQuery));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("an exact App grant exposes only its primary and linked table rows", async () => {
  const f = await setup();
  const app = await call(`/external/apps/${f.orgId}/${f.app.id}`, f.sessions.guest);
  expect(app.status).toBe(200);
  expect(await app.json()).toMatchObject({ app: { id: f.app.id, name: "Shared app" } });
  expect((await call(`/external/apps/${f.orgId}/${f.otherApp.id}`, f.sessions.guest)).status).toBe(404);

  const primary = await call(`/external/apps/${f.orgId}/${f.app.id}/tables/${f.app.tableId}/rows`, f.sessions.guest);
  expect(primary.status).toBe(200);
  const primaryBody = await primary.json();
  expect(primaryBody.rows).toMatchObject([{ id: f.primaryRowId, data: { title: "visible row" } }]);
  expect(primaryBody.rows[0].data).toEqual({ title: "visible row" });
  const linked = await call(`/external/apps/${f.orgId}/${f.app.id}/tables/${f.linkedTable.id}/rows/${f.linkedRowId}`, f.sessions.guest);
  expect(linked.status).toBe(200);
  expect(await linked.json()).toMatchObject({ rows: [{ id: f.linkedRowId, data: { secret: "linked row" } }] });
  expect((await call(`/external/apps/${f.orgId}/${f.app.id}/tables/${f.unlinkedTable.id}/rows`, f.sessions.guest)).status).toBe(404);
  expect((await call(`/external/apps/${f.orgId}/${f.app.id}/tables/${f.linkedTable.id}/rows/${f.primaryRowId}`, f.sessions.guest)).status).toBe(404);
  // A workspace member cannot use the guest capability, even if they can use
  // the same App through ordinary membership-based routes.
  expect((await call(`/external/apps/${f.orgId}/${f.app.id}`, f.sessions.member)).status).toBe(404);
});

test("App and record conversations stay in their exact scope and require edit to send", async () => {
  const f = await setup();
  const rootPath = `/external/apps/${f.orgId}/${f.app.id}/conversation`;
  const rootSend = await call(rootPath, f.sessions.guest, "POST", { body: "App note", requestId: "root_request_000001" });
  expect(rootSend.status).toBe(201);
  expect((await (await call(rootPath, f.sessions.guest)).json()).messages).toMatchObject([{ body: "App note" }]);

  const recordPath = `${rootPath}?tableId=${encodeURIComponent(f.linkedTable.id)}&rowId=${encodeURIComponent(f.linkedRowId)}`;
  const recordSend = await call(rootPath, f.sessions.guest, "POST", { tableId: f.linkedTable.id, rowId: f.linkedRowId, body: "Record note", requestId: "record_request_0001" });
  expect(recordSend.status).toBe(201);
  expect((await (await call(recordPath, f.sessions.guest)).json()).messages).toMatchObject([{ body: "Record note" }]);
  expect((await (await call(rootPath, f.sessions.guest)).json()).messages).toHaveLength(1);
  expect((await call(rootPath, f.sessions.guest, "POST", { tableId: f.unlinkedTable.id, rowId: "any", body: "bad scope", requestId: "bad_scope_request_01" })).status).toBe(404);

  await grantExternalResource(env.DB, { orgId: f.orgId, resourceType: "app", resourceId: f.app.id, recipientGithubId: f.guestId, permission: "view", grantedBy: f.ownerId });
  expect((await call(rootPath, f.sessions.guest)).status).toBe(200);
  expect((await call(rootPath, f.sessions.guest, "POST", { body: "view-only", requestId: "view_request_00001" })).status).toBe(403);
});

test("App guest access fails closed after revocation and in Simple mode", async () => {
  const f = await setup();
  const path = `/external/apps/${f.orgId}/${f.app.id}`;
  expect((await call(path, f.sessions.guest)).status).toBe(200);
  await revokeExternalResource(env.DB, { orgId: f.orgId, resourceType: "app", resourceId: f.app.id, recipientGithubId: f.guestId, revokedBy: f.ownerId });
  expect((await call(path, f.sessions.guest)).status).toBe(404);
  expect((await call(`${path}/conversation`, f.sessions.guest)).status).toBe(404);

  await grantExternalResource(env.DB, { orgId: f.orgId, resourceType: "app", resourceId: f.app.id, recipientGithubId: f.guestId, permission: "edit", grantedBy: f.ownerId });
  await setMode(env.DB, f.orgId, "simple", f.ownerId);
  expect((await call(path, f.sessions.guest)).status).toBe(404);
});

test("expired App grants deny metadata, row lists, and conversation reads", async () => {
  const f = await setup();
  const grant = await env.DB.prepare(`SELECT id FROM hx_external_resource_grants
    WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL`)
    .bind(f.orgId, f.app.id, f.guestId).first();
  expect(grant?.id).toBeTruthy();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET granted_at=?1,expires_at=?2 WHERE id=?3")
    .bind("2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z", grant.id).run();

  const appPath = `/external/apps/${f.orgId}/${f.app.id}`;
  const rowsPath = `${appPath}/tables/${f.app.tableId}/rows`;
  const conversationPath = `${appPath}/conversation`;
  expect((await call(appPath, f.sessions.guest)).status).toBe(404);
  expect((await call(rowsPath, f.sessions.guest)).status).toBe(404);
  expect((await call(conversationPath, f.sessions.guest)).status).toBe(404);
});

test("workspace purge and tombstones deny linked table metadata and conversations", async () => {
  const f = await setup();
  const appPath = `/external/apps/${f.orgId}/${f.app.id}`;
  const tablePath = `${appPath}/tables/${f.linkedTable.id}/rows`;
  const conversationPath = `${appPath}/conversation`;
  const now = new Date().toISOString();

  await env.DB.prepare(`INSERT INTO workspace_deletions
    (org_id,due_at,requested_by,requested_at,purge_started_at) VALUES (?1,?2,?3,?2,?2)`)
    .bind(f.orgId, now, f.ownerId).run();
  expect((await call(tablePath, f.sessions.guest)).status).toBe(404);
  expect((await call(conversationPath, f.sessions.guest)).status).toBe(404);
  await env.DB.prepare("DELETE FROM workspace_deletions WHERE org_id=?1").bind(f.orgId).run();

  await env.DB.prepare("INSERT INTO workspace_tombstones (org_id,deleted_at,requested_by) VALUES (?1,?2,?3)")
    .bind(f.orgId, now, f.ownerId).run();
  expect((await call(tablePath, f.sessions.guest)).status).toBe(404);
  expect((await call(conversationPath, f.sessions.guest)).status).toBe(404);
});

test("App invite managers can list, issue, redeem, update, and revoke an exact guest grant", async () => {
  const f = await setup();
  const guestId = `external-app-invitee-${tag()}`;
  await upsertUser(env.DB, { githubId: guestId, login: guestId, name: "Invitee", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3")
    .bind("invitee@example.com", new Date().toISOString(), guestId).run();
  const session = await createSession(env.DB, guestId, "external-app-guest-test");
  const sharing = `/external/apps/${f.orgId}/${f.app.id}/sharing`;
  const created = await call(sharing, f.sessions.owner, "POST", {
    email: "Invitee@Example.com", permission: "view",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(created.status).toBe(201);
  const invite = (await created.json()).invite;
  expect(invite.inviteUrl).toContain("/#/external-invite/");
  const stored = await env.DB.prepare("SELECT token_hash FROM hx_external_app_invites WHERE id=?1").bind(invite.id).first();
  expect(stored.token_hash).not.toBe(invite.token);
  expect((await call(sharing, f.sessions.owner)).status).toBe(200);
  expect((await call(sharing, f.sessions.member, "POST", { email: "blocked@example.com", permission: "view" })).status).toBe(404);

  const redeemed = await call("/external/invites/redeem", session, "POST", { token: invite.token });
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toMatchObject({ ok: true, resourceType: "app", orgId: f.orgId, appId: f.app.id });
  expect((await call(`/external/apps/${f.orgId}/${f.app.id}`, session)).status).toBe(200);

  const updated = await call(`${sharing}/${guestId}`, f.sessions.owner, "PATCH", { permission: "edit", expiresAt: null });
  expect(updated.status).toBe(200);
  const revoked = await call(`${sharing}/${guestId}`, f.sessions.owner, "DELETE");
  expect(revoked.status).toBe(200);
  expect((await call(`/external/apps/${f.orgId}/${f.app.id}`, session)).status).toBe(404);
});

test("view guests can request App conversation sends for owner approval only", async () => {
  const f = await setup();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET permission='view' WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).run();
  const appPath = `/external/apps/${f.orgId}/${f.app.id}`;
  const requested = await call(`${appPath}/conversation`, f.sessions.guest, "POST", { body: "Please approve this note.", requestSend: true });
  expect(requested.status).toBe(201);
  const queuePath = `/external/apps/${f.orgId}/${f.app.id}/sharing/requests`;
  const queue = await call(queuePath, f.sessions.owner);
  expect((await queue.json()).requests).toMatchObject([{ id: (await requested.clone().json()).requestId, body: "Please approve this note." }]);
  const requestId = (await requested.json()).requestId;
  const approved = await call(`${queuePath}/${requestId}`, f.sessions.owner, "POST", { decision: "approve" });
  expect(approved.status).toBe(200);
  const conversation = await call(`${appPath}/conversation`, f.sessions.guest);
  expect((await conversation.json()).messages).toMatchObject([{ body: "Please approve this note.", authorName: "Guest" }]);

  const second = await call(`${appPath}/conversation`, f.sessions.guest, "POST", { body: "Please reject this note.", requestSend: true });
  expect(second.status).toBe(201);
  const rejected = await call(`${queuePath}/${(await second.json()).requestId}`, f.sessions.owner, "POST", { decision: "reject" });
  expect(rejected.status).toBe(200);
});

test("external App row writes honor exact edit grants, linked table scope, and declared columns", async () => {
  const f = await setup();
  const appPath = `/external/apps/${f.orgId}/${f.app.id}`;
  const primaryRows = `${appPath}/tables/${f.app.tableId}/rows`;
  const linkedRows = `${appPath}/tables/${f.linkedTable.id}/rows`;
  const unlinkedRows = `${appPath}/tables/${f.unlinkedTable.id}/rows`;
  const otherAppRows = `/external/apps/${f.orgId}/${f.otherApp.id}/tables/${f.otherApp.tableId}/rows`;

  await env.DB.prepare("UPDATE hx_external_resource_grants SET permission='view' WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).run();
  expect((await call(primaryRows, f.sessions.guest, "POST", { values: { title: "view blocked" } })).status).toBe(403);

  await env.DB.prepare("UPDATE hx_external_resource_grants SET permission='edit' WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).run();
  expect((await call(unlinkedRows, f.sessions.guest, "POST", { values: { private: "blocked" } })).status).toBe(404);
  expect((await call(otherAppRows, f.sessions.guest, "POST", { values: { name: "blocked" } })).status).toBe(404);
  expect((await call(`${primaryRows}/${f.linkedRowId}`, f.sessions.guest, "PATCH", { values: { title: "cross table" } })).status).toBe(404);

  const deniedField = await call(primaryRows, f.sessions.guest, "POST", { values: { title: "allowed", hidden: "must not store" } });
  expect(deniedField.status).toBe(400);
  const created = await call(primaryRows, f.sessions.guest, "POST", { values: { title: "guest record" } });
  expect(created.status).toBe(201);
  const createdRow = (await created.json()).row;
  expect(createdRow.values).toEqual({ title: "guest record" });
  const deniedUpdate = await call(`${primaryRows}/${createdRow.id}`, f.sessions.guest, "PATCH", {
    values: { unexpected: "must not store" }, expectedUpdatedAt: createdRow.updatedAt,
  });
  expect(deniedUpdate.status).toBe(400);
  const updated = await call(`${primaryRows}/${createdRow.id}`, f.sessions.guest, "PATCH", {
    values: { title: "updated guest record" }, expectedUpdatedAt: createdRow.updatedAt,
  });
  expect(updated.status).toBe(200);
  const updatedRow = (await updated.json()).row;
  expect(updatedRow.values).toEqual({ title: "updated guest record" });

  await revokeExternalResource(env.DB, {
    orgId: f.orgId, resourceType: "app", resourceId: f.app.id,
    recipientGithubId: f.guestId, revokedBy: f.ownerId,
  });
  expect((await call(`${primaryRows}/${createdRow.id}`, f.sessions.guest, "DELETE", {
    expectedUpdatedAt: updatedRow.updatedAt,
  })).status).toBe(404);
});

test("external App guests are told when a published Custom App runtime is not supported", async () => {
  const f = await setup();
  await env.DB.prepare("UPDATE hx_apps SET definition=?1 WHERE org_id=?2 AND id=?3")
    .bind(JSON.stringify({ custom: { published: true, html: "<p>custom</p>" } }), f.orgId, f.app.id).run();
  const appPath = `/external/apps/${f.orgId}/${f.app.id}`;
  const appResponse = await call(appPath, f.sessions.guest);
  expect(appResponse.status).toBe(409);
  expect(await appResponse.json()).toMatchObject({ code: "CUSTOM_APP_GUEST_UNSUPPORTED" });
  const managerResponse = await call(`${appPath}/sharing`, f.sessions.owner);
  expect((await managerResponse.json()).customUnsupported).toBe(true);
  expect((await call(`${appPath}/sharing`, f.sessions.owner, "POST", {
    email: "custom-guest@example.com", permission: "view",
  })).status).toBe(409);
});

test("row helper SQL rechecks the exact active App edit grant at the mutation boundary", async () => {
  const f = await setup();
  const path = `/external/apps/${f.orgId}/${f.app.id}/tables/${f.app.tableId}/rows`;
  const seed = await call(path, f.sessions.guest, "POST", { values: { title: "before" } });
  expect(seed.status).toBe(201);
  const row = (await seed.json()).row;
  const writeGuard = externalAppWriteGuard(f.orgId, f.app.id, f.guestId, f.app.tableId);

  await revokeExternalResource(env.DB, {
    orgId: f.orgId, resourceType: "app", resourceId: f.app.id,
    recipientGithubId: f.guestId, revokedBy: f.ownerId,
  });

  const create = await addRow(env.DB, f.orgId, f.app.tableId, { title: "after revoke" }, f.guestId, "strict", null, writeGuard);
  expect(create.error).toBeTruthy();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_rows WHERE org_id=?1 AND table_id=?2").bind(f.orgId, f.app.tableId).first()).toMatchObject({ n: 2 });

  const update = await updateRow(env.DB, f.orgId, f.app.tableId, row.id, { title: "after revoke" }, f.guestId, row.updatedAt, "strict", null, writeGuard);
  expect(update.error).toBeTruthy();
  const unchanged = await env.DB.prepare("SELECT data FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3").bind(f.orgId, f.app.tableId, row.id).first();
  expect(JSON.parse(unchanged.data)).toEqual({ title: "before" });

  const remove = await deleteRow(env.DB, f.orgId, f.app.tableId, row.id, row.updatedAt, null, writeGuard);
  expect(remove.error).toBeTruthy();
  expect(await env.DB.prepare("SELECT id FROM hx_rows WHERE org_id=?1 AND table_id=?2 AND id=?3").bind(f.orgId, f.app.tableId, row.id).first()).toMatchObject({ id: row.id });
});

test("sharing mutations recheck manager membership at commit after concurrent removal", async () => {
  const f = await setup();
  const managerId = `external-app-manager-${tag()}`;
  await upsertUser(env.DB, { githubId: managerId, login: managerId, name: "Manager", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, f.orgId, managerId, "admin");
  const managerSession = await createSession(env.DB, managerId, "external-app-guest-test");
  const sharing = `/external/apps/${f.orgId}/${f.app.id}/sharing`;
  const removeAfterAccess = () => removeManagerImmediatelyAfterAccess(env.DB, f.orgId, managerId);
  const restoreManager = () => upsertMembership(env.DB, f.orgId, managerId, "admin");

  const inviteEmail = `race-${tag()}@example.com`;
  const issued = await call(sharing, managerSession, "POST", { email: inviteEmail, permission: "edit" }, removeAfterAccess());
  expect(issued.status).toBe(403);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_external_app_invites WHERE org_id=?1 AND resource_id=?2 AND invited_email=?3")
    .bind(f.orgId, f.app.id, inviteEmail).first()).toMatchObject({ n: 0 });

  await restoreManager();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET permission='view' WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).run();
  const upgraded = await call(`${sharing}/${f.guestId}`, managerSession, "PATCH", { permission: "edit" }, removeAfterAccess());
  expect(upgraded.status).toBe(404);
  expect(await env.DB.prepare("SELECT permission FROM hx_external_resource_grants WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).first()).toMatchObject({ permission: "view" });

  await restoreManager();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET permission='edit' WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).run();
  const revokedGrant = await call(`${sharing}/${f.guestId}`, managerSession, "DELETE", undefined, removeAfterAccess());
  expect(revokedGrant.status).toBe(404);
  expect(await env.DB.prepare("SELECT revoked_at FROM hx_external_resource_grants WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3")
    .bind(f.orgId, f.app.id, f.guestId).first()).toMatchObject({ revoked_at: null });

  await restoreManager();
  const ownerInviteResponse = await call(sharing, f.sessions.owner, "POST", {
    email: `revoke-${tag()}@example.com`, permission: "view",
  });
  expect(ownerInviteResponse.status).toBe(201);
  const ownerInvite = (await ownerInviteResponse.json()).invite;
  const revokedInvite = await call(`${sharing}/invites/${ownerInvite.id}`, managerSession, "DELETE", undefined, removeAfterAccess());
  expect(revokedInvite.status).toBe(404);
  expect(await env.DB.prepare("SELECT revoked_at FROM hx_external_app_invites WHERE id=?1").bind(ownerInvite.id).first())
    .toMatchObject({ revoked_at: null });

  await restoreManager();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET permission='view' WHERE org_id=?1 AND resource_type='app' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(f.orgId, f.app.id, f.guestId).run();
  const rejectedRequest = await call(`/external/apps/${f.orgId}/${f.app.id}/conversation`, f.sessions.guest, "POST", {
    body: "Request must remain pending after manager removal.", requestSend: true,
  });
  expect(rejectedRequest.status).toBe(201);
  const rejectedRequestId = (await rejectedRequest.json()).requestId;
  const rejected = await call(`${sharing}/requests/${rejectedRequestId}`, managerSession, "POST", { decision: "reject" }, removeAfterAccess());
  expect(rejected.status).toBe(404);
  expect(await env.DB.prepare("SELECT status FROM hx_external_app_send_requests WHERE id=?1").bind(rejectedRequestId).first())
    .toMatchObject({ status: "pending" });

  await restoreManager();
  const approvedRequest = await call(`/external/apps/${f.orgId}/${f.app.id}/conversation`, f.sessions.guest, "POST", {
    tableId: f.linkedTable.id, rowId: f.linkedRowId,
    body: "Message must not be approved after manager removal.", requestSend: true,
  });
  expect(approvedRequest.status).toBe(201);
  const approvedRequestId = (await approvedRequest.json()).requestId;
  const approved = await call(`${sharing}/requests/${approvedRequestId}`, managerSession, "POST", { decision: "approve" }, removeAfterAccess());
  expect(approved.status).toBe(404);
  expect(await env.DB.prepare("SELECT status FROM hx_external_app_send_requests WHERE id=?1").bind(approvedRequestId).first())
    .toMatchObject({ status: "pending" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_messages WHERE org_id=?1 AND app_id=?2 AND body=?3")
    .bind(f.orgId, f.app.id, "Message must not be approved after manager removal.").first()).toMatchObject({ n: 0 });
});


function mutateAfterVerifiedEmailRead(db, mutation) {
  const identityQuery = "SELECT email,email_verified_at FROM users WHERE github_id=?1";
  let mutate = true;
  const wrapStatement = (statement, matches) => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values) => wrapStatement(target.bind(...values), matches);
      if (property === "first") return async (...args) => {
        const row = await target.first(...args);
        if (row && matches && mutate) {
          mutate = false;
          await mutation();
        }
        return row;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return sql => wrapStatement(target.prepare(sql), String(sql) === identityQuery);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function createAppInvite(f, email) {
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3")
    .bind(email, new Date().toISOString(), f.guestId).run();
  const response = await call(`/external/apps/${f.orgId}/${f.app.id}/sharing`, f.sessions.owner, "POST", { email, permission: "view" });
  expect(response.status).toBe(201);
  const data = await response.json();
  return data.invite.token;
}

test("App invite redemption rechecks verified email in the grant insert fence", async () => {
  const f = await setup();
  const email = `email-race-${tag()}@example.com`;
  const token = await createAppInvite(f, email);
  const racingDb = mutateAfterVerifiedEmailRead(env.DB, async () => {
    await env.DB.prepare("UPDATE users SET email_verified_at=NULL WHERE github_id=?1").bind(f.guestId).run();
  });

  const redeemed = await call("/external/invites/redeem", f.sessions.guest, "POST", { token }, racingDb);
  expect(redeemed.status).toBe(404);
  expect(await env.DB.prepare("SELECT redeemed_at FROM hx_external_app_invites WHERE invited_email=?1").bind(email).first()).toMatchObject({ redeemed_at: null });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_external_resource_grants WHERE org_id=?1 AND resource_id=?2 AND recipient_github_id=?3")
    .bind(f.orgId, f.app.id, f.guestId).first()).toMatchObject({ n: 0 });
});

test("App invite redemption rechecks workspace tombstones in the grant insert fence", async () => {
  const f = await setup();
  const email = `workspace-race-${tag()}@example.com`;
  const token = await createAppInvite(f, email);
  const racingDb = mutateAfterVerifiedEmailRead(env.DB, async () => {
    await env.DB.prepare("INSERT INTO workspace_tombstones (org_id,deleted_at,requested_by) VALUES (?1,?2,?3)")
      .bind(f.orgId, new Date().toISOString(), f.ownerId).run();
  });

  const redeemed = await call("/external/invites/redeem", f.sessions.guest, "POST", { token }, racingDb);
  expect(redeemed.status).toBe(404);
  expect(await env.DB.prepare("
    SELECT redeemed_at FROM hx_external_app_invites WHERE invited_email=?1").bind(email).first()).toMatchObject({ redeemed_at: null });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_external_resource_grants WHERE org_id=?1 AND resource_id=?2 AND recipient_github_id=?3")
    .bind(f.orgId, f.app.id, f.guestId).first()).toMatchObject({ n: 0 });
});

import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";
import { setMode } from "../src/harness/mode.js";
import { createApp } from "../src/harness/apps.js";
import { createTable } from "../src/harness/tables.js";
import { grantExternalResource, revokeExternalResource } from "../src/harness/externalCollaborators.js";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";
import worker from "../src/index.js";

const tag = () => crypto.randomUUID().replaceAll("-", "");
const context = { waitUntil() {} };
const grantMigration = migrationsSql.split("\n").filter((line) =>
  /^CREATE TABLE IF NOT EXISTS hx_external_resource_grants /.test(line) ||
  /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_resource_grants_/.test(line)
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

async function call(path, token, method = "GET", body = undefined) {
  return worker.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { "x-session-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, context);
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

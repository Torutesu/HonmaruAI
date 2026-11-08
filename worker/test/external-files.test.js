import { createHash } from "node:crypto";
import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import filesSql from "../workspace-files.sql?raw";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";
import { setMode } from "../src/harness/mode.js";
import { grantExternalResource } from "../src/harness/externalCollaborators.js";
import { createFileLedger, appendFileVersion } from "../src/harness/fileVersionLedger.js";

const context = { waitUntil() {} };
const bytes = new TextEncoder().encode("shared file contents");
const suffix = () => crypto.randomUUID().replaceAll("-", "");
let fixture;

async function setup() {
  const tag = suffix();
  const orgId = `external-files-${tag}`;
  const ownerId = `external-file-owner-${tag}`;
  const guestId = `external-file-guest-${tag}`;
  const fileId = `f_${tag.slice(0, 24)}`;
  await env.DB.exec(filesSql.replace(/\n/g, " "));
  await upsertUser(env.DB, { githubId: ownerId, login: ownerId, name: "Owner" });
  await upsertUser(env.DB, { githubId: guestId, login: guestId, name: "Guest" });
  await env.DB.prepare("UPDATE users SET email = ?1, email_verified_at = ?2 WHERE github_id = ?3")
    .bind(`${guestId}@example.test`, new Date().toISOString(), guestId).run();
  await upsertMembership(env.DB, orgId, ownerId, "member");
  await env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?1, ?2, ?3)")
    .bind(orgId, orgId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO businesses (org_id, slug, name, created_by, created_at, private) VALUES (?1, 'general', 'General', ?2, ?3, 0)")
    .bind(orgId, ownerId, new Date().toISOString()).run();
  await setMode(env.DB, orgId, "harness", ownerId);
  const scope = `b:general`;
  expect(await createFileLedger(env.DB, {
    orgId, fileId, scope, path: "plans/launch.txt", createdBy: ownerId,
  })).toEqual({ created: true });
  const objectKey = `org/${encodeURIComponent(orgId)}/workspace-files/${fileId}/v1`;
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType: "text/plain" } });
  expect(await appendFileVersion(env.DB, {
    orgId, fileId, expectedVersion: 0, createdBy: ownerId, objectKey,
    contentHash, contentType: "text/plain", size: bytes.byteLength,
  })).toEqual({ saved: true, version: 1 });
  const ownerSession = await createSession(env.DB, ownerId, "external-file-test");
  const guestSession = await createSession(env.DB, guestId, "external-file-test");
  fixture = { orgId, ownerId, guestId, fileId, ownerSession, guestSession, objectKey };
  return fixture;
}

beforeEach(async () => { await setup(); });

async function call(path, token, method = "GET", body, contentType = "text/plain") {
  const { default: worker } = await import("../src/index.js");
  return worker.fetch(new Request(`https://example.com${path}`, {
    method, headers: { "x-session-token": token, ...(body===undefined?{}:{"content-type":contentType}) }, ...(body===undefined?{}:{body}),
  }), env, context);
}

async function share(permission = "view", expiresAt = null) {
  const input = { ...fixture, permission, grantedBy: fixture.ownerId };
  await grantExternalResource(env.DB, {
    orgId: input.orgId, resourceType: "file", resourceId: input.fileId,
    recipientGithubId: input.guestId, permission, grantedBy: input.grantedBy, expiresAt,
  });
}

const filePath = () => `/external/files/${encodeURIComponent(fixture.orgId)}/${encodeURIComponent(fixture.fileId)}`;

test("an exact external file grant reads only its metadata, versions and content", async () => {
  await share("view");
  const metadata = await call(filePath(), fixture.guestSession);
  expect(metadata.status).toBe(200);
  const metadataBody = await metadata.json();
  expect(metadataBody).toMatchObject({
    permission: "view",
    file: { id: fixture.fileId, path: "launch.txt", version: 1, contentType: "text/plain", size: bytes.byteLength, deleted: false },
  });
  expect(metadataBody.file).not.toHaveProperty("scope");
  expect(metadataBody.file).not.toHaveProperty("createdBy");
  expect(metadataBody.file.path).not.toContain("/");
  expect(JSON.stringify(metadataBody)).not.toContain(fixture.ownerId);

  const versions = await call(`${filePath()}/versions`, fixture.guestSession);
  expect(versions.status).toBe(200);
  const versionBody = await versions.json();
  expect(versionBody).toMatchObject({
    permission: "view",
    versions: [{ version: 1, kind: "content", isCurrent: true, purged: false }],
  });
  expect(versionBody.versions[0]).not.toHaveProperty("createdBy");
  expect(JSON.stringify(versionBody)).not.toContain(fixture.ownerId);

  const content = await call(`${filePath()}/versions/1/content`, fixture.guestSession);
  expect(content.status).toBe(200);
  expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
  expect(content.headers.get("cache-control")).toBe("private, no-store");

  expect((await call(`${filePath()}-other`, fixture.guestSession)).status).toBe(404);
  expect((await call(`/external/files/${fixture.orgId}-other/${fixture.fileId}`, fixture.guestSession)).status).toBe(404);
  expect((await call(`/external/files/${fixture.orgId}`, fixture.guestSession)).status).toBe(404);
  expect((await call(filePath(), fixture.guestSession, "POST")).status).toBe(405);
  expect((await call(filePath(),fixture.guestSession,'DELETE')).status).toBe(405);
  expect((await call(`${filePath()}/restore`,fixture.guestSession,'POST')).status).toBe(405);
  expect((await call(`${filePath()}/purge`,fixture.guestSession,'POST')).status).toBe(405);
  expect((await call('/external/files/'+encodeURIComponent(fixture.orgId)+'/new/content?expectedVersion=1&size=0',fixture.guestSession,'PUT',new Blob([]).stream())).status).toBe(404);
});

test("an edit grant uploads a new exact-file version; revocation and expiry block access", async () => {
  await share("edit");
  expect((await call(filePath(), fixture.guestSession)).status).toBe(200);
  expect((await call(`${filePath()}/versions/1/content`, fixture.guestSession, "PUT")).status).toBe(405);

  const replacement=new TextEncoder().encode('updated by guest');
  const uploaded=await call(`${filePath()}/content?expectedVersion=1&size=${replacement.byteLength}`,fixture.guestSession,'PUT',new Blob([replacement]).stream());
  expect(uploaded.status).toBe(200);expect(await uploaded.json()).toMatchObject({saved:true,version:2});
  expect(new Uint8Array(await (await call(`${filePath()}/versions/2/content`,fixture.guestSession)).arrayBuffer())).toEqual(replacement);
  expect((await call(`${filePath()}/content?expectedVersion=1&size=0`,fixture.guestSession,'PUT',new Blob([]).stream())).status).toBe(409);
  expect((await call(`${filePath()}/content?expectedVersion=2&size=0`,fixture.guestSession,'PUT',new Blob([]).stream(),'bad-type')).status).toBe(400);
  expect((await call(`${filePath()}/content?expectedVersion=2&size=26214401`,fixture.guestSession,'PUT',new Blob([]).stream())).status).toBe(400);
  expect((await call(`${filePath()}/content?expectedVersion=2&size=1`,fixture.guestSession,'PUT',new Blob([]).stream())).status).toBe(400);
  const finalBytes=new Blob(['final version']);
  expect((await call(`${filePath()}/content?expectedVersion=2&size=${finalBytes.size}`,fixture.guestSession,'PUT',finalBytes.stream())).status).toBe(200);

  await env.DB.prepare("UPDATE hx_external_resource_grants SET revoked_at = ?1 WHERE org_id = ?2 AND resource_id = ?3 AND recipient_github_id = ?4")
    .bind(new Date().toISOString(), fixture.orgId, fixture.fileId, fixture.guestId).run();
  expect((await call(`${filePath()}/content?expectedVersion=3&size=0`,fixture.guestSession,'PUT',new Blob([]).stream())).status).toBe(404);
  expect((await call(filePath(), fixture.guestSession)).status).toBe(404);
  expect((await call(`${filePath()}/versions`, fixture.guestSession)).status).toBe(404);
  expect((await call(`${filePath()}/versions/1/content`, fixture.guestSession)).status).toBe(404);

  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await share("edit", expiresAt);
  const pastGrant = new Date(Date.now() - 120_000).toISOString();
  const pastExpiry = new Date(Date.now() - 60_000).toISOString();
  await env.DB.prepare("UPDATE hx_external_resource_grants SET granted_at = ?1, expires_at = ?2 WHERE org_id = ?3 AND resource_id = ?4 AND recipient_github_id = ?5 AND revoked_at IS NULL")
    .bind(pastGrant, pastExpiry, fixture.orgId, fixture.fileId, fixture.guestId).run();
  expect((await call(filePath(), fixture.guestSession)).status).toBe(404);
  expect((await call(`${filePath()}/versions/1/content`, fixture.guestSession)).status).toBe(404);
  expect((await call(`${filePath()}/content?expectedVersion=3&size=0`,fixture.guestSession,'PUT',new Blob([]).stream())).status).toBe(404);
});

test("view grants cannot upload and access is rechecked after R2 staging", async () => {
  await share('view');
  const body=new Blob([new TextEncoder().encode('new version')]);
  expect((await call(`${filePath()}/content?expectedVersion=1&size=${body.size}`,fixture.guestSession,'PUT',body.stream())).status).toBe(403);
  await share('edit');
  const originalPut=env.MEDIA.put.bind(env.MEDIA);
  const spy=vi.spyOn(env.MEDIA,'put').mockImplementation(async(...args)=>{
    const stored=await originalPut(...args);
    await env.DB.prepare("UPDATE hx_external_resource_grants SET revoked_at=?1 WHERE org_id=?2 AND resource_id=?3 AND recipient_github_id=?4 AND permission='edit'")
      .bind(new Date().toISOString(),fixture.orgId,fixture.fileId,fixture.guestId).run();
    return stored;
  });
  const response=await call(`${filePath()}/content?expectedVersion=1&size=${body.size}`,fixture.guestSession,'PUT',body.stream());
  spy.mockRestore();
  expect(response.status).toBe(409);
  expect(await env.DB.prepare('SELECT current_version FROM hx_workspace_files WHERE org_id=?1 AND id=?2').bind(fixture.orgId,fixture.fileId).first()).toEqual({current_version:1});
});

test("Simple mode, a deleted Room and a deleted current File all deny a live grant", async () => {
  await share("view");
  await setMode(env.DB, fixture.orgId, "simple", fixture.ownerId);
  expect((await call(filePath(), fixture.guestSession)).status).toBe(404);
  await setMode(env.DB, fixture.orgId, "harness", fixture.ownerId);
  await env.DB.prepare("INSERT INTO hx_room_access (org_id, channel, version, deleted_at) VALUES (?1, 'b:general', 1, ?2)")
    .bind(fixture.orgId, new Date().toISOString()).run();
  expect((await call(filePath(), fixture.guestSession)).status).toBe(404);
  await env.DB.prepare("DELETE FROM hx_room_access WHERE org_id = ?1 AND channel = 'b:general'").bind(fixture.orgId).run();
  await env.DB.prepare("INSERT INTO workspace_tombstones (org_id, deleted_at, requested_by) VALUES (?1, ?2, ?3)")
    .bind(fixture.orgId, new Date().toISOString(), fixture.ownerId).run();
  expect((await call(filePath(), fixture.guestSession)).status).toBe(404);
  await env.DB.prepare("DELETE FROM workspace_tombstones WHERE org_id = ?1").bind(fixture.orgId).run();

  expect(await appendFileVersion(env.DB, {
    orgId: fixture.orgId, fileId: fixture.fileId, expectedVersion: 1, createdBy: fixture.ownerId,
    kind: "deleted", objectKey: null, contentHash: null, contentType: null, size: null,
  })).toEqual({ saved: true, version: 2 });
  expect((await call(filePath(), fixture.guestSession)).status).toBe(404);
  expect((await call(`${filePath()}/versions/1/content`, fixture.guestSession)).status).toBe(404);
});

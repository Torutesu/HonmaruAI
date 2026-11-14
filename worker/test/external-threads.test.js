import { env } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";
import { hashPassword, newSaltHex } from "../src/auth.js";
import { setMode } from "../src/harness/mode.js";
import { externalThreadPermission, threadAudienceAccessSql } from "../src/harness/externalThreadAudience.js";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import migrationsSql from "../migrations.sql?raw";

const suffix = () => crypto.randomUUID().replaceAll("-", "");
const migrationLines = migrationsSql.split("\n");
const grantMigrations = [
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_resource_grants /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_resource_grants_/.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_send_requests /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_thread_send_requests_/.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_invites /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_thread_invites_/.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_link_shares /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_thread_link_shares_/.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_link_redemptions /.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_audiences /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_thread_audiences_/.test(line)),
  migrationLines.find((line) => /^CREATE TABLE IF NOT EXISTS hx_external_thread_audience_requests /.test(line)),
  ...migrationLines.filter((line) => /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_hx_external_thread_audience_requests_/.test(line)),
].filter(Boolean);

async function setup() {
  const tag = suffix();
  await flushBackground();
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
      !grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_thread_invites ")) ||
      !grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_thread_link_shares ")) ||
      !grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_thread_link_redemptions "))) {
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

const context = { tasks: [], waitUntil(task) { this.tasks.push(Promise.resolve(task)); } };
afterEach(() => fetchMock.deactivate());
async function flushBackground() {
  while (context.tasks.length) await Promise.all(context.tasks.splice(0));
}
async function call(path, token, method = "GET", body = undefined, extra = {}, requestHeaders = {}) {
  const response = await import("../src/index.js").then(({ default: worker }) => worker.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { "x-session-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }), ...requestHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { ...env, ...extra }, context,
  ));
  return response;
}
async function callUpload(path, token, content = "guest attachment bytes") {
  const bytes = new TextEncoder().encode(content);
  return import("../src/index.js").then(({ default: worker }) => worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: {
        "x-session-token": token,
        "content-type": "text/plain",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    }), env, context,
  ));
}

test("external Thread route is registered and requires a signed-in session", async () => {
  const { orgId, rootId } = await setup();
  const response = await call(`/external/threads/${orgId}/${rootId}`, "");
  expect(response.status).toBe(401);
});

test("resource-scoped collaborator search returns only minimal verified external identities", async () => {
  const { orgId, rootId, sessions } = await setup();
  const path = `/external/collaborators/search?${new URLSearchParams({ orgId, resourceType: "thread", resourceId: rootId, q: "gue" })}`;
  const response = await call(path, sessions.owner);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.people).toEqual([{ ref: expect.stringMatching(/^c1\./), login: expect.stringMatching(/^external-guest-/), name: "guest" }]);
  expect(body.people[0]).not.toHaveProperty("email");
  expect(body.people[0]).not.toHaveProperty("githubId");
  const emailSearch = await call(path.replace("q=gue", "q=example"), sessions.owner);
  expect((await emailSearch.json()).people).toMatchObject([{ name: "guest" }]);
  expect((await call(path, "")).status).toBe(401);
  expect((await call(path.replace("q=gue", "q=gu"), sessions.owner)).status).toBe(400);
  // A workspace member without access to this private Thread cannot use its share surface to enumerate accounts.
  expect((await call(path, sessions.editor)).status).toBe(404);
});

test("Thread share accepts a selected collaborator reference and still rejects workspace members", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const endpoint = `/external/threads/${orgId}/${rootId}/shares`;
  const search = `/external/collaborators/search?${new URLSearchParams({ orgId, resourceType: "thread", resourceId: rootId, q: "gue" })}`;
  const [person] = (await (await call(search, sessions.owner)).json()).people;
  const shared = await call(endpoint, sessions.owner, "POST", { recipientRef: person.ref, permission: "view" });
  expect(shared.status).toBe(201);
  expect((await shared.json()).shared).toBe(true);
  // A raw account id is no longer a way to name someone.
  expect((await call(endpoint, sessions.owner, "POST", { recipientGithubId: ids.guest, permission: "view" })).status).toBe(404);
  expect((await call(endpoint, sessions.owner, "POST", { recipientRef: "c1.not-a-ref", permission: "view" })).status).toBe(404);
});

// #956: email sign-up accounts are `email:<address>` / `u:<address>`, SSO
// accounts `u:<address>`. Neither the search nor sharing may hand the
// address to someone in another workspace who did not type it.
test("collaborator search and Thread sharing never return an outside account's email address", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const tag = suffix();
  const emailAddress = `ada-${tag}@acme.test`, ssoAddress = `grace-${tag}@acme.test`;
  const emailId = `email:${emailAddress}`, ssoId = `sso-${tag}`;
  await upsertUser(env.DB, { githubId: emailId, login: `u:${emailAddress}`, name: "", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: ssoId, login: `u:${ssoAddress}`, name: ssoAddress, avatarUrl: null, locale: "en" });
  for (const [id, address] of [[emailId, emailAddress], [ssoId, ssoAddress]]) {
    await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(address, new Date().toISOString(), id).run();
  }
  const search = (resourceId) => `/external/collaborators/search?${new URLSearchParams({ orgId, resourceType: "thread", resourceId, q: "acme.test" })}`;
  const found = await call(search(rootId), sessions.owner);
  expect(found.status).toBe(200);
  const text = await found.text();
  for (const address of [emailAddress, ssoAddress]) expect(text.toLowerCase()).not.toContain(address);
  const { people } = JSON.parse(text);
  expect(people).toHaveLength(2);
  expect(people.map((person) => person.login)).toEqual([null, null]);
  expect(people.map((person) => person.name).sort()).toEqual([`ada-${tag}`, `grace-${tag}`]);

  const endpoint = `/external/threads/${orgId}/${rootId}/shares`;
  for (const person of people) {
    const shared = await call(endpoint, sessions.owner, "POST", { recipientRef: person.ref, permission: "view" });
    expect(shared.status).toBe(201);
    const sharedText = await shared.text();
    for (const address of [emailAddress, ssoAddress]) expect(sharedText.toLowerCase()).not.toContain(address);
    expect(JSON.parse(sharedText).recipient).toMatchObject({ email: null, ref: expect.stringMatching(/^c1\./) });
  }
  const listed = await (await call(endpoint, sessions.owner)).text();
  for (const address of [emailAddress, ssoAddress]) expect(listed.toLowerCase()).not.toContain(address);
  const { shares } = JSON.parse(listed);
  expect(shares).toHaveLength(2);
  // A reference from the list changes that person's access without naming them.
  const regranted = await call(endpoint, sessions.owner, "POST", { recipientRef: shares[0].recipient.ref, permission: "edit" });
  expect(regranted.status).toBe(201);

  // A reference opens only for the resource it was issued for.
  const otherRoot = `thread-other-${tag}`;
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, 'b:private-room', ?3, 'message', 'Other plan', ?4)")
    .bind(otherRoot, orgId, ids.owner, new Date().toISOString()).run();
  expect((await call(`/external/threads/${orgId}/${otherRoot}/shares`, sessions.owner, "POST", { email: ssoAddress, permission: "view" })).status).toBe(201);
  expect((await call(`/external/threads/${orgId}/${otherRoot}/shares`, sessions.owner, "POST", { recipientRef: people[0].ref, permission: "view" })).status).toBe(404);

  // Someone who types the address gets back what they typed, and no more.
  const typed = await call(endpoint, sessions.owner, "POST", { email: emailAddress, permission: "view" });
  expect(typed.status).toBe(201);
  expect((await typed.json()).recipient.email).toBe(emailAddress);
});

test("workspace audience is live, CAS protected, and gates send approval by its active generation", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const endpoint = `/external/threads/${orgId}/${rootId}/audience`;
  const initial = await (await call(endpoint, sessions.owner)).json();
  expect(initial).toMatchObject({ audience: null, version: 0 });
  const saved = await call(endpoint, sessions.owner, "PUT", {
    version: 0, type: "workspace", permission: "view", expiresAt: null,
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).audience).toMatchObject({ type: "workspace", permission: "view", version: 1 });
  expect((await call(endpoint, sessions.owner, "PUT", { version: 0, type: null })).status).toBe(409);

  const read = await call(`/external/threads/${orgId}/${rootId}`, sessions.editor);
  expect(read.status).toBe(200);
  const send = await call(`/external/threads/${orgId}/${rootId}`, sessions.editor, "POST", {
    body: "Please approve this group-audience reply", requestSend: true,
  });
  expect(send.status).toBe(201);
  const { requestId: pendingId } = await send.json();
  const listed = await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.owner);
  expect((await listed.json()).requests.map(request => request.id)).toContain(pendingId);
  const approved = await call(`/external/threads/${orgId}/${rootId}/requests/approve`, sessions.owner, "POST", { requestId: pendingId });
  expect(approved.status).toBe(200);

  const updated = await call(endpoint, sessions.owner, "PUT", {
    version: 1, type: "workspace", permission: "view", expiresAt: null,
  });
  expect(updated.status).toBe(200);
  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.editor)).status).toBe(200);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId, ids.editor).run();
  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.editor)).status).toBe(404);
});

test("Room Thread audiences stop granting access when their Room is archived or deleted", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const audiencePath = `/external/threads/${orgId}/${rootId}/audience`;
  const threadPath = `/external/threads/${orgId}/${rootId}`;
  const saved = await call(audiencePath, sessions.owner, "PUT", {
    version: 0, type: "room", roomId: "b:private-room", permission: "view", expiresAt: null,
  });
  expect(saved.status).toBe(200);
  const sqlPermission = () => env.DB.prepare(`SELECT ${threadAudienceAccessSql({ org: "?1", root: "?2", user: "?3", now: "?4" })} AS allowed`)
    .bind(orgId, rootId, ids.editor, new Date().toISOString()).first();
  expect(Number((await sqlPermission()).allowed)).toBe(1);
  expect((await call(threadPath, sessions.editor)).status).toBe(200);

  await env.DB.prepare("UPDATE businesses SET archived_at=?1 WHERE org_id=?2 AND slug='private-room'")
    .bind(new Date().toISOString(), orgId).run();
  expect(await externalThreadPermission(env.DB, { orgId, rootId, githubId: ids.editor })).toBeNull();
  expect(Number((await sqlPermission()).allowed)).toBe(0);
  expect((await call(threadPath, sessions.editor)).status).toBe(404);

  await env.DB.prepare("UPDATE businesses SET archived_at=NULL WHERE org_id=?1 AND slug='private-room'")
    .bind(orgId).run();
  await env.DB.prepare(`INSERT INTO hx_room_access(org_id,channel,version,deleted_at)
    VALUES(?1,'b:private-room',1,?2) ON CONFLICT(org_id,channel) DO UPDATE SET deleted_at=excluded.deleted_at`)
    .bind(orgId, new Date().toISOString()).run();
  expect(await externalThreadPermission(env.DB, { orgId, rootId, githubId: ids.editor })).toBeNull();
  expect(Number((await sqlPermission()).allowed)).toBe(0);
  expect((await call(threadPath, sessions.editor)).status).toBe(404);
});

test("a direct grant cannot revive an audience-origin request after membership and generation change", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const endpoint = `/external/threads/${orgId}/${rootId}/audience`;
  expect((await call(endpoint, sessions.owner, "PUT", {
    version: 0, type: "workspace", permission: "view", expiresAt: null,
  })).status).toBe(200);
  const send = await call(`/external/threads/${orgId}/${rootId}`, sessions.editor, "POST", {
    body: "Audience-origin request that must be fenced", requestSend: true,
  });
  expect(send.status).toBe(201);
  const { requestId } = await send.json();

  // Simulate a separate direct grant being added after the group request was
  // created, followed by membership removal and an audience generation change.
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO hx_external_resource_grants
    (id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at)
    VALUES (?1,?2,'thread',?3,?4,'view',?5,?6)`)
    .bind(`test-grant-${rootId}`, orgId, rootId, ids.editor, ids.owner, now).run();
  await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId, ids.editor).run();
  await env.DB.prepare("UPDATE hx_external_thread_audiences SET version=version+1,change_token='test-next-generation' WHERE org_id=?1 AND root_message_id=?2")
    .bind(orgId, rootId).run();

  const listed = await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.owner);
  expect((await listed.json()).requests.map(request => request.id)).not.toContain(requestId);
  const approved = await call(`/external/threads/${orgId}/${rootId}/requests/approve`, sessions.owner, "POST", { requestId });
  expect(approved.status).toBe(409);
  expect(await env.DB.prepare("SELECT 1 FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND body='Audience-origin request that must be fenced'")
    .bind(orgId, rootId).first()).toBeNull();
});

test("a verified non-member can read and reply only to an explicitly shared Thread", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const privateBody = "UNSHARED CHANNEL SECRET 9d68a";
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, 'b:private-room', ?3, 'message', ?4, ?5)")
    .bind(`unshared-${rootId}`, orgId, ids.owner, privateBody, new Date(Date.now() - 5_000).toISOString()).run();
  let aiPrompt;
  fetchMock.activate();
  fetchMock.get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, (opts) => {
      aiPrompt = JSON.parse(opts.body);
      return { choices: [{ message: { content: "I can summarize the shared launch thread." } }] };
    });
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
  const request = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: `@${ids.owner} @AI summarize the launch plan`, requestSend: true });
  expect(request.status).toBe(201);
  const sendRequest = await request.json();
  // A view-only guest request is stored for owner review; it is neither a
  // channel message nor a notification until the owner approves it.
  expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_messages WHERE org_id=?1 AND body=?2")
    .bind(orgId, `@${ids.owner} @AI summarize the launch plan`).first()).toMatchObject({ n: 0 });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM push_queue WHERE org_id=?1 AND reason='mention'").bind(orgId).first()).toMatchObject({ n: 0 });
  expect((await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.editor)).status).toBe(404);
  const pending = await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.owner);
  expect((await pending.json()).requests).toMatchObject([{ id: sendRequest.requestId, body: `@${ids.owner} @AI summarize the launch plan` }]);
  const approved = await call(`/external/threads/${orgId}/${rootId}/requests/approve`, sessions.owner, "POST", { requestId: sendRequest.requestId }, { OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini" });
  expect(approved.status).toBe(200);
  const approvedMessage = await approved.json();
  await flushBackground();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_messages WHERE org_id=?1 AND id=?2")
    .bind(orgId, approvedMessage.messageId).first()).toMatchObject({ n: 1 });
  expect(aiPrompt.messages.find((message) => message.role === "user").content).not.toContain(privateBody);
  expect(JSON.stringify(aiPrompt.messages)).not.toContain(privateBody);

  const refreshed = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  expect(refreshed.thread.replies).toMatchObject([
    { body: `@${ids.owner} @AI summarize the launch plan`, authorName: "guest", mine: true },
    { kind: "ai", parentId: rootId, body: "I can summarize the shared launch thread." },
  ]);
  expect(refreshed.thread.replies.every((reply) => !String(reply.body).includes(privateBody))).toBe(true);
  expect(await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2").bind(orgId, approvedMessage.messageId).all())
    .toMatchObject({ results: [{ login: ids.owner, reason: "mention" }] });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND kind='agent'").bind(orgId, rootId).first()).toMatchObject({ n: 0 });
});

test("anyone-with-link redeems only an exact Thread grant and revoke removes the redeemed access", async () => {
  const {orgId,rootId,ids,sessions}=await setup();
  const path=`/external/threads/${orgId}/${rootId}/links`;
  const created=await call(path,sessions.owner,"POST",{permission:"edit",expiresAt:new Date(Date.now()+60_000).toISOString()});
  expect(created.status).toBe(201);
  const payload=await created.json();
  const token=payload.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1]||payload.token;
  expect(token).toMatch(/^[a-f0-9]{64}$/i);
  expect(await env.DB.prepare("SELECT token_hash FROM hx_external_thread_link_shares WHERE id=?1").bind(payload.link.id).first()).toMatchObject({token_hash:expect.not.stringMatching(token)});
  expect((await call("/external/invites/redeem","","POST",{token})).status).toBe(401);
  const redeemed=await call("/external/invites/redeem",sessions.guest,"POST",{token});
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toMatchObject({redeemed:true,resourceType:"thread",resourceId:rootId,permission:"edit"});
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId,ids.guest).first()).toBeNull();
  expect((await call(`/external/threads/${orgId}/${rootId}`,sessions.guest)).status).toBe(200);
  expect((await call(`/channels/messages?orgId=${orgId}&channel=b%3Aprivate-room`,sessions.guest)).status).toBe(403);
  expect((await call("/external/invites/redeem",sessions.guest,"POST",{token})).status).toBe(200);
  expect((await call(`${path}/${payload.link.id}`,sessions.editor,"DELETE")).status).toBe(404);
  expect((await call(`${path}/${payload.link.id}`,sessions.owner,"DELETE")).status).toBe(200);
  expect((await call(`/external/threads/${orgId}/${rootId}`,sessions.guest)).status).toBe(404);
  expect((await call("/external/invites/redeem",sessions.guest,"POST",{token})).status).toBe(404);
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
  const reply = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: `@${ids.owner} Approved edit` });
  expect(reply.status).toBe(201);
  const replyBody = await reply.json();
  await flushBackground();
  expect(await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2").bind(orgId, replyBody.messageId).all())
    .toMatchObject({ results: [{ login: ids.owner, reason: "mention" }] });
});

async function addDmRoot(orgId, ids) {
  const channel = `dm:${[ids.owner, ids.editor].sort().join("|")}`;
  const rootId = `dm-root-${suffix()}`;
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'message', 'DM plan', ?5)")
    .bind(rootId, orgId, channel, ids.owner, new Date().toISOString()).run();
  return { channel, rootId };
}

test("a stored canonical DM Thread can be managed through its viewer handle", async () => {
  const { orgId, ids, sessions } = await setup();
  const { rootId } = await addDmRoot(orgId, ids);
  const response = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", {
    email: `guest-${orgId.split("-").at(-1)}@example.test`, permission: "view",
  });
  expect(response.status).toBe(201);
});

test("DM share write fence rejects removal of the other participant after preflight", async () => {
  const { orgId, ids, sessions } = await setup();
  const { rootId } = await addDmRoot(orgId, ids);
  let removed = false;
  const racingDb = new Proxy(env.DB, { get(db, key) {
    if (key === "batch") return async statements => {
      if (!removed) {
        removed = true;
        await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2")
          .bind(orgId, ids.editor).run();
      }
      return db.batch(statements);
    };
    return typeof db[key] === "function" ? db[key].bind(db) : db[key];
  }});
  const response = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", {
    email: `guest-${orgId.split("-").at(-1)}@example.test`, permission: "edit",
  }, { DB: racingDb });
  expect(response.status).toBe(404);
  expect(await env.DB.prepare(`SELECT id FROM hx_external_resource_grants
    WHERE org_id=?1 AND resource_type='thread' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL`)
    .bind(orgId, rootId, ids.guest).first()).toBeNull();
});

test("share creation rechecks active workspace membership at the write boundary", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  let removed = false;
  const racingDb = new Proxy(env.DB, { get(db, key) {
    if (key === "batch") return async statements => {
      if (!removed) {
        removed = true;
        await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2")
          .bind(orgId, ids.owner).run();
      }
      return db.batch(statements);
    };
    return typeof db[key] === "function" ? db[key].bind(db) : db[key];
  }});
  const response = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST",
    { email, permission: "edit" }, { DB: racingDb });
  expect(response.status).toBe(404);
  expect(await env.DB.prepare(`SELECT id FROM hx_external_resource_grants
    WHERE org_id=?1 AND resource_type='thread' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL`)
    .bind(orgId, rootId, ids.guest).first()).toBeNull();
});

test("invitation creation and send approval recheck membership at their write boundary", async () => {
  const invitationFixture = await setup();
  const invitePath = `/external/threads/${invitationFixture.orgId}/${invitationFixture.rootId}/invites`;
  let removedBeforeInviteInsert = false;
  const inviteDb = new Proxy(env.DB, { get(db, key) {
    if (key !== "prepare") return typeof db[key] === "function" ? db[key].bind(db) : db[key];
    return sql => {
      const statement = db.prepare(sql);
      if (!sql.startsWith("INSERT INTO hx_external_thread_invites")) return statement;
      return { bind(...values) {
        const bound = statement.bind(...values);
        return { async run() {
          if (!removedBeforeInviteInsert) {
            removedBeforeInviteInsert = true;
            await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2")
              .bind(invitationFixture.orgId, invitationFixture.ids.owner).run();
          }
          return bound.run();
        }};
      }};
    };
  }});
  const invite = await call(invitePath, invitationFixture.sessions.owner, "POST",
    { email: `invite-${suffix()}@example.test`, permission: "view" }, { DB: inviteDb });
  expect(invite.status).toBe(404);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM hx_external_thread_invites WHERE org_id=?1 AND resource_id=?2")
    .bind(invitationFixture.orgId, invitationFixture.rootId).first()).toMatchObject({ n: 0 });

  const approvalFixture = await setup();
  const email = `guest-${approvalFixture.orgId.split("-").at(-1)}@example.test`;
  const shared = await call(`/external/threads/${approvalFixture.orgId}/${approvalFixture.rootId}/shares`,
    approvalFixture.sessions.owner, "POST", { email, permission: "view" });
  expect(shared.status).toBe(201);
  const pending = await call(`/external/threads/${approvalFixture.orgId}/${approvalFixture.rootId}`,
    approvalFixture.sessions.guest, "POST", { body: "Please send this", requestSend: true });
  expect(pending.status).toBe(201);
  const { requestId: pendingId } = await pending.json();
  let removedBeforeDecision = false;
  const approvalDb = new Proxy(env.DB, { get(db, key) {
    if (key === "batch") return async statements => {
      if (!removedBeforeDecision) {
        removedBeforeDecision = true;
        await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2")
          .bind(approvalFixture.orgId, approvalFixture.ids.owner).run();
      }
      return db.batch(statements);
    };
    return typeof db[key] === "function" ? db[key].bind(db) : db[key];
  }});
  const approved = await call(`/external/threads/${approvalFixture.orgId}/${approvalFixture.rootId}/requests/approve`,
    approvalFixture.sessions.owner, "POST", { requestId: pendingId }, { DB: approvalDb });
  expect(approved.status).toBe(409);
  expect(await env.DB.prepare("SELECT status,message_id FROM hx_external_thread_send_requests WHERE org_id=?1 AND id=?2")
    .bind(approvalFixture.orgId, pendingId).first()).toMatchObject({ status: "pending", message_id: null });
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


test("unregistered email invitations redeem after OTP proof without workspace membership", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `new-guest-${suffix()}@example.test`;
  expect(await env.DB.prepare("SELECT github_id FROM users WHERE email=?1").bind(email).first()).toBeNull();

  const path = `/external/threads/${orgId}/${rootId}/invites`;
  const created = await call(path, sessions.owner, "POST", { email, permission: "edit" });
  expect(created.status).toBe(201);
  const invitation = await created.json();
  expect(invitation).toMatchObject({ invited: true, expiresAt: expect.any(String) });
  const token = invitation.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1] || invitation.token;
  expect(token).toMatch(/^[a-f0-9]{64}$/i);
  expect(await env.DB.prepare("SELECT github_id FROM users WHERE email=?1").bind(email).first()).toBeNull();

  const guestId = `email:${email}`;
  const codeValue = "382941";
  const salt = newSaltHex();
  const hash = await hashPassword(codeValue,salt);
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO login_codes (email,code_hash,code_salt,expires_at,attempts,created_at) VALUES (?1,?2,?3,?4,0,?5)")
    .bind(email,hash,salt,new Date(Date.now()+10*60_000).toISOString(),now).run();
  const authenticated = await call("/auth/otp/verify", "", "POST", {email,code:codeValue,name:"New guest"});
  expect(authenticated.status).toBe(200);
  const authResult = await authenticated.json();
  expect(authResult).toMatchObject({created:true,userId:guestId});
  const guestSession = authResult.token;
  const redemption = await call("/external/invites/redeem",guestSession,"POST",{token});
  expect(redemption.status).toBe(200);
  expect(await redemption.json()).toMatchObject({ redeemed: true, resourceType: "thread", resourceId: rootId, permission: "edit" });
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId,guestId).first()).toBeNull();
  expect((await call(`/external/threads/${orgId}/${rootId}`,guestSession)).status).toBe(200);
  expect((await call("/external/invites/redeem",guestSession,"POST",{token})).status).toBe(404);
  expect((await call(`${path}/${invitation.invitationId}`,sessions.owner,"DELETE")).status).toBe(200);
  expect((await call(`/external/threads/${orgId}/${rootId}`,guestSession)).status).toBe(404);
  expect(await env.DB.prepare("SELECT revoked_at FROM hx_external_thread_invites WHERE id=?1").bind(invitation.invitationId).first()).toMatchObject({revoked_at:expect.any(String)});
});

test("pending Thread invitations can change permission and access expiry without changing the link", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const path = `/external/threads/${orgId}/${rootId}/invites`;
  const email = `editable-${suffix()}@example.test`;
  const created = await call(path, sessions.owner, "POST", {
    email, permission: "view", accessExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  expect(created.status).toBe(201);
  const invite = await created.json();
  const token = invite.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1] || invite.token;
  const before = await env.DB.prepare("SELECT token_hash,expires_at FROM hx_external_thread_invites WHERE id=?1").bind(invite.invitationId).first();
  const accessExpiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
  const updated = await call(`${path}/${invite.invitationId}`, sessions.owner, "PATCH", { permission: "edit", accessExpiresAt });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({ updated: true });
  const after = await env.DB.prepare("SELECT permission,access_expires_at,token_hash,expires_at FROM hx_external_thread_invites WHERE id=?1").bind(invite.invitationId).first();
  expect(after).toMatchObject({ permission: "edit", access_expires_at: accessExpiresAt, token_hash: before.token_hash, expires_at: before.expires_at });

  const inviteeId = `email:${email}`;
  await upsertUser(env.DB, { githubId: inviteeId, login: `u:${email}`, name: "Invitee", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(email,new Date().toISOString(),inviteeId).run();
  const inviteeSession = await createSession(env.DB, inviteeId, "external-invite-test");
  expect((await call("/external/invites/redeem", inviteeSession, "POST", { token })).status).toBe(200);
  expect(await env.DB.prepare("SELECT permission,expires_at FROM hx_external_resource_grants WHERE org_id=?1 AND resource_type='thread' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL")
    .bind(orgId, rootId, inviteeId).first()).toMatchObject({ permission: "edit", expires_at: accessExpiresAt });
  expect((await call(`${path}/${invite.invitationId}`, sessions.owner, "PATCH", { permission: "view", accessExpiresAt: null })).status).toBe(404);
});

test("pending Thread invitation edits reject non-managers and newly joined recipients", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const path = `/external/threads/${orgId}/${rootId}/invites`;
  const email = `became-member-${suffix()}@example.test`;
  const invite = await (await call(path, sessions.owner, "POST", { email, permission: "view" })).json();
  expect((await call(`${path}/${invite.invitationId}`, sessions.editor, "PATCH", { permission: "edit", accessExpiresAt: null })).status).toBe(404);
  const inviteeId = `email:${email}`;
  await upsertUser(env.DB, { githubId: inviteeId, login: `u:${email}`, name: "New member", avatarUrl: null, locale: "en" });
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(email,new Date().toISOString(),inviteeId).run();
  await upsertMembership(env.DB, orgId, inviteeId, "member");
  expect((await call(`${path}/${invite.invitationId}`, sessions.owner, "PATCH", { permission: "edit", accessExpiresAt: null })).status).toBe(404);
  expect(await env.DB.prepare("SELECT permission FROM hx_external_thread_invites WHERE id=?1").bind(invite.invitationId).first()).toMatchObject({ permission: "view" });
});

test("invitation email mismatch, expiry, revoke, and new workspace membership cannot redeem guest access", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const path = `/external/threads/${orgId}/${rootId}/invites`;
  const email = `invitee-${suffix()}@example.test`;
  const created = await call(path,sessions.owner,"POST",{email,permission:"view"});
  const invitation = await created.json();
  const token = invitation.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1] || invitation.token;
  const otherId = `email:other-${suffix()}@example.test`;
  const otherEmail = otherId.slice("email:".length);
  await upsertUser(env.DB,{githubId:otherId,login:`u:${otherEmail}`,name:"Other",avatarUrl:null,locale:"en"});
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(otherEmail,new Date().toISOString(),otherId).run();
  const otherSession = await createSession(env.DB,otherId,"external-invite-test");
  expect((await call("/external/invites/redeem",otherSession,"POST",{token})).status).toBe(404);

  const unverifiedId=`email:${email}`;
  await upsertUser(env.DB,{githubId:unverifiedId,login:`u:${email}`,name:"Unverified",avatarUrl:null,locale:"en"});
  await env.DB.prepare("UPDATE users SET email=?1 WHERE github_id=?2").bind(email,unverifiedId).run();
  const unverifiedSession=await createSession(env.DB,unverifiedId,"external-invite-test");
  expect((await call("/external/invites/redeem",unverifiedSession,"POST",{token})).status).toBe(404);
  expect((await call("/external/invites/redeem","", "POST",{token})).status).toBe(401);

  const inviteId = invitation.invitationId;
  expect((await call(`${path}/${inviteId}`,sessions.editor,"DELETE")).status).toBe(404);
  expect((await call(`${path}/${inviteId}`,sessions.owner,"DELETE")).status).toBe(200);
  const inviteeId = `email:${email}`;
  await upsertUser(env.DB,{githubId:inviteeId,login:`u:${email}`,name:"Invitee",avatarUrl:null,locale:"en"});
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(email,new Date().toISOString(),inviteeId).run();
  const inviteeSession=await createSession(env.DB,inviteeId,"external-invite-test");
  expect((await call("/external/invites/redeem",inviteeSession,"POST",{token})).status).toBe(404);

  const membershipEmail=`member-invite-${suffix()}@example.test`;
  const membershipInvite=await (await call(path,sessions.owner,"POST",{email:membershipEmail,permission:"edit"})).json();
  const membershipToken=membershipInvite.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1]||membershipInvite.token;
  const memberId=`email:${membershipEmail}`;
  await upsertUser(env.DB,{githubId:memberId,login:`u:${membershipEmail}`,name:"Now member",avatarUrl:null,locale:"en"});
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(membershipEmail,new Date().toISOString(),memberId).run();
  await upsertMembership(env.DB,orgId,memberId,"member");
  const memberSession=await createSession(env.DB,memberId,"external-invite-test");
  const memberRedemption=await call("/external/invites/redeem",memberSession,"POST",{token:membershipToken});
  expect(memberRedemption.status).toBe(404);
  expect(await env.DB.prepare("SELECT redeemed_at FROM hx_external_thread_invites WHERE id=?1").bind(membershipInvite.invitationId).first()).toMatchObject({redeemed_at:null});
  expect(await env.DB.prepare("SELECT 1 FROM hx_external_resource_grants WHERE org_id=?1 AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL").bind(orgId,rootId,memberId).first()).toBeNull();

  const expiredEmail=`expired-${suffix()}@example.test`;
  const expired=await (await call(path,sessions.owner,"POST",{email:expiredEmail,permission:"view"})).json();
  const expiredToken=expired.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1]||expired.token;
  const oldCreated=new Date(Date.now()-120_000).toISOString();
  const oldExpiry=new Date(Date.now()-60_000).toISOString();
  await env.DB.prepare("UPDATE hx_external_thread_invites SET created_at=?1,expires_at=?2 WHERE id=?3").bind(oldCreated,oldExpiry,expired.invitationId).run();
  const expiredId=`email:${expiredEmail}`;
  await upsertUser(env.DB,{githubId:expiredId,login:`u:${expiredEmail}`,name:"Expired",avatarUrl:null,locale:"en"});
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(expiredEmail,new Date().toISOString(),expiredId).run();
  const expiredSession=await createSession(env.DB,expiredId,"external-invite-test");
  expect((await call("/external/invites/redeem",expiredSession,"POST",{token:expiredToken})).status).toBe(404);
});

test("external invitations accept normal email addresses and reject malformed whitespace", async () => {
  const {orgId,rootId,sessions}=await setup();
  const path=`/external/threads/${orgId}/${rootId}/invites`;
  expect((await call(path,sessions.owner,"POST",{email:"guest@example.test",permission:"view"})).status).toBe(201);
  for(const email of ["guest @example.test","guest@example .test","not-an-email","guest@other@example.test",`${"a".repeat(250)}@x.io`]) {
    expect((await call(path,sessions.owner,"POST",{email,permission:"view"})).status).toBe(400);
  }
});


test("revoking an older invitation leaves a later explicit re-share active", async () => {
  const {orgId,rootId,sessions}=await setup();
  const email=`guest-${suffix()}@example.test`;
  const path=`/external/threads/${orgId}/${rootId}`;
  const invited=await (await call(`${path}/invites`,sessions.owner,"POST",{email,permission:"edit"})).json();
  const token=invited.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1]||invited.token;
  const guestId=`external-guest-${suffix()}`;
  await upsertUser(env.DB,{githubId:guestId,login:guestId,name:"Guest",avatarUrl:null,locale:"en"});
  await env.DB.prepare("UPDATE users SET email=?1,email_verified_at=?2 WHERE github_id=?3").bind(email,new Date().toISOString(),guestId).run();
  const guestSession=await createSession(env.DB,guestId,"external-invite-test");
  expect((await call("/external/invites/redeem",guestSession,"POST",{token})).status).toBe(200);
  const original=await env.DB.prepare("SELECT created_grant_id FROM hx_external_thread_invites WHERE id=?1").bind(invited.invitationId).first();
  expect(original.created_grant_id).toEqual(expect.any(String));

  expect((await call(`${path}/shares`,sessions.owner,"POST",{email,permission:"view"})).status).toBe(201);
  const active=await env.DB.prepare("SELECT id,permission FROM hx_external_resource_grants WHERE org_id=?1 AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL").bind(orgId,rootId,guestId).first();
  expect(active).toMatchObject({permission:"view"});
  expect(active.id).not.toBe(original.created_grant_id);

  expect((await call(`${path}/invites/${invited.invitationId}`,sessions.owner,"DELETE")).status).toBe(200);
  expect(await env.DB.prepare("SELECT id FROM hx_external_resource_grants WHERE org_id=?1 AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL").bind(orgId,rootId,guestId).first())
    .toMatchObject({id:active.id});
  expect((await call(`${path.replace("/external/threads/","/external/threads/")}`,guestSession)).status).toBe(200);
});


test("owner can list active grants and revoke by grant id after recipient joins", async () => {
  const {orgId,rootId,ids,sessions}=await setup();
  const email=`guest-${orgId.split("-").at(-1)}@example.test`;
  const created=await call(`/external/threads/${orgId}/${rootId}/shares`,sessions.owner,"POST",{email,permission:"edit"});
  expect(created.status).toBe(201);
  const grant=(await created.json()).grant;
  let listed=await call(`/external/threads/${orgId}/${rootId}/shares`,sessions.owner);
  // Every manager reads the list, not only the one who typed the address (#956).
  expect(await listed.json()).toMatchObject({shares:[{id:grant.id,permission:"edit",recipient:{name:"guest",email:null},recipientIsMember:false,suspended:false}]});
  await upsertMembership(env.DB,orgId,ids.guest,"member");
  listed=await call(`/external/threads/${orgId}/${rootId}/shares`,sessions.owner);
  expect(await listed.json()).toMatchObject({shares:[{id:grant.id,recipient:{name:"guest",email:null},recipientIsMember:true,suspended:true}]});
  const revoked=await call(`/external/threads/${orgId}/${rootId}/shares`,sessions.owner,"DELETE",{grantId:grant.id});
  expect(await revoked.json()).toEqual({revoked:true});
  expect(await env.DB.prepare("SELECT revoked_at FROM hx_external_resource_grants WHERE id=?1").bind(grant.id).first()).toMatchObject({revoked_at:expect.any(String)});
});


test("concurrent redemption and revoke leave no live Thread grant", async () => {
  const {orgId,rootId,ids,sessions}=await setup();
  const email=`guest-${orgId.split("-").at(-1)}@example.test`;
  const path=`/external/threads/${orgId}/${rootId}/invites`;
  const created=await call(path,sessions.owner,"POST",{email,permission:"edit"});
  expect(created.status).toBe(201);
  const invite=await created.json();
  const token=invite.inviteUrl?.match(/external-invite\/([a-f0-9]{64})$/i)?.[1]||invite.token;
  const [redemption,revocation]=await Promise.all([
    call("/external/invites/redeem",sessions.guest,"POST",{token}),
    call(`${path}/${invite.invitationId}`,sessions.owner,"DELETE"),
  ]);
  expect([200,404]).toContain(redemption.status);
  expect(revocation.status).toBe(200);
  expect(await env.DB.prepare("SELECT revoked_at FROM hx_external_thread_invites WHERE id=?1").bind(invite.invitationId).first())
    .toMatchObject({revoked_at:expect.any(String)});
  expect(await env.DB.prepare(`SELECT count(*) AS n FROM hx_external_resource_grants
    WHERE org_id=?1 AND resource_type='thread' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL`)
    .bind(orgId,rootId,ids.guest).first()).toMatchObject({n:0});
  expect((await call(`/external/threads/${orgId}/${rootId}`,sessions.guest)).status).toBe(404);
});

test("edit guests can attach to an exact Thread reply and every file read is grant checked", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  expect((await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "edit" })).status).toBe(201);
  const uploaded = await callUpload(`/external/threads/${orgId}/${rootId}/files?name=launch-notes.txt`, sessions.guest);
  expect(uploaded.status).toBe(201);
  const { file } = await uploaded.json();
  expect(file).toMatchObject({ name: "launch-notes.txt", type: "text/plain" });
  expect(file.url).toBeUndefined();
  const sent = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", {
    body: "Launch notes attached", files: [file.id],
  });
  expect(sent.status).toBe(201);
  const { messageId } = await sent.json();
  const read = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest);
  const data = await read.json();
  const reply = data.thread.replies.find(message => message.id === messageId);
  expect(reply.files).toMatchObject([{
    id: file.id, name: "launch-notes.txt", type: "text/plain", size: 22,
  }]);
  expect(reply.files[0].url).toBe(`/external/threads/${orgId}/${rootId}/files/${file.id}`);
  const bytes = await call(reply.files[0].url, sessions.guest);
  expect(bytes.status).toBe(200);
  expect(await bytes.text()).toBe("guest attachment bytes");
  const ranged = await call(reply.files[0].url, sessions.guest, "GET", undefined, {}, { range: "bytes=6-15" });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe("bytes 6-15/22");
  expect(await ranged.text()).toBe("attachment");
  const unsatisfiable = await call(reply.files[0].url, sessions.guest, "GET", undefined, {}, { range: "bytes=22-23" });
  expect(unsatisfiable.status).toBe(416);
  expect(unsatisfiable.headers.get("content-range")).toBe("bytes */22");
  const reaction = await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", {
    messageId, emoji: "👍",
  });
  expect(reaction.status).toBe(200);
  const refreshed = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  expect(refreshed.thread.replies.find(message => message.id === messageId).reactions).toEqual([
    { emoji: "👍", count: 1, mine: true },
  ]);
  expect((await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "DELETE", { email })).status).toBe(200);
  expect((await call(reply.files[0].url, sessions.guest)).status).toBe(404);
  expect((await call(reply.files[0].url, sessions.guest, "GET", undefined, {}, { range: "bytes=0-5" })).status).toBe(404);
  expect((await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", { messageId, emoji: "✅" })).status).toBe(404);
  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).status).toBe(404);
});
test("view guests may read attachment ranges and react but cannot upload, attach, or cross Threads", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  const shared = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "edit" });
  expect(shared.status).toBe(201);
  const grantId = (await shared.json()).grant.id;
  const uploaded = await callUpload(`/external/threads/${orgId}/${rootId}/files?name=viewable.txt`, sessions.guest);
  expect(uploaded.status).toBe(201);
  const { file } = await uploaded.json();
  const pendingUpload = await callUpload(`/external/threads/${orgId}/${rootId}/files?name=pending.txt`, sessions.guest, "pending attachment bytes");
  expect(pendingUpload.status).toBe(201);
  const { file: pendingFile } = await pendingUpload.json();
  const sent = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", {
    body: "Attached before changing the grant to view", files: [file.id],
  });
  expect(sent.status).toBe(201);
  const { messageId } = await sent.json();
  await flushBackground();
  const revoked = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "DELETE", { grantId });
  expect(revoked.status).toBe(200);
  // Revoking the edit grant leaves no active grant, so range metadata is hidden too.
  expect((await call(`/external/threads/${orgId}/${rootId}/files/${file.id}`, sessions.guest, "GET", undefined, {}, { range: "bytes=0-5" })).status).toBe(404);
  const viewGrant = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "view" });
  expect(viewGrant.status).toBe(201);

  const upload = await callUpload(`/external/threads/${orgId}/${rootId}/files?name=view-only.txt`, sessions.guest);
  expect(upload.status).toBe(403);
  const attach = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", {
    body: "View guests cannot attach", files: [pendingFile.id],
  });
  expect(attach.status).toBe(403);
  const replyDenied = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: "View grants cannot reply" });
  expect(replyDenied.status).toBe(403);

  const thread = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  const reply = thread.thread.replies.find(message => message.id === messageId);
  expect(reply.files).toMatchObject([{ id: file.id, size: 22 }]);
  const ranged = await call(reply.files[0].url, sessions.guest, "GET", undefined, {}, { range: "bytes=6-15" });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe("bytes 6-15/22");
  expect(await ranged.text()).toBe("attachment");
  const unsatisfiable = await call(reply.files[0].url, sessions.guest, "GET", undefined, {}, { range: "bytes=22-23" });
  expect(unsatisfiable.status).toBe(416);
  expect(unsatisfiable.headers.get("content-range")).toBe("bytes */22");

  const otherRootId = `${rootId}-other`;
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, 'b:private-room', ?3, 'message', 'Other Thread', ?4)")
    .bind(otherRootId, orgId, ids.owner, new Date().toISOString()).run();
  const crossRange = await call(`/external/threads/${orgId}/${otherRootId}/files/${file.id}`, sessions.guest, "GET", undefined, {}, { range: "bytes=0-5" });
  expect(crossRange.status).toBe(404);
  const crossReaction = await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", {
    messageId: otherRootId, emoji: "👀",
  });
  expect(crossReaction.status).toBe(404);
  expect((await call(`/external/threads/${orgId}/${otherRootId}`, sessions.guest)).status).toBe(404);
  const reaction = await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", {
    messageId: rootId, emoji: "👀",
  });
  expect(reaction.status).toBe(200);
  const refreshed = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  expect(refreshed.thread.parent.reactions).toEqual([{ emoji: "👀", count: 1, mine: true }]);
});
test("external Thread guests never receive or create workspace shortcode reactions", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  const share = await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "edit" });
  expect(share.status).toBe(201);

  await env.DB.prepare(`INSERT INTO message_reactions (org_id,message_id,emoji,login,created_at)
    VALUES (?1,?2,':private_mark:',?3,?4)`).bind(orgId, rootId, ids.owner, new Date().toISOString()).run();
  const read = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest);
  expect(read.status).toBe(200);
  const body = await read.text();
  expect(body).not.toContain(":private_mark:");
  expect(body).not.toContain("private_mark");

  const toggle = await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", {
    messageId: rootId, emoji: ":private_mark:",
  });
  expect(toggle.status).toBe(400);
  expect(await env.DB.prepare(`SELECT 1 FROM message_reactions WHERE org_id=?1 AND message_id=?2 AND login=?3 AND emoji=':private_mark:'`)
    .bind(orgId, rootId, ids.guest).first()).toBeNull();
});

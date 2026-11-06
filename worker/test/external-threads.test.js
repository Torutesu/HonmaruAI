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
      !grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_thread_send_requests "))) {
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
async function flushBackground() {
  while (context.tasks.length) await Promise.all(context.tasks.splice(0));
}
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
  const request = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: `@${ids.owner} @AI summarize the launch plan`, requestSend: true });
  expect(request.status).toBe(201);
  const sendRequest = await request.json();
  expect((await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.editor)).status).toBe(404);
  const pending = await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.owner);
  expect((await pending.json()).requests).toMatchObject([{ id: sendRequest.requestId, body: `@${ids.owner} @AI summarize the launch plan` }]);
  const approved = await call(`/external/threads/${orgId}/${rootId}/requests/approve`, sessions.owner, "POST", { requestId: sendRequest.requestId });
  expect(approved.status).toBe(200);
  const approvedMessage = await approved.json();
  await flushBackground();

  const refreshed = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  expect(refreshed.thread.replies).toMatchObject([
    { body: `@${ids.owner} @AI summarize the launch plan`, authorName: "guest", mine: true },
    { kind: "ai", parentId: rootId },
  ]);
  expect(await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2").bind(orgId, approvedMessage.messageId).all())
    .toMatchObject({ results: [{ login: ids.owner, reason: "mention" }] });
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
  const reply = await call(`/external/threads/${orgId}/${rootId}`, sessions.guest, "POST", { body: `@${ids.owner} Approved edit` });
  expect(reply.status).toBe(201);
  const replyBody = await reply.json();
  await flushBackground();
  expect(await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2").bind(orgId, replyBody.messageId).all())
    .toMatchObject({ results: [{ login: ids.owner, reason: "mention" }] });
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
  expect((await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", { messageId, emoji: "✅" })).status).toBe(404);
  expect((await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).status).toBe(404);
});

test("view guests may react but cannot upload; attachments and reactions do not cross Thread grants", async () => {
  const { orgId, rootId, ids, sessions } = await setup();
  const email = `guest-${orgId.split("-").at(-1)}@example.test`;
  expect((await call(`/external/threads/${orgId}/${rootId}/shares`, sessions.owner, "POST", { email, permission: "view" })).status).toBe(201);

  const upload = await callUpload(`/external/threads/${orgId}/${rootId}/files?name=view-only.txt`, sessions.guest);
  expect(upload.status).toBe(403);

  const otherRootId = `${rootId}-other`;
  await env.DB.prepare("INSERT INTO channel_messages (id, org_id, channel, author_login, kind, body, created_at) VALUES (?1, ?2, 'b:private-room', ?3, 'message', 'Other Thread', ?4)")
    .bind(otherRootId, orgId, ids.owner, new Date().toISOString()).run();
  const crossReaction = await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", {
    messageId: otherRootId, emoji: "👀",
  });
  expect(crossReaction.status).toBe(404);
  expect((await call(`/external/threads/${orgId}/${otherRootId}`, sessions.guest)).status).toBe(404);

  const reaction = await call(`/external/threads/${orgId}/${rootId}/reactions`, sessions.guest, "POST", {
    messageId: rootId, emoji: "👀",
  });
  expect(reaction.status).toBe(200);
  const thread = await (await call(`/external/threads/${orgId}/${rootId}`, sessions.guest)).json();
  expect(thread.thread.parent.reactions).toEqual([{ emoji: "👀", count: 1, mine: true }]);
});

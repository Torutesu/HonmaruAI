import { env } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { createSession, upsertMembership, upsertUser } from "../src/db.js";
import { hashPassword, newSaltHex } from "../src/auth.js";
import { setMode } from "../src/harness/mode.js";
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
      !grantMigrations.some((line) => line.startsWith("CREATE TABLE IF NOT EXISTS hx_external_thread_invites "))) {
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
  expect((await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.editor)).status).toBe(404);
  const pending = await call(`/external/threads/${orgId}/${rootId}/requests`, sessions.owner);
  expect((await pending.json()).requests).toMatchObject([{ id: sendRequest.requestId, body: `@${ids.owner} @AI summarize the launch plan` }]);
  const approved = await call(`/external/threads/${orgId}/${rootId}/requests/approve`, sessions.owner, "POST", { requestId: sendRequest.requestId }, { OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini" });
  expect(approved.status).toBe(200);
  const approvedMessage = await approved.json();
  await flushBackground();
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
  expect(memberRedemption.status).toBe(200);
  expect(await memberRedemption.json()).toMatchObject({redeemed:true,alreadyMember:true});
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
  expect(await listed.json()).toMatchObject({shares:[{id:grant.id,permission:"edit",recipient:{email},recipientIsMember:false,suspended:false}]});
  await upsertMembership(env.DB,orgId,ids.guest,"member");
  listed=await call(`/external/threads/${orgId}/${rootId}/shares`,sessions.owner);
  expect(await listed.json()).toMatchObject({shares:[{id:grant.id,recipient:{email},recipientIsMember:true,suspended:true}]});
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

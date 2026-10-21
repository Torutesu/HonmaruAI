import { env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// Seeing a team, and closing a door you opened.
//
// Inviting somebody was the whole of team management: no member list, no way
// to take anyone out, and no way to find or cancel a code already handed over.
// The one endpoint that answered "who is here" read a GitHub repository's
// collaborators, so it answered nothing for anyone who signed in with an email
// address — which is everyone the web client can sign in.

const TEAM = "personal:teamtest";
const REPO_ORG = "acme/widgets";

let adminToken;
let memberToken;
let outsiderToken;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");

  await upsertUser(env.DB, { githubId: "9001", login: "dana", name: "Dana", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9001", "admin");
  adminToken = await createSession(env.DB, "9001", "gho_dana");

  await upsertUser(env.DB, { githubId: "9002", login: "kenji", name: "Kenji", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9002", "member");
  memberToken = await createSession(env.DB, "9002", "gho_kenji");

  await upsertUser(env.DB, { githubId: "9003", login: "aya", name: "Aya", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9003", "member");

  await upsertUser(env.DB, { githubId: "9099", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  outsiderToken = await createSession(env.DB, "9099", "gho_nobody");

  // A repository-backed org, where membership is GitHub's answer and not ours.
  await upsertUser(env.DB, { githubId: "9101", login: "owner", name: "Owner", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, REPO_ORG, "9101", "admin");
  await upsertMembership(env.DB, REPO_ORG, "9102", "member");
});

const get = (path, token) =>
  worker.fetch(new Request(`https://example.com${path}`, { headers: { "x-session-token": token } }), env);

const del = (path, token, body) =>
  worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify(body),
    }),
    env
  );

const mint = (token, body) =>
  worker.fetch(
    new Request("https://example.com/invites/create", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify(body),
    }),
    env
  );

test("a workspace made at sign-up can say who is in it", async () => {
  // The old answer, /orgs/:owner/:repo/graph, needs a GitHub session and a
  // repository. This one needs neither.
  const res = await get(`/members?orgId=${encodeURIComponent(TEAM)}`, memberToken);
  expect(res.status).toBe(200);
  const { members, editable } = await res.json();
  expect(members.map((m) => m.name).sort()).toEqual(["Aya", "Dana", "Kenji"]);
  expect(members.find((m) => m.name === "Dana").role).toBe("owner");
  expect(members.find((m) => m.name === "Kenji").mine).toBe(true);
  expect(editable).toBe(true);
});

test("the member list does not hand out everybody's email address", async () => {
  // The obvious handle for a member is the login, and for every account that
  // signed in with an email that login *is* the address — `u:dana@…`, with
  // `user_github_id` as `email:dana@…`. A member list is read by the whole
  // team, so naming people that way puts the address in all of their browsers
  // in order to serve a Remove button.
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "email:dana@honmaru.test", login: "u:dana@honmaru.test", name: "Dana", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "email:dana@honmaru.test", "member");
  const dana = await createSession(env.DB, "email:dana@honmaru.test", "email-auth");

  const res = await get(`/members?orgId=${encodeURIComponent(TEAM)}`, dana);
  const body = await res.text();
  expect(body).not.toContain("dana@honmaru.test");
  expect(body).toContain("Dana");

  const { members } = JSON.parse(body);
  const row = members.find((m) => m.name === "Dana");
  expect(row.userId).toBeUndefined();
  expect(row.login).toBeUndefined();
  expect(row.ref).toMatch(/^[0-9a-f]{16}$/);
});

test("a ref is enough to remove somebody, and only in its own workspace", async () => {
  const { isMember, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9300", login: "temp", name: "Temp", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9300", "member");
  await upsertMembership(env.DB, "personal:elsewhere", "9300", "member");

  const { members } = await (await get(`/members?orgId=${encodeURIComponent(TEAM)}`, adminToken)).json();
  const ref = members.find((m) => m.name === "Temp").ref;

  // The same person in another workspace carries a different handle, so a
  // list taken from one team cannot be used to reach into another.
  const { memberRef } = await import("../src/team.js");
  expect(await memberRef("personal:elsewhere", "9300")).not.toBe(ref);

  const res = await del("/members", adminToken, { orgId: TEAM, ref });
  expect(res.status).toBe(200);
  expect(await isMember(env.DB, TEAM, "9300")).toBe(false);
  expect(await isMember(env.DB, "personal:elsewhere", "9300")).toBe(true);
});

test("a team is not public", async () => {
  const res = await get(`/members?orgId=${encodeURIComponent(TEAM)}`, outsiderToken);
  expect(res.status).toBe(403);
  expect(JSON.stringify(await res.json())).not.toContain("Dana");
});

test("a repository-backed team is shown, and said to be GitHub's to change", async () => {
  const res = await get(`/members?orgId=${encodeURIComponent(REPO_ORG)}`, await sessionFor("9101"));
  const { members, editable } = await res.json();
  expect(members).toHaveLength(2);
  // Removing a row here would be undone by the next org-graph load, which
  // re-derives membership from GitHub. Better to say so than to appear to work.
  expect(editable).toBe(false);
});

async function sessionFor(githubId) {
  const { createSession } = await import("../src/db.js");
  return createSession(env.DB, githubId, "gho_test");
}

test("a member cannot remove another member", async () => {
  const res = await del("/members", memberToken, { orgId: TEAM, userId: "9003" });
  expect(res.status).toBe(403);
  const { isMember } = await import("../src/db.js");
  expect(await isMember(env.DB, TEAM, "9003")).toBe(true);
});

test("an admin can, and the person's decisions stay behind", async () => {
  const { isMember, saveCard, getCard } = await import("../src/db.js");
  await saveCard(env.DB, TEAM, {
    id: "card-aya-1", recipientUserID: "aya", senderUserID: "dana",
    status: "approved", createdAt: new Date().toISOString(),
  });

  const res = await del("/members", adminToken, { orgId: TEAM, userId: "9003" });
  expect(res.status).toBe(200);
  expect(await isMember(env.DB, TEAM, "9003")).toBe(false);
  // What was decided is the organization's record, not the decider's
  // belongings — account deletion draws the same line.
  expect(await getCard(env.DB, TEAM, "card-aya-1")).not.toBeNull();
});

test("nobody may remove someone at or above their own role", async () => {
  const { upsertUser, upsertMembership, createSession, isMember } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9004", login: "kai", name: "Kai", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9004", "admin");
  const otherAdmin = await createSession(env.DB, "9004", "gho_kai");

  const res = await del("/members", otherAdmin, { orgId: TEAM, userId: "9001" });
  expect(res.status).toBe(403);
  expect(await isMember(env.DB, TEAM, "9001")).toBe(true);
});

test("you can always let yourself out", async () => {
  const { isMember } = await import("../src/db.js");
  const res = await del("/members", memberToken, { orgId: TEAM, userId: "9002" });
  expect(res.status).toBe(200);
  expect((await res.json()).left).toBe(true);
  expect(await isMember(env.DB, TEAM, "9002")).toBe(false);
});

test("the last person out cannot close the door behind them", async () => {
  // An org with nobody in it is a row nothing can reach again, its cards
  // included, and no invite can be minted to get back in.
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9200", login: "solo", name: "Solo", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:solo", "9200", "admin");
  const solo = await createSession(env.DB, "9200", "gho_solo");

  const res = await del("/members", solo, { orgId: "personal:solo", userId: "9200" });
  expect(res.status).toBe(400);
});

test("membership that came from GitHub is not ours to delete", async () => {
  const { isMember } = await import("../src/db.js");
  const res = await del("/members", await sessionFor("9101"), { orgId: REPO_ORG, userId: "9102" });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toContain("GitHub");
  expect(await isMember(env.DB, REPO_ORG, "9102")).toBe(true);
});

test("the codes you have out are listed, and yours are readable", async () => {
  const minted = await (await mint(adminToken, { orgId: TEAM, role: "engineer" })).json();

  const res = await get(`/invites?orgId=${encodeURIComponent(TEAM)}`, adminToken);
  expect(res.status).toBe(200);
  const { invites } = await res.json();
  const found = invites.find((i) => i.code === minted.code);
  expect(found).toBeTruthy();
  expect(found.mine).toBe(true);
  expect(found.role).toBe("engineer");
  expect(found.uses).toBe(0);
  // A link is for everyone it is shared with.
  expect(found.maxUses).toBeGreaterThan(1);
  expect(found.ref).toMatch(/^[0-9a-f]{16}$/);
});

test("a code above your own role is listed but not shown", async () => {
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9005", login: "plain", name: "Plain", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9005", "member");
  const plain = await createSession(env.DB, "9005", "gho_plain");

  const admin = await (await mint(adminToken, { orgId: TEAM, role: "admin" })).json();
  const res = await get(`/invites?orgId=${encodeURIComponent(TEAM)}`, plain);
  const { invites } = await res.json();

  // Reading it would be a promotion: redeeming an admin code makes you one,
  // and this person cannot mint one. They can see that it exists.
  const hidden = invites.find((i) => i.ref && i.code === null);
  expect(hidden).toBeTruthy();
  expect(hidden.role).toBe("admin");
  expect(JSON.stringify(invites)).not.toContain(admin.code);
});

test("a code you minted, you can cancel", async () => {
  const minted = await (await mint(adminToken, { orgId: TEAM, role: "member" })).json();
  const res = await del("/invites", adminToken, { orgId: TEAM, code: minted.code });
  expect(res.status).toBe(200);

  const { acceptInvite } = await import("../src/auth.js");
  expect((await acceptInvite(env, { code: minted.code, userId: "9500" })).error).toBeTruthy();
});

test("a code somebody else minted is not yours to cancel", async () => {
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9006", login: "bystander", name: "Bystander", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9006", "member");
  const bystander = await createSession(env.DB, "9006", "gho_bystander");

  const minted = await (await mint(adminToken, { orgId: TEAM, role: "member" })).json();
  const res = await del("/invites", bystander, { orgId: TEAM, code: minted.code });
  expect(res.status).toBe(403);

  // Still good for the person it was actually for.
  const { acceptInvite } = await import("../src/auth.js");
  expect((await acceptInvite(env, { code: minted.code, userId: "9501" })).error).toBeUndefined();
});

test("an admin cancels one by reference, without ever being shown it", async () => {
  const { upsertUser, upsertMembership, createSession } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9007", login: "lead", name: "Lead", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, TEAM, "9007", "triager");
  const lead = await createSession(env.DB, "9007", "gho_lead");

  const minted = await (await mint(lead, { orgId: TEAM, role: "member" })).json();
  const { inviteRef } = await import("../src/team.js");
  const ref = await inviteRef(minted.code);
  const { invites } = await (await get(`/invites?orgId=${encodeURIComponent(TEAM)}`, adminToken)).json();
  const theirs = invites.find((i) => i.ref === ref);
  expect(theirs.mine).toBe(false);

  const res = await del("/invites", adminToken, { orgId: TEAM, ref: theirs.ref });
  expect(res.status).toBe(200);
  const { acceptInvite } = await import("../src/auth.js");
  expect((await acceptInvite(env, { code: minted.code, userId: "9502" })).error).toBeTruthy();
});

test("a code minted before refs were stored is still listed and revocable", async () => {
  // The column arrived after the codes did. A row with no ref must not become
  // one nobody can see or cancel — listing writes it back, so the set needing
  // the fallback only ever shrinks.
  const minted = await (await mint(adminToken, { orgId: TEAM, role: "member" })).json();
  await env.DB.prepare("UPDATE invites SET ref = NULL WHERE code = ?1").bind(minted.code).run();

  const { invites } = await (await get(`/invites?orgId=${encodeURIComponent(TEAM)}`, adminToken)).json();
  const listed = invites.find((i) => i.code === minted.code);
  expect(listed.ref).toMatch(/^[0-9a-f]{16}$/);

  const backfilled = await env.DB
    .prepare("SELECT ref FROM invites WHERE code = ?1").bind(minted.code).first();
  expect(backfilled.ref).toBe(listed.ref);

  const res = await del("/invites", adminToken, { orgId: TEAM, ref: listed.ref });
  expect(res.status).toBe(200);
  const { acceptInvite } = await import("../src/auth.js");
  expect((await acceptInvite(env, { code: minted.code, userId: "9600" })).error).toBeTruthy();
});

test("a ref that was never written can still be revoked", async () => {
  // The window between the deploy and the first person opening the team
  // screen: nothing has backfilled yet, and cancelling still has to work.
  const minted = await (await mint(adminToken, { orgId: TEAM, role: "member" })).json();
  const { inviteRef } = await import("../src/team.js");
  const ref = await inviteRef(minted.code);
  await env.DB.prepare("UPDATE invites SET ref = NULL WHERE code = ?1").bind(minted.code).run();

  const res = await del("/invites", adminToken, { orgId: TEAM, ref });
  expect(res.status).toBe(200);
  const { acceptInvite } = await import("../src/auth.js");
  expect((await acceptInvite(env, { code: minted.code, userId: "9601" })).error).toBeTruthy();
});

test("GitHub sync is claimed only where it can actually run", async () => {
  // The status now also asks Composio whether this person's GitHub is
  // connected; nobody's is here.
  fetchMock.activate();
  fetchMock.get("https://backend.composio.dev")
    .intercept({ path: (p) => p.startsWith("/api/v3/connected_accounts"), method: "GET" })
    .reply(200, { items: [] })
    .persist();
  // The Tools screen said "Always on · Built in" to everybody. For an email
  // account in the workspace it was given at sign-up there is no repository to
  // open an issue in and no token to write with.
  const personal = await (await get(`/connectors/github?orgId=${encodeURIComponent(TEAM)}`, adminToken)).json();
  expect(personal.builtIn).toBe(false);
  expect(personal.reason).toBeTruthy();

  const repo = await (await get(`/connectors/github?orgId=${encodeURIComponent(REPO_ORG)}`, await sessionFor("9101"))).json();
  expect(repo.builtIn).toBe(true);

  // A repository org reached with an email session cannot sync either: the
  // decision is written as the person's own GitHub account.
  const { createSession } = await import("../src/db.js");
  const { EMAIL_AUTH_TOKEN } = await import("../src/auth.js");
  const emailSession = await createSession(env.DB, "9101", EMAIL_AUTH_TOKEN);
  const noToken = await (await get(`/connectors/github?orgId=${encodeURIComponent(REPO_ORG)}`, emailSession)).json();
  expect(noToken.builtIn).toBe(false);
});

test('departure preview names only live managed-agent responsibilities and opaque successor refs', async () => {
  const { memberRef } = await import('../src/team.js');
  const { upsertUser, upsertMembership } = await import('../src/db.js');
  await upsertUser(env.DB, { githubId:'9004', login:'guest', name:'Guest', locale:'en' });
  await upsertMembership(env.DB, TEAM, '9004', 'guest');
  const add = async (id, owner, scope='team', profiled=true) => {
    await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,?2,?2,?2,'private body',?3,?4,'now','now')`).bind(TEAM,id,scope,owner).run();
    if(profiled) await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','now')`).bind(TEAM,id).run();
  };
  await add('owned','kenji','personal');
  await add('administered','aya');
  await add('ordinary','aya');
  await add('dormant','aya');
  await add('deleted','kenji');
  await add('legacy','kenji','team',false);
  await env.DB.prepare("UPDATE custom_agents SET deleted_at='now' WHERE org_id=?1 AND id='deleted'").bind(TEAM).run();
  for (const [id,role] of [['administered','admin'],['ordinary','member'],['dormant','admin']]) {
    await env.DB.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
      SELECT ?1,?2,'9002',?3,'9001','now',created_at FROM memberships WHERE org_id=?1 AND user_github_id='9002'`).bind(TEAM,id,role).run();
  }
  await env.DB.prepare("UPDATE hx_agent_members SET member_since='old membership' WHERE org_id=?1 AND agent_id='dormant'").bind(TEAM).run();
  const ref=await memberRef(TEAM,'9002');
  const response=await get(`/members/departure?orgId=${encodeURIComponent(TEAM)}&ref=${ref}`,adminToken);
  expect(response.status).toBe(200);
  const body=await response.json();
  expect(body.agents).toEqual([
    {id:'administered',name:'administered',owned:false,scope:'team',version:0},
    {id:'owned',name:'owned',owned:true,scope:'personal',version:0},
  ]);
  expect(body.candidates.map(p=>p.name).sort()).toEqual(['Aya','Dana']);
  expect(body.candidates.every(p=>Object.keys(p).sort().join(',')==='name,ref')).toBe(true);
  expect(JSON.stringify(body)).not.toContain('private body');
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id='9002'").bind(TEAM).first()).not.toBeNull();
  const own=await get(`/members/departure?orgId=${encodeURIComponent(TEAM)}&ref=${ref}`,memberToken);
  expect((await own.json()).member).toMatchObject({ref,mine:true});
});

test('departure preview cannot inspect another member without removal authority',async()=>{
  const {memberRef}=await import('../src/team.js');
  const ref=await memberRef(TEAM,'9003');
  const path=`/members/departure?orgId=${encodeURIComponent(TEAM)}&ref=${ref}`;
  expect((await get(path,memberToken)).status).toBe(403);
  expect((await get(path,outsiderToken)).status).toBe(403);
  const ownerRef=await memberRef(TEAM,'9001');
  const lastOwner=await get(`/members/departure?orgId=${encodeURIComponent(TEAM)}&ref=${ownerRef}`,adminToken);
  expect(lastOwner.status).toBe(409);
  expect((await lastOwner.json()).code).toBe('last-owner');
});

async function departingAgent() {
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
    VALUES (?1,'departure-agent','departure-agent','Departure agent','Keep this','personal','kenji','now','now')`).bind(TEAM).run();
  await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,'departure-agent','private','now')`).bind(TEAM).run();
  const {memberRef}=await import('../src/team.js');
  const ref=await memberRef(TEAM,'9002'),transferTo=await memberRef(TEAM,'9003');
  const preview=await (await get(`/members/departure?orgId=${encodeURIComponent(TEAM)}&ref=${ref}`,memberToken)).json();
  return {ref,transferTo,previewVersion:preview.version};
}

test('member departure requires a current preview and atomically transfers ownership without changing creator or private scope',async()=>{
  const input=await departingAgent();
  const missing=await del('/members',memberToken,{orgId:TEAM,ref:input.ref});
  expect(missing.status).toBe(409);
  expect((await missing.json()).code).toBe('agent-handoff-required');
  const response=await del('/members',memberToken,{orgId:TEAM,...input});
  expect(response.status).toBe(200);
  expect((await response.json()).handoff).toEqual({agents:1,to:input.transferTo});
  const agent=await env.DB.prepare("SELECT owner_login,created_by_login,instructions,scope FROM custom_agents WHERE org_id=?1 AND id='departure-agent'").bind(TEAM).first();
  expect(agent).toEqual({owner_login:'aya',created_by_login:'kenji',instructions:'Keep this',scope:'personal'});
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id='9002'").bind(TEAM).first()).toBeNull();
  expect((await env.DB.prepare("SELECT role FROM hx_agent_members WHERE org_id=?1 AND agent_id='departure-agent' AND user_id='9003'").bind(TEAM).first()).role).toBe('admin');
  expect((await env.DB.prepare("SELECT version FROM hx_agent_access WHERE org_id=?1 AND agent_id='departure-agent'").bind(TEAM).first()).version).toBe(1);
});

test('a changed preview cannot transfer or remove membership',async()=>{
  const input=await departingAgent();
  await env.DB.prepare("INSERT INTO hx_agent_access(org_id,agent_id,version) VALUES (?1,'departure-agent',1)").bind(TEAM).run();
  const response=await del('/members',memberToken,{orgId:TEAM,...input});
  expect(response.status).toBe(409);
  expect((await env.DB.prepare("SELECT owner_login FROM custom_agents WHERE org_id=?1 AND id='departure-agent'").bind(TEAM).first()).owner_login).toBe('kenji');
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id='9002'").bind(TEAM).first()).not.toBeNull();
});

test('recipient departure between preview and transaction makes the whole handoff a no-op',async()=>{
  const input=await departingAgent();
  const {removeMember}=await import('../src/team.js');
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id='9003'").bind(TEAM).run();
    return env.DB.batch(statements);
  }};
  const result=await removeMember({...env,DB:db},{orgId:TEAM,actorId:'9002',...input});
  expect(result).toMatchObject({status:409,code:'departure-conflict'});
  expect((await env.DB.prepare("SELECT owner_login FROM custom_agents WHERE org_id=?1 AND id='departure-agent'").bind(TEAM).first()).owner_login).toBe('kenji');
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id='9002'").bind(TEAM).first()).not.toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id='departure-agent'").bind(TEAM).first()).toBeNull();
});

test('an administrator removing a member transfers delegated administration while preserving the existing owner',async()=>{
  const input=await departingAgent();
  await env.DB.prepare("UPDATE custom_agents SET owner_login='dana',scope='team' WHERE org_id=?1 AND id='departure-agent'").bind(TEAM).run();
  await env.DB.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
    SELECT ?1,'departure-agent','9002','admin','9001','now',created_at FROM memberships WHERE org_id=?1 AND user_github_id='9002'`).bind(TEAM).run();
  const preview=await (await get(`/members/departure?orgId=${encodeURIComponent(TEAM)}&ref=${input.ref}`,adminToken)).json();
  const response=await del('/members',adminToken,{orgId:TEAM,...input,previewVersion:preview.version});
  expect(response.status).toBe(200);
  expect((await env.DB.prepare("SELECT owner_login FROM custom_agents WHERE org_id=?1 AND id='departure-agent'").bind(TEAM).first()).owner_login).toBe('dana');
  expect((await env.DB.prepare("SELECT role FROM hx_agent_members WHERE org_id=?1 AND agent_id='departure-agent' AND user_id='9003'").bind(TEAM).first()).role).toBe('admin');
  expect(await env.DB.prepare("SELECT 1 FROM hx_agent_members WHERE org_id=?1 AND user_id='9002'").bind(TEAM).first()).toBeNull();
});

test('an agent assigned after a no-responsibilities preview prevents removal inside the transaction',async()=>{
  const {memberRef,removeMember}=await import('../src/team.js');
  const ref=await memberRef(TEAM,'9002');
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
      VALUES (?1,'new-agent','new-agent','New agent','Keep','personal','kenji','now','now')`).bind(TEAM).run();
    await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,updated_at) VALUES (?1,'new-agent','now')").bind(TEAM).run();
    return env.DB.batch(statements);
  }};
  expect(await removeMember({...env,DB:db},{orgId:TEAM,actorId:'9002',ref})).toMatchObject({status:409,code:'departure-conflict'});
  expect(await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id='9002'").bind(TEAM).first()).not.toBeNull();
});

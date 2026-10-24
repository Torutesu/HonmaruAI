import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { watchTeammateRuns } from "../src/channelRoutes.js";

// AI teammates, the way Claude Tag works in Slack: an admin sets Claude up
// with a key from an account made for it, tools' keys go to Anthropic's vault,
// and "@claude" in a thread starts a Managed Agents session whose answer
// comes back into the thread, within the month's limit.

const ORG = "personal:teammates";
let toru; let mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, extra = {}) => { const res = await worker.fetch(new Request("https://example.com" + path, init), { ...env, OPENAI_API_KEY: undefined, ...extra }, ctx); await settle(); return res; };
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (method, path, token, body, extra) => call(path, { method, headers: headers(token), body: JSON.stringify(body) }, extra);
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const anthropic = () => fetchMock.get("https://api.anthropic.com");
const thread = async (token, messageId) => (await (await get(`/channels/thread?${q({ orgId: ORG, channel: "b:cafe", messageId })}`, token)).json()).replies;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9701", "toru", "Toru", "admin"], ["9702", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9701" });
  await upsertBusiness(env.DB, ORG, { name: "Other", createdBy: "9701" });
  toru = await createSession(env.DB, "9701", "gho_t");
  mika = await createSession(env.DB, "9702", "gho_m");
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

/// Launch: the environment, the vault with the tool's key, and the agent.
async function launch(extra = {}) {
  let credential = null;
  let agentBody = null;
  anthropic().intercept({ path: "/v1/environments?beta=true", method: "POST" }).reply(200, { id: "env_1", type: "environment" });
  anthropic().intercept({ path: "/v1/vaults?beta=true", method: "POST" }).reply(200, { id: "vlt_1", type: "vault" });
  anthropic().intercept({ path: "/v1/vaults/vlt_1/credentials?beta=true", method: "POST" }).reply(200, (opts) => { credential = JSON.parse(opts.body); return { id: "cred_1", type: "credential" }; });
  anthropic().intercept({ path: "/v1/agents?beta=true", method: "POST" }).reply(200, (opts) => { agentBody = JSON.parse(opts.body); return { id: "agent_1", version: 1, type: "agent" }; });
  const res = await send("PUT", "/teammates", toru, {
    orgId: ORG, provider: "claude", enabled: true, apiKey: "sk-ant-test", githubToken: "ghp_claude", repos: ["acme/app"],
    tools: [{ name: "Linear", secretName: "LINEAR_API_KEY", secretValue: "lin_secret", host: "api.linear.app" }],
    instructions: "Keep answers short.", ...extra,
  });
  return { res, credential, agentBody };
}

test("an admin launches Claude: keys stay out of every answer, tools' keys go to the vault, and @claude is a teammate", async () => {
  expect((await send("PUT", "/teammates", mika, { orgId: ORG, provider: "claude", enabled: true, apiKey: "x" })).status).toBe(403);
  expect((await send("PUT", "/teammates", toru, { orgId: ORG, provider: "claude", enabled: true })).status).toBe(400);
  expect((await send("PUT", "/teammates", toru, { orgId: ORG, provider: "claude", apiKey: "x", repos: ["acme/app"] })).status).toBe(400);
  const { res, credential, agentBody } = await launch();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.teammate).toMatchObject({ enabled: true, ready: true, hasApiKey: true, hasGithubToken: true, repos: ["acme/app"], model: "claude-opus-5-5", monthlyLimit: 500, unit: "usd" });
  expect(body.teammate.tools).toEqual([{ name: "Linear", secretName: "LINEAR_API_KEY", host: "api.linear.app" }]);
  expect(JSON.stringify(body)).not.toMatch(/sk-ant-test|ghp_claude|lin_secret/);
  expect(credential.auth).toMatchObject({ type: "environment_variable", secret_name: "LINEAR_API_KEY", secret_value: "lin_secret", networking: { type: "limited", allowed_hosts: ["api.linear.app"] } });
  expect(agentBody.model).toBe("claude-opus-5-5");
  expect(agentBody.system).toContain("$LINEAR_API_KEY");
  expect(agentBody.system).toContain("acme/app");
  expect(agentBody.system).toContain("Keep answers short.");
  expect(agentBody.system).not.toContain("lin_secret");
  // Anyone sees it, never its keys; the Agents screen shows it, not for editing.
  const seen = await (await get(`/teammates?${q({ orgId: ORG, provider: "claude" })}`, mika)).json();
  expect(seen.canEdit).toBe(false);
  expect(JSON.stringify(seen)).not.toMatch(/sk-ant-test|ghp_claude/);
  const agents = (await (await get(`/channels/agents?${q({ orgId: ORG })}`, mika)).json()).agents;
  const claude = agents.find((a) => a.handle === "claude");
  expect(claude).toMatchObject({ provider: "claude", canEdit: false, canDelete: false });
  // Recorded, without a key.
  const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?1 AND action = 'workspace.teammate_changed'").bind(ORG).first().catch(() => null);
  if (logged) expect(Number(logged.n)).toBeGreaterThan(0);
});

test("@claude in a thread starts a session with the repo, vault and budget, and its answer comes back into the thread", async () => {
  await launch();
  let session = null;
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, (opts) => { session = JSON.parse(opts.body); return { id: "sesn_1", type: "session", status: "running" }; });
  anthropic().intercept({ path: (p) => p.startsWith("/v1/sessions/sesn_1/events?"), method: "GET" }).reply(200, {
    data: [
      { id: "e1", type: "session.status_running", processed_at: "2026-09-30T10:00:01Z" },
      { id: "e2", type: "agent.message", processed_at: "2026-09-30T10:00:05Z", content: [{ type: "text", text: "Fixed the login redirect. PR: https://github.com/acme/app/pull/7" }] },
      { id: "e3", type: "session.status_idle", processed_at: "2026-09-30T10:00:06Z", stop_reason: { type: "end_turn" } },
    ],
    next_page: null,
  });
  anthropic().intercept({ path: "/v1/sessions/sesn_1?beta=true", method: "GET" }).reply(200, { id: "sesn_1", status: "idle", usage: { list_cost: { amount: "123", currency: "USD" } } });
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@claude the login page sends people to a 404, fix it" })).json()).message;
  expect(session.agent).toBe("agent_1");
  expect(session.environment_id).toBe("env_1");
  expect(session.vault_ids).toEqual(["vlt_1"]);
  expect(session.resources).toEqual([{ type: "github_repository", url: "https://github.com/acme/app", authorization_token: "ghp_claude" }]);
  expect(session.budget).toEqual({ type: "limit", max_list_cost: { amount: "50000", currency: "USD" } });
  expect(session.initial_events[0].content[0].text).toContain("the login page sends people to a 404");
  expect(session.initial_events[0].content[0].text).toContain("#cafe");
  const replies = await thread(mika, posted.id);
  expect(replies.map((m) => m.body)).toEqual(["On it. I'll answer here when I'm done.", "Fixed the login redirect. PR: https://github.com/acme/app/pull/7"]);
  expect(replies.every((m) => m.kind === "agent" && m.authorName === "Claude")).toBe(true);
  const run = await env.DB.prepare("SELECT * FROM ai_teammate_runs WHERE org_id = ?1").bind(ORG).first();
  expect(run).toMatchObject({ status: "idle", cost_cents: 123, remote_id: "sesn_1", last_event_at: "2026-09-30T10:00:06Z" });
  const spent = (await (await get(`/teammates?${q({ orgId: ORG, provider: "claude" })}`, toru)).json()).teammate.spentThisMonth;
  expect(spent).toBe(1.23);

  // A follow-up in the same thread goes to the same session, and only what
  // came after it is posted.
  let followUp = null;
  anthropic().intercept({ path: "/v1/sessions/sesn_1/events?beta=true", method: "POST" }).reply(200, (opts) => { followUp = JSON.parse(opts.body); return { data: [] }; });
  anthropic().intercept({ path: (p) => p.startsWith("/v1/sessions/sesn_1/events?") && p.includes("created_at%5Bgt%5D=2026-09-30T10%3A00%3A06Z"), method: "GET" }).reply(200, {
    data: [
      { id: "e4", type: "user.message", processed_at: "2026-09-30T10:05:00Z", content: [{ type: "text", text: "Mika: also add a test" }] },
      { id: "e5", type: "agent.message", processed_at: "2026-09-30T10:05:09Z", content: [{ type: "text", text: "Added a test to the PR." }] },
      { id: "e6", type: "session.status_idle", processed_at: "2026-09-30T10:05:10Z", stop_reason: { type: "end_turn" } },
    ],
    next_page: null,
  });
  anthropic().intercept({ path: "/v1/sessions/sesn_1?beta=true", method: "GET" }).reply(200, { id: "sesn_1", status: "idle", usage: { list_cost: { amount: "180", currency: "USD" } } });
  await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@claude also add a test", parentId: posted.id });
  expect(followUp.events[0]).toMatchObject({ type: "user.message", content: [{ type: "text", text: "Mika: also add a test" }] });
  const after = (await thread(mika, posted.id)).map((m) => m.body);
  expect(after.slice(-2)).toEqual(["Picking this up where we left off.", "Added a test to the PR."]);
  expect(Number((await env.DB.prepare("SELECT cost_cents FROM ai_teammate_runs WHERE org_id = ?1").bind(ORG).first()).cost_cents)).toBe(180);
});

test("a run still working is left for the minute cron, which posts it once", async () => {
  await launch();
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: "sesn_2", type: "session", status: "running" });
  // Still at work while the request may wait.
  anthropic().intercept({ path: (p) => p.startsWith("/v1/sessions/sesn_2/events?"), method: "GET" }).reply(200, {
    data: [{ id: "e1", type: "agent.message", processed_at: "2026-09-30T10:00:05Z", content: [{ type: "text", text: "Looking at the logs." }] }], next_page: null,
  });
  // The request looks once, and leaves it working.
  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@claude why did last night's deploy fail?" }, { TEAMMATE_WATCH_MS: "0" })).json()).message;
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual(["On it. I'll answer here when I'm done."]);
  // Everything it has said so far is still there for the look that finds it done.
  anthropic().intercept({ path: (p) => p.startsWith("/v1/sessions/sesn_2/events?") && !p.includes("created_at"), method: "GET" }).reply(200, {
    data: [
      { id: "e1", type: "agent.message", processed_at: "2026-09-30T10:00:05Z", content: [{ type: "text", text: "Looking at the logs." }] },
      { id: "e2", type: "agent.message", processed_at: "2026-09-30T10:02:05Z", content: [{ type: "text", text: "The migration timed out on the orders table." }] },
      { id: "e3", type: "session.status_idle", processed_at: "2026-09-30T10:02:06Z", stop_reason: { type: "end_turn" } },
    ],
    next_page: null,
  });
  anthropic().intercept({ path: "/v1/sessions/sesn_2?beta=true", method: "GET" }).reply(200, { id: "sesn_2", usage: { list_cost: { amount: "40", currency: "USD" } } });
  await watchTeammateRuns(env);
  await watchTeammateRuns(env);
  const replies = (await thread(mika, posted.id)).map((m) => m.body);
  expect(replies).toEqual(["On it. I'll answer here when I'm done.", "Looking at the logs.\n\nThe migration timed out on the orders table."]);
});

test("outside its channels, past its limit, or switched off, Claude says so and starts nothing", async () => {
  await launch({ channels: ["b:other"] });
  const say = async (body) => {
    const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body })).json()).message;
    return (await thread(mika, posted.id)).map((m) => m.body);
  };
  expect(await say("@claude look at this")).toEqual(["I'm not set up to work in this channel. An admin can add it in Studio → AI teammates."]);
  // Everywhere, but the month is spent.
  anthropic().intercept({ path: "/v1/agents/agent_1?beta=true", method: "POST" }).reply(200, { id: "agent_1", version: 2 });
  expect((await send("PUT", "/teammates", toru, { orgId: ORG, provider: "claude", channels: null, monthlyLimit: 1 })).status).toBe(200);
  await env.DB.prepare("INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, status, cost_cents, created_at, updated_at) VALUES ('r0', ?1, 'claude', 'b:cafe', 'x', 'sesn_0', 'idle', 99, ?2, ?2)")
    .bind(ORG, new Date().toISOString()).run();
  expect(await say("@claude look at this")).toEqual(["I've reached this workspace's monthly spending limit for me. An admin can raise it in Studio → AI teammates."]);
  // Off: @claude is nobody.
  expect((await send("PUT", "/teammates", toru, { orgId: ORG, provider: "claude", enabled: false })).status).toBe(200);
  expect(await say("@claude look at this")).toEqual([]);
  // A person's own agent cannot be named over it, nor can it be edited as one.
  const agents = (await (await get(`/channels/agents?${q({ orgId: ORG })}`, toru)).json()).agents;
  expect(agents.some((a) => a.handle === "claude")).toBe(false);
});

test("a bad key is said plainly, and nothing is saved as on", async () => {
  anthropic().intercept({ path: "/v1/environments?beta=true", method: "POST" }).reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  const res = await send("PUT", "/teammates", toru, { orgId: ORG, provider: "claude", enabled: true, apiKey: "sk-bad" });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toBe("Anthropic did not accept that API key.");
  const seen = await (await get(`/teammates?${q({ orgId: ORG, provider: "claude" })}`, toru)).json();
  expect(seen.teammate.enabled).toBe(false);
});

test('external teammates receive current room rules on each turn without changing shared configuration or leaking into other rooms',async()=>{
 const {loadTeammate,startTeammateRun}=await import('../src/teammates.js');await launch();
 await env.DB.prepare("INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES (?1,'b:cafe','Cafe rules only',1,'9701',datetime('now'))").bind(ORG).run();
 await env.DB.prepare("INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES ('personal:other-org','b:cafe','Other workspace secret',1,'9701',datetime('now'))").run();
 const t=await loadTeammate(env.DB,ORG,'claude');let first,follow,other;
 anthropic().intercept({path:'/v1/sessions?beta=true',method:'POST'}).reply(200,opts=>{first=JSON.parse(opts.body);return{id:'sesn_rules'}});
 const args={orgId:ORG,t,key:'b:cafe',threadId:'rules-thread',where:'Cafe',askedBy:'Toru',transcript:[],request:'Do the task',login:'toru'};
 await startTeammateRun(env,args);
 expect(first.initial_events[0].content[0].text).toContain('Cafe rules only');expect(first.title).not.toContain('Cafe rules only');expect(first.initial_events[0].content[0].text).not.toContain('Other workspace secret');
 await env.DB.prepare("UPDATE hx_room_guidelines SET body='',version=2 WHERE org_id=?1 AND channel='b:cafe'").bind(ORG).run();
 anthropic().intercept({path:'/v1/sessions/sesn_rules/events?beta=true',method:'POST'}).reply(200,opts=>{follow=JSON.parse(opts.body);return{data:[]}});
 await startTeammateRun(env,{...args,request:'Continue'});
 const text=follow.events[0].content[0].text;expect(text).toContain('revision 2');expect(text).toContain('empty string means no room-specific rules');expect(text).not.toContain('Cafe rules only');
 anthropic().intercept({path:'/v1/sessions?beta=true',method:'POST'}).reply(200,opts=>{other=JSON.parse(opts.body);return{id:'sesn_other'}});
 await startTeammateRun(env,{...args,key:'b:other',threadId:'other-thread'});
 expect(other.initial_events[0].content[0].text).not.toContain('Current room guidelines');
 expect((await loadTeammate(env.DB,ORG,'claude')).instructions).toBe('Keep answers short.');
});

test.each(['active','revoked','agent-deleted'])('delayed webhook teammate completion respects state=%s',async state=>{
 await launch();
 const {createManagedRoom}=await import('../src/harness/roomCreation.js');
 const {createRoomHook,authenticateRoomHook,receiveRoomHookEvent,changeRoomHook}=await import('../src/harness/roomHooks.js');
 const {loadTeammate,startTeammateRun}=await import('../src/teammates.js');
 const channel=(await createManagedRoom(env.DB,ORG,'9701',{requestId:'teammate-hook-room',name:'Webhook events',private:true,guidelines:'',color:'teal',memberRefs:[],agentIds:[]})).room.channel;
 const made=await createRoomHook(env.DB,ORG,channel,'9701','Deploy');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'deploy-1',body:'@claude Review deployment'});
 const t=await loadTeammate(env.DB,ORG,'claude');
 anthropic().intercept({path:'/v1/sessions?beta=true',method:'POST'}).reply(200,{id:'sesn_hook',type:'session',status:'running'});
 const started=await startTeammateRun(env,{orgId:ORG,t,key:channel,threadId:event.messageId,where:'Webhook events',askedBy:'Toru',transcript:[],request:'Review deployment',login:'toru',roomHookSource:event.messageId});
 expect(started.run.room_hook_source).toBe(event.messageId);
 expect((await env.DB.prepare('SELECT room_hook_source FROM ai_teammate_runs WHERE id=?1').bind(started.run.id).first()).room_hook_source).toBe(event.messageId);
 if(state==='revoked')await changeRoomHook(env.DB,ORG,channel,'9701',hook.id,1,'revoke');
 if(state==='agent-deleted')await env.DB.prepare("UPDATE custom_agents SET deleted_at='now' WHERE org_id=?1 AND id=?2").bind(ORG,t.agentId).run();
 anthropic().intercept({path:p=>p.startsWith('/v1/sessions/sesn_hook/events?'),method:'GET'}).reply(200,{data:[
  {id:'hook-e1',type:'agent.message',processed_at:'2026-10-23T00:00:01Z',content:[{type:'text',text:'Deployment reviewed.'}]},
  {id:'hook-e2',type:'session.status_idle',processed_at:'2026-10-23T00:00:02Z',stop_reason:{type:'end_turn'}},
 ],next_page:null});
 anthropic().intercept({path:'/v1/sessions/sesn_hook?beta=true',method:'GET'}).reply(200,{id:'sesn_hook',usage:{list_cost:{amount:'0',currency:'USD'}}});
 await watchTeammateRuns(env,{ids:[started.run.id]});
 const replies=(await env.DB.prepare('SELECT body FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(ORG,event.messageId).all()).results;
 expect(replies).toEqual(state==='active'?[{body:'Deployment reviewed.'}]:[]);
});

test.each(['finish','stop','signout','publication_retry'])('a handed-off external run retains ownership until %s and never replays remote work',async outcome=>{
 await launch();
 const {agent:source}=await(await send('POST','/channels/agents',toru,{orgId:ORG,markdown:'---\nname: Coordinator\nhandle: coordinator\nscope: team\n---\nCoordinate the task.'})).json();
 const target=await env.DB.prepare("SELECT id FROM custom_agents WHERE org_id=?1 AND provider='claude'").bind(ORG).first();
 const {setMode}=await import('../src/harness/mode.js');const {postMessage}=await import('../src/channels.js');const {getSession}=await import('../src/db.js');
 const {beginAuthorizedAssignment,acceptAgentHandoff}=await import('../src/harness/agentAssignmentGrant.js');
 const {runQueuedHandoff,settleHandoff}=await import('../src/harness/agentHandoffRun.js');
 await setMode(env.DB,ORG,'harness','9701');
 for(const id of [source.id,target.id])await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,'b:cafe',?2,'9701','2026-10-24')").bind(ORG,id).run();
 const {row}=await postMessage(env.DB,{orgId:ORG,key:'b:cafe',authorLogin:'mika',body:'@coordinator review the deployment'});
 const begun=await beginAuthorizedAssignment(env,{orgId:ORG,rowId:row.id,token:(await getSession(env.DB,mika)).token},source.id);expect(begun.started).toBe(true);
 expect((await acceptAgentHandoff(env,{orgId:ORG,assignmentId:begun.assignment.id,generation:0,sourceAgentId:source.id,targetAgentId:target.id,operationId:'external-hop',brief:'Investigate the migration and return findings.',messageBody:'Handing off to @claude'})).error).toBeUndefined();
 anthropic().intercept({path:'/v1/sessions?beta=true',method:'POST'}).reply(200,opts=>{
  expect(JSON.parse(opts.body).initial_events[0].content[0].text).toContain('Investigate the migration and return findings.');
  return {id:'external-assigned',type:'session',status:'running'};
 });
 anthropic().intercept({path:p=>p.startsWith('/v1/sessions/external-assigned/events?'),method:'GET'}).reply(200,{data:[],next_page:null});
 const job={orgId:ORG,rowId:'external-hop'};const runtime={...env,AGENT_INLINE:'',TEAMMATE_WATCH_MS:'0'};
 expect(await runQueuedHandoff(runtime,job)).toEqual({status:'awaiting_external',answered:0});
 await settleHandoff(runtime,job,{status:'interrupted'});
 expect(await runQueuedHandoff(runtime,job)).toEqual({status:'awaiting_external',answered:0});
 const remote=await env.DB.prepare('SELECT * FROM ai_teammate_runs WHERE org_id=?1').bind(ORG).first();
 expect(remote).toMatchObject({assignment_id:begun.assignment.id,assignment_generation:1,assignment_agent_id:target.id,status:'running'});
 expect(await env.DB.prepare('SELECT status FROM hx_agent_assignments WHERE id=?1').bind(begun.assignment.id).first()).toEqual({status:'running'});
 if(outcome==='stop')expect((await send('POST','/channels/agent-runs/stop',mika,{orgId:ORG,channel:'b:cafe',messageId:row.id,assignmentId:begun.assignment.id,generation:1})).status).toBe(200);
 if(outcome==='signout'){const {endHere}=await import('../src/sessions.js');await endHere(env,ORG,[(await getSession(env.DB,mika)).token]);}
 anthropic().intercept({path:p=>p.startsWith('/v1/sessions/external-assigned/events?'),method:'GET'}).reply(200,{data:[{id:'answer',type:'agent.message',processed_at:'2026-10-24T10:00:00Z',content:[{type:'text',text:'External assigned result'}]},{id:'done',type:'session.status_idle',processed_at:'2026-10-24T10:00:01Z',stop_reason:{type:'end_turn'}}],next_page:null});
 anthropic().intercept({path:'/v1/sessions/external-assigned?beta=true',method:'GET'}).reply(200,{id:'external-assigned',usage:{list_cost:{amount:'20',currency:'USD'}}});
 if(outcome==='publication_retry')await env.DB.exec("CREATE TRIGGER fail_assignment_end BEFORE UPDATE ON hx_agent_assignments WHEN NEW.status='finished' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 await watchTeammateRuns(runtime);
 if(outcome==='publication_retry') {
  expect(await env.DB.prepare('SELECT status FROM hx_agent_assignments WHERE id=?1').bind(begun.assignment.id).first()).toEqual({status:'running'});
  await settleHandoff(runtime,job,{status:'interrupted'});
  expect(await env.DB.prepare('SELECT status FROM hx_agent_assignments WHERE id=?1').bind(begun.assignment.id).first()).toEqual({status:'running'});
  await env.DB.exec('DROP TRIGGER fail_assignment_end');
  await env.DB.prepare('UPDATE ai_teammate_result_dispatch SET next_attempt=0 WHERE run_id=?1').bind(remote.id).run();
 }
 await watchTeammateRuns(runtime);await watchTeammateRuns(runtime);
 const finished=outcome==='finish'||outcome==='publication_retry';
 const replies=(await env.DB.prepare("SELECT body FROM channel_messages WHERE org_id=?1 AND body='External assigned result'").bind(ORG).all()).results;
 expect(replies).toHaveLength(finished?1:0);
 expect(await env.DB.prepare('SELECT status FROM hx_agent_assignments WHERE id=?1').bind(begun.assignment.id).first()).toEqual({status:finished?'finished':'cancelled'});
 expect(await env.DB.prepare('SELECT status,payload FROM ai_teammate_result_dispatch WHERE run_id=?1').bind(remote.id).first()).toEqual({status:finished?'published':'cancelled',payload:null});
});

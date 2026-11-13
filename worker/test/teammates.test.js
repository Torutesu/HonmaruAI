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

test('a workspace ACP teammate queues prompts for a node without sending host launch settings',async()=>{
 const registered=await send('POST','/gateways',toru,{orgId:ORG,name:'Mac mini'});
 expect(registered.status).toBe(201);const {gateway,token}=await registered.json();
 const ready=await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({capabilities:['acp-v1'],acpAgents:['codex-local']})}),env,ctx);
 expect((await ready.json()).job).toBeNull();
 const configured=await send('PUT','/teammates',toru,{orgId:ORG,provider:'acp',enabled:true,gatewayId:gateway.id,agentKey:'codex-local'});
 expect(configured.status).toBe(200);
 const teammate=(await configured.json()).teammate;
 expect(teammate).toMatchObject({provider:'acp',enabled:true,ready:true,hasKey:true,gatewayId:gateway.id,agentKey:'codex-local',unit:'task',workspaceTools:false});
 expect(JSON.stringify(teammate)).not.toContain(token);
 const message=(await (await send('POST','/channels/messages',toru,{orgId:ORG,channel:'b:cafe',body:`@${teammate.handle} review this repository`},{TEAMMATE_WATCH_MS:'0'})).json()).message;
 const run=await env.DB.prepare("SELECT * FROM ai_teammate_runs WHERE org_id=?1 AND provider='acp'").bind(ORG).first();
 expect(run.status).toBe('running');
 const job=await env.DB.prepare('SELECT id,payload FROM hx_gateway_jobs WHERE org_id=?1 AND gateway_id=?2').bind(ORG,gateway.id).first();
 const payload=JSON.parse(job.payload);
 expect(payload).toMatchObject({acp:true,agentKey:'codex-local'});
 expect(payload.prompt).toContain('review this repository');
 for(const forbidden of ['command','args','cwd','env','mcpServers'])expect(payload).not.toHaveProperty(forbidden);
 const nodeClaim=await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({capabilities:['acp-v1'],acpAgents:['codex-local']})}),env,ctx);
 const claimed=(await nodeClaim.json()).job;
 expect(claimed.id).toBe(job.id);
 const progressEvents=[];
 const relay={idFromName:name=>name,get:()=>({fetch:async(_url,init)=>{const body=JSON.parse(init.body);progressEvents.push(...(body.events||(body.deliveries||[]).map(item=>item.event)));return new Response('ok');}})};
 const progressResponse=await worker.fetch(new Request(`https://example.com/gateways/jobs/${job.id}/progress`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({lease:claimed.lease,progress:{kind:'tool',title:'Run focused checks',status:'in_progress'}})}),env,ctx);
 expect(progressResponse.status).toBe(200);
 await watchTeammateRuns({...env,ORG_RELAY:relay},{ids:[run.id],deadline:Date.now()});
 expect(progressEvents.some(event=>event.name==='channel_ai_progress'&&event.value?.step==='agent_progress'&&event.value?.activity?.title==='Run focused checks')).toBe(true);
 const finished=await worker.fetch(new Request(`https://example.com/gateways/jobs/${job.id}/finish`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({lease:claimed.lease,status:'succeeded',stdout:JSON.stringify({text:'Reviewed the local repository.',sessionId:'acp-session-1',stopReason:'end_turn'}),stderr:'',exitCode:0})}),env,ctx);
 expect(finished.status).toBe(200);
 await watchTeammateRuns(env,{ids:[run.id],deadline:Date.now()});
 expect((await thread(toru,message.id)).map(reply=>reply.body).slice(-1)).toEqual(['Reviewed the local repository.']);
 expect(await env.DB.prepare('SELECT status,remote_turn FROM ai_teammate_runs WHERE id=?').bind(run.id).first()).toEqual({status:'idle',remote_turn:'acp-session-1'});
 expect(message.body).toContain(teammate.handle);

 // Workspace access stays off until an administrator deliberately enables it.
 await send('PUT','/orgs/mode',toru,{orgId:ORG,mode:'harness'});
 const enabled=await send('PUT','/teammates',toru,{orgId:ORG,provider:'acp',enabled:true,gatewayId:gateway.id,agentKey:'codex-local',workspaceTools:true});
 expect(enabled.status).toBe(200);
 expect((await enabled.json()).teammate.workspaceTools).toBe(true);
 const saved=await env.DB.prepare("SELECT remote FROM ai_teammates WHERE org_id=?1 AND provider='acp'").bind(ORG).first();
 expect(JSON.parse(saved.remote).workspaceTools).toBe(true);
});

test('Grok Bot routine returns a thread task through the one-time completion MCP tool', async () => {
  const dataKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const pool = fetchMock.get('https://routine.example.com');
  let delivered = null;
  pool.intercept({ path: '/hooks/routine-1', method: 'POST', headers: { authorization: 'Bearer routine-secret' } }).reply((opts) => {
    delivered = JSON.parse(opts.body);
    return { data: { accepted: true } };
  });
  const saved = await send('PUT', '/teammates', toru, {
    orgId: ORG, provider: 'grok-bot', enabled: true, webhookUrl: 'https://routine.example.com/hooks/routine-1', apiKey: 'routine-secret',
  }, { DATA_KEY: dataKey });
  expect(saved.status).toBe(200);
  const teammate = (await saved.json()).teammate;
  expect(teammate).toMatchObject({ provider: 'grok-bot', enabled: true, hasKey: true, hasApiKey: true, webhookUrl: 'https://routine.example.com/hooks/routine-1' });
  expect(JSON.stringify(teammate)).not.toContain('routine-secret');
  const stored = await env.DB.prepare("SELECT api_key,remote FROM ai_teammates WHERE org_id=?1 AND provider='grok-bot'").bind(ORG).first();
  expect(stored.api_key).toMatch(/^enc:v2:/);
  expect(JSON.parse(stored.remote).webhookUrl).toMatch(/^enc:v2:/);
  const memberView = await (await call(`/teammates?${q({ orgId: ORG, provider: 'grok-bot' })}`, { headers: headers(mika) }, { DATA_KEY: dataKey })).json();
  expect(memberView.teammate.webhookUrl).toBe('');
  expect(memberView.teammate.completionMcpUrl).toBe('');
  expect(JSON.stringify(memberView)).not.toContain('routine-secret');
  const loaded = await (await call(`/teammates?${q({ orgId: ORG, provider: 'grok-bot' })}`, { headers: headers(toru) }, { DATA_KEY: dataKey, API_ORIGIN: 'https://example.com' })).json();
  expect(loaded.teammate.webhookUrl).toBe('https://routine.example.com/hooks/routine-1');
  expect(loaded.teammate.completionMcpUrl).toBe('https://example.com/teammates/grok-bot/mcp');
  const registeredAgent = await env.DB.prepare("SELECT * FROM custom_agents WHERE org_id=?1 AND provider='grok-bot' AND deleted_at IS NULL").bind(ORG).first();
  const { teammateForAgent } = await import('../src/teammates.js');
  expect((await teammateForAgent(env.DB, ORG, registeredAgent, { ...env, DATA_KEY: dataKey })).remote.webhookUrl).toBe('https://routine.example.com/hooks/routine-1');

  const message = (await (await send('POST', '/channels/messages', toru, {
    orgId: ORG, channel: 'b:cafe', body: '@grok-bot summarize this thread',
  }, { DATA_KEY: dataKey, API_ORIGIN: 'https://example.com', TEAMMATE_WATCH_MS: '0' })).json()).message;
  expect(delivered).toMatchObject({ task: expect.stringContaining('summarize this thread') });
  expect(delivered.completion).toMatchObject({ mcp_server: 'https://example.com/teammates/grok-bot/mcp', tool: 'honmaru_complete_grok_bot_task', task_id: delivered.task_id });
  expect(delivered.completion.token).toMatch(/^[A-Za-z0-9_-]{40,60}$/);
  expect(delivered.completion_instruction).toContain('call the named Honmaru MCP tool exactly once');
  expect(JSON.stringify(delivered)).not.toContain('routine-secret');
  const run = await env.DB.prepare("SELECT * FROM ai_teammate_runs WHERE org_id=?1 AND provider='grok-bot'").bind(ORG).first();
  expect(run).toMatchObject({ status: 'running', remote_id: delivered.task_id });

  const mcpPath = '/teammates/grok-bot/mcp';
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const preflight = await call(mcpPath, { method: 'OPTIONS' });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
  const initialized = await call(mcpPath, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })) });
  expect(initialized.status).toBe(200);
  expect(await initialized.json()).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } } } });
  const tools = await call(mcpPath, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(rpc(2, 'tools/list')) });
  expect(await tools.json()).toMatchObject({ result: { tools: [{ name: 'honmaru_complete_grok_bot_task' }] } });
  const args = { task_id: delivered.completion.task_id, token: delivered.completion.token, status: 'succeeded', text: 'The thread is about the launch checklist.' };
  const invoke = (arguments_) => call(mcpPath, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(rpc(3, 'tools/call', { name: 'honmaru_complete_grok_bot_task', arguments: arguments_ })) }, { DATA_KEY: dataKey });
  expect((await (await invoke({ ...args, token: `${args.token}wrong` })).json()).result.isError).toBe(true);
  expect((await (await invoke(args)).json()).result.isError).toBe(false);
  expect((await (await invoke(args)).json()).result.isError).toBe(true);

  await watchTeammateRuns(env, { ids: [run.id], deadline: Date.now() });
  const replies = await thread(toru, message.id);
  expect(replies.map(reply => reply.body).slice(-1)).toEqual(['The thread is about the launch checklist.']);
  expect((await env.DB.prepare('SELECT status FROM ai_teammate_runs WHERE id=?').bind(run.id).first()).status).toBe('idle');
});

test.each([
 ['hermes','Hermes','hermes'],
 ['grok-build','Grok Build','grok-build'],
 ['antigravity-cli','Antigravity CLI','antigravity'],
])('%s is a separate local ACP teammate with its own handle and allowlist key',async(provider,name,handle)=>{
 const registered=await send('POST','/gateways',toru,{orgId:ORG,name:'Mac mini'});
 expect(registered.status).toBe(201);const {gateway,token}=await registered.json();
 const agentKey=`${handle}-local`;
 const ready=await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({capabilities:['acp-v1'],acpAgents:[agentKey]})}),env,ctx);
 expect((await ready.json()).job).toBeNull();
 const configured=await send('PUT','/teammates',toru,{orgId:ORG,provider,enabled:true,gatewayId:gateway.id,agentKey,workspaceTools:true});
 expect(configured.status).toBe(200);
 const teammate=(await configured.json()).teammate;
 expect(teammate).toMatchObject({provider,name,handle,enabled:true,ready:true,hasKey:true,gatewayId:gateway.id,agentKey,unit:'task',workspaceTools:true});
 const sent=await send('POST','/channels/messages',toru,{orgId:ORG,channel:'b:cafe',body:`@${handle} inspect the current project`},{TEAMMATE_WATCH_MS:'0'});
 expect(sent.status).toBe(201);
 const run=await env.DB.prepare('SELECT provider,status FROM ai_teammate_runs WHERE org_id=?1 AND provider=?2').bind(ORG,provider).first();
 expect(run).toMatchObject({provider,status:'running'});
 const job=await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE org_id=?1 AND gateway_id=?2').bind(ORG,gateway.id).first();
 expect(JSON.parse(job.payload)).toMatchObject({acp:true,agentKey,prompt:expect.stringContaining('inspect the current project')});
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
  expect(replies.map((m) => m.body)).toEqual(["Fixed the login redirect. PR: https://github.com/acme/app/pull/7"]);
  expect(replies.every((m) => m.kind === "agent" && m.authorName === "Claude")).toBe(true);
  const completion = replies[0];
  const pushed = await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2").bind(ORG, completion.id).all();
  expect(pushed.results).toEqual([{ login: "mika", reason: "thread" }]);
  const activity = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  expect(activity.items.map((item) => item.message.id)).toContain(completion.id);
  expect(activity.items.some((item) => item.message.body.includes("On it. I'll answer"))).toBe(false);
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
  expect(after.slice(-1)).toEqual(["Added a test to the PR."]);
  expect(Number((await env.DB.prepare("SELECT cost_cents FROM ai_teammate_runs WHERE org_id = ?1").bind(ORG).first()).cost_cents)).toBe(180);
});

test('stopping an assignment interrupts only the exact Claude session and generation',async()=>{
 await launch();
 const {cancelAssignedTeammateRuns}=await import('../src/teammates.js');
 await env.DB.prepare(`INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,created_at,updated_at,assignment_id,assignment_generation)
   VALUES ('remote-current',?1,'claude','b:cafe','thread','sesn_current','running','2026-10-26','2026-10-26','assignment-stop',3),
          ('remote-stale',?1,'claude','b:cafe','thread','sesn_stale','running','2026-10-25','2026-10-25','assignment-stop',2)`).bind(ORG).run();
 let sent;
 anthropic().intercept({path:'/v1/sessions/sesn_current/events?beta=true',method:'POST'}).reply(200,opts=>{sent=JSON.parse(opts.body);return {data:[{type:'user.interrupt'}]};});
 const result=await cancelAssignedTeammateRuns(env,{orgId:ORG,assignmentId:'assignment-stop',generation:3});
 expect(result).toEqual({status:'requested'});
 expect(sent).toEqual({events:[{type:'user.interrupt'}]});
});

test('stopping a Cursor assignment calls the provider run cancel endpoint',async()=>{
 const cursorApi=fetchMock.get('https://api.cursor.com');
 cursorApi.intercept({path:'/v1/me',method:'GET'}).reply(200,{id:'user'});
 expect((await send('PUT','/teammates',toru,{orgId:ORG,provider:'cursor',enabled:true,apiKey:'cursor-test-key',repos:['acme/app']})).status).toBe(200);
 await env.DB.prepare(`INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,remote_turn,status,created_at,updated_at,assignment_id,assignment_generation)
   VALUES ('cursor-run',?1,'cursor','b:cafe','thread','cursor-agent','cursor-turn','running','2026-10-26','2026-10-26','cursor-assignment',4)`).bind(ORG).run();
 let called=false;
 cursorApi.intercept({path:'/v1/agents/cursor-agent/runs/cursor-turn/cancel',method:'POST'}).reply(200,()=>{called=true;return {id:'cursor-turn'};});
 const {cancelAssignedTeammateRuns}=await import('../src/teammates.js');
 const result=await cancelAssignedTeammateRuns(env,{orgId:ORG,assignmentId:'cursor-assignment',generation:4});
 expect(result).toEqual({status:'requested'});expect(called).toBe(true);
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
  expect((await thread(mika, posted.id)).map((m) => m.body)).toEqual([]);
  const activityWhileRunning = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  expect(activityWhileRunning.items.some((item) => item.message.body.includes("On it. I'll answer"))).toBe(false);
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
  expect(replies).toEqual(["Looking at the logs.\n\nThe migration timed out on the orders table."]);
});

test.each(["simple", "harness"])('%s agent completion keeps mention/read preferences without a progress reply', async (mode) => {
  await launch();
  const { setMode } = await import("../src/harness/mode.js");
  const { setChannelPref } = await import("../src/people.js");
  await setMode(env.DB, ORG, mode, "9701");
  await setChannelPref(env.DB, { orgId: ORG, login: "mika", key: "b:cafe", level: "mentions" });
  await setChannelPref(env.DB, { orgId: ORG, login: "toru", key: "b:cafe", level: "mentions" });
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: `sesn_${mode}`, type: "session", status: "running" });
  anthropic().intercept({ path: (path) => path.startsWith(`/v1/sessions/sesn_${mode}/events?`), method: "GET" }).reply(200, {
    data: [
      { id: "answer", type: "agent.message", processed_at: "2026-11-07T10:00:05Z", content: [{ type: "text", text: "@Toru the deployment is healthy." }] },
      { id: "done", type: "session.status_idle", processed_at: "2026-11-07T10:00:06Z", stop_reason: { type: "end_turn" } },
    ], next_page: null,
  });
  anthropic().intercept({ path: `/v1/sessions/sesn_${mode}?beta=true`, method: "GET" }).reply(200, { id: `sesn_${mode}`, status: "idle", usage: { list_cost: { amount: "10", currency: "USD" } } });

  const posted = (await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:cafe", body: "@claude check deployment" })).json()).message;
  const replies = await thread(mika, posted.id);
  expect(replies.map((reply) => reply.body)).toEqual(["@Toru the deployment is healthy."]);
  const completion = replies[0];
  const queue = await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2 ORDER BY login").bind(ORG, completion.id).all();
  // Mika's mentions-only preference suppresses the ordinary thread reply;
  // Toru is still notified because the final reply explicitly names him.
  expect(queue.results).toEqual([{ login: "toru", reason: "mention" }]);
  const activityForMika = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  const activityForToru = await (await get(`/channels/activity?${q({ orgId: ORG })}`, toru)).json();
  expect(activityForMika.items.some((item) => item.message.id === completion.id && item.type === "reply")).toBe(true);
  expect(activityForToru.items.some((item) => item.message.id === completion.id && item.type === "mention")).toBe(true);
  expect(activityForMika.items.some((item) => item.message.body.includes("On it. I'll answer"))).toBe(false);
});

test("a Harness DM uses live progress, while only the final reply creates Activity and direct notifications", async () => {
  await launch();
  const { setMode } = await import("../src/harness/mode.js");
  const { setChannelPref } = await import("../src/people.js");
  await setMode(env.DB, ORG, "harness", "9701");
  await setChannelPref(env.DB, { orgId: ORG, login: "mika", key: "dm:mika|toru", level: "mute" });
  await setChannelPref(env.DB, { orgId: ORG, login: "toru", key: "dm:mika|toru", level: "mentions" });
  const { memberRef } = await import("../src/team.js");
  const toruRef = await memberRef(ORG, "9701");
  const events = [];
  const relay = { idFromName: (name) => name, get: () => ({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    events.push(...(body.events || (body.deliveries || []).map((item) => item.event)));
    return new Response("ok");
  } }) };
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: "sesn_harness_dm", type: "session", status: "running" });
  anthropic().intercept({ path: (path) => path.startsWith("/v1/sessions/sesn_harness_dm/events?"), method: "GET" }).reply(200, {
    data: [
      { id: "answer", type: "agent.message", processed_at: "2026-11-07T10:00:05Z", content: [{ type: "text", text: "@Toru I found the cause." }] },
      { id: "done", type: "session.status_idle", processed_at: "2026-11-07T10:00:06Z", stop_reason: { type: "end_turn" } },
    ], next_page: null,
  });
  anthropic().intercept({ path: "/v1/sessions/sesn_harness_dm?beta=true", method: "GET" }).reply(200, { id: "sesn_harness_dm", status: "idle", usage: { list_cost: { amount: "10", currency: "USD" } } });

  const response = await send("POST", "/channels/messages", mika, { orgId: ORG, channel: `dm:${toruRef}`, body: "@claude investigate the alert" }, { ORG_RELAY: relay });
  expect(response.status).toBe(201);
  const root = (await response.json()).message;
  const replies = await env.DB.prepare("SELECT id, body, kind FROM channel_messages WHERE org_id=?1 AND channel='dm:mika|toru' AND parent_id=?2 ORDER BY created_at").bind(ORG, root.id).all();
  expect(replies.results).toHaveLength(1);
  expect(replies.results[0]).toMatchObject({ body: "@Toru I found the cause.", kind: "agent" });
  expect(events.some((event) => event.name === "channel_ai_progress" && event.value?.step === "agent")).toBe(true);
  expect(events.some((event) => event.name === "channel_message" && event.value?.message?.parentId === root.id && event.value?.message?.body.includes("On it. I'll answer"))).toBe(false);
  const queue = await env.DB.prepare("SELECT login, reason FROM push_queue WHERE org_id=?1 AND message_id=?2 ORDER BY login").bind(ORG, replies.results[0].id).all();
  expect(queue.results).toEqual([{ login: "toru", reason: "direct" }]);
  const activityForMika = await (await get(`/channels/activity?${q({ orgId: ORG })}`, mika)).json();
  const activityForToru = await (await get(`/channels/activity?${q({ orgId: ORG })}`, toru)).json();
  expect(activityForMika.items.some((item) => item.message.id === replies.results[0].id && item.type === "reply")).toBe(true);
  expect(activityForToru.items.some((item) => item.message.id === replies.results[0].id && item.type === "mention")).toBe(true);
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
 const text=follow.events[0].content[0].text;expect(text).toContain('revision 2');expect(text).toContain('empty string means this Room has no specific rules');expect(text).not.toContain('Cafe rules only');
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
 if(outcome==='stop'){
  let stopEvent;
  anthropic().intercept({path:'/v1/sessions/external-assigned/events?beta=true',method:'POST'}).reply(200,opts=>{stopEvent=JSON.parse(opts.body);return {data:[{type:'user.interrupt'}]};});
  const response=await send('POST','/channels/agent-runs/stop',mika,{orgId:ORG,channel:'b:cafe',messageId:row.id,assignmentId:begun.assignment.id,generation:1});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({stopped:true,remoteStop:'requested'});expect(stopEvent).toEqual({events:[{type:'user.interrupt'}]});
  expect(await env.DB.prepare('SELECT remote_stop_status FROM hx_agent_assignments WHERE id=?1').bind(begun.assignment.id).first()).toEqual({remote_stop_status:'requested'});
  const {agentRunSnapshot}=await import('../src/harness/agentRunSnapshot.js');
  expect((await agentRunSnapshot(env,ORG,[row.id],{actorId:'9702',login:'mika'})).results[0].assignments[0]).toMatchObject({status:'cancelled',providerStopStatus:'requested'});
  const retry=await send('POST','/channels/agent-runs/stop',mika,{orgId:ORG,channel:'b:cafe',messageId:row.id,assignmentId:begun.assignment.id,generation:1});
  expect(await retry.json()).toEqual({stopped:true,remoteStop:'requested'});
 }
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

test.each([['active',true],['revoked',false]])('an external Harness Agent handoff to a %s local Agent is checked at completion',async(_state,eligible)=>{
 await launch();
 const {agent:source}=await(await send('POST','/channels/agents',toru,{orgId:ORG,markdown:'---\nname: Coordinator\nhandle: coordinator\nscope: team\n---\nCoordinate the task.'})).json();
 const {agent:reviewer}=await(await send('POST','/channels/agents',toru,{orgId:ORG,markdown:'---\nname: Reviewer\nhandle: reviewer\nscope: team\n---\nReview the handoff.'})).json();
 const external=await env.DB.prepare("SELECT id FROM custom_agents WHERE org_id=?1 AND provider='claude'").bind(ORG).first();
 const {setMode}=await import('../src/harness/mode.js');const {postMessage}=await import('../src/channels.js');const {getSession}=await import('../src/db.js');
 const {beginAuthorizedAssignment,acceptAgentHandoff}=await import('../src/harness/agentAssignmentGrant.js');
 const {runQueuedHandoff}=await import('../src/harness/agentHandoffRun.js');
 await setMode(env.DB,ORG,'harness','9701');
 for(const id of [source.id,reviewer.id,external.id])await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,'b:cafe',?2,'9701','2026-10-24')").bind(ORG,id).run();
 const {row}=await postMessage(env.DB,{orgId:ORG,key:'b:cafe',authorLogin:'mika',body:'@coordinator review the deployment'});
 const begun=await beginAuthorizedAssignment(env,{orgId:ORG,rowId:row.id,token:(await getSession(env.DB,mika)).token},source.id);
 expect(begun.started).toBe(true);
 expect((await acceptAgentHandoff(env,{orgId:ORG,assignmentId:begun.assignment.id,generation:0,sourceAgentId:source.id,targetAgentId:external.id,operationId:'external-source-hop',brief:'Investigate the deployment.',messageBody:'Handing off to @claude'})).error).toBeUndefined();
 const queued=[];
 const runner={idFromName:name=>name,get:()=>({fetch:async(_url,init)=>{queued.push(JSON.parse(init.body));return new Response('Queued',{status:202})}})};
 anthropic().intercept({path:'/v1/sessions?beta=true',method:'POST'}).reply(200,opts=>{
  const request=JSON.parse(opts.body).initial_events[0].content[0].text;
  expect(request).toContain('[[HONMARU_HANDOFF:');expect(request).toContain(reviewer.id);expect(request).toContain('@reviewer');
  expect(request).not.toContain(source.id);expect(request).not.toContain(external.id);
  return {id:'external-local-handoff',type:'session',status:'running'};
 });
 anthropic().intercept({path:p=>p.startsWith('/v1/sessions/external-local-handoff/events?'),method:'GET'}).reply(200,{data:[],next_page:null});
 anthropic().intercept({path:p=>p.startsWith('/v1/sessions/external-local-handoff/events?'),method:'GET'}).reply(200,{data:[
  {id:'handoff-answer',type:'agent.message',processed_at:'2026-10-24T10:00:00Z',content:[{type:'text',text:`I found the deployment risk.\n[[HONMARU_HANDOFF:{"targetAgentId":"${reviewer.id}","brief":"Review the deployment risk and recommend the safest next step."}]]`}]},
  {id:'handoff-done',type:'session.status_idle',processed_at:'2026-10-24T10:00:01Z',stop_reason:{type:'end_turn'}},
 ],next_page:null});
 anthropic().intercept({path:'/v1/sessions/external-local-handoff?beta=true',method:'GET'}).reply(200,{id:'external-local-handoff',usage:{list_cost:{amount:'0',currency:'USD'}}});
 const runtime={...env,AGENT_RUNNER:runner,AGENT_INLINE:'',TEAMMATE_WATCH_MS:'0'};
 expect(await runQueuedHandoff(runtime,{orgId:ORG,rowId:'external-source-hop'})).toEqual({status:'awaiting_external',answered:0});
 if(!eligible)await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1 AND channel='b:cafe' AND agent_id=?2").bind(ORG,reviewer.id).run();
 const {watchTeammateRuns}=await import('../src/channelRoutes.js');
 await watchTeammateRuns(runtime);
 // A remote Agent may keep its existing room handoff path, but waking a
 // local managed Agent now waits for the requester's private approval card.
 expect(queued).toHaveLength(0);
 const assignment=await env.DB.prepare('SELECT current_agent_id,generation,status FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(ORG,begun.assignment.id).first();
 if(eligible) {
  expect(assignment).toEqual({current_agent_id:external.id,generation:1,status:'running'});
  const approval=await env.DB.prepare("SELECT status,target_agent_id,brief FROM hx_agent_wake_approvals WHERE org_id=?1 AND assignment_id=?2").bind(ORG,begun.assignment.id).first();
  expect(approval).toEqual({status:'pending',target_agent_id:reviewer.id,brief:'Review the deployment risk and recommend the safest next step.'});
  expect((await env.DB.prepare("SELECT body FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND kind='agent' ORDER BY created_at,id").bind(ORG,row.id).all()).results.map(item=>item.body)).toEqual(['Handing off to @claude']);
 } else {
  expect(assignment).toEqual({current_agent_id:external.id,generation:1,status:'finished'});
  expect((await env.DB.prepare("SELECT body FROM channel_messages WHERE org_id=?1 AND parent_id=?2 AND kind='agent' ORDER BY created_at,id").bind(ORG,row.id).all()).results.map(item=>item.body)).toEqual([
   'Handing off to @claude',"I found the deployment risk.\n\nI couldn't hand this task to the requested Agent because it is no longer available. No transfer was made.",
  ]);
 }
 const result=await env.DB.prepare('SELECT status,payload FROM ai_teammate_result_dispatch WHERE run_id=(SELECT id FROM ai_teammate_runs WHERE remote_id=\'external-local-handoff\')').first();
 expect(result.status).toBe(eligible?'pending':'published');
 if(eligible)expect(result.payload).toEqual(expect.any(String));else expect(result.payload).toBeNull();
});

test("two mentions arriving together in one thread start one paid run, not two", async () => {
  const { loadTeammate, startTeammateRun } = await import("../src/teammates.js");
  await launch();
  const t = await loadTeammate(env.DB, ORG, "claude");
  // One start answered, slowly. A second paid start finds no interceptor
  // and throws, so it shows as a rejection below.
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: "sesn_race_1" }).delay(50);
  const args = { orgId: ORG, t, key: "b:cafe", threadId: "race-thread", where: "Cafe", askedBy: "Toru", transcript: [], request: "Do the task", login: "toru" };
  const settled = await Promise.allSettled([startTeammateRun(env, args), startTeammateRun(env, { ...args, request: "And this" })]);
  expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  const results = settled.map((r) => r.value);
  expect(results.filter((r) => r.run)).toHaveLength(1);
  expect(results.filter((r) => r.refused === "busy")).toHaveLength(1);
  const rows = (await env.DB.prepare("SELECT status, remote_id FROM ai_teammate_runs WHERE org_id = ?1 AND thread_id = 'race-thread'").bind(ORG).all()).results;
  expect(rows).toEqual([{ status: "running", remote_id: "sesn_race_1" }]);
});

test("a failed lookup starts nothing, and a failed start leaves no run so the next mention can start one", async () => {
  const { loadTeammate, startTeammateRun } = await import("../src/teammates.js");
  await launch();
  const t = await loadTeammate(env.DB, ORG, "claude");
  const args = { orgId: ORG, t, key: "b:cafe", threadId: "fragile-thread", where: "Cafe", askedBy: "Toru", transcript: [], request: "Do the task", login: "toru" };
  // The thread's run cannot be looked up: an error, not "no run". No start
  // is answered yet, so one attempted here would fail differently.
  const realPrepare = env.DB.prepare.bind(env.DB);
  let failed = false;
  const db = new Proxy(env.DB, { get(target, prop) {
    if (prop === "prepare") return (sql) => {
      if (failed || !/^SELECT \* FROM ai_teammate_runs WHERE org_id = \?1 AND provider = \?2 AND channel = \?3 AND thread_id = \?4/.test(sql)) return realPrepare(sql);
      failed = true;
      return { bind: () => ({ first: async () => { throw new Error("D1 hiccup"); } }) };
    };
    const v = target[prop];
    return typeof v === "function" ? v.bind(target) : v;
  } });
  await expect(startTeammateRun({ ...env, DB: db }, args)).rejects.toThrow("D1 hiccup");
  // The provider refuses the start: no run is left holding the thread.
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(400, { type: "error", error: { type: "invalid_request_error", message: "no" } });
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: "sesn_fragile" });
  await expect(startTeammateRun(env, args)).rejects.toThrow();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_teammate_runs WHERE org_id = ?1 AND thread_id = 'fragile-thread'").bind(ORG).first()).n).toBe(0);
  const next = await startTeammateRun(env, args);
  expect(next.run.remote_id).toBe("sesn_fragile");
});

test("two starts at the edge of the monthly limit do not both go ahead", async () => {
  const { loadTeammate, startTeammateRun } = await import("../src/teammates.js");
  await launch();
  // Room for one more run: 50¢ left of a $10 month.
  await env.DB.prepare("UPDATE ai_teammates SET monthly_limit_cents = 1000 WHERE org_id = ?1 AND provider = 'claude'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, status, cost_cents, created_at, updated_at) VALUES ('spent', ?1, 'claude', 'b:cafe', 'old', 'sesn_old', 'idle', 950, ?2, ?2)")
    .bind(ORG, new Date().toISOString()).run();
  const t = await loadTeammate(env.DB, ORG, "claude");
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: "sesn_edge" }).delay(50);
  const args = { orgId: ORG, t, key: "b:cafe", where: "Cafe", askedBy: "Toru", transcript: [], request: "Do the task", login: "toru" };
  const settled = await Promise.allSettled([startTeammateRun(env, { ...args, threadId: "edge-a" }), startTeammateRun(env, { ...args, threadId: "edge-b" })]);
  expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  const results = settled.map((r) => r.value);
  expect(results.filter((r) => r.run)).toHaveLength(1);
  expect(results.filter((r) => r.refused === "limit")).toHaveLength(1);
});

test("a start whose request died holds its place in the month only while its hold lasts", async () => {
  const { loadTeammate, startTeammateRun, spentThisMonth } = await import("../src/teammates.js");
  await launch();
  await env.DB.prepare("UPDATE ai_teammates SET monthly_limit_cents = 1000 WHERE org_id = ?1 AND provider = 'claude'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, status, cost_cents, created_at, updated_at) VALUES ('spent', ?1, 'claude', 'b:cafe', 'old', 'sesn_old', 'idle', 950, ?2, ?2)")
    .bind(ORG, new Date().toISOString()).run();
  // A reservation left twenty minutes ago by a start that never finished.
  const crashed = new Date(Date.now() - 20 * 60000).toISOString();
  await env.DB.prepare("INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, status, cost_cents, created_at, updated_at) VALUES ('crashed', ?1, 'claude', 'b:cafe', 'gone', '', 'starting', 50, ?2, ?2)")
    .bind(ORG, crashed).run();
  expect(await spentThisMonth(env.DB, ORG, "claude")).toBe(950);
  const t = await loadTeammate(env.DB, ORG, "claude");
  anthropic().intercept({ path: "/v1/sessions?beta=true", method: "POST" }).reply(200, { id: "sesn_after_crash" });
  const args = { orgId: ORG, t, key: "b:cafe", where: "Cafe", askedBy: "Toru", transcript: [], request: "Do the task", login: "toru" };
  const started = await startTeammateRun(env, { ...args, threadId: "after-crash" });
  expect(started.run?.remote_id).toBe("sesn_after_crash");
  // One still within its hold counts: the month is full again.
  await env.DB.prepare("INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, status, cost_cents, created_at, updated_at) VALUES ('fresh', ?1, 'claude', 'b:cafe', 'busy', '', 'starting', 50, ?2, ?2)")
    .bind(ORG, new Date().toISOString()).run();
  expect(await startTeammateRun(env, { ...args, threadId: "too-late" })).toEqual({ refused: "limit" });
});

test("the minute cron reaches every running run in turn, not only the oldest", async () => {
  const { openRuns } = await import("../src/teammates.js");
  const base = Date.parse("2026-09-30T00:00:00Z");
  // Sixty runs at work across two workspaces, none of them finishing.
  for (let i = 0; i < 60; i++) {
    const at = new Date(base + i * 60000).toISOString();
    await env.DB.prepare("INSERT INTO ai_teammate_runs (id, org_id, provider, channel, thread_id, remote_id, status, created_at, updated_at) VALUES (?1, ?2, 'claude', 'b:cafe', ?3, ?4, 'running', ?5, ?5)")
      .bind(`run-${String(i).padStart(2, "0")}`, i % 2 ? ORG : "personal:teammates-other", `thread-${i}`, `sesn_${i}`, at).run();
  }
  const seen = new Set();
  for (let tick = 0; tick < 3; tick++) {
    const runs = await openRuns(env.DB, { limit: 25, now: new Date(base + 86400000 + tick * 60000) });
    expect(runs.length).toBeLessThanOrEqual(25);
    for (const run of runs) seen.add(run.id);
  }
  expect(seen.size).toBe(60);
  // A run that has finished is no longer read.
  await env.DB.prepare("UPDATE ai_teammate_runs SET status = 'idle' WHERE id = 'run-59' AND org_id = ?1").bind(ORG).run();
  const next = await openRuns(env.DB, { limit: 60, now: new Date(base + 2 * 86400000) });
  expect(next.map((r) => r.id)).not.toContain("run-59");
  expect(next).toHaveLength(59);
});

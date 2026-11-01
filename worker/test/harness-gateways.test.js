import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { expireGatewayJobs } from '../src/harness/gateways.js';
import { enqueueAcpExecution } from '../src/harness/executions.js';
import { setMode } from '../src/harness/mode.js';
const orgId = 'gateway-tests';
let admin, member, other;
async function api(method, path, session, body = {}, token) {
  return worker.fetch(new Request(`https://example.com/gateways${path}${method === 'GET' ? `?orgId=${orgId}` : ''}`, {
    method, headers: { 'content-type': 'application/json', ...(session ? { 'x-session-token': session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ orgId, ...body }) }),
  }), env, { waitUntil() {} });
}
async function node() {
  const r = await api('POST', '', admin, { name: 'Mac mini' });
  expect(r.status).toBe(201); return r.json();
}
async function enqueue(gatewayId, requestId = crypto.randomUUID()) {
  const r = await api('POST', '/jobs', member, { gatewayId, requestId, code: 'return input * 2', input: 21 });
  expect(r.status).toBe(201); return (await r.json()).job;
}
const claim = async (token, capabilities = [], acpAgents = []) => (await (await api('POST', '/claim', null, { capabilities, acpAgents }, token)).json()).job;
beforeEach(async () => {
  const { upsertUser, upsertMembership, createSession } = await import('../src/db.js');
  const sessions = [];
  for (const [id, role] of [['9501', 'admin'], ['9502', 'member'], ['9503', 'member']]) {
    await upsertUser(env.DB, { githubId: id, login: `user${id}`, name: id, locale: 'en' });
    await upsertMembership(env.DB, orgId, id, role);
    sessions.push(await createSession(env.DB, id, 'test'));
  }
  [admin, member, other] = sessions;
});
test('registration is admin-only and stores only a hash; logs belong to requester', async () => {
  expect((await api('POST', '', member, { name: 'No' })).status).toBe(403);
  const { gateway, token } = await node();
  const stored = await env.DB.prepare('SELECT * FROM hx_gateways WHERE id = ?').bind(gateway.id).first();
  expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored)).not.toContain(token);
  expect(await (await api('GET', '', member)).text()).not.toContain(stored.token_hash);
  const job = await enqueue(gateway.id);
  for (const session of [admin, other]) {
    expect((await api('GET', `/jobs/${job.id}`, session)).status).toBe(404);
    expect((await (await api('GET', '/jobs', session)).json()).jobs).toEqual([]);
  }
});
test('claim is exclusive, submissions idempotent, finish rejects replay and wrong node', async () => {
  const { gateway, token } = await node();
  const second = await node();
  const job = await enqueue(gateway.id, 'same');
  expect((await api('POST', '/jobs', member, { gatewayId: gateway.id, requestId: 'same', code: 'return input * 2', input: 21 })).status).toBe(200);
  expect((await api('POST', '/jobs', member, { gatewayId: gateway.id, requestId: 'same', code: 'different' })).status).toBe(409);
  await enqueue(gateway.id);
  const claims = await Promise.all([claim(token), claim(token)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const running = claims.find(Boolean);
  expect(running.id).toBe(job.id);
  const body = { lease: running.lease, status: 'succeeded', stdout: '42', exitCode: 0 };
  expect((await api('POST', `/jobs/${job.id}/finish`, null, body, second.token)).status).toBe(409);
  expect((await api('POST', `/jobs/${job.id}/finish`, null, body, token)).status).toBe(200);
  expect((await api('POST', `/jobs/${job.id}/finish`, null, body, token)).status).toBe(409);
  expect(await claim(token)).not.toBeNull();
});
test('ACP prompts require a local capability and carry only the configured agent key',async()=>{
 const {gateway,token}=await node();
 expect(await claim(token,['acp-v1'],['codex-local'])).toBeNull();
 const listed=(await (await api('GET','',admin)).json()).gateways.find(entry=>entry.id===gateway.id);
 expect(listed.acpAgents).toEqual(['codex-local']);
 const {enqueueAcpExecution}=await import('../src/harness/executions.js');
 const queued=await enqueueAcpExecution(env.DB,orgId,'9501',{gatewayId:gateway.id,agentKey:'codex-local',prompt:'Review this change',sessionId:'session-1',context:['Previous message']});
 expect(queued.job).toBeTruthy();
 const stored=await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?').bind(queued.job.id).first();
 expect(JSON.parse(stored.payload)).toEqual({acp:true,agentKey:'codex-local',prompt:'Review this change',sessionId:'session-1',context:['Previous message']});
 expect(await claim(token,[],['codex-local'])).toBeNull();
 const got=await claim(token,['acp-v1'],['codex-local']);expect(got.id).toBe(queued.job.id);
 expect(got.timeoutMs).toBe(110000);
 expect(got.payload).not.toHaveProperty('command');expect(got.payload).not.toHaveProperty('cwd');
});
test('a node whose finish reply was lost is told its result is in, and nothing changes', async () => {
  const { gateway, token } = await node();
  const second = await node();
  await enqueue(gateway.id);
  const running = await claim(token);
  const body = { lease: running.lease, status: 'succeeded', stdout: '42', exitCode: 0 };
  expect((await api('POST', `/jobs/${running.id}/finish`, null, body, token)).status).toBe(200);
  const before = await env.DB.prepare('SELECT status, result, finished_at FROM hx_gateway_jobs WHERE id = ?').bind(running.id).first();
  const again = await api('POST', `/jobs/${running.id}/finish`, null, body, token);
  expect(again.status).toBe(409);
  expect((await again.json()).code).toBe('already_finished');
  expect(await env.DB.prepare('SELECT status, result, finished_at FROM hx_gateway_jobs WHERE id = ?').bind(running.id).first()).toEqual(before);
  // A different result, another node, or another lease is refused as before.
  for (const [b, t] of [[{ ...body, stdout: '43' }, token], [body, second.token], [{ ...body, lease: 'not-the-lease' }, token]]) {
    const r = await api('POST', `/jobs/${running.id}/finish`, null, b, t);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBeUndefined();
  }
  // A cancelled job is never reported as delivered.
  await enqueue(gateway.id);
  const next = await claim(token);
  expect((await api('POST', `/jobs/${next.id}/cancel`, member)).status).toBe(200);
  const late = await api('POST', `/jobs/${next.id}/finish`, null, { lease: next.lease, status: 'succeeded', stdout: '42', exitCode: 0 }, token);
  expect((await late.json()).code).toBeUndefined();
});
test('cancellation and revocation immediately reject leases and tokens', async () => {
  const { gateway, token } = await node();
  await enqueue(gateway.id);
  const running = await claim(token);
  expect((await api('POST', `/jobs/${running.id}/cancel`, member)).status).toBe(200);
  expect((await api('POST', `/jobs/${running.id}/heartbeat`, null, { lease: running.lease }, token)).status).toBe(409);
  const queued = await enqueue(gateway.id);
  expect((await api('POST', `/${gateway.id}/revoke`, member)).status).toBe(403);
  expect((await api('POST', `/${gateway.id}/revoke`, admin)).status).toBe(200);
  expect((await api('POST', '/claim', null, {}, token)).status).toBe(401);
  expect((await (await api('GET', `/jobs/${queued.id}`, member)).json()).job.status).toBe('cancelled');
});
test('expiry works without a connected node and membership removal invalidates execution', async () => {
  const { gateway, token } = await node();
  await enqueue(gateway.id);
  const running = await claim(token);
  await env.DB.prepare('UPDATE hx_gateway_jobs SET lease_until = 1 WHERE id = ?').bind(running.id).run();
  await expireGatewayJobs(env.DB);
  expect((await (await api('GET', `/jobs/${running.id}`, member)).json()).job.status).toBe('failed');
  await enqueue(gateway.id);
  const next = await claim(token);
  await env.DB.prepare('DELETE FROM memberships WHERE org_id = ? AND user_github_id = ?').bind(orgId, '9502').run();
  expect((await api('POST', `/jobs/${next.id}/finish`, null, { lease: next.lease, status: 'succeeded' }, token)).status).toBe(409);
  await expireGatewayJobs(env.DB);
  expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id = ?').bind(next.id).first()).status).toBe('failed');
});


test('node polling has independent limits from team operations and from other nodes', async () => {
  const first = await node(), second = await node();
  expect((await api('POST', '/claim', null, {}, first.token)).status).toBe(200);
  await env.DB.prepare("UPDATE rate_limits SET count = 120 WHERE bucket = 'team'").run();
  // A busy human UI must not interrupt the execution heartbeat/queue.
  expect((await api('POST', '/claim', null, {}, second.token)).status).toBe(200);
  await env.DB.prepare("UPDATE rate_limits SET count = 120 WHERE bucket = 'gateway/node' AND subject = ?").bind(`gateway:${first.gateway.id}`).run();
  expect((await api('POST', '/claim', null, {}, first.token)).status).toBe(429);
  expect((await api('POST', '/claim', null, {}, second.token)).status).toBe(200);
  await env.DB.prepare("UPDATE rate_limits SET count = 600 WHERE bucket = 'gateway/edge'").run();
  expect((await api('POST', '/claim', null, {}, second.token)).status).toBe(429);
});

test('ACP Workspace MCP is opt-in, read-only, node-and-lease bound, and rechecks Harness access', async () => {
  await setMode(env.DB, orgId, 'simple', '9501');
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at,provider)
    VALUES(?1,'acp-workspace','acp-workspace','Local ACP','Read Workspace safely.','team','user9502','now','now','acp')`).bind(orgId).run();
  const { gateway, token } = await node();
  const register = await api('POST', '/claim', null, { capabilities: ['acp-v1'], acpAgents: ['workspace-reader'] }, token);
  expect(register.status).toBe(200);
  const simple = await enqueueAcpExecution(env.DB, orgId, '9502', { gatewayId: gateway.id, agentKey: 'workspace-reader', prompt: 'Read this' });
  expect(simple.statusCode).toBe(201);
  let stored = await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(simple.job.id).first();
  expect(JSON.parse(stored.payload)).not.toHaveProperty('workspaceTools');
  expect((await api('POST', `/jobs/${simple.job.id}/cancel`, member)).status).toBe(200);
  const simpleFallback = await enqueueAcpExecution(env.DB, orgId, '9502', {
    gatewayId: gateway.id, agentKey: 'workspace-reader', prompt: 'Read this', agentId: 'acp-workspace', workspaceTools: true,
  });
  expect(simpleFallback.statusCode).toBe(201);
  const fallbackPayload = await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(simpleFallback.job.id).first();
  expect(JSON.parse(fallbackPayload.payload)).not.toHaveProperty('workspaceTools');
  expect((await api('POST', `/jobs/${simpleFallback.job.id}/cancel`, member)).status).toBe(200);

  await setMode(env.DB, orgId, 'harness', '9501');
  const enabled = await enqueueAcpExecution(env.DB, orgId, '9502', {
    gatewayId: gateway.id, agentKey: 'workspace-reader', prompt: 'Read this', agentId: 'acp-workspace', workspaceTools: true,
  });
  expect(enabled.statusCode).toBe(201);
  stored = await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(enabled.job.id).first();
  expect(JSON.parse(stored.payload)).toMatchObject({ acp: true, workspaceTools: true, agentId: 'acp-workspace' });

  const claimed = await api('POST', '/claim', null, { capabilities: ['acp-v1'], acpAgents: ['workspace-reader'] }, token);
  const running = (await claimed.json()).job;
  expect(running.id).toBe(enabled.job.id);
  const mcp = (method, params = {}, lease = running.lease, auth = token) => api('POST', `/jobs/${running.id}/mcp`, null, { lease, method, params }, auth);
  expect((await mcp('tools/list', {}, 'wrong-lease')).status).toBe(409);
  const listed = await mcp('tools/list');
  expect(listed.status).toBe(200);
  const tools = (await listed.json()).result.tools.map(tool => tool.name);
  expect(tools).toEqual(['list_apps', 'read_app', 'list_tables', 'query_rows', 'list_workflows', 'list_followups']);
  expect((await mcp('tools/call', { name: 'add_row', arguments: {} })).status).toBe(403);
  // Exercise the actual ACP transport limit and continuation past offset 1000.
  const { createApp } = await import('../src/harness/apps.js');
  const made = await createApp(env.DB, { orgId, by: '9502', name: 'Large rows', columns: [{ name: 'ID', type: 'text' }, { name: 'Body', type: 'text' }] });
  const app = made.app;
  const rows = Array.from({ length: 1105 }, (_, i) => env.DB.prepare(`INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'9502','now','now')`)
    .bind(`acp-row-${i}`, app.tableId, orgId, JSON.stringify({ id: `business-${i}`, body: '界'.repeat(600) }), i));
  for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
  const read = await mcp('tools/call', { name: 'read_app', arguments: { appId: app.id } });
  expect(read.status).toBe(200);
  const readPage = (await read.json()).result.structuredContent;
  expect(readPage.app.tableId).toBe(app.tableId);
  expect(readPage.nextOffset).toBe(readPage.rows.length);
  expect(readPage.rows[0]).toMatchObject({ id: 'acp-row-0', recordId: 'acp-row-0', values: { id: 'business-0' } });
  let offset = 0, found = [];
  while (offset !== null) {
    const response = await mcp('tools/call', { name: 'query_rows', arguments: { tableId: app.tableId, limit: 100, offset } });
    expect(response.status).toBe(200);
    const result = (await response.json()).result;
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(200000);
    const page = result.structuredContent;
    expect(page.rows.length).toBeGreaterThan(0);
    found.push(...page.rows.map(row => row.id));
    expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
    offset = page.nextOffset;
  }
  expect(found).toHaveLength(1105);
  expect(new Set(found).size).toBe(1105);
  expect(found[1104]).toBe('acp-row-1104');
  const columns = Array.from({ length: 30 }, (_, i) => ({ name: `Field ${i}`, type: 'text' }));
  const large = (await createApp(env.DB, { orgId, by: '9502', name: 'Oversized row', columns })).app;
  const bigValues = Object.fromEntries(columns.map((_, i) => [`field_${i}`, 'x'.repeat(5000)]));
  await env.DB.prepare(`INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES('acp-huge',?1,?2,?3,0,'9502','now','now')`).bind(large.tableId, orgId, JSON.stringify(bigValues)).run();
  const hugeResponse = await mcp('tools/call', { name: 'query_rows', arguments: { tableId: large.tableId } });
  expect(hugeResponse.status).toBe(200);
  const huge = (await hugeResponse.json()).result;
  expect(huge.isError).toBe(true);
  expect(huge.content[0].text).toContain('fewer selected fields');
  const projectedResponse = await mcp('tools/call', { name: 'query_rows', arguments: { tableId: large.tableId, fields: ['field_0'] } });
  expect(projectedResponse.status).toBe(200);
  const projected = (await projectedResponse.json()).result.structuredContent;
  expect(projected.rows[0]).toMatchObject({ id: 'acp-huge', field_0: 'x'.repeat(5000) });
  expect(projected.rows[0]).not.toHaveProperty('field_1');
  expect(projected.nextOffset).toBeNull();

  expect((await mcp('resources/list')).status).toBe(400);
  expect((await api('POST', `/jobs/${running.id}/mcp`, null, { lease: running.lease, method: 'tools/list' }, 'hgw_invalid')).status).toBe(401);
  const otherNode = await node();
  expect((await api('POST', `/jobs/${running.id}/mcp`, null, { lease: running.lease, method: 'tools/list' }, otherNode.token)).status).toBe(409);

  await setMode(env.DB, orgId, 'simple', '9501');
  expect((await mcp('tools/list')).status).toBe(403);
  await setMode(env.DB, orgId, 'harness', '9501');
  await env.DB.prepare('UPDATE custom_agents SET deleted_at=?3 WHERE org_id=?1 AND id=?2').bind(orgId,'acp-workspace','now').run();
  expect((await mcp('tools/list')).status).toBe(403);
  expect((await api('POST', `/jobs/${running.id}/cancel`, member)).status).toBe(200);
  expect((await mcp('tools/list')).status).toBe(409);
});

test('TypeScript module language survives queueing and participates in request identity',async()=>{
 const {gateway,token}=await node();
 const input={gatewayId:gateway.id,requestId:'typed-module',language:'typescript',code:'export default (input:number):number => input * 2',input:21};
 expect((await api('POST','/jobs',member,input)).status).toBe(201);
 expect((await api('POST','/jobs',member,input)).status).toBe(200);
 expect((await api('POST','/jobs',member,{...input,language:'javascript'})).status).toBe(409);
 expect((await api('POST','/jobs',member,{...input,requestId:'invalid',language:'shell'})).status).toBe(400);
 const job=await claim(token);
 expect(job.payload).toEqual({code:input.code,input:21,language:'typescript'});
});

test('node state endpoint uses an assigned workflow activation and refuses unrelated scope',async()=>{
 const {claimWorkflowNode}=await import('../src/harness/workflowCheckpoints.js');
 const {gateway,token}=await node();const second=await node();
 const queued=await enqueue(gateway.id);const running=await claim(token);const at=Date.now();
 const call=(operation,params={},auth=token,lease=running.lease)=>api('POST',`/jobs/${queued.id}/state`,null,{lease,operation,params},auth);
 expect((await call('state.get')).status).toBe(409);
 await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES('sdk-workflow',?1,'SDK',1,'{\"type\":\"manual\"}','[]','9502','now','now')").bind(orgId).run();
 await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES('sdk-run',?1,'sdk-workflow','manual','running','[]','now')").bind(orgId).run();
 await env.DB.prepare("INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES('sdk-run',?1,?2,'now')").bind(orgId,JSON.stringify({id:'sdk-workflow',createdBy:'9502',definitionRevision:1})).run();
 const checkpoint=await claimWorkflowNode(env.DB,{orgId,runId:'sdk-run',nodeId:'code',fingerprint:'frozen-code',at,ttl:60000});
 await env.DB.prepare("INSERT INTO hx_workflow_activations(org_id,job_id,run_id,node_id,node_owner,node_attempt) VALUES(?1,?2,'sdk-run','code',?3,?4)").bind(orgId,queued.id,checkpoint.owner,checkpoint.attempt).run();
 const initial=await call('state.get');expect(initial.status).toBe(200);expect(await initial.json()).toMatchObject({found:false,revision:0});
 const saved=await call('state.set',{state:{count:1},expectedRevision:0,validationStatus:'passed',schemaVersion:'v1'});
 expect(saved.status).toBe(200);const receipt=await saved.json();expect(receipt).toMatchObject({saved:true,currentRunId:'sdk-run',revision:1});
 const restored=await call('state.get',{includeCurrentRun:true});expect(restored.status).toBe(200);
 const value=await restored.json();expect(value).toMatchObject({state:{count:1},metadata:{definitionRevision:1,schemaVersion:'v1',contentHash:receipt.contentHash}});
 for(const secret of [token,running.lease,checkpoint.owner])expect(JSON.stringify(value)).not.toContain(secret);
 expect((await call('state.get',{},second.token)).status).toBe(409);
 expect((await call('state.get',{},token,'wrong-lease')).status).toBe(409);
 expect((await call('state.get',{runId:'other'})).status).toBe(400);
 expect((await call('state.set',{state:[],expectedRevision:1})).status).toBe(400);
 expect((await api('POST',`/jobs/${queued.id}/state`,member,{lease:running.lease,operation:'state.get',params:{}})).status).toBe(401);
 await api('POST',`/jobs/${queued.id}/cancel`,member,{});
 expect((await call('state.get')).status).toBe(409);
});

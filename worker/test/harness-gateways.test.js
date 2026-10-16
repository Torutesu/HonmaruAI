import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { expireGatewayJobs } from '../src/harness/gateways.js';
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
const claim = async token => (await (await api('POST', '/claim', null, {}, token)).json()).job;
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

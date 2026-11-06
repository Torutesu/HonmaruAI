import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fetchMock } from './helpers/fetch-mock.js';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';

const ORG = 'personal:agent-role-execution';
let toru, mika, kenji, agentId;
const pending = [];
const ctx = { waitUntil: promise => pending.push(promise) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, over = {}) => {
  const response = await worker.fetch(new Request(`https://example.com${path}`, init),
    { ...env, OPENAI_API_KEY: undefined, ...over }, ctx);
  await settle();
  return response;
};
const headers = token => ({ 'content-type': 'application/json', 'x-session-token': token });
const send = (method, path, token, body, over) => call(path,
  { method, headers: headers(token), body: JSON.stringify(body) }, over);
const get = (path, token) => call(path, { headers: headers(token) });
const q = value => new URLSearchParams(value).toString();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import('../src/db.js');
  for (const [id, login, name, role] of [
    ['9201', 'toru', 'Toru', 'admin'],
    ['9202', 'mika', 'Mika', 'member'],
    ['9203', 'kenji', 'Kenji', 'member'],
  ]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: 'en' });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: 'Ops', createdBy: '9201' });
  toru = await createSession(env.DB, '9201', 'gho_t');
  mika = await createSession(env.DB, '9202', 'gho_m');
  kenji = await createSession(env.DB, '9203', 'gho_k');
  fetchMock.activate();
  await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode: 'harness' });
  const made = await send('POST', '/channels/agents', mika,
    { orgId: ORG, name: 'Billy', handle: 'billy', instructions: 'Review operations.', scope: 'team' });
  agentId = (await made.json()).agent.id;
  await send('PUT', '/channels/agents', mika, { orgId: ORG, id: agentId, scope: 'team' });
  await send('PUT', `/hx/agents/${agentId}/profile`, mika, { orgId: ORG, access: 'private' });
  // Room placement alone is not an Agent grant when its Harness profile is private.
  await env.DB.prepare(`INSERT INTO channel_agents (org_id,channel,agent_id,added_by,added_at)
    VALUES (?1,'b:ops',?2,'mika',?)`).bind(ORG, agentId, new Date().toISOString()).run();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

test('a private Agent needs an explicit role to dispatch and revocation cancels queued execution', async () => {
  const { getSession } = await import('../src/db.js');
  const { getMessage } = await import('../src/channels.js');
  const { agentExecutionGrant, agentExecutionAuthorizer } = await import('../src/agentExecutionGrant.js');
  const rolesPath = `/hx/agents/${agentId}/members`;
  const jobs = [];
  const runner = { idFromName: id => id, get: () => ({ fetch: async (_url, init) => {
    jobs.push(JSON.parse(init.body));
    return new Response('Queued', { status: 202 });
  } }) };
  const over = { AGENT_INLINE: '', AGENT_RUNNER: runner };

  const ungranted = await send('POST', '/channels/messages', kenji,
    { orgId: ORG, channel: 'b:ops', body: '@billy review this item' }, over);
  expect(ungranted.status).toBe(201);
  expect(jobs).toHaveLength(0);

  const state = await (await get(`${rolesPath}?${q({ orgId: ORG })}`, mika)).json();
  const ref = state.candidates.find(person => person.name === 'Kenji').ref;
  expect((await send('PUT', rolesPath, mika,
    { orgId: ORG, ref, role: 'member', expectedVersion: 0 })).status).toBe(200);

  const queued = await send('POST', '/channels/messages', kenji,
    { orgId: ORG, channel: 'b:ops', body: '@billy review the next item' }, over);
  expect(queued.status).toBe(201);
  const message = (await queued.json()).message;
  expect(jobs).toHaveLength(1);
  expect(jobs[0].rowId).toBe(message.id);
  const request = { orgId: ORG, token: (await getSession(env.DB, kenji)).token, rowId: message.id };
  const grant = await agentExecutionGrant(env, request);
  expect(grant.agents.map(agent => agent.id)).toContain(agentId);
  const source = await getMessage(env.DB, ORG, message.id);
  const authorize = agentExecutionAuthorizer(env, request, source);
  expect(await authorize(agentId)).toBe(true);

  expect((await send('PUT', rolesPath, mika,
    { orgId: ORG, ref, role: 'none', expectedVersion: 1 })).status).toBe(200);
  expect(await authorize(agentId)).toBe(false);
  expect((await agentExecutionGrant(env, request)).agents).toEqual([]);
  const revoked = await send('POST', '/channels/messages', kenji,
    { orgId: ORG, channel: 'b:ops', body: '@billy do not run this' }, over);
  expect(revoked.status).toBe(201);
  expect(jobs).toHaveLength(1);
});

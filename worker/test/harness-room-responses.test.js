import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { roomResponses, saveRoomResponses } from '../src/harness/roomResponses.js';
import { createSession, upsertUser, upsertMembership, upsertBusiness } from '../src/db.js';
const ORG = 'personal:room-responses';
let owner, outsider;
const call = (method, token, input = {}) => worker.fetch(new Request(`https://example.com/hx/rooms/responses?${new URLSearchParams({ orgId: ORG, channel: 'b:private' })}`, { method, headers: { 'x-session-token': token, 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ orgId: ORG, channel: 'b:private', ...input }) } : {}) }), env);
beforeEach(async () => {
  for (const [id, login] of [['responses-owner', 'owner'], ['responses-other', 'other']]) {
    await upsertUser(env.DB, { githubId: id, login, name: login });
    await upsertMembership(env.DB, ORG, id, 'admin');
  }
  owner = await createSession(env.DB, 'responses-owner', 'test');
  outsider = await createSession(env.DB, 'responses-other', 'test');
  await upsertBusiness(env.DB, ORG, { name: 'Private', createdBy: 'responses-owner' });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'private'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:private', 'owner', 'owner', ?2)").bind(ORG, new Date().toISOString()).run();
});
test('response policy is scoped to accessible rooms and stale saves cannot overwrite it', async () => {
  expect((await call('GET', outsider)).status).toBe(404);
  expect((await call('PUT', outsider, { mentionedOnly: true, version: 0 })).status).toBe(404);
  expect(await (await call('GET', owner)).json()).toMatchObject({ responses: { mentionedOnly: false, version: 0 } });
  expect((await call('PUT', owner, { mentionedOnly: 'true', version: 0 })).status).toBe(400);
  expect((await call('PUT', owner, { mentionedOnly: true, version: 0 })).status).toBe(200);
  expect((await call('PUT', owner, { mentionedOnly: false, version: 0 })).status).toBe(409);
  expect(await roomResponses(env.DB, ORG, 'b:private')).toEqual({ mentionedOnly: true, version: 1 });
  expect(await roomResponses(env.DB, 'another-org', 'b:private')).toEqual({ mentionedOnly: false, version: 0 });
  expect(await saveRoomResponses(env.DB, ORG, 'b:private', { mentionedOnly: false, version: 1 }, 'owner')).toMatchObject({ responses: { mentionedOnly: false, version: 2 } });
});

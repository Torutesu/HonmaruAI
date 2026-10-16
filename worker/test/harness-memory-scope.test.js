import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { addAgentMemory, listAgentMemories, deleteAgentMemory, prepareAgent, filterResponders } from '../src/harness/agents.js';

const org = 'memory-scope';
const agent = 'a';
test('room and DM memories stay in their source conversation; shared knowledge remains shared', async () => {
  await addAgentMemory(env.DB, org, agent, 'Shared context');
  await addAgentMemory(env.DB, org, agent, 'Private financial detail', { channel: 'b:finance', kind: 'reference' });
  await addAgentMemory(env.DB, org, agent, 'Private preference', { channel: 'dm:a|b', kind: 'preference' });
  const texts = async (channel) => (await listAgentMemories(env.DB, org, agent, { channel })).map(m => m.text);
  expect(await texts('b:finance')).toEqual(expect.arrayContaining(['Shared context', 'Private financial detail']));
  expect(await texts('b:sales')).toEqual(['Shared context']);
  expect(await texts('')).toEqual(['Shared context']);
  expect(await texts('dm:a|b')).toEqual(expect.arrayContaining(['Shared context', 'Private preference']));
  expect(await listAgentMemories(env.DB, 'other', agent, { channel: 'b:finance' })).toEqual([]);
  const prepared = await prepareAgent(env, org, { id: agent, instructions: 'Help' }, null, { channel: 'b:sales' });
  expect(prepared.agent.instructions).not.toContain('Private financial detail');
});

test('deduplication and deletion do not cross conversation boundaries', async () => {
  const first = await addAgentMemory(env.DB, org, agent, 'Same text', { channel: 'b:one' });
  const second = await addAgentMemory(env.DB, org, agent, 'Same text', { channel: 'b:two' });
  expect(first.memory.id).not.toBe(second.memory.id);
  expect((await addAgentMemory(env.DB, org, agent, 'Same text', { channel: 'b:one' })).duplicate).toBe(true);
  expect((await deleteAgentMemory(env.DB, org, agent, first.memory.id, { channel: 'b:two' })).deleted).toBe(0);
  expect((await deleteAgentMemory(env.DB, org, agent, '*', { channel: 'b:two' })).deleted).toBe(1);
  expect((await listAgentMemories(env.DB, org, agent, { channel: 'b:one' })).length).toBe(1);
});

test('legacy memories remain readable without rewriting existing data', async () => {
  await env.DB.prepare('INSERT INTO hx_agent_memories (id, org_id, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)').bind('legacy', org, agent, 'Legacy', new Date().toISOString()).run();
  expect((await listAgentMemories(env.DB, org, agent, { channel: 'b:one' }))[0].text).toBe('Legacy');
});

test('unprofiled personal agents are still private', async () => {
  expect(await filterResponders(env.DB, org, 'outsider', [{ id: agent, scope: 'personal', ownerLogin: 'owner' }])).toEqual([]);
});

test('deferred conversation checks accept canonical DMs only for their current members', async () => {
  const { mayUseConversation } = await import('../src/harness/conversationAccess.js');
  const { upsertUser, upsertMembership } = await import('../src/db.js');
  for (const id of ['alice', 'bob', 'outsider']) {
    await upsertUser(env.DB, { githubId: id, login: id, name: id });
    await upsertMembership(env.DB, org, id, 'member');
  }
  expect(await mayUseConversation(env.DB, org, 'alice', 'dm:alice|bob')).toBe(true);
  expect(await mayUseConversation(env.DB, org, 'outsider', 'dm:alice|bob')).toBe(false);
  await env.DB.prepare('DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2').bind(org, 'alice').run();
  expect(await mayUseConversation(env.DB, org, 'alice', 'dm:alice|bob')).toBe(false);
});

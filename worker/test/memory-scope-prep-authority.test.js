import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { upsertUser, upsertMembership } from '../src/db.js';
import { addAgentMemory, prepareAgent } from '../src/harness/agents.js';
import { mayUseConversation } from '../src/harness/conversationAccess.js';

test('preparing an agent exports room memory only while the caller can read that room', async () => {
  const org = 'memory-prep-authority';
  const agent = 'agent';
  const channel = 'b:memory-private';
  for (const id of ['member', 'outsider']) {
    await upsertUser(env.DB, { githubId: id, login: id, name: id });
    await upsertMembership(env.DB, org, id, 'member');
  }
  await env.DB.prepare('INSERT INTO businesses (org_id, slug, name, created_at, private) VALUES (?, ?, ?, ?, 1)')
    .bind(org, 'memory-private', 'Private memory room', new Date().toISOString()).run();
  await env.DB.prepare('INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
    .bind(org, channel, 'member', 'member', new Date().toISOString()).run();

  await addAgentMemory(env.DB, org, agent, 'Shared agent preference');
  await addAgentMemory(env.DB, org, agent, 'Private room instruction', { channel });
  expect(await mayUseConversation(env.DB, org, 'outsider', channel)).toBe(false);

  const prepare = (context) => prepareAgent(env, org, { id: agent, instructions: 'Help' }, null, context);
  const member = await prepare({ channel, userId: 'member' });
  expect(member.agent.instructions).toContain('Private room instruction');

  for (const context of [{ channel, userId: 'outsider' }, { channel }]) {
    const denied = await prepare(context);
    expect(denied.agent.instructions).not.toContain('Private room instruction');
    expect(denied.agent.instructions).not.toContain('Shared agent preference');
  }

  await env.DB.prepare('DELETE FROM conversation_members WHERE org_id = ? AND channel = ? AND login = ?')
    .bind(org, channel, 'member').run();
  const revoked = await prepare({ channel, userId: 'member' });
  expect(revoked.agent.instructions).not.toContain('Private room instruction');
  expect(revoked.agent.instructions).not.toContain('Shared agent preference');
  expect(await mayUseConversation(env.DB, org, 'member', channel)).toBe(false);
});

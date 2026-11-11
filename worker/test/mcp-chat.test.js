import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import { callChatTool } from '../src/mcpChatTools.js';
import { prepareConversationMessage, acceptConversationMessage } from '../src/conversationOperations.js';
import { resolveMcpConversation } from '../src/mcpConversation.js';
import { upsertUser, upsertMembership, upsertBusiness } from '../src/db.js';
import { postMessage } from '../src/channels.js';
import { listMembers } from '../src/team.js';
import { createApiToken } from '../src/mcp.js';
import { uploadFile } from '../src/files.js';
import { runMinuteJobs, cancelScheduled } from '../src/later.js';
import { deliverMcpScheduledMessage } from '../src/mcpScheduled.js';
import { initializeRoomRoles } from '../src/harness/roomRoles.js';
import { sidebarSnapshot, saveSidebarIfVersion } from '../src/people-groups.js';
import sql from '../mcp-chat.sql?raw';

const orgId = 'personal:mcp-chat';
let actor;
let other;
const context = { waitUntil: promise => jobs.push(promise) };
let jobs;
const call = async (name, args, principal = actor) => {
  const out = await callChatTool(env, principal, name, args, new Request('https://example.com/mcp'), context);
  while (jobs.length) await jobs.shift();
  return out.structuredContent;
};
const seed = async (key, body, extra = {}) => (await postMessage(env.DB, { orgId, key, authorLogin: 'alex', body, ...extra })).row;

beforeEach(async () => {
  jobs = [];
  await env.DB.exec(sql.replace(/\n/g, ' '));
  for (const [githubId, login] of [['mcp-a', 'alex'], ['mcp-b', 'beth'], ['mcp-c', 'cara']]) {
    await upsertUser(env.DB, { githubId, login, name: login, locale: 'en' });
    await upsertMembership(env.DB, orgId, githubId, 'member');
  }
  await upsertBusiness(env.DB, orgId, { name: 'General', createdBy: 'mcp-a' });
  await upsertBusiness(env.DB, orgId, { name: 'Private', createdBy: 'mcp-a' });
  await env.DB.prepare('UPDATE businesses SET private=1 WHERE org_id=?1 AND slug=?2').bind(orgId, 'private').run();
  await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,?2,?3,?3,?4)').bind(orgId, 'b:private', 'alex', new Date().toISOString()).run();
  actor = { orgId, githubId: 'mcp-a', login: 'alex', name: 'Alex', tokenId: 'token-a', scopes: ['chat:read', 'chat:write', 'chat:schedule', 'reactions:write', 'channels:write'] };
  actor.tokenId = (await createApiToken(env.DB, { orgId, githubId: actor.githubId, name: 'chat fixture', scopes: actor.scopes })).id;
  other = (await listMembers(env.DB, orgId, 'mcp-a')).find(m => m.login === 'beth');
});

test('MCP Room discovery is public-only and join/leave change the token owner membership without adding an Agent', async () => {
  await upsertBusiness(env.DB, orgId, { name: 'Planning', createdBy: 'mcp-b' });
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1 AND slug='planning'").bind(orgId).run();
  await initializeRoomRoles(env.DB, orgId, 'b:planning', 'mcp-b');
  const first = await call('discover_public_rooms', { query: 'plan' });
  expect(first).toMatchObject({ total: 1, rooms: [{ channel: 'b:planning', name: 'Planning', joined: false }] });
  expect((await call('discover_public_rooms', { joined: true })).total).toBe(0);
  expect(await call('join_public_room', { conversationId: 'b:planning' })).toMatchObject({ joined: true, conversationId: 'b:planning' });
  expect((await call('discover_public_rooms', { joined: true })).rooms.map(room => room.channel)).toEqual(['b:planning']);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_agents WHERE org_id=?1 AND channel='b:planning'").bind(orgId).first('n')).toBe(0);
  expect(await call('leave_public_room', { conversationId: 'b:planning' })).toMatchObject({ left: true, conversationId: 'b:planning' });
  expect((await call('discover_public_rooms', { joined: true })).total).toBe(0);
  expect((await call('discover_public_rooms', {})).rooms.map(room => room.channel)).not.toContain('b:private');
});

test('MCP Room rename, archive, restore and archive listing preserve membership boundaries', async () => {
  await upsertBusiness(env.DB, orgId, { name: 'Roadmap', createdBy: 'mcp-b' });
  await initializeRoomRoles(env.DB, orgId, 'b:roadmap', 'mcp-b');
  await upsertBusiness(env.DB, orgId, { name: 'Simple Archive', createdBy: 'mcp-b' });
  await env.DB.prepare("UPDATE businesses SET archived_at='2026-01-01T00:00:00.000Z' WHERE org_id=?1 AND slug='simple-archive'").bind(orgId).run();
  await upsertBusiness(env.DB, orgId, { name: 'Private Vault', createdBy: 'mcp-b' });
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1 AND slug='private-vault'").bind(orgId).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:private-vault','beth','beth','joined')").bind(orgId).run();
  await initializeRoomRoles(env.DB, orgId, 'b:private-vault', 'mcp-b');
  expect((await call('list_archived_rooms', {})).rooms).toEqual([]);
  await expect(call('archive_room', { conversationId: 'b:private-vault' })).rejects.toThrow('No such accessible managed Room.');
  await expect(call('rename_room', { conversationId: 'b:roadmap', name: 'Plan' })).rejects.toThrow('Only a current Room member can rename it.');
  await call('join_public_room', { conversationId: 'b:roadmap' });
  expect(await call('rename_room', { conversationId: 'b:roadmap', name: 'Plan' })).toMatchObject({ name: 'Plan', version: 3 });
  expect(await call('archive_room', { conversationId: 'b:roadmap' })).toMatchObject({ archived: true, version: 4 });
  expect((await call('list_archived_rooms', { query: 'plan' })).rooms).toMatchObject([{ channel: 'b:roadmap', name: 'Plan' }]);
  expect((await call('list_archived_rooms', {})).rooms.map(room => room.channel)).not.toContain('b:private-vault');
  expect((await call('discover_public_rooms', {})).rooms.map(room => room.channel)).not.toContain('b:roadmap');
  expect(await call('unarchive_room', { conversationId: 'b:roadmap' })).toMatchObject({ archived: false, version: 5 });
  expect((await call('discover_public_rooms', { joined: true })).rooms.map(room => room.channel)).toContain('b:roadmap');
});

test('MCP Room settings expose managed defaults and update only requested settings under build authority', async () => {
  await initializeRoomRoles(env.DB, orgId, 'b:general', actor.githubId);
  expect(await call('get_room_settings', { conversationId: 'b:general' })).toMatchObject({
    conversationId: 'b:general', canEdit: true, settings: { name: 'General', color: 'teal', mentionedOnly: false, defaultAgentId: null, version: 1, responseVersion: 0 },
  });
  const updated = await call('update_room_settings', { conversationId: 'b:general', name: 'Operations', mentionedOnly: true, color: 'lake' });
  expect(updated.settings).toMatchObject({ name: 'Operations', color: 'lake', mentionedOnly: true, version: 2, responseVersion: 1 });
  expect(await env.DB.prepare("SELECT name FROM businesses WHERE org_id=?1 AND slug='general'").bind(orgId).first('name')).toBe('Operations');
  expect(await env.DB.prepare("SELECT color FROM hx_room_appearance WHERE org_id=?1 AND channel='b:general'").bind(orgId).first('color')).toBe('lake');
  await expect(call('update_room_settings', { conversationId: 'b:general', defaultAgentId: 'missing-agent' })).rejects.toThrow('Choose an agent available in this room');
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'mcp-room-agent','mcp-room-agent','Room Agent','Plan.','team','alex',?2,?2)").bind(orgId, at).run();
  await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,'b:general','mcp-room-agent','alex',?2)").bind(orgId, at).run();
  const agentUpdate = await call('update_room_settings', { conversationId: 'b:general', defaultAgentId: 'mcp-room-agent' });
  expect(agentUpdate.settings).toMatchObject({ defaultAgentId: 'mcp-room-agent', version: 3, responseVersion: 2 });
});

test('MCP Room mute is personal and reorder preserves the rest of the versioned sidebar', async () => {
  await initializeRoomRoles(env.DB, orgId, 'b:general', actor.githubId);
  expect(await call('set_room_muted', { conversationId: 'b:general', muted: true })).toMatchObject({ muted: true, level: 'mute' });
  expect(await env.DB.prepare('SELECT level FROM channel_prefs WHERE org_id=?1 AND login=?2 AND channel=?3').bind(orgId, 'alex', 'b:general').first('level')).toBe('mute');
  expect(await call('set_room_muted', { conversationId: 'b:general', muted: false })).toMatchObject({ muted: false, level: 'default' });
  expect(await env.DB.prepare('SELECT level FROM channel_prefs WHERE org_id=?1 AND login=?2 AND channel=?3').bind(orgId, 'alex', 'b:general').first()).toBeNull();
  const original = await sidebarSnapshot(env.DB, orgId, actor.login);
  await saveSidebarIfVersion(env.DB, orgId, actor.login, { ...original.sidebar, starred: ['b:general'], order: ['b:private', 'b:general'] }, original.version);
  const reordered = await call('reorder_rooms', { conversationIds: ['b:general'] });
  expect(reordered.reordered).toEqual(['b:general']);
  expect(reordered.sidebar.starred).toEqual(['b:general']);
  expect(reordered.sidebar.order).toEqual(['b:general', 'b:private']);
  await expect(call('reorder_rooms', { conversationIds: ['b:general', 'b:general'] })).rejects.toThrow('cannot contain duplicates');
  await expect(call('reorder_rooms', { conversationIds: ['dm:alex|beth'] })).rejects.toThrow('Only joined Rooms');
});

test('public grant cannot discover, search, or guess private and DM messages', async () => {
  await seed('b:general', 'needle public');
  const privateMessage = await seed('b:private', 'needle private');
  const dm = await seed('dm:alex|beth', 'needle dm');
  expect((await call('list_conversations', {})).conversations.map(c => c.id)).toEqual(['b:general']);
  expect((await call('search_messages', { query: 'needle' })).messages.map(m => m.body)).toEqual(['needle public']);
  await expect(call('get_message', { messageId: privateMessage.id })).rejects.toThrow('chat:private');
  await expect(call('get_message', { messageId: dm.id })).rejects.toThrow('chat:dm');
  await expect(call('read_channel', { conversationId: `dm:${other.ref}` })).rejects.toThrow('chat:dm');
  const expanded = { ...actor, scopes: [...actor.scopes, 'chat:private', 'chat:dm'] };
  expect((await call('search_messages', { query: 'needle' }, expanded)).messages).toHaveLength(3);
});

test('search grant filter occurs before limit and cursor handles timestamp ties', async () => {
  const first = await seed('b:general', 'needle one');
  const second = await seed('b:general', 'needle two');
  await seed('b:private', 'needle hidden');
  await env.DB.prepare('UPDATE channel_messages SET created_at=?1 WHERE org_id=?2').bind('2026-10-01T00:00:00.000Z', orgId).run();
  const page = await call('search_messages', { query: 'needle', limit: 1 });
  expect(page.messages.map(m => m.id)).toEqual([second.id]);
  const next = await call('search_messages', { query: 'needle', limit: 1, cursor: page.nextCursor });
  expect(next.messages.map(m => m.id)).toEqual([first.id]);
  expect(next.nextCursor).toBeNull();
});

test('channel history pages preserve ties and do not mark messages read', async () => {
  const rows = [await seed('b:general', 'one'), await seed('b:general', 'two'), await seed('b:general', 'three')];
  await env.DB.prepare('UPDATE channel_messages SET created_at=?1 WHERE org_id=?2').bind('2026-10-01T00:00:00.000Z', orgId).run();
  const newest = await call('read_channel', { conversationId: 'b:general', limit: 2 });
  expect(newest.messages.map(m => m.id)).toEqual(rows.slice(1).map(r => r.id));
  expect(newest.messages[0].url).toContain(`#/m/${rows[1].id}/`);
  const oldest = await call('read_channel', { conversationId: 'b:general', limit: 2, cursor: newest.nextCursor });
  expect(oldest.messages.map(m => m.id)).toEqual([rows[0].id]);
  expect(await env.DB.prepare('SELECT 1 FROM channel_reads WHERE org_id=?1').bind(orgId).first()).toBeNull();
});

test('thread pages include parent and never accept parent from another channel', async () => {
  const parent = await seed('b:general', 'parent');
  await seed('b:general', 'reply one', { parentId: parent.id });
  await seed('b:general', 'reply two', { parentId: parent.id });
  const thread = await call('read_thread', { conversationId: 'b:general', threadId: parent.id, limit: 1 });
  expect(thread.parent.id).toBe(parent.id);
  expect(thread.replies).toHaveLength(1);
  expect(thread.nextCursor).toBeTruthy();
  await expect(call('read_thread', { conversationId: 'b:private', threadId: parent.id }, { ...actor, scopes: [...actor.scopes, 'chat:private'] })).rejects.toThrow('No accessible thread');
});

test('thread title, personal mute and personal pin are scoped to an accessible root', async () => {
  const root = await seed('b:general', 'Planning');
  expect(await call('rename_thread', { conversationId: 'b:general', threadId: root.id, title: 'Roadmap', version: 0 }))
    .toMatchObject({ threadId: root.id, title: 'Roadmap', version: 1 });
  await expect(call('rename_thread', { conversationId: 'b:general', threadId: root.id, title: 'Stale', version: 0 }))
    .rejects.toThrow('thread changed');
  expect(await call('set_thread_muted', { conversationId: 'b:general', threadId: root.id, muted: true })).toMatchObject({ muted: true });
  expect(await call('set_thread_muted', { conversationId: 'b:general', threadId: root.id, muted: false })).toMatchObject({ muted: false });
  expect(await call('set_thread_pin', { conversationId: 'b:general', threadId: root.id, pinned: true })).toMatchObject({ pinned: true });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_thread_pins WHERE org_id=?1 AND user_id=?2 AND message_id=?3').bind(orgId, actor.githubId, root.id).first('n')).toBe(1);
  await expect(call('set_thread_pin', { conversationId: 'b:private', threadId: root.id, pinned: true }, { ...actor, scopes: [...actor.scopes, 'chat:private'] })).rejects.toThrow('No accessible thread');
});

test('send retries persist once, reject changed payload and do not mark read or invoke AI', async () => {
  const args = { conversationId: 'b:general', body: '@AI hello', requestId: 'repeat-send-1' };
  const first = await call('send_message', args);
  const second = await call('send_message', args);
  expect(second.message.id).toBe(first.message.id);
  expect(second.replayed).toBe(true);
  await expect(call('send_message', { ...args, body: 'different' })).rejects.toThrow('different message content');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(1);
  expect(await env.DB.prepare('SELECT 1 FROM channel_reads WHERE org_id=?1').bind(orgId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM cards WHERE org_id=?1').bind(orgId).first()).toBeNull();
});

test('concurrent sends with one request key persist one message', async () => {
  const args = { conversationId: 'b:general', body: 'once', requestId: 'concurrent-1' };
  const [a, b] = await Promise.all([callChatTool(env, actor, 'send_message', args), callChatTool(env, actor, 'send_message', args)]);
  expect(a.structuredContent.message.id).toBe(b.structuredContent.message.id);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(1);
});

test('unavailable attachment is refused before a message is persisted', async () => {
  await expect(call('send_message', { conversationId: 'b:general', body: 'file', requestId: 'missing-file-1', fileIds: ['file-missing'] }, { ...actor, scopes: [...actor.scopes, 'files:write'] })).rejects.toThrow();
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
});

test('repeating add and remove reactions preserves desired state', async () => {
  const row = await seed('b:general', 'react');
  const args = { messageId: row.id, emoji: '👍' };
  await call('add_reaction', args); await call('add_reaction', args);
  expect((await call('get_reactions', { messageId: row.id })).reactions).toMatchObject([{ emoji: '👍', count: 1, mine: true }]);
  await call('remove_reaction', args); await call('remove_reaction', args);
  expect((await call('get_reactions', { messageId: row.id })).reactions).toEqual([]);
});

test('removed members and guessed cross-workspace IDs cannot read', async () => {
  const row = await seed('b:general', 'hello');
  await expect(call('get_message', { messageId: row.id }, { ...actor, orgId: 'other' })).rejects.toThrow('Workspace access');
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, actor.githubId).run();
  await expect(call('read_channel', { conversationId: 'b:general' })).rejects.toThrow('Workspace access');
});

test('old read/write scopes do not grant chat tools', async () => {
  await expect(call('list_conversations', {}, { ...actor, scopes: ['read', 'write'] })).rejects.toThrow('chat:read');
});

test('MCP scheduled delivery rejects a padded case-variant guest membership', async () => {
  await env.DB.prepare("UPDATE memberships SET role=' gUeSt ' WHERE org_id=?1 AND user_github_id=?2").bind(orgId, actor.githubId).run();
  const result = await deliverMcpScheduledMessage(env, { org_id: orgId }, { user_id: actor.githubId, membership_since: (await env.DB.prepare('SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, actor.githubId).first()).created_at });
  expect(result).toEqual({ sent: false });
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
});

test('scheduled retry is stable and revoking its token prevents delivery', async () => {
  const made = await createApiToken(env.DB, { orgId, githubId: actor.githubId, name: 'schedule', scopes: actor.scopes });
  actor.tokenId = made.id;
  const sendAt = new Date(Date.now() + 120000).toISOString();
  const args = { conversationId: 'b:general', body: 'future', requestId: 'schedule-1', sendAt };
  const first = await call('schedule_message', args);
  const retry = await call('schedule_message', args);
  expect(first.scheduledMessage.id).toBe(retry.scheduledMessage.id);
  await env.DB.prepare('DELETE FROM api_tokens WHERE id=?1').bind(made.id).run();
  await runMinuteJobs(env, { now: new Date(Date.now() + 150000) });
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
});

test('scheduled authorized messages are sent once', async () => {
  const made = await createApiToken(env.DB, { orgId, githubId: actor.githubId, name: 'schedule', scopes: actor.scopes });
  actor.tokenId = made.id;
  const sendAt = new Date(Date.now() + 120000).toISOString();
  await call('schedule_message', { conversationId: 'b:general', body: 'future', requestId: 'schedule-2', sendAt });
  await runMinuteJobs(env, { now: new Date(Date.now() + 150000) });
  await runMinuteJobs(env, { now: new Date(Date.now() + 150000) });
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(1);
});


test('DLP applies before MCP immediate and scheduled sends', async () => {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO dlp_rules(id,org_id,name,kind,detector,action,created_by,created_at,updated_at) VALUES('block-card',?1,'Card number','builtin','credit_card','block',?2,?3,?3)").bind(orgId, actor.githubId, now).run();
  await expect(call('send_message', { conversationId: 'b:general', body: '4111 1111 1111 1111', requestId: 'dlp-immediate' })).rejects.toThrow("can't be sent");
  await expect(call('schedule_message', { conversationId: 'b:general', body: '4111 1111 1111 1111', requestId: 'dlp-schedule', sendAt: new Date(Date.now() + 120000).toISOString() })).rejects.toThrow("can't be sent");
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM scheduled_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
});

test.each(['membership', 'token', 'grant'])('a removed %s between preparation and persistence prevents the message', async removed => {
  const conversation = await resolveMcpConversation(env, actor, 'b:general');
  if (removed === 'grant') {
    const membership = await env.DB.prepare('SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, actor.githubId).first();
    await env.DB.prepare("INSERT INTO mcp_oauth_clients(id,owner_id,name,redirect_uris,created_at) VALUES('test-client',?1,'test','[]',?2)").bind(actor.githubId, Date.now()).run();
    await env.DB.prepare("INSERT INTO mcp_oauth_grants(id,client_id,org_id,user_id,membership_since,scopes,resource,sso_backed,created_at,expires_at) VALUES('test-grant','test-client',?1,?2,?3,?4,'https://example.com/mcp',0,?5,?6)").bind(orgId, actor.githubId, membership.created_at, JSON.stringify(actor.scopes), Date.now(), Date.now() + 60000).run();
  }
  const body = { body: 'must not send', clientId: 'tmp-mcp-revocation-race' };
  const prepared = await prepareConversationMessage(env, null, { orgId, user: conversation.user, resolved: conversation.resolved, body });
  if (removed === 'membership') await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, actor.githubId).run();
  else if (removed === 'token') await env.DB.prepare('DELETE FROM api_tokens WHERE id=?1').bind(actor.tokenId).run();
  else await env.DB.prepare("UPDATE mcp_oauth_grants SET revoked_at=?1 WHERE id='test-grant'").bind(Date.now()).run();
  const out = await acceptConversationMessage(env, { orgId, user: conversation.user, resolved: conversation.resolved, body, prepared, conversationActorId: actor.githubId, mcpAuthority: { ...(removed === 'grant' ? { grantId: 'test-grant' } : { tokenId: actor.tokenId }), scope: 'chat:write' } });
  expect(out.error).toBe('Conversation access changed.');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
});

test('channel and group creation retry without duplicating conversations', async () => {
  const args = { type: 'channel', name: 'MCP room', requestId: 'create-room-1' };
  const first = await call('create_conversation', args);
  const second = await call('create_conversation', args);
  expect(second.conversation.id).toBe(first.conversation.id);
  expect(second.created).toBe(false);
  await expect(call('create_conversation', { ...args, name: 'Other room' })).rejects.toThrow('different conversation content');
  const members = await listMembers(env.DB, orgId, actor.githubId);
  const groupArgs = { type: 'group', memberRefs: members.filter(m => m.login !== actor.login).map(m => m.ref), requestId: 'create-group-1' };
  const expanded = { ...actor, scopes: [...actor.scopes, 'chat:dm'] };
  const a = await call('create_conversation', groupArgs, expanded);
  const b = await call('create_conversation', groupArgs, expanded);
  expect(b.conversation.id).toBe(a.conversation.id);
});


test('cancelling a scheduled message in the web app prevents retry resurrection', async () => {
  const args = { conversationId: 'b:general', body: 'cancel me', requestId: 'cancel-schedule-1', sendAt: new Date(Date.now() + 120000).toISOString() };
  const first = await call('schedule_message', args);
  expect(await cancelScheduled(env.DB, orgId, actor.login, first.scheduledMessage.id)).toBe(true);
  await expect(call('schedule_message', args)).rejects.toThrow('was cancelled');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM scheduled_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
});


test('a valid upload is attached atomically and survives a send retry', async () => {
  actor.scopes.push('files:write', 'files:read');
  actor.tokenId = (await createApiToken(env.DB, { orgId, githubId: actor.githubId, name: 'files fixture', scopes: actor.scopes })).id;
  const url = new URL('https://example.com/channels/files?name=hello.txt');
  const response = await uploadFile(new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '5' }, body: 'hello' }), env, url, { orgId, resolved: { key: 'b:general' }, login: actor.login });
  expect(response.status).toBe(201);
  const file = (await response.json()).file;
  const args = { conversationId: 'b:general', body: 'attachment', requestId: 'attach-retry-1', fileIds: [file.id] };
  const first = await call('send_message', args);
  const second = await call('send_message', args);
  expect(second.message.id).toBe(first.message.id);
  expect(first.message.files.map(f => f.id)).toEqual([file.id]);
  expect((await env.DB.prepare('SELECT message_id FROM message_files WHERE id=?1').bind(file.id).first()).message_id).toBe(first.message.id);
});

test('a file named twice is attached once, and the send reports success rather than a reused requestId', async () => {
  actor.scopes.push('files:write', 'files:read');
  actor.tokenId = (await createApiToken(env.DB, { orgId, githubId: actor.githubId, name: 'files fixture', scopes: actor.scopes })).id;
  const url = new URL('https://example.com/channels/files?name=twice.txt');
  const response = await uploadFile(new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '5' }, body: 'twice' }), env, url, { orgId, resolved: { key: 'b:general' }, login: actor.login });
  const file = (await response.json()).file;
  const args = { conversationId: 'b:general', body: 'twice', requestId: 'attach-twice-1', fileIds: [file.id, file.id] };
  const first = await call('send_message', args);
  expect(first.message.files.map(f => f.id)).toEqual([file.id]);
  expect((await call('send_message', args)).message.id).toBe(first.message.id);
});


test.each(['deleted', 'missing', 'other-channel'])('orphan replies with %s parents cannot be read or reacted to', async parentState => {
  const visible = await seed('b:general', 'needle visible');
  const parent = await seed('b:general', 'thread parent');
  const reply = await seed('b:general', 'needle hidden', { parentId: parent.id, alsoChannel: true });
  if (parentState === 'deleted') await env.DB.prepare('UPDATE channel_messages SET deleted_at=?1 WHERE id=?2').bind(new Date().toISOString(), parent.id).run();
  else if (parentState === 'missing') await env.DB.prepare('UPDATE channel_messages SET parent_id=?1 WHERE id=?2').bind('missing-parent', reply.id).run();
  else await env.DB.prepare('UPDATE channel_messages SET channel=?1 WHERE id=?2').bind('b:private', parent.id).run();
  for (const name of ['get_message', 'get_reactions', 'add_reaction', 'remove_reaction']) {
    const args = { messageId: reply.id, ...(name === 'add_reaction' || name === 'remove_reaction' ? { emoji: '👍' } : {}) };
    await expect(call(name, args)).rejects.toThrow('No accessible message');
  }
  const page = await call('read_channel', { conversationId: 'b:general', limit: 1 });
  expect(page.messages.map(message => message.id)).not.toContain(reply.id);
  const search = await call('search_messages', { query: 'needle', limit: 1 });
  expect(search.messages.map(message => message.id)).toEqual([visible.id]);
  expect(search.nextCursor).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM message_reactions WHERE message_id=?1').bind(reply.id).first()).toBeNull();
});

test('a corrupt cross-channel reply cannot enter an authorized thread page', async () => {
  const parent = await seed('b:general', 'parent');
  const reply = await seed('b:general', 'private words', { parentId: parent.id });
  await env.DB.prepare('UPDATE channel_messages SET channel=?1 WHERE id=?2').bind('b:private', reply.id).run();
  expect((await call('read_thread', { conversationId: 'b:general', threadId: parent.id })).replies).toEqual([]);
});


test('chat-only results omit attachments and quote filenames across every message surface', async () => {
  actor.scopes.push('files:write');
  actor.tokenId = (await createApiToken(env.DB, { orgId, githubId: actor.githubId, name: 'attachment fixture', scopes: actor.scopes })).id;
  const url = new URL('https://example.com/channels/files?name=secret-file-name.txt');
  const response = await uploadFile(new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '5' }, body: 'hello' }), env, url, { orgId, resolved: { key: 'b:general' }, login: actor.login });
  const file = (await response.json()).file;
  const sent = await call('send_message', { conversationId: 'b:general', body: '', requestId: 'scope-file-send', fileIds: [file.id] });
  const reply = await call('send_message', { conversationId: 'b:general', body: 'needle quote', requestId: 'scope-file-quote', replyToMessageId: sent.message.id });
  await seed('b:general', 'needle thread', { parentId: sent.message.id });
  const outputs = [sent, reply,
    await call('get_message', { messageId: sent.message.id }),
    await call('read_channel', { conversationId: 'b:general' }),
    await call('read_thread', { conversationId: 'b:general', threadId: sent.message.id }),
    await call('search_messages', { query: 'has:file' }),
    await call('search_messages', { query: 'needle' }),
  ];
  expect(JSON.stringify(outputs)).not.toContain('secret-file-name.txt');
  expect(JSON.stringify(outputs)).not.toContain(file.url);
  expect(sent.message.files).toBeUndefined();
  expect(reply.message.replyTo.excerpt).toBe('');
  expect(reply.message.replyTo.source.fileName).toBeUndefined();
  const allowed = await call('get_message', { messageId: sent.message.id }, { ...actor, scopes: [...actor.scopes, 'files:read'] });
  expect(allowed.message.files[0]).toMatchObject({ id: file.id, name: 'secret-file-name.txt', contentUrl: `https://example.com/mcp/files/${file.id}/content`, requiresAuthorization: true });
  expect(allowed.message.files[0].url).toBeUndefined();
  expect(allowed.message.files[0].expiresAt).toBeUndefined();
});

test.each(['deleted', 'archived'])('a %s private business never becomes an accessible virtual channel', async state => {
  const message = await seed('b:private', 'hidden needle');
  if (state === 'deleted') await env.DB.prepare('DELETE FROM businesses WHERE org_id=?1 AND slug=?2').bind(orgId, 'private').run();
  else await env.DB.prepare('UPDATE businesses SET archived_at=?1 WHERE org_id=?2 AND slug=?3').bind(new Date().toISOString(), orgId, 'private').run();
  await expect(call('read_channel', { conversationId: 'b:private' })).rejects.toThrow('No accessible conversation');
  await expect(call('get_message', { messageId: message.id })).rejects.toThrow('No accessible conversation');
  expect((await call('search_messages', { query: 'hidden' })).messages).toEqual([]);
});

test('DM and group request keys reject changed payloads and cross-kind reuse', async () => {
  const expanded = { ...actor, scopes: [...actor.scopes, 'chat:dm'] };
  const members = (await listMembers(env.DB, orgId, actor.githubId)).filter(member => member.login !== actor.login);
  const args = { type: 'dm', memberRefs: [members[0].ref], requestId: 'stable-dm-request' };
  const first = await call('create_conversation', args, expanded);
  expect((await call('create_conversation', args, expanded)).conversation.id).toBe(first.conversation.id);
  await expect(call('create_conversation', { ...args, memberRefs: [members[1].ref] }, expanded)).rejects.toThrow('different conversation content');
  await expect(call('create_conversation', { ...args, type: 'group', memberRefs: members.map(member => member.ref) }, expanded)).rejects.toThrow('different conversation content');
});

test('concurrent group requests create only one group for the same members', async () => {
  const expanded = { ...actor, scopes: [...actor.scopes, 'chat:dm'] };
  const members = (await listMembers(env.DB, orgId, actor.githubId)).filter(member => member.login !== actor.login);
  const args = { type: 'group', memberRefs: members.map(member => member.ref), requestId: 'concurrent-group-1' };
  const results = await Promise.all([call('create_conversation', args, expanded), call('create_conversation', args, expanded), call('create_conversation', { ...args, requestId: 'concurrent-group-2' }, expanded)]);
  expect(new Set(results.map(result => result.conversation.id)).size).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(DISTINCT channel) n FROM conversation_members WHERE org_id=?1 AND channel LIKE 'g:%'").bind(orgId).first()).n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM conversation_members WHERE org_id=?1 AND channel LIKE 'g:%'").bind(orgId).first()).n).toBe(3);
});

test('retrying a group request after removal does not restore membership', async () => {
  const expanded = { ...actor, scopes: [...actor.scopes, 'chat:dm'] };
  const members = (await listMembers(env.DB, orgId, actor.githubId)).filter(member => member.login !== actor.login);
  const args = { type: 'group', memberRefs: members.map(member => member.ref), requestId: 'removed-group-retry' };
  const { conversation } = await call('create_conversation', args, expanded);
  await env.DB.prepare('DELETE FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login=?3').bind(orgId, conversation.id, actor.login).run();
  await expect(call('create_conversation', args, expanded)).rejects.toThrow('No accessible conversation');
  expect(await env.DB.prepare('SELECT 1 FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login=?3').bind(orgId, conversation.id, actor.login).first()).toBeNull();
});

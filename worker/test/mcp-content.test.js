import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import contentSchema from '../mcp-content.sql?raw';
import { callContentTool, handleMcpContentUpload } from '../src/mcpContentTools.js';
import { upsertUser, upsertMembership } from '../src/db.js';
import { setMode } from '../src/harness/mode.js';
import { createApp } from '../src/harness/apps.js';
import { fileKey } from '../src/files.js';
import { listMembers } from '../src/team.js';

const orgId = 'personal:mcp-content';
const request = new Request('https://example.com/mcp');
let actor;
const run = async (name, args = {}, who = actor) => (await callContentTool(env, who, name, args, request)).structuredContent;

beforeEach(async () => {
  await env.DB.exec(contentSchema.replace(/\n/g, ' '));
  await upsertUser(env.DB, { githubId: '7101', login: 'u:one@example.test', name: 'One', locale: 'en' });
  await upsertUser(env.DB, { githubId: '7102', login: 'u:two@example.test', name: 'Two', locale: 'en' });
  await upsertMembership(env.DB, orgId, '7101', 'admin');
  await upsertMembership(env.DB, orgId, '7102', 'member');
  for (const [slug, privateRoom] of [['general', 0], ['private', 1]]) {
    await env.DB.prepare('INSERT INTO businesses (org_id,slug,name,private,created_at) VALUES (?1,?2,?2,?3,?4)').bind(orgId, slug, privateRoom, new Date().toISOString()).run();
  }
  await env.DB.prepare('INSERT INTO conversation_members (org_id,channel,login,added_at) VALUES (?1,?2,?3,?4)').bind(orgId, 'b:private', 'u:one@example.test', new Date().toISOString()).run();
  actor = { orgId, githubId: '7101', login: 'u:one@example.test', name: 'One', tokenId: 'key-1', scopes: ['users:read', 'files:read', 'files:write', 'canvases:read', 'canvases:write', 'lists:read', 'lists:write'] };
});

test('people results use opaque IDs, paginate and require an explicit scope', async () => {
  await expect(run('search_users', {}, { ...actor, scopes: ['read'] })).rejects.toThrow('users:read');
  const first = await run('search_users', { limit: 1 });
  const second = await run('search_users', { limit: 1, cursor: first.nextCursor });
  expect(first.users).toHaveLength(1);
  expect(second.users).toHaveLength(1);
  expect(first.users[0].userId).not.toBe(second.users[0].userId);
  const profile = await run('get_user', { userId: first.users[0].userId });
  expect(profile.user.userId).toBe(first.users[0].userId);
  expect(JSON.stringify({ first, second, profile })).not.toContain('@example.test');
  await expect(run('list_channel_members', { conversation: 'b:private' })).rejects.toThrow('chat:private');
});

test('canvas writes persist versions and refuse stale or missing audience grants', async () => {
  await expect(run('create_canvas', { conversation: 'b:private', body: 'private' })).rejects.toThrow('chat:private');
  const created = await run('create_canvas', { conversation: 'b:general', body: 'first' });
  expect(created.canvas).toMatchObject({ body: 'first', version: 1 });
  const changed = await run('update_canvas', { conversation: 'b:general', body: 'second', baseVersion: 1 });
  expect(changed.canvas.version).toBe(2);
  await expect(run('update_canvas', { conversation: 'b:general', body: 'stale', baseVersion: 1 })).rejects.toThrow('canvas changed');
  expect((await env.DB.prepare('SELECT body FROM channel_canvases WHERE org_id=?1 AND channel=?2').bind(orgId, 'b:general').first()).body).toBe('second');
  const privateActor = { ...actor, scopes: [...actor.scopes, 'chat:private'] };
  await run('create_canvas', { conversation: 'b:private', body: 'private' }, privateActor);
  await expect(run('read_canvas', { conversation: 'b:private' })).rejects.toThrow('chat:private');
});

test('file reads enforce live parent, audience and current membership without signed URLs', async () => {
  const fileId = 'f_111111111111111111111111';
  await env.DB.prepare("INSERT INTO channel_messages (id,org_id,channel,author_login,body,created_at) VALUES ('head',?1,'b:private',?2,'parent',?3)").bind(orgId, actor.login, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO channel_messages (id,org_id,channel,author_login,body,parent_id,created_at) VALUES ('reply',?1,'b:private',?2,'reply','head',?3)").bind(orgId, actor.login, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO message_files (id,org_id,channel,message_id,uploader,name,type,size,created_at) VALUES (?1,?2,'b:private','reply',?3,'report.txt','text/plain',5,?4)").bind(fileId, orgId, actor.login, new Date().toISOString()).run();
  await env.MEDIA.put(fileKey(orgId, fileId), 'hello');
  await expect(run('get_file', { fileId })).rejects.toThrow('chat:private');
  const privateActor = { ...actor, scopes: [...actor.scopes, 'chat:private'] };
  const read = await run('read_file', { fileId }, privateActor);
  expect(read.text).toBe('hello');
  expect(read.file.contentUrl).toBe(`https://example.com/mcp/files/${fileId}/content`);
  expect(read.file.requiresAuthorization).toBe(true);
  const response = await handleMcpContentUpload(new Request(read.file.contentUrl), env, new URL(read.file.contentUrl), privateActor);
  expect(await response.text()).toBe('hello');
  expect(response.headers.get('content-disposition')).toBe('attachment');
  await env.DB.prepare("UPDATE channel_messages SET deleted_at=?1 WHERE id='head'").bind(new Date().toISOString()).run();
  await expect(run('read_file', { fileId }, privateActor)).rejects.toThrow('No such file');
});

test('upload reservation is connection-bound and retries create one file', async () => {
  const input = { conversation: 'b:general', name: 'hello.txt', contentType: 'text/plain', size: 5, requestId: 'upload-001' };
  const reservation = await run('get_file_upload_url', input);
  expect(await run('get_file_upload_url', input)).toEqual(reservation);
  await expect(run('get_file_upload_url', { ...input, name: 'other.txt' })).rejects.toThrow('different input');
  const put = () => new Request(reservation.uploadUrl, { method: 'PUT', headers: { 'content-type': 'text/plain', 'content-length': '5' }, body: 'hello' });
  const denied = await handleMcpContentUpload(put(), env, new URL(reservation.uploadUrl), { ...actor, tokenId: 'key-2' });
  expect(denied.status).toBe(400);
  const uploaded = await handleMcpContentUpload(put(), env, new URL(reservation.uploadUrl), actor);
  expect(uploaded.status).toBe(201);
  expect((await handleMcpContentUpload(put(), env, new URL(reservation.uploadUrl), actor)).status).toBe(200);
  const completed = await run('complete_file_upload', { uploadId: reservation.uploadId });
  expect(completed.shared).toBe(false);
  expect((await run('read_file', { fileId: completed.fileId })).text).toBe('hello');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM message_files WHERE org_id=?1').bind(orgId).first()).n).toBe(1);
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId, actor.githubId).run();
  await expect(run('complete_file_upload', { uploadId: reservation.uploadId })).rejects.toThrow('Workspace access');
});

test('private DM file reservations require explicit DM consent', async () => {
  const members = await listMembers(env.DB, orgId, actor.githubId);
  const other = members.find(member => member.userId === '7102');
  const input = { conversation: `dm:${other.ref}`, name: 'private.txt', contentType: 'text/plain', size: 1, requestId: 'upload-dm-001' };
  await expect(run('get_file_upload_url', input)).rejects.toThrow('chat:dm');
  const granted = await run('get_file_upload_url', input, { ...actor, scopes: [...actor.scopes, 'chat:dm'] });
  expect(granted.uploadId).toBeTruthy();
});

test('lists retain IDs, deduplicate creates, enforce mode and reject stale edits', async () => {
  const input = { name: 'Tasks', columns: [{ name: 'Name', type: 'text' }], requestId: 'list-create-001' };
  await expect(run('create_list', input)).rejects.toThrow('Harness');
  await setMode(env.DB, orgId, 'harness', actor.githubId);
  const created = await run('create_list', input);
  expect((await run('create_list', input)).list.id).toBe(created.list.id);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_tables WHERE org_id=?1').bind(orgId).first()).n).toBe(1);
  const add = { listId: created.list.id, values: { name: 'One' }, requestId: 'list-row-001' };
  const added = await run('add_list_record', add);
  expect((await run('add_list_record', add)).record.id).toBe(added.record.id);
  const changed = await run('update_list_record', { listId: created.list.id, recordId: added.record.id, values: { name: 'Two' }, expectedUpdatedAt: added.record.updatedAt });
  expect(changed.record.values.name).toBe('Two');
  await expect(run('update_list_record', { listId: created.list.id, recordId: added.record.id, values: { name: 'Stale' }, expectedUpdatedAt: added.record.updatedAt })).rejects.toThrow('changed');
  const read = await run('read_list', { listId: created.list.id });
  expect(read.records).toHaveLength(1);
  expect(read.records[0].id).toBe(added.record.id);
  expect(read.records[0].values.name).toBe('Two');
  const updated = await run('update_list', { listId: created.list.id, name: 'Changed', expectedUpdatedAt: created.list.updatedAt });
  expect(updated.list.name).toBe('Changed');
  await expect(run('update_list', { listId: created.list.id, name: 'Stale', expectedUpdatedAt: created.list.updatedAt })).rejects.toThrow('changed');
});

test('private app tables stay hidden and cannot be modified through list tools', async () => {
  await setMode(env.DB, orgId, 'harness', actor.githubId);
  const created = await createApp(env.DB, { orgId, by: '7102', name: 'Private', columns: [{ name: 'Name', type: 'text' }], privateByDefault: true });
  expect(created.error).toBeUndefined();
  expect((await run('list_lists')).lists).toHaveLength(0);
  await expect(run('read_list', { listId: created.app.tableId })).rejects.toThrow('No such list');
  await expect(run('add_list_record', { listId: created.app.tableId, values: { name: 'No' }, requestId: 'private-001' })).rejects.toThrow('No such list');
});

test('file name search is bounded, escapes wildcard text and pages only permitted room files', async () => {
  const files = [
    ['f_222222222222222222222222', 'report%one.txt'],
    ['f_333333333333333333333333', 'report%two.txt'],
    ['f_444444444444444444444444', 'report-other.txt'],
  ];
  for (const [id, name] of files) await env.DB.prepare("INSERT INTO message_files (id,org_id,channel,message_id,uploader,name,type,size,created_at) VALUES (?1,?2,'b:general',NULL,?3,?4,'text/plain',1,?5)").bind(id, orgId, actor.login, name, new Date().toISOString()).run();
  const first = await run('search_files', { conversation: 'b:general', query: '%', limit: 1 });
  const second = await run('search_files', { conversation: 'b:general', query: '%', limit: 1, cursor: first.nextCursor });
  expect(first.files.map(file => file.name)).toEqual(['report%one.txt']);
  expect(second.files.map(file => file.name)).toEqual(['report%two.txt']);
  expect(second.nextCursor).toBeNull();
  await expect(run('search_files', { conversation: 'b:private' })).rejects.toThrow('chat:private');
});

test('concurrent request IDs create one list and changed input never reuses its result', async () => {
  await setMode(env.DB, orgId, 'harness', actor.githubId);
  const input = { name: 'Once', columns: [{ name: 'Name', type: 'text' }], requestId: 'list-concurrent-001' };
  const outcomes = await Promise.allSettled([run('create_list', input), run('create_list', input)]);
  expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM hx_tables WHERE org_id=?1').bind(orgId).first()).n).toBe(1);
  await expect(run('create_list', { ...input, name: 'Different' })).rejects.toThrow('different input');
  const replay = await run('create_list', { requestId: input.requestId, columns: input.columns, name: input.name });
  expect(replay.list.name).toBe('Once');
});

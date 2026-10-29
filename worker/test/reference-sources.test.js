import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { referenceMessages } from '../src/channels.js';
import { createSession, upsertMembership, upsertUser, upsertBusiness } from '../src/db.js';

const orgId = 'personal:reference-sources';
const channel = 'b:general';
let token;
const message = (id, { parentId = null, workspace = orgId, sourceChannel = channel, deletedAt = null, alsoChannel = 0 } = {}) => env.DB.prepare(`INSERT INTO channel_messages
  (id,org_id,channel,author_login,kind,body,parent_id,deleted_at,also_channel,created_at)
  VALUES(?,?,?,'source-reader','message',?,?,?,?,'2026-10-01')`)
  .bind(id, workspace, sourceChannel, `Synthetic private body ${id}`, parentId, deletedAt, alsoChannel).run();
const read = (ids, session = token, database = env.DB) => worker.fetch(new Request(`https://example.test/channels/messages?${new URLSearchParams({ orgId, channel, sourceIds: JSON.stringify(ids) })}`, {
  headers: { 'x-session-token': session },
}), { ...env, DB: database });

beforeEach(async () => {
  await upsertUser(env.DB, { githubId: 'source-reader-id', login: 'source-reader', name: 'Source Reader' });
  await upsertMembership(env.DB, orgId, 'source-reader-id', 'member');
  await upsertBusiness(env.DB, orgId, { name: 'General', createdBy: 'source-reader-id' });
  token = await createSession(env.DB, 'source-reader-id', 'synthetic');
});

test('root tombstone fences an also-channel late child and its file before second-pass cleanup', async () => {
  await message('root');
  await message('late-child', { parentId: 'root', alsoChannel: 1 });
  await env.DB.prepare(`INSERT INTO message_files(id,org_id,channel,message_id,uploader,name,type,size,created_at)
    VALUES('f_0123456789abcdef01234567',?,?,'late-child','source-reader','Synthetic secret attachment.txt','text/plain',7,'2026-10-01')`).bind(orgId, channel).run();
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='now' WHERE id='root' AND org_id=?").bind(orgId).run();
  const response = await read(['root', 'late-child']);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({ id: 'root', deleted: true, body: '', files: [] });
  expect(result.missingIds).toEqual(['late-child']);
  expect(JSON.stringify(result)).not.toContain('Synthetic private body');
  expect(JSON.stringify(result)).not.toContain('Synthetic secret attachment');
  expect((await env.DB.prepare("SELECT deleted_at FROM channel_messages WHERE id='late-child'").first()).deleted_at).toBeNull();
});

test.each(['missing', 'deleted', 'wrong-channel', 'wrong-org', 'non-root'])('a live child cannot expose a %s parent source', async state => {
  if (state !== 'missing') await message('parent', {
    deletedAt: state === 'deleted' ? 'now' : null,
    sourceChannel: state === 'wrong-channel' ? 'b:elsewhere' : channel,
    workspace: state === 'wrong-org' ? 'another-org' : orgId,
    parentId: state === 'non-root' ? 'ancestor' : null,
  });
  await message('child', { parentId: 'parent', alsoChannel: 1 });
  const result = await (await read(['child'])).json();
  expect(result).toEqual({ messages: [], missingIds: ['child'] });
});

test('live matching root children remain readable, while a deleted source stays sanitized even with a dead parent', async () => {
  await message('root');
  await message('live-child', { parentId: 'root' });
  await message('deleted-child', { parentId: 'absent-root', deletedAt: 'now' });
  const result = await (await read(['live-child', 'deleted-child'])).json();
  expect(result.messages.find(m => m.id === 'live-child')).toMatchObject({ deleted: false, body: 'Synthetic private body live-child', authorName: 'Source Reader' });
  expect(result.messages.find(m => m.id === 'deleted-child')).toMatchObject({ deleted: true, body: '', files: [] });
  expect(result.missingIds).toEqual([]);
});

test('sixty authorized IDs use one source selection query, stay under parameter limits, and present once', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `source-${i}`);
  await env.DB.batch(ids.map(id => env.DB.prepare(`INSERT INTO channel_messages
    (id,org_id,channel,author_login,kind,body,created_at) VALUES(?,?,?,'source-reader','message','Synthetic source','2026-10-01')`).bind(id, orgId, channel)));
  const queries = [];
  const database = new Proxy(env.DB, { get(db, property) {
    if (property === 'prepare') return sql => {
      queries.push(sql);
      const prepared = db.prepare(sql);
      return new Proxy(prepared, { get(statement, method) {
        if (method === 'bind') return (...args) => { expect(args.length).toBeLessThanOrEqual(100); return statement.bind(...args); };
        const value = statement[method]; return typeof value === 'function' ? value.bind(statement) : value;
      } });
    };
    const value = db[property]; return typeof value === 'function' ? value.bind(db) : value;
  } });
  const response = await read(ids, token, database);
  expect(response.status).toBe(200);
  expect((await response.json()).messages).toHaveLength(60);
  expect(queries.filter(sql => sql.includes('m.id IN (') && sql.includes('thread_title'))).toHaveLength(1);
  expect(queries.filter(sql => sql.includes('m.id = ?2') && sql.includes('thread_title'))).toHaveLength(0);
  expect(queries.filter(sql => sql.includes('SELECT parent_id, author_login, kind, created_at'))).toHaveLength(1);
  expect(queries.filter(sql => sql.includes('SELECT message_id, emoji, login'))).toHaveLength(1);
});

test('empty source IDs skip source SQL; input bounds and authentication remain enforced', async () => {
  expect(await referenceMessages({ prepare: () => { throw new Error('Empty IDs must not query'); } }, orgId, channel, [])).toEqual([]);
  expect(await (await read([])).json()).toEqual({ messages: [], missingIds: [] });
  expect((await read(['unknown'], 'invalid-session')).status).toBe(401);
  expect((await read(Array.from({ length: 61 }, (_, i) => String(i)))).status).toBe(400);
  expect((await read([42])).status).toBe(400);
});

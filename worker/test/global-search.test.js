import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';
import { setMode } from '../src/harness/mode.js';
import { createFileLedger } from '../src/harness/fileVersionLedger.js';
import { appendFileVersion } from '../src/harness/fileVersionLedger.js';
import fileSql from '../workspace-files.sql?raw';

const orgId = 'personal:global-search';
let token, guestToken;
const call = (path, method = 'GET', body, session = token, raw = false) => worker.fetch(new Request(
  `https://example.test${path}${path.includes('?') ? '&' : '?'}orgId=${encodeURIComponent(orgId)}`,
  { method, headers: { 'x-session-token': session || '', 'content-type': raw ? 'text/plain' : 'application/json' }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) },
), env);

beforeEach(async () => {
  await env.DB.exec(fileSql.replace(/\n/g, ' '));
  await upsertUser(env.DB, { githubId: 'search-human', login: 'search-human', name: 'Search Human' });
  await upsertUser(env.DB, { githubId: 'search-guest', login: 'search-guest', name: 'Search Guest' });
  await upsertUser(env.DB, { githubId: 'search-owner', login: 'search-owner', name: 'Search Owner' });
  await upsertMembership(env.DB, orgId, 'search-human', 'admin');
  await upsertMembership(env.DB, orgId, 'search-guest', 'guest');
  await upsertMembership(env.DB, orgId, 'search-owner', 'member');
  token = await createSession(env.DB, 'search-human', 'test');
  guestToken = await createSession(env.DB, 'search-guest', 'test');
  await setMode(env.DB, orgId, 'harness', 'search-human');
  await env.DB.prepare(`INSERT INTO businesses(org_id,slug,name,created_at,private) VALUES(?1,'general','General',?2,0), (?1,'locked','Locked',?2,1)`)
    .bind(orgId, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES
    ('search-public',?1,'b:general','search-human','message','needle in a public room',?2),
    ('search-private',?1,'b:locked','search-owner','message','needle private room body',?2)`)
    .bind(orgId, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO message_files(id,org_id,channel,message_id,uploader,name,type,size,created_at) VALUES
    ('f_aaaaaaaaaaaaaaaaaaaaaaaa',?1,'b:general','search-public','search-human','needle-public.pdf','application/pdf',10,?2),
    ('f_bbbbbbbbbbbbbbbbbbbbbbbb',?1,'b:locked','search-private','search-owner','needle-private.pdf','application/pdf',10,?2)`)
    .bind(orgId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('table-visible',?1,'Visible Tasks','[{\"id\":\"title\",\"name\":\"Title\",\"type\":\"text\"}]','search-human',?2,?2), ('table-private',?1,'Private Tasks','[{\"id\":\"title\",\"name\":\"Title\",\"type\":\"text\"}]','search-owner',?2,?2)")
    .bind(orgId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES('row-visible','table-visible',?1,'{\"title\":\"needle visible record\"}',1,'search-human',?2,?2), ('row-private','table-private',?1,'{\"title\":\"needle private record\"}',1,'search-owner',?2,?2)")
    .bind(orgId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('app-visible',?1,'Visible app','table-visible','{}','search-human',?2,?2), ('app-private',?1,'Private app','table-private','{}','search-owner',?2,?2)")
    .bind(orgId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,'app-private','private',1)").bind(orgId).run();
  await env.DB.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at)
    VALUES('workflow-needle',?1,'needle automation',1,'{"type":"manual"}','[]','search-human',?2,?2)`)
    .bind(orgId, new Date().toISOString()).run();
});

test('Harness global search groups visible messages, attachment names, file body, rows, and automations', async () => {
  const { id: fileId } = await (await call('/hx/files', 'POST', { scope: 'workspace', path: 'docs/plan.txt' })).json();
  expect((await call(`/hx/files/${fileId}/content?expectedVersion=0&size=21`, 'PUT', 'needle file body text', token, true)).status).toBe(200);

  const response = await call('/hx/search/resources?q=needle');
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.messages.map(message => message.id)).toContain('search-public');
  expect(result.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'f_aaaaaaaaaaaaaaaaaaaaaaaa', source: 'attachment', name: 'needle-public.pdf' }),
    expect.objectContaining({ id: fileId, source: 'workspace', path: 'docs/plan.txt', matchedBy: 'content' }),
  ]));
  expect(result.records).toEqual([expect.objectContaining({ rowId: 'row-visible', tableId: 'table-visible', appId: 'app-visible' })]);
  expect(result.automations).toEqual([expect.objectContaining({ id: 'workflow-needle', name: 'needle automation', triggerType: 'manual' })]);
  expect(JSON.stringify(result)).not.toContain('needle file body text');
  expect(JSON.stringify(result)).not.toContain('hook_secret');
});

test('current room and App ACLs suppress private messages, attachments, and records; guests and Simple mode cannot use the Harness endpoint', async () => {
  const response = await call('/hx/search/resources?q=needle');
  const result = await response.json();
  expect(result.messages.map(message => message.id)).not.toContain('search-private');
  expect(result.files.map(file => file.id)).not.toContain('f_bbbbbbbbbbbbbbbbbbbbbbbb');
  expect(result.records.map(record => record.rowId)).not.toContain('row-private');
  expect((await call('/hx/search/resources?q=needle', 'GET', undefined, guestToken)).status).toBe(403);

  await setMode(env.DB, orgId, 'simple', 'search-human');
  expect((await call('/hx/search/resources?q=needle')).status).toBe(404);
  const simple = await call('/channels/search?q=needle');
  expect(simple.status).toBe(200);
  expect((await simple.json()).messages.map(message => message.id)).toContain('search-public');
});

test('text indexing is size-bounded, current-version-only, and removed on update or delete', async () => {
  const tooLarge = 'over-bound-' + 'x'.repeat(128 * 1024);
  const { id: largeId } = await (await call('/hx/files', 'POST', { scope: 'workspace', path: 'large.txt' })).json();
  expect((await call(`/hx/files/${largeId}/content?expectedVersion=0&size=${tooLarge.length}`, 'PUT', tooLarge, token, true)).status).toBe(200);
  expect(await env.DB.prepare('SELECT 1 FROM hx_workspace_file_search WHERE org_id=?1 AND file_id=?2').bind(orgId, largeId).first()).toBeNull();

  const { id } = await (await call('/hx/files', 'POST', { scope: 'workspace', path: 'changing.txt' })).json();
  expect((await call(`/hx/files/${id}/content?expectedVersion=0&size=18`, 'PUT', 'needle old version', token, true)).status).toBe(200);
  expect((await env.DB.prepare('SELECT version FROM hx_workspace_file_search WHERE org_id=?1 AND file_id=?2').bind(orgId, id).first()).version).toBe(1);
  expect((await call(`/hx/files/${id}`,'DELETE',{expectedVersion:1})).status).toBe(200);
  expect(await env.DB.prepare('SELECT 1 FROM hx_workspace_file_search WHERE org_id=?1 AND file_id=?2').bind(orgId, id).first()).toBeNull();
  const result = await (await call('/hx/search/resources?q=needle')).json();
  expect(result.files.map(file => file.id)).not.toContain(id);
});

test('per-Workspace body retention stays at the newest 256 current files', async () => {
  for (let i = 0; i < 257; i++) {
    const fileId = `retention-${String(i).padStart(3, '0')}`;
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    await env.DB.prepare('INSERT INTO hx_workspace_files(org_id,id,scope,path,created_by,created_login,created_at,updated_at,current_version) VALUES(?1,?2,\'workspace\',?3,\'search-human\',\'search-human\',?4,?4,1)')
      .bind(orgId, fileId, `${fileId}.txt`, at).run();
    await env.DB.prepare(`INSERT INTO hx_workspace_file_versions(org_id,file_id,version,operation_id,kind,object_key,content_hash,content_type,size,created_by,created_login,created_at)
      VALUES(?1,?2,1,?3,'content',?4,?5,'text/plain',1,'search-human','search-human',?6)`)
      .bind(orgId, fileId, `op-${i}`, `org/${encodeURIComponent(orgId)}/workspace-files/${fileId}`, 'a'.repeat(64), at).run();
    await env.DB.prepare('INSERT INTO hx_workspace_file_search(org_id,file_id,version,body) VALUES(?1,?2,1,\'x\')').bind(orgId, fileId).run();
  }
  const fileId = 'retention-newest';
  expect((await createFileLedger(env.DB, { orgId, fileId, scope: 'workspace', path: `${fileId}.txt`, createdBy: 'search-human' })).created).toBe(true);
  expect((await appendFileVersion(env.DB, { orgId, fileId, expectedVersion: 0, createdBy: 'search-human', objectKey: `org/${encodeURIComponent(orgId)}/workspace-files/${fileId}`, contentHash: 'b'.repeat(64), contentType: 'text/plain', size: 1, searchText: 'new' })).saved).toBe(true);
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM hx_workspace_file_search WHERE org_id=?1').bind(orgId).first()).count).toBe(256);
  expect(await env.DB.prepare('SELECT 1 FROM hx_workspace_file_search WHERE org_id=?1 AND file_id=\'retention-000\'').bind(orgId).first()).toBeNull();
});

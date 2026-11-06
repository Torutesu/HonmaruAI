import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import schemaSql from '../schema.sql?raw';
import filesSql from '../workspace-files.sql?raw';
import worker from '../src/index.js';
import { upsertUser, upsertMembership, createSession } from '../src/db.js';
import { createFileLedger, appendFileVersion } from '../src/harness/fileVersionLedger.js';

const ORG = 'personal:unified-search';
let alice, bob, outsider;
const req = (path, token, init = {}) => worker.fetch(new Request(`https://example.com${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(token ? { 'x-session-token': token } : {}), ...(init.headers || {}) },
}), env);
const get = (path, token) => req(path, token);
const send = (path, token, body) => req(path, token, { method: 'POST', body: JSON.stringify(body) });
const q = (values) => new URLSearchParams(values).toString();

async function seedFile({ id, scope = 'workspace', body, orgId = ORG, path = `${id}.txt`, owner = '9201' }) {
  await createFileLedger(env.DB, { orgId, fileId: id, scope, path, createdBy: owner });
  const objectKey = `org/${encodeURIComponent(orgId)}/workspace-files/${id}`;
  const bytes = new TextEncoder().encode(body);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  await env.MEDIA.put(objectKey, bytes);
  await appendFileVersion(env.DB, { orgId, fileId: id, expectedVersion: 0, createdBy: owner, objectKey, contentHash, contentType: 'text/plain', size: bytes.byteLength });
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.exec(filesSql.replace(/\n/g, ' '));
  for (const [id, login, name] of [['9201', 'alice', 'Alice'], ['9202', 'bob', 'Bob'], ['9203', 'outsider', 'Outsider']]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: 'en' });
  }
  await upsertMembership(env.DB, ORG, '9201', 'admin');
  await upsertMembership(env.DB, ORG, '9202', 'member');
  await upsertMembership(env.DB, 'personal:other-org', '9203', 'admin');
  alice = await createSession(env.DB, '9201', 'unified_alice');
  bob = await createSession(env.DB, '9202', 'unified_bob');
  outsider = await createSession(env.DB, '9203', 'unified_outsider');
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?1,'payroll','Payroll',1,'9201','2026-01-01T00:00:00.000Z')").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,'b:payroll','alice','2026-01-01T00:00:00.000Z')").bind(ORG).run();
});

test('file body search includes authorized content and excludes private-room and cross-org files before limits', async () => {
  await seedFile({ id: 'workspace-doc', body: 'The unique NeedleStar is in this document.' });
  await seedFile({ id: 'private-doc', scope: 'b:payroll', body: 'NeedleStar behind the private room door.' });
  await seedFile({ id: 'other-org-doc', orgId: 'personal:other-org', owner: '9203', body: 'NeedleStar in another workspace.' });
  await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_by,updated_at) VALUES (?1,'harness','9201','now')").bind(ORG).run();

  const owner = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, alice)).json();
  expect(owner.files.map((file) => file.id)).toEqual(['private-doc', 'workspace-doc']);
  expect(owner.files.every((file) => file.snippet.includes('NeedleStar'))).toBe(true);

  const member = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, bob)).json();
  expect(member.files.map((file) => file.id)).toEqual(['workspace-doc']);
  expect(JSON.stringify(member)).not.toContain('private-doc');
  expect(JSON.stringify(member)).not.toContain('private room door');
  expect(JSON.stringify(member)).not.toContain('other-org-doc');
  expect((await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, outsider)).status).toBe(403);
});

test('a membership revoked during the R2 body fetch cannot leak file metadata or snippets', async () => {
  await seedFile({ id: 'raced-private-doc', body: 'NeedleStar body must be dropped after revocation.' });
  await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_by,updated_at) VALUES (?1,'harness','9201','now')").bind(ORG).run();
  const racedEnv = {
    ...env,
    MEDIA: { get: async (key) => {
      const object = await env.MEDIA.get(key);
      await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG, '9201').run();
      return object;
    } },
  };
  const response = await worker.fetch(new Request(`https://example.com/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, {
    headers: { 'x-session-token': alice },
  }), racedEnv);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.files).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('raced-private-doc');
  expect(JSON.stringify(result)).not.toContain('body must be dropped');
});

test('app row content is returned only to users authorized for the app, with snippets and stable caps', async () => {
  await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_by,updated_at) VALUES (?1,'harness','9201','now')").bind(ORG).run();
  const publicAppRes = await send('/apps', bob, { orgId: ORG, name: 'Public records', columns: [{ name: 'Title', type: 'text' }] });
  const { app: publicApp } = await publicAppRes.json();
  await send(`/tables/${publicApp.tableId}/rows`, bob, { orgId: ORG, values: { Title: 'NeedleStar public record' } });

  const privateAppRes = await send('/apps', alice, { orgId: ORG, name: 'Private records', columns: [{ name: 'Title', type: 'text' }] });
  const { app: privateApp } = await privateAppRes.json();
  await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?1,?2,'private',1)").bind(ORG, privateApp.id).run();
  await env.DB.prepare("INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at) VALUES ('private-row',?1,?2,'{\"title\":\"NeedleStar private record\"}',1,'9201','9201','2026-01-01','2026-01-01')").bind(privateApp.tableId, ORG).run();

  const bobResults = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, bob)).json();
  expect(bobResults.records).toHaveLength(1);
  expect(bobResults.records[0]).toMatchObject({ appId: publicApp.id, appName: 'Public records', tableId: publicApp.tableId, snippet: 'Title: NeedleStar public record' });
  expect(JSON.stringify(bobResults)).not.toContain('private-row');
  expect(JSON.stringify(bobResults)).not.toContain('Private records');

  const aliceResults = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, alice)).json();
  expect(aliceResults.records.map((record) => record.rowId)).toContain('private-row');
  expect(aliceResults.records.some((record) => record.appId === publicApp.id)).toBe(true);
});

test('Simple mode keeps the legacy message-only response shape', async () => {
  await seedFile({ id: 'simple-doc', body: 'NeedleStar remains in storage.' });
  const result = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, alice)).json();
  expect(result).toHaveProperty('messages');
  expect(result).toHaveProperty('query');
  expect(result).not.toHaveProperty('files');
  expect(result).not.toHaveProperty('records');
});

test('file and record candidate/result bounds are explicit and deterministic', async () => {
  await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_by,updated_at) VALUES (?1,'harness','9201','now')").bind(ORG).run();
  // Body fetches are capped at 25 regardless of how many files match; every
  // request advertises that the bounded result is incomplete.
  for (let i = 0; i < 26; i++) await seedFile({ id: `bounded-${String(i).padStart(2, '0')}`, body: 'NeedleStar bounded body', path: `bounded-${String(i).padStart(2, '0')}.txt` });
  const result = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, alice)).json();
  expect(result.files).toHaveLength(8);
  expect(result.filesTruncated).toBe(true);
  expect(result.filesNextCursor).toBeTruthy();
  expect(new Set(result.files.map((file) => file.id)).size).toBe(result.files.length);
  const next = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar', fileCursor: result.filesNextCursor, skipRecords: '1' })}`, alice)).json();
  expect(next.files.length).toBeGreaterThan(0);
  expect(next.files.some((file) => result.files.some((first) => first.id === file.id))).toBe(false);
});

test('record results continue deterministically after the first bounded page', async () => {
  await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_by,updated_at) VALUES (?1,'harness','9201','now')").bind(ORG).run();
  const created = await send('/apps', bob, { orgId: ORG, name: 'Paged records', columns: [{ name: 'Title', type: 'text' }] });
  const { app } = await created.json();
  for (let i = 0; i < 10; i++) {
    const id = `page-row-${String(i).padStart(2, '0')}`;
    await env.DB.prepare(`INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,updated_by,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,'9202','9202',?6,?6)`)
      .bind(id, app.tableId, ORG, JSON.stringify({ title: `NeedleStar record ${i}` }), i, `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`).run();
  }
  const first = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, bob)).json();
  expect(first.records).toHaveLength(8);
  expect(first.recordsNextCursor).toBeTruthy();
  const second = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar', recordCursor: first.recordsNextCursor, skipFiles: '1' })}`, bob)).json();
  expect(second.records).toHaveLength(2);
  expect(second.records.some((record) => first.records.some((page) => page.rowId === record.rowId))).toBe(false);
});

test('Simple-only preference suppresses resource additions while leaving messages intact', async () => {
  await seedFile({ id: 'simple-only-doc', body: 'NeedleStar stays searchable only from simple search messages.' });
  await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_by,updated_at) VALUES (?1,'harness','9201','now')").bind(ORG).run();
  await env.DB.prepare("INSERT INTO hx_user_display_preferences(org_id,user_id,simple_only,revision,updated_at) VALUES (?1,'9201',1,1,'now')").bind(ORG).run();
  const result = await (await get(`/channels/search?${q({ orgId: ORG, q: 'NeedleStar' })}`, alice)).json();
  expect(result).toHaveProperty('messages');
  expect(result).not.toHaveProperty('files');
  expect(result).not.toHaveProperty('records');
});

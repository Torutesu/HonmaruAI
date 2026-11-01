import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createSession, sessionKey, upsertMembership, upsertUser } from '../src/db.js';
import { createSkill } from '../src/harness/skills.js';
import { createSkillShare, downloadSkillShare, importSkillShare, readSkillShare } from '../src/harness/skillShares.js';
import worker from '../src/index.js';

const source = 'share-lifecycle-source';
const destination = 'share-lifecycle-destination';
const actor = '9981';
const confirmed = { confirmAnyoneWithLink: true };
const count = async table => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
async function fixture() {
  await upsertUser(env.DB, { githubId: actor, login: 'share-lifecycle', name: 'Owner', locale: 'en' });
  await upsertMembership(env.DB, source, actor, 'member');
  await upsertMembership(env.DB, destination, actor, 'member');
  return (await createSkill(env.DB, source, { name: 'Procedure', description: 'A procedure', body: 'Instructions', visibility: 'private' }, actor)).skill;
}
async function transition(orgId, state) {
  if (state === 'mixed-case guest') {
    await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1 AND user_github_id=?2").bind(orgId, actor).run();
  } else if (state === 'rejoined') {
    await env.DB.prepare("UPDATE memberships SET created_at='new-membership-generation' WHERE org_id=?1 AND user_github_id=?2").bind(orgId, actor).run();
  } else if (state === 'purge started') {
    await env.DB.prepare(`INSERT INTO workspace_deletions (org_id,due_at,requested_by,requested_at,purge_started_at)
      VALUES (?1,'2026-01-01',?2,'2026-01-01','2026-01-01')`).bind(orgId, actor).run();
  } else if (state === 'deletion scheduled') {
    await env.DB.prepare(`INSERT INTO workspace_deletions (org_id,due_at,requested_by,requested_at)
      VALUES (?1,'2999-01-01',?2,'2026-01-01')`).bind(orgId, actor).run();
  } else {
    await env.DB.prepare("INSERT INTO workspace_tombstones (org_id,deleted_at,requested_by) VALUES (?1,'2026-01-01',?2)").bind(orgId, actor).run();
  }
}
function beforeBatch(action) {
  return { prepare: sql => env.DB.prepare(sql), async batch(statements) { await action(); return env.DB.batch(statements); } };
}

test.each(['mixed-case guest', 'rejoined', 'deletion scheduled', 'purge started', 'tombstone'])('share issuance rejects a workspace %s race', async state => {
  const skill = await fixture();
  const db = beforeBatch(() => transition(source, state));
  expect(await createSkillShare(db, source, skill, actor, confirmed)).toMatchObject({ status: 409 });
  expect(await count('hx_skill_shares')).toBe(0);
  expect(await count('hx_skill_share_files')).toBe(0);
});

test.each(['mixed-case guest', 'rejoined', 'deletion scheduled', 'purge started', 'tombstone'])('share import rejects a destination %s race without a partial copy', async state => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  const tables = ['hx_skills', 'hx_skill_access', 'hx_skill_files'];
  const before = await Promise.all(tables.map(count));
  const db = beforeBatch(() => transition(destination, state));
  expect(await importSkillShare(db, token, { orgId: destination, userId: actor })).toMatchObject({ status: 404 });
  expect(await Promise.all(tables.map(count))).toEqual(before);
});

test.each(['deletion scheduled', 'purge started', 'tombstone'])('share import rejects a source %s race without a partial copy', async state => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  const tables = ['hx_skills', 'hx_skill_access', 'hx_skill_files'];
  const before = await Promise.all(tables.map(count));
  const db = beforeBatch(() => transition(source, state));
  expect(await importSkillShare(db, token, { orgId: destination, userId: actor })).toMatchObject({ status: 404 });
  expect(await Promise.all(tables.map(count))).toEqual(before);
});

test.each(['deletion scheduled', 'purge started', 'tombstone'])('public preview and download close after the source workspace has %s', async state => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  await transition(source, state);
  expect(await readSkillShare(env.DB, token)).toMatchObject({ status: 404 });
  expect(await downloadSkillShare(env.DB, token)).toMatchObject({ status: 404 });
});

test('cancelling a workspace deletion restores previously issued links', async () => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  await transition(source, 'deletion scheduled');
  expect(await readSkillShare(env.DB, token)).toMatchObject({ status: 404 });
  await env.DB.prepare('DELETE FROM workspace_deletions WHERE org_id=?1').bind(source).run();
  expect((await readSkillShare(env.DB, token)).share.name).toBe('Procedure');
  expect((await downloadSkillShare(env.DB, token)).bytes).toBeTruthy();
});

test('a workspace owner can import into their destination pending cancellation', async () => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE org_id=?1 AND user_github_id=?2").bind(destination, actor).run();
  await transition(destination, 'deletion scheduled');
  const result = await importSkillShare(env.DB, token, { orgId: destination, userId: actor });
  expect(result.skill).toMatchObject({ visibility: 'private', createdBy: actor });
});

test('download closes if source purge starts while reading shared files', async () => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  let injected = false;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith('SELECT content FROM hx_skill_share_files')) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return { async first() {
        injected = true;
        await transition(source, 'purge started');
        return bound.first();
      } }; } };
    },
  };
  expect(await downloadSkillShare(db, token)).toMatchObject({ status: 404 });
  expect(injected).toBe(true);
});

test('concurrent import cannot exceed the destination Skill limit', async () => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  const insert = i => env.DB.prepare(`INSERT INTO hx_skills
    (id,org_id,name,body,created_by,created_at,updated_at) VALUES (?1,?2,'Other','Instructions',?3,'2026-01-01','2026-01-01')`)
    .bind(`existing-${i}`, destination, actor);
  await env.DB.batch(Array.from({ length: 99 }, (_, i) => insert(i)));
  const db = beforeBatch(() => insert(99).run());
  expect(await importSkillShare(db, token, { orgId: destination, userId: actor })).toMatchObject({ status: 404 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?1').bind(destination).first()).n).toBe(100);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_access WHERE org_id=?1').bind(destination).first()).n).toBe(0);
});

test.each(['issue', 'import'])('HTTP %s keeps the membership generation from authentication', async operation => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  const session = await createSession(env.DB, actor, 'test');
  const before = await Promise.all(['hx_skills', 'hx_skill_access', 'hx_skill_shares'].map(count));
  let injected = false;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      const target = operation === 'issue' ? sql.startsWith('SELECT COUNT(*) AS count FROM hx_skill_shares') : sql.startsWith('SELECT path, size FROM hx_skill_share_files');
      if (!target) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return {
        async first() { injected = true; await transition(source, 'rejoined'); return bound.first(); },
        async all() { injected = true; await transition(destination, 'rejoined'); return bound.all(); },
      }; } };
    },
    batch: statements => env.DB.batch(statements),
  };
  const path = operation === 'issue' ? `/skills/${skill.id}/shares` : `/skill-shares/${token}/import`;
  const request = new Request(`https://example.com${path}`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: operation === 'issue' ? source : destination, confirmAnyoneWithLink: true }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(injected).toBe(true);
  expect(response.status).toBe(operation === 'issue' ? 409 : 404);
  expect(await Promise.all(['hx_skills', 'hx_skill_access', 'hx_skill_shares'].map(count))).toEqual(before);
});

test.each(['issue', 'import'])('HTTP %s rejects a session ended before its write transaction', async operation => {
  const skill = await fixture();
  const { token } = await createSkillShare(env.DB, source, skill, actor, confirmed);
  const session = await createSession(env.DB, actor, 'test');
  const key = await sessionKey(session);
  const orgId = operation === 'issue' ? source : destination;
  const before = await Promise.all(['hx_skills', 'hx_skill_access', 'hx_skill_shares'].map(count));
  let injected = false;
  const stop = async () => {
    injected = true;
    await env.DB.prepare("UPDATE session_workspaces SET ended_at='2026-01-01' WHERE org_id=?1 AND token=?2").bind(orgId, key).run();
  };
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      const target = operation === 'issue' ? sql.startsWith('SELECT COUNT(*) AS count FROM hx_skill_shares') : sql.startsWith('SELECT path, size FROM hx_skill_share_files');
      if (!target) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return {
        async first() { await stop(); return bound.first(); },
        async all() { await stop(); return bound.all(); },
      }; } };
    },
    batch: statements => env.DB.batch(statements),
  };
  const path = operation === 'issue' ? `/skills/${skill.id}/shares` : `/skill-shares/${token}/import`;
  const request = new Request(`https://example.com${path}`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId, confirmAnyoneWithLink: true }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(injected).toBe(true);
  expect(response.status).toBe(operation === 'issue' ? 409 : 404);
  expect(await Promise.all(['hx_skills', 'hx_skill_access', 'hx_skill_shares'].map(count))).toEqual(before);
});

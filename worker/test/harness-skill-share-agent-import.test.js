import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createSession, sessionKey, upsertMembership, upsertUser } from '../src/db.js';
import { createSkill } from '../src/harness/skills.js';
import { createSkillShare, importSkillShare } from '../src/harness/skillShares.js';
import worker from '../src/index.js';

const source = 'agent-import-source', destination = 'agent-import-destination';
const actor = '9982', agent = 'agent-import-target';
async function fixture(kind) {
  await upsertUser(env.DB, { githubId: actor, login: 'importer', name: 'Importer', locale: 'en' });
  await upsertMembership(env.DB, source, actor, 'member');
  await upsertMembership(env.DB, destination, actor, kind === 'legacy-admin' ? 'admin' : 'member');
  const skill = (await createSkill(env.DB, source, { name: 'Procedure', description: 'A procedure', body: 'Instructions', visibility: 'private' }, actor)).skill;
  const { token } = await createSkillShare(env.DB, source, skill, actor, { confirmAnyoneWithLink: true });
  await env.DB.prepare(`INSERT INTO custom_agents (org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
    VALUES (?1,?2,'target','Target','Help','team',?3,'2026-01-01','2026-01-01')`).bind(destination, agent, kind === 'owner' ? 'importer' : 'someone-else').run();
  if (kind === 'delegated') {
    await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','2026-01-01')").bind(destination, agent).run();
    await env.DB.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
      SELECT ?1,?2,?3,'admin',?3,'2026-01-01',created_at FROM memberships WHERE org_id=?1 AND user_github_id=?3`).bind(destination, agent, actor).run();
  }
  return token;
}
const tables = ['hx_skills', 'hx_skill_access', 'hx_skill_files', 'hx_agent_skills'];
async function counts() { return Promise.all(tables.map(async name => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first()).n)); }
function beforeBatch(action) { return { prepare: sql => env.DB.prepare(sql), async batch(statements) { await action(); return env.DB.batch(statements); } }; }

const changes = {
  'agent deleted': ['owner', () => env.DB.prepare("UPDATE custom_agents SET deleted_at='2026-01-01' WHERE org_id=?1 AND id=?2").bind(destination, agent).run()],
  'ownership changed': ['owner', () => env.DB.prepare("UPDATE custom_agents SET owner_login='someone-else' WHERE org_id=?1 AND id=?2").bind(destination, agent).run()],
  'agent made personal': ['delegated', () => env.DB.prepare("UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id=?2").bind(destination, agent).run()],
  'delegation removed': ['delegated', () => env.DB.prepare('DELETE FROM hx_agent_members WHERE org_id=?1 AND agent_id=?2 AND user_id=?3').bind(destination, agent, actor).run()],
  'delegation downgraded': ['delegated', () => env.DB.prepare("UPDATE hx_agent_members SET role='member' WHERE org_id=?1 AND agent_id=?2 AND user_id=?3").bind(destination, agent, actor).run()],
  'membership replaced': ['delegated', () => env.DB.prepare("UPDATE memberships SET created_at='rejoined' WHERE org_id=?1 AND user_github_id=?2").bind(destination, actor).run()],
  'workspace admin downgraded': ['legacy-admin', () => env.DB.prepare("UPDATE memberships SET role='member' WHERE org_id=?1 AND user_github_id=?2").bind(destination, actor).run()],
  'legacy profile created': ['legacy-admin', () => env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','2026-01-01')").bind(destination, agent).run()],
};

test.each(Object.keys(changes))('agent import is atomic when %s during preparation', async transition => {
  const [kind, action] = changes[transition];
  const token = await fixture(kind);
  const before = await counts();
  const result = await importSkillShare(beforeBatch(action), token, { orgId: destination, userId: actor, agentId: agent });
  expect(result.status).toBe(404);
  expect(await counts()).toEqual(before);
});

test.each(['owner', 'delegated', 'legacy-admin'])('a current %s can import and install the Skill atomically', async kind => {
  const token = await fixture(kind);
  const result = await importSkillShare(env.DB, token, { orgId: destination, userId: actor, agentId: agent });
  expect(result.skill).toMatchObject({ visibility: 'private', createdBy: actor });
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_skills WHERE org_id=?1 AND agent_id=?2 AND skill_id=?3').bind(destination, agent, result.skill.id).first()).toBeTruthy();
});

test('HTTP agent import refuses ownership revoked just before the transaction', async () => {
  const token = await fixture('owner');
  const session = await createSession(env.DB, actor, 'test');
  const before = await counts();
  let armed = false, injected = false;
  const db = {
    prepare(sql) {
      if (sql.startsWith('INSERT INTO hx_skills ')) armed = true;
      return env.DB.prepare(sql);
    },
    async batch(statements) {
      if (armed && !injected) {
        injected = true;
        await changes['ownership changed'][1]();
      }
      return env.DB.batch(statements);
    },
  };
  const request = new Request(`https://example.com/skill-shares/${token}/import`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: destination, agentId: agent }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(injected).toBe(true);
  expect(response.status).toBe(404);
  expect(await counts()).toEqual(before);
});

test('an import remains auditable if the saved copy becomes unreadable before its first read', async () => {
  const token = await fixture('owner');
  const session = await createSession(env.DB, actor, 'test');
  let armed = false, copiedId;
  const db = {
    prepare(sql) { if (sql.startsWith('INSERT INTO hx_skills ')) armed = true; return env.DB.prepare(sql); },
    async batch(statements) {
      const result = await env.DB.batch(statements);
      if (armed && !copiedId) {
        copiedId = (await env.DB.prepare('SELECT id FROM hx_skills WHERE org_id=?1').bind(destination).first()).id;
        await env.DB.prepare("UPDATE hx_skills SET owner_id='someone-else' WHERE id=?1").bind(copiedId).run();
      }
      return result;
    },
  };
  const request = new Request(`https://example.com/skill-shares/${token}/import`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: destination, agentId: agent }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.code).toBe('import-may-be-saved');
  expect(JSON.stringify(body)).not.toContain('Instructions');
  expect(await env.DB.prepare('SELECT 1 FROM hx_skills WHERE id=?1').bind(copiedId).first()).toBeTruthy();
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_skills WHERE skill_id=?1').bind(copiedId).first()).toBeTruthy();
  const events = (await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action IN ('skill.share_imported','skill.import_delivery_denied')").bind(destination).all()).results;
  expect(events.map(row => row.action).sort()).toEqual(['skill.import_delivery_denied', 'skill.share_imported']);
});

test('an import remains saved and is audited when final delivery authorization cannot be read', async () => {
  const token = await fixture('owner');
  const session = await createSession(env.DB, actor, 'test');
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT 1 AS ok FROM hx_skills s')) return { bind: () => ({ first: async () => { throw new Error('delivery check unavailable'); } }) };
      return env.DB.prepare(sql);
    },
    batch: statements => env.DB.batch(statements),
  };
  const request = new Request(`https://example.com/skill-shares/${token}/import`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: destination, agentId: agent }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('import-may-be-saved');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?1').bind(destination).first()).n).toBe(1);
  expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE org_id=?1 AND action='skill.import_delivery_denied' AND outcome='failure'").bind(destination).first()).toBeTruthy();
});

test.each(['membership removed', 'guest', 'rejoined', 'agent owner changed', 'agent deleted', 'agent link removed', 'skill owner changed', 'skill content changed', 'purge started', 'source revoked', 'session ended', 'session deleted', 'session expired', 'scim inactive'])('HTTP import rechecks access after audit when %s', async change => {
  const token = await fixture('owner');
  const session = await createSession(env.DB, actor, 'test');
  const key = await sessionKey(session);
  let injected = false, copiedId;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith('INSERT INTO audit_events')) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return { async run() {
        if (injected) return bound.run();
        injected = true;
        copiedId = (await env.DB.prepare('SELECT id FROM hx_skills WHERE org_id=?1').bind(destination).first()).id;
        if (change === 'membership removed') await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(destination, actor).run();
        if (change === 'guest') await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1 AND user_github_id=?2").bind(destination, actor).run();
        if (change === 'rejoined') await env.DB.prepare("UPDATE memberships SET created_at='rejoined' WHERE org_id=?1 AND user_github_id=?2").bind(destination, actor).run();
        if (change === 'agent owner changed') await changes['ownership changed'][1]();
        if (change === 'agent deleted') await changes['agent deleted'][1]();
        if (change === 'agent link removed') await env.DB.prepare('DELETE FROM hx_agent_skills WHERE org_id=?1 AND agent_id=?2 AND skill_id=?3').bind(destination, agent, copiedId).run();
        if (change === 'skill owner changed') await env.DB.prepare("UPDATE hx_skills SET owner_id='someone-else' WHERE id=?1").bind(copiedId).run();
        if (change === 'skill content changed') await env.DB.prepare("UPDATE hx_skills SET body='Replacement content' WHERE id=?1").bind(copiedId).run();
        if (change === 'purge started') await env.DB.prepare(`INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at,purge_started_at)
          VALUES (?1,'2026-01-01',?2,'2026-01-01','2026-01-01')`).bind(destination, actor).run();
        if (change === 'source revoked') await env.DB.prepare("UPDATE hx_skill_shares SET revoked_at='2026-01-01' WHERE org_id=?1").bind(source).run();
        if (change === 'session ended') await env.DB.prepare("UPDATE session_workspaces SET ended_at='2026-01-01' WHERE org_id=?1 AND token=?2").bind(destination, key).run();
        if (change === 'session deleted') await env.DB.prepare('DELETE FROM sessions WHERE token=?1').bind(key).run();
        if (change === 'session expired') await env.DB.prepare("UPDATE sessions SET expires_at='2000-01-01' WHERE token=?1").bind(key).run();
        if (change === 'scim inactive') await env.DB.prepare(`INSERT INTO scim_users(org_id,id,user_github_id,user_name,active,created_at,updated_at)
          VALUES (?1,'scim-agent-import',?2,'importer',0,'2026-01-01','2026-01-01')`).bind(destination, actor).run();
        return bound.run();
      } }; } };
    },
    batch: statements => env.DB.batch(statements),
  };
  const request = new Request(`https://example.com/skill-shares/${token}/import`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: destination, agentId: agent }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(injected).toBe(true);
  expect(response.status).toBe(change === 'source revoked' ? 201 : 409);
  if (change !== 'source revoked') expect(await response.text()).not.toContain('Instructions');
  expect(await env.DB.prepare('SELECT 1 FROM hx_skills WHERE org_id=?1 AND id=?2').bind(destination, copiedId).first()).toBeTruthy();
  const link = await env.DB.prepare('SELECT 1 FROM hx_agent_skills WHERE org_id=?1 AND agent_id=?2 AND skill_id=?3').bind(destination, agent, copiedId).first();
  if (change === 'agent link removed') expect(link).toBeNull(); else expect(link).toBeTruthy();
  if (change !== 'source revoked') expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE org_id=?1 AND action='skill.import_delivery_denied' AND outcome='failure'").bind(destination).first()).toBeTruthy();
});

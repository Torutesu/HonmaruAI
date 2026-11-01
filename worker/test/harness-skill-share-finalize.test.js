import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createSession, sessionKey, upsertMembership, upsertUser } from '../src/db.js';
import { createSkill } from '../src/harness/skills.js';
import { createSkillShare, finalizeSkillShare } from '../src/harness/skillShares.js';
import worker from '../src/index.js';

const org = 'share-finalize', actor = '9983';
async function fixture() {
  await upsertUser(env.DB, { githubId: actor, login: 'finalize-owner', name: 'Owner', locale: 'en' });
  await upsertMembership(env.DB, org, actor, 'member');
  const skill = (await createSkill(env.DB, org, { name: 'Procedure', description: 'A procedure', body: 'Instructions', visibility: 'private' }, actor)).skill;
  const share = () => createSkillShare(env.DB, org, skill, actor, { confirmAnyoneWithLink: true });
  const memberSince = (await env.DB.prepare('SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(org, actor).first()).created_at;
  return { skill, old: await share(), issued: await share(), memberSince };
}
const changes = {
  'membership removed': f => env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(org, actor).run(),
  'guest': f => env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1 AND user_github_id=?2").bind(org, actor).run(),
  'membership replaced': f => env.DB.prepare("UPDATE memberships SET created_at='rejoined' WHERE org_id=?1 AND user_github_id=?2").bind(org, actor).run(),
  'owner changed': f => env.DB.prepare("UPDATE hx_skills SET owner_id='different' WHERE org_id=?1 AND id=?2").bind(org, f.skill.id).run(),
  'source restricted': f => env.DB.prepare(`INSERT INTO hx_skill_source_scopes(org_id,skill_id,agent_id,channel,memory_id,memory_version,created_by,created_at)
    VALUES (?1,?2,'agent','private','memory',1,?3,'2026-01-01')`).bind(org, f.skill.id, actor).run(),
  'purge started': f => env.DB.prepare(`INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at,purge_started_at)
    VALUES (?1,'2026-01-01',?2,'2026-01-01','2026-01-01')`).bind(org, actor).run(),
  'deletion scheduled': f => env.DB.prepare(`INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at)
    VALUES (?1,'2999-01-01',?2,'2026-01-01')`).bind(org, actor).run(),
  'workspace deleted': f => env.DB.prepare("INSERT INTO workspace_tombstones(org_id,deleted_at) VALUES (?1,'2026-01-01')").bind(org).run(),
  'link revoked': f => env.DB.prepare("UPDATE hx_skill_shares SET revoked_at='2026-01-01' WHERE id=?1").bind(f.issued.share.id).run(),
  'link expired': f => env.DB.prepare("UPDATE hx_skill_shares SET expires_at='2026-01-01' WHERE id=?1").bind(f.issued.share.id).run(),
};

test.each(Object.keys(changes))('finalize revokes the newly issued link when %s', async change => {
  const f = await fixture();
  await changes[change](f);
  expect(await finalizeSkillShare(env.DB, org, f.skill.id, actor, f.issued, f.memberSince)).toBe(false);
  const rows = (await env.DB.prepare('SELECT id,revoked_at FROM hx_skill_shares ORDER BY id').all()).results;
  expect(rows.find(row => row.id === f.old.share.id).revoked_at).toBeNull();
  expect(rows.find(row => row.id === f.issued.share.id).revoked_at).toBeTruthy();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_share_files').first()).n).toBe(2);
});

test('finalize keeps valid shares and rejects an identity mismatch without modifying either link', async () => {
  const f = await fixture();
  expect(await finalizeSkillShare(env.DB, org, f.skill.id, actor, f.issued, f.memberSince)).toBe(true);
  expect(await finalizeSkillShare(env.DB, org, f.skill.id, actor, { ...f.issued, token: f.old.token }, f.memberSince)).toBe(false);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares WHERE revoked_at IS NOT NULL').first()).n).toBe(0);
});

test.each(['membership removed', 'guest', 'membership replaced', 'owner changed', 'source restricted', 'deletion scheduled', 'purge started', 'workspace deleted', 'link revoked', 'link expired', 'session ended', 'session deleted', 'session expired', 'scim inactive'])('HTTP share creation does not return a token when %s during audit', async change => {
  const f = await fixture();
  const session = await createSession(env.DB, actor, 'test');
  const key = await sessionKey(session);
  let injected = false, newId;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith('INSERT INTO audit_events')) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return { async run() {
        if (injected) return bound.run();
        const row = await env.DB.prepare('SELECT id FROM hx_skill_shares WHERE skill_id=?1 AND id!=?2 AND id!=?3').bind(f.skill.id, f.old.share.id, f.issued.share.id).first();
        newId = row.id;
        injected = true;
        if (change === 'session ended') await env.DB.prepare("UPDATE session_workspaces SET ended_at='2026-01-01' WHERE org_id=?1 AND token=?2").bind(org, key).run();
        else if (change === 'session deleted') await env.DB.prepare('DELETE FROM sessions WHERE token=?1').bind(key).run();
        else if (change === 'session expired') await env.DB.prepare("UPDATE sessions SET expires_at='2000-01-01' WHERE token=?1").bind(key).run();
        else if (change === 'scim inactive') await env.DB.prepare(`INSERT INTO scim_users(org_id,id,user_github_id,user_name,active,created_at,updated_at)
          VALUES (?1,'scim-finalize',?2,'finalize-owner',0,'2026-01-01','2026-01-01')`).bind(org, actor).run();
        else await changes[change]({ ...f, issued: { share: { id: newId } } });
        return bound.run();
      } }; } };
    },
    batch: statements => env.DB.batch(statements),
  };
  const request = new Request(`https://example.com/skills/${f.skill.id}/shares`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: org, confirmAnyoneWithLink: true }),
  });
  const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
  expect(injected).toBe(true);
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty('token');
  const rows = (await env.DB.prepare('SELECT id,revoked_at FROM hx_skill_shares').all()).results;
  expect(rows.find(row => row.id === newId).revoked_at).toBeTruthy();
  expect(rows.find(row => row.id === f.old.share.id).revoked_at).toBeNull();
  expect(rows.find(row => row.id === f.issued.share.id).revoked_at).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE org_id=?1 AND action='skill.share_delivery_denied' AND outcome='failure'").bind(org).first()).toBeTruthy();
});

test.each([true, false])('HTTP share creation fails closed when final authorization fails (cleanup available: %s)', async cleanupAvailable => {
  const f = await fixture();
  const session = await createSession(env.DB, actor, 'test');
  let finalizing = false;
  const db = {
    prepare(sql) {
      if (sql.startsWith('UPDATE hx_skill_shares AS sh')) {
        finalizing = true;
        if (!cleanupAvailable) return { bind: () => ({ run: async () => { throw new Error('cleanup unavailable'); } }) };
      }
      return env.DB.prepare(sql);
    },
    async batch(statements) { if (finalizing) throw new Error('final authorization unavailable'); return env.DB.batch(statements); },
  };
  const request = new Request(`https://example.com/skills/${f.skill.id}/shares`, {
    method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: org, confirmAnyoneWithLink: true }),
  });
  let response;
  try { response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} }); } catch { /* Failed closed. */ }
  expect(finalizing).toBe(true);
  if (response) {
    expect(response.status).not.toBe(201);
    expect(await response.text()).not.toContain('skl_');
  }
  const rows = (await env.DB.prepare('SELECT id,revoked_at FROM hx_skill_shares').all()).results;
  const newShare = rows.find(row => row.id !== f.old.share.id && row.id !== f.issued.share.id);
  if (cleanupAvailable) expect(newShare.revoked_at).toBeTruthy();
  else expect(newShare.revoked_at).toBeNull();
  expect(rows.find(row => row.id === f.old.share.id).revoked_at).toBeNull();
  expect(rows.find(row => row.id === f.issued.share.id).revoked_at).toBeNull();
});

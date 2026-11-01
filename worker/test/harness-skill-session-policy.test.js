import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createSession, sessionKey, upsertMembership, upsertUser } from '../src/db.js';
import { brokenRule, forgetPolicies } from '../src/policy.js';
import { skillSessionAuthority } from '../src/harness/skillSessionAuthority.js';
import { currentSkillPolicy, skillSsoDeadline } from '../src/harness/skillPolicyProof.js';
import { createSkill } from '../src/harness/skills.js';
import { createSkillShare } from '../src/harness/skillShares.js';
import worker from '../src/index.js';

const org = 'skill-session-policy', user = '9949';
async function fixture() {
  await upsertUser(env.DB, { githubId: user, login: 'skill-policy', name: 'User', locale: 'en' });
  await upsertMembership(env.DB, org, user, 'member');
  const key = await sessionKey(await createSession(env.DB, user, 'test'));
  await env.DB.prepare('INSERT INTO org_session_policy(org_id,web_max_hours,mobile_max_hours,idle_hours,updated_by,updated_at) VALUES (?1,1,2,1,?2,?3)')
    .bind(org, user, new Date().toISOString()).run();
  return key;
}

test.each([
  ['web within limit', 'web', 30, 0, 0],
  ['web maximum elapsed', 'web', 70, 0, 0],
  ['ios uses mobile maximum', 'iOS', 70, 0, 0],
  ['ios maximum elapsed', 'ios', 130, 0, 0],
  ['idle wall clock elapsed', 'web', 30, 70, 0],
  ['historical idle elapsed', 'web', 30, 0, 3600001],
  ['no idle expiry', 'web', 30, 0, 3599000],
])('D1 policy check matches brokenRule: %s', async (_label, client, createdMinutes, seenMinutes, longestIdle) => {
  const key = await fixture();
  const now = Date.now();
  await env.DB.prepare('UPDATE sessions SET client=?1,created_at=?2,last_seen_at=?3,longest_idle_ms=?4 WHERE token=?5')
    .bind(client, new Date(now - createdMinutes * 60000).toISOString(), new Date(now - seenMinutes * 60000).toISOString(), longestIdle, key).run();
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token=?1').bind(key).first();
  const policy = await env.DB.prepare('SELECT * FROM org_session_policy WHERE org_id=?1').bind(org).first();
  const actual = await env.DB.prepare(`SELECT ${skillSessionAuthority('?1', '?2', '?3')} AS allowed`).bind(org, user, key).first();
  expect(Boolean(actual.allowed)).toBe(brokenRule(policy, session) === null);
});

test('D1 policy checks continue to allow unparseable legacy timestamps as brokenRule does', async () => {
  const key = await fixture();
  await env.DB.prepare("UPDATE sessions SET created_at='not-a-date',last_seen_at='not-a-date',longest_idle_ms=0 WHERE token=?1").bind(key).run();
  const session = await env.DB.prepare('SELECT * FROM sessions WHERE token=?1').bind(key).first();
  const policy = await env.DB.prepare('SELECT * FROM org_session_policy WHERE org_id=?1').bind(org).first();
  expect(brokenRule(policy, session)).toBeNull();
  const actual = await env.DB.prepare(`SELECT ${skillSessionAuthority('?1', '?2', '?3')} AS allowed`).bind(org, user, key).first();
  expect(actual.allowed).toBe(1);
});

test('SSO deadline is rechecked against actual time at the database boundary', async () => {
  const deadline = Date.now() + 1000;
  const check = () => env.DB.prepare(`SELECT ${skillSsoDeadline('?1')} AS allowed`).bind(deadline).first();
  expect((await check()).allowed).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect((await check()).allowed).toBe(0);
});

test('SSO policy proof evaluates the exact snapshot even if live policy briefly changes', async () => {
  const key = await fixture();
  const at = new Date().toISOString();
  await env.DB.prepare("UPDATE users SET email='user@example.test' WHERE github_id=?1").bind(user).run();
  await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES ('example.test',?1,'token',?2,?3,?2)").bind(org, at, user).run();
  await env.DB.prepare(`INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,created_by,created_at,updated_at)
    VALUES ('proof-sso',?1,'oidc','https://example.test','["example.test"]','active',?2,?3,?3)`).bind(org, user, at).run();
  await env.DB.prepare('INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES (?1,1,?2)').bind(org, at).run();
  let injected = false;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith('SELECT json_object(')) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return { async first() {
        const result = await bound.first();
        injected = true;
        await env.DB.prepare('UPDATE org_sso_policy SET enforce=0 WHERE org_id=?1').bind(org).run();
        return result;
      } }; } };
    },
    batch: statements => env.DB.batch(statements),
  };
  expect(await currentSkillPolicy({ ...env, DB: db }, org, user, key)).toEqual({ allowed: false });
  expect(injected).toBe(true);
});

test('an allowed legacy SSO configuration migrates and permits the first policy proof', async () => {
  const key = await fixture();
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO org_sso(org_id,provider,issuer,client_id,client_secret,allowed_domains,enforce,status,created_by,updated_at)
    VALUES (?1,'oidc','https://legacy.example','id','secret','[]',0,'active',?2,?3)`).bind(org, user, at).run();
  expect((await currentSkillPolicy(env, org, user, key)).allowed).toBe(true);
  expect(await env.DB.prepare('SELECT 1 FROM org_sso WHERE org_id=?1').bind(org).first()).toBeNull();
});

test('SSO deadline selects the same required and explicit connections as the existing policy', async () => {
  const key = await fixture();
  const at = new Date().toISOString();
  await env.DB.prepare('DELETE FROM org_session_policy WHERE org_id=?1').bind(org).run();
  forgetPolicies();
  await env.DB.prepare("UPDATE users SET email='user@example.test' WHERE github_id=?1").bind(user).run();
  await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES ('example.test',?1,'token',?2,?3,?2)").bind(org, at, user).run();
  await env.DB.prepare(`INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,session_hours,created_by,created_at,updated_at)
    VALUES ('a-first',?1,'oidc','https://first.test','["first.test"]','draft',1,?2,'2026-01-01',?3)`).bind(org, user, at).run();
  await env.DB.prepare(`INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,session_hours,created_by,created_at,updated_at)
    VALUES ('b-required',?1,'oidc','https://example.test','["example.test"]','active',10,?2,'2026-01-02',?3)`).bind(org, user, at).run();
  await env.DB.prepare('INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES (?1,1,?2)').bind(org, at).run();
  await env.DB.prepare("UPDATE sessions SET auth_method='sso',sso_org_id=?1,sso_connection_id=NULL,created_at=?2 WHERE token=?3")
    .bind(org, new Date(Date.now() - 2 * 3600000).toISOString(), key).run();
  expect((await currentSkillPolicy(env, org, user, key)).allowed).toBe(true);
  await env.DB.prepare("UPDATE sessions SET sso_connection_id='a-first' WHERE token=?1").bind(key).run();
  expect((await currentSkillPolicy(env, org, user, key)).allowed).toBe(false);
  await env.DB.prepare('UPDATE org_sso_policy SET enforce=0 WHERE org_id=?1').bind(org).run();
  await env.DB.prepare('UPDATE sessions SET sso_connection_id=NULL WHERE token=?1').bind(key).run();
  expect((await currentSkillPolicy(env, org, user, key)).allowed).toBe(false);
  forgetPolicies();
});

test.each(['issue', 'import'].flatMap(operation => ['mobile maximum', 'idle wall clock', 'historical idle'].map(mode => [operation, mode])))('%s does not deliver when %s expires during audit', async (operation, mode) => {
  await upsertUser(env.DB, { githubId: user, login: 'skill-policy', name: 'User', locale: 'en' });
  await upsertMembership(env.DB, org, user, 'member');
  await upsertMembership(env.DB, 'skill-policy-target', user, 'member');
  const skill = (await createSkill(env.DB, org, { name: 'Procedure', description: 'Private procedure', body: 'Sensitive instructions', visibility: 'private' }, user)).skill;
  const share = await createSkillShare(env.DB, org, skill, user, { confirmAnyoneWithLink: true });
  const target = operation === 'issue' ? org : 'skill-policy-target';
  await env.DB.prepare('INSERT INTO org_session_policy(org_id,mobile_max_hours,idle_hours,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5)')
    .bind(target, mode === 'mobile maximum' ? 1 : null, mode === 'mobile maximum' ? null : 1, user, new Date().toISOString()).run();
  forgetPolicies();
  const session = await createSession(env.DB, user, 'test'), key = await sessionKey(session);
  if (mode === 'mobile maximum') await env.DB.prepare("UPDATE sessions SET client='iOS' WHERE token=?1").bind(key).run();
  let injected = false;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith('INSERT INTO audit_events')) return statement;
      return { bind(...args) { const bound = statement.bind(...args); return { async run() {
        if (!injected) {
          injected = true;
          const update = mode === 'mobile maximum' ? "UPDATE sessions SET created_at='2000-01-01T00:00:00.000Z' WHERE token=?1"
            : mode === 'idle wall clock' ? "UPDATE sessions SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE token=?1"
              : 'UPDATE sessions SET longest_idle_ms=3600001 WHERE token=?1';
          await env.DB.prepare(update).bind(key).run();
        }
        return bound.run();
      } }; } };
    },
    batch: statements => env.DB.batch(statements),
  };
  try {
    const path = operation === 'issue' ? `/skills/${skill.id}/shares` : `/skill-shares/${share.token}/import`;
    const request = new Request(`https://example.com${path}`, { method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: target, confirmAnyoneWithLink: true }) });
    const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
    expect(injected).toBe(true);
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).not.toContain('Sensitive instructions');
    expect(body).not.toMatch(/skl_[a-f0-9]{64}/);
  } finally { forgetPolicies(); }
});

import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import worker from '../src/index.js';
import { createSession, sessionKey, upsertMembership, upsertUser } from '../src/db.js';
import { createSkill } from '../src/harness/skills.js';
import { createSkillShare } from '../src/harness/skillShares.js';
import { forgetPolicies } from '../src/policy.js';
import { forgetGovernance } from '../src/governance.js';

test.each(['issue', 'import'].flatMap(operation => ['sso', 'connection', 'network', 'session'].flatMap(mode => ['before commit', 'before delivery'].map(phase => [operation, mode, phase]))))('%s rejects a %s restriction enabled then removed %s', async (operation, mode, phase) => {
  const source = 'skill-aba-source', destination = 'skill-aba-destination', actor = '9955';
  const target = operation === 'issue' ? source : destination;
  await upsertUser(env.DB, { githubId: actor, login: 'aba-user', name: 'User', locale: 'en' });
  await env.DB.prepare("UPDATE users SET email='aba-user@example.test' WHERE github_id=?1").bind(actor).run();
  await upsertMembership(env.DB, source, actor, 'member');
  await upsertMembership(env.DB, destination, actor, 'member');
  const skill = (await createSkill(env.DB, source, { name: 'Procedure', description: 'Private procedure', body: 'Sensitive instructions', visibility: 'private' }, actor)).skill;
  const share = await createSkillShare(env.DB, source, skill, actor, { confirmAnyoneWithLink: true });
  if (mode === 'sso' || mode === 'connection') {
    await env.DB.prepare("INSERT INTO org_domains(domain,org_id,verify_token,verified_at,created_by,created_at) VALUES ('example.test',?1,'token','2026-01-01',?2,'2026-01-01')").bind(target, actor).run();
    await env.DB.prepare(`INSERT INTO sso_connections(id,org_id,provider,issuer,allowed_domains,status,session_hours,created_by,created_at,updated_at)
      VALUES ('aba-sso',?1,'oidc','https://example.test','["example.test"]','active',24,?2,'2026-01-01','2026-01-01')`).bind(target, actor).run();
    await env.DB.prepare("INSERT INTO org_sso_policy(org_id,enforce,updated_at) VALUES (?1,0,'2026-01-01T00:00:00.000Z')").bind(target).run();
  } else if (mode === 'network') {
    await env.DB.prepare(`INSERT INTO org_governance(org_id,ip_enforce,ip_allowlist,updated_by,updated_at)
      VALUES (?1,0,'[]',?2,'2026-01-01T00:00:00.000Z')`).bind(target, actor).run();
  } else {
    await env.DB.prepare("INSERT INTO org_session_policy(org_id,updated_by,updated_at) VALUES (?1,?2,'2026-01-01T00:00:00.000Z')").bind(target, actor).run();
  }
  forgetPolicies(); forgetGovernance();
  const session = await createSession(env.DB, actor, 'test');
  if (mode === 'session') await env.DB.prepare('UPDATE sessions SET created_at=?1 WHERE token=?2').bind(new Date(Date.now() - 2 * 3600000).toISOString(), await sessionKey(session)).run();
  if (mode === 'connection') await env.DB.prepare("UPDATE sessions SET auth_method='sso',sso_org_id=?1,sso_connection_id='aba-sso',created_at=?2 WHERE token=?3").bind(target, new Date(Date.now() - 2 * 3600000).toISOString(), await sessionKey(session)).run();
  let armed = false, injected = false;
  async function changeAndRestore() {
    injected = true;
    if (mode === 'sso') {
      await env.DB.prepare("UPDATE org_sso_policy SET enforce=1,updated_at='2026-01-02T00:00:00.000Z' WHERE org_id=?1").bind(target).run();
      await env.DB.prepare("UPDATE org_sso_policy SET enforce=0,updated_at='2026-01-03T00:00:00.000Z' WHERE org_id=?1").bind(target).run();
    } else if (mode === 'connection') {
      await env.DB.prepare("UPDATE sso_connections SET session_hours=1,updated_at='2026-01-02T00:00:00.000Z' WHERE org_id=?1 AND id='aba-sso'").bind(target).run();
      await env.DB.prepare("UPDATE sso_connections SET session_hours=24,updated_at='2026-01-03T00:00:00.000Z' WHERE org_id=?1 AND id='aba-sso'").bind(target).run();
    } else if (mode === 'network') {
      await env.DB.prepare("UPDATE org_governance SET ip_enforce=1,ip_allowlist='[\"192.0.2.0/24\"]',updated_at='2026-01-02T00:00:00.000Z' WHERE org_id=?1").bind(target).run();
      await env.DB.prepare("UPDATE org_governance SET ip_enforce=0,ip_allowlist='[]',updated_at='2026-01-03T00:00:00.000Z' WHERE org_id=?1").bind(target).run();
    } else {
      await env.DB.prepare("UPDATE org_session_policy SET web_max_hours=1,updated_at='2026-01-02T00:00:00.000Z' WHERE org_id=?1").bind(target).run();
      await env.DB.prepare("UPDATE org_session_policy SET web_max_hours=NULL,updated_at='2026-01-03T00:00:00.000Z' WHERE org_id=?1").bind(target).run();
    }
  }
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (phase === 'before delivery' && sql.startsWith('INSERT INTO audit_events')) return { bind(...args) { const bound = statement.bind(...args); return { async run() {
        if (!injected) await changeAndRestore();
        return bound.run();
      } }; } };
      if (phase === 'before commit' && (operation === 'issue' && sql.startsWith('INSERT INTO hx_skill_shares') || operation === 'import' && sql.startsWith('INSERT INTO hx_skills '))) armed = true;
      return statement;
    },
    async batch(statements) {
      if (armed && !injected) await changeAndRestore();
      return env.DB.batch(statements);
    },
  };
  try {
    const path = operation === 'issue' ? `/skills/${skill.id}/shares` : `/skill-shares/${share.token}/import`;
    const request = new Request(`https://example.com${path}`, { method: 'POST', headers: { 'x-session-token': session, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ orgId: target, confirmAnyoneWithLink: true }) });
    const response = await worker.fetch(request, { ...env, DB: db }, { waitUntil() {} });
    expect(injected).toBe(true);
    expect([403, 404, 409]).toContain(response.status);
    const count = operation === 'issue'
      ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares WHERE skill_id=?1').bind(skill.id).first()).n
      : (await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?1').bind(destination).first()).n;
    expect(count).toBe(phase === 'before commit' ? (operation === 'issue' ? 1 : 0) : (operation === 'issue' ? 2 : 1));
    if (phase === 'before delivery' && operation === 'issue') expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares WHERE skill_id=?1 AND revoked_at IS NOT NULL').bind(skill.id).first()).n).toBe(1);
  } finally { forgetPolicies(); forgetGovernance(); }
});

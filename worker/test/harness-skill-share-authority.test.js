import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { upsertMembership, upsertUser } from '../src/db.js';
import { createSkill, getSkill } from '../src/harness/skills.js';
import { createSkillShare } from '../src/harness/skillShares.js';

const org = 'share-authority';
const actor = '9961';
const confirmed = { confirmAnyoneWithLink: true };
async function fixture() {
  await upsertUser(env.DB, { githubId: actor, login: 'skill-owner', name: 'Owner', locale: 'en' });
  await upsertMembership(env.DB, org, actor, 'member');
  return (await createSkill(env.DB, org, { name: 'Procedure', description: 'Private procedure', body: 'Internal instructions', visibility: 'private' }, actor)).skill;
}

test('a previously loaded Skill cannot be shared after its owner loses workspace membership', async () => {
  const skill = await fixture();
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(org, actor).run();
  const result = await createSkillShare(env.DB, org, skill, actor, confirmed);
  expect(result.status).toBe(409);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares').first()).n).toBe(0);
});

test('a Skill that changed during link creation cannot publish a stale snapshot', async () => {
  const skill = await fixture();
  await env.DB.prepare("UPDATE hx_skills SET body='New confidential instructions' WHERE id=?1").bind(skill.id).run();
  const result = await createSkillShare(env.DB, org, skill, actor, confirmed);
  expect(result.status).toBe(409);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares').first()).n).toBe(0);
});

test('the previous owner cannot create a link after ownership changes', async () => {
  const skill = await fixture();
  await env.DB.prepare("UPDATE hx_skills SET owner_id='another-owner' WHERE id=?1").bind(skill.id).run();
  const result = await createSkillShare(env.DB, org, skill, actor, confirmed);
  expect(result.status).toBe(409);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares').first()).n).toBe(0);
});

test('a Skill that becomes source-restricted cannot be published using stale access', async () => {
  const skill = await fixture();
  await env.DB.prepare(`INSERT INTO hx_skill_source_scopes
    (org_id, skill_id, agent_id, channel, memory_id, memory_version, created_by, created_at)
    VALUES (?1, ?2, 'agent-private', 'private-room', 'memory-private', 1, ?3, '2026-01-01T00:00:00.000Z')`)
    .bind(org, skill.id, actor).run();
  const result = await createSkillShare(env.DB, org, skill, actor, confirmed);
  expect(result.status).toBe(409);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares').first()).n).toBe(0);
});

test('concurrent link creation cannot exceed the 50 active links limit', async () => {
  const skill = await fixture();
  const addLink = i => env.DB.prepare(`INSERT INTO hx_skill_shares
    (id, org_id, skill_id, token_hash, snapshot, created_by, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, '{}', ?5, '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')`)
    .bind(`old-${i}`, org, skill.id, `hash-${i}`, actor);
  await env.DB.batch(Array.from({ length: 49 }, (_, i) => addLink(i)));
  const racingDb = {
    prepare: sql => env.DB.prepare(sql),
    async batch(writes) { await addLink(49).run(); return env.DB.batch(writes); },
  };
  const result = await createSkillShare(racingDb, org, skill, actor, confirmed);
  expect(result.status).toBe(409);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_shares').first()).n).toBe(50);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_share_files').first()).n).toBe(0);
});

test('a current owner can still create and read a normal Skill share', async () => {
  const skill = await fixture();
  const current = await getSkill(env.DB, org, skill.id, actor);
  const result = await createSkillShare(env.DB, org, current, actor, confirmed);
  expect(result.token).toMatch(/^skl_[a-f0-9]{64}$/);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_share_files WHERE share_id=?1').bind(result.share.id).first()).n).toBe(1);
});

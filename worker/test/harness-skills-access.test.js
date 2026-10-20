import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { installedSkillTools } from '../src/harness/skillReader.js';
import { prepareAgent } from '../src/harness/agents.js';
import { createSkill, executionSkills, getSkill } from '../src/harness/skills.js';

const orgId = 'skills-access';
let owner, member, admin, agentId;
const request = (method, path, token, body) => worker.fetch(new Request(`https://example.com${path}${method === 'GET' || method === 'DELETE' ? `?orgId=${orgId}` : ''}`, {
  method, headers: { 'x-session-token': token, 'content-type': 'application/json' },
  ...(['GET', 'DELETE'].includes(method) ? {} : { body: JSON.stringify({ orgId, ...body }) }),
}), env, { waitUntil() {} });
const create = async (visibility = 'private') => {
  const r = await request('POST', '/skills', owner, { name: 'Private method', body: 'Confidential instructions', visibility });
  expect(r.status).toBe(201);
  return (await r.json()).skill;
};
beforeEach(async () => {
  const { upsertUser, upsertMembership, createSession } = await import('../src/db.js');
  const sessions = [];
  for (const [id, login, role] of [['9401', 'owner', 'member'], ['9402', 'member', 'member'], ['9403', 'admin', 'admin']]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, locale: 'en' });
    await upsertMembership(env.DB, orgId, id, role);
    sessions.push(await createSession(env.DB, id, 'test'));
  }
  [owner, member, admin] = sessions;
  const made = await request('POST', '/channels/agents', owner, { name: 'Helper', handle: 'helper', instructions: 'Help', scope: 'team' });
  agentId = (await made.json()).agent.id;
});

test('SKILL.md preview writes nothing; saving and exporting preserve metadata and private access', async () => {
  const markdown = '---\nname: weekly-report\ndescription: Prepare weekly reports\nallowed-tools: [read_file]\n---\nReview the agreed sources.';
  const preview = await request('POST', '/skills/preview-import', owner, { markdown });
  expect(preview.status).toBe(200);
  const { draft } = await preview.json();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills').first()).n).toBe(0);
  const saved = await request('POST', '/skills', owner, { ...draft, visibility: 'private' });
  expect(saved.status).toBe(201);
  const { skill } = await saved.json();
  expect(skill.metadata).toEqual({ 'allowed-tools': ['read_file'] });
  await request('PUT', `/skills/${skill.id}`, owner, { body: 'Updated procedure.' });
  const exported = await request('GET', `/skills/${skill.id}/export`, owner);
  expect(exported.status).toBe(200);
  const file = await exported.json();
  expect(file.filename).toBe('SKILL.md');
  const again = await request('POST', '/skills/preview-import', owner, { markdown: file.markdown });
  expect((await again.json()).draft).toMatchObject({ body: 'Updated procedure.', metadata: skill.metadata });
  for (const token of [member, admin]) expect((await request('GET', `/skills/${skill.id}/export`, token)).status).toBe(404);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_agent_skills').first()).n).toBe(0);
});

test('private skills hide body, links and all direct CRUD routes from members and admins in either mode', async () => {
  const skill = await create();
  expect(skill).toMatchObject({ visibility: 'private', accessVersion: 1, createdBy: '9401' });
  expect((await request('POST', `/hx/agents/${agentId}/skills`, owner, { skillId: skill.id })).status).toBe(200);
  for (const mode of ['harness', 'simple']) {
    await request('PUT', '/orgs/mode', admin, { mode });
    for (const token of [member, admin]) {
      expect((await (await request('GET', '/skills', token)).json()).skills).toEqual([]);
      expect((await (await request('GET', `/hx/agents/${agentId}/skills`, token)).json()).skills).toEqual([]);
      for (const method of ['GET', 'PUT', 'DELETE']) expect((await request(method, `/skills/${skill.id}`, token, { body: 'Overwrite' })).status).toBe(404);
      expect((await request('PUT', `/skills/${skill.id}/access`, token, { visibility: 'workspace', version: 1 })).status).toBe(404);
    }
  }
  expect((await request('PUT', `/skills/${skill.id}`, owner, { body: 'Owner edit' })).status).toBe(200);
  expect((await request('DELETE', `/skills/${skill.id}`, owner)).status).toBe(200);
  expect(await env.DB.prepare('SELECT * FROM hx_skill_access WHERE skill_id = ?').bind(skill.id).first()).toBeNull();
});

test('sharing is owner-only, versioned, and revocation applies to linked agents immediately', async () => {
  const skill = await create('workspace');
  expect((await request('POST', `/hx/agents/${agentId}/skills`, owner, { skillId: skill.id })).status).toBe(200);
  expect((await request('PUT', `/skills/${skill.id}/access`, admin, { visibility: 'private', version: 1 })).status).toBe(403);
  expect((await request('PUT', `/skills/${skill.id}/access`, owner, { visibility: 'private', version: 1 })).status).toBe(200);
  expect((await request('PUT', `/skills/${skill.id}/access`, owner, { visibility: 'workspace', version: 1 })).status).toBe(409);
  expect((await request('POST', `/hx/agents/${agentId}/skills`, admin, { skillId: skill.id })).status).toBe(404);
  const publicPrompt = await prepareAgent(env, orgId, { id: agentId, instructions: 'Help' }, null, { userId: '9401', channel: 'b:public' });
  expect(publicPrompt.agent.instructions).not.toContain('Confidential');
  const ownerPrompt = await prepareAgent(env, orgId, { id: agentId, instructions: 'Help' }, null, { userId: '9401', channel: `ag:${agentId}|owner` });
  expect(ownerPrompt.agent.instructions).toContain('Confidential');
  for (const context of [{ userId: '9402', channel: `ag:${agentId}|member` }, { userId: '9401', channel: `ag:${agentId}|member` }, { channel: `ag:${agentId}|owner` }]) {
    expect(await executionSkills(env.DB, orgId, agentId, context)).toEqual([]);
  }
  await env.DB.prepare('DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2').bind(orgId, '9401').run();
  expect(await executionSkills(env.DB, orgId, agentId, { userId: '9401', channel: `ag:${agentId}|owner` })).toEqual([]);
});

test('legacy skills retain sharing and personal agent links are filtered', async () => {
  await env.DB.prepare("INSERT INTO hx_skills (id, org_id, name, body, created_by, created_at, updated_at) VALUES ('legacy', ?1, 'Legacy', 'Existing body', '9401', '2026-10-16', '2026-10-16')").bind(orgId).run();
  const legacy = await getSkill(env.DB, orgId, 'legacy', '9402');
  expect(legacy).toMatchObject({ visibility: 'workspace', accessVersion: 0 });
  await request('POST', `/hx/agents/${agentId}/skills`, owner, { skillId: 'legacy' });
  await request('PUT', '/channels/agents', owner, { id: agentId, scope: 'personal' });
  expect((await (await request('GET', '/skills', member)).json()).skills[0].agents).toEqual([]);
  expect((await (await request('GET', '/skills', owner)).json()).skills[0].agents).toEqual([agentId]);
  expect((await request('PUT', '/skills/legacy/access', owner, { visibility: 'private', version: 0 })).status).toBe(200);
  expect((await request('GET', '/skills/legacy', member)).status).toBe(404);
});

test('skill and initial visibility are atomic', async () => {
  await env.DB.exec("CREATE TRIGGER reject_skill_policy BEFORE INSERT ON hx_skill_access BEGIN SELECT RAISE(ABORT, 'policy unavailable'); END;");
  await expect(createSkill(env.DB, orgId, { name: 'Must not remain', body: 'Secret', visibility: 'private' }, '9401')).rejects.toThrow();
  expect(await env.DB.prepare("SELECT id FROM hx_skills WHERE org_id = ?1 AND name = 'Must not remain'").bind(orgId).first()).toBeNull();
});

test('installed skill procedures retain instructions beyond the old 4000-character cutoff', async () => {
  const body = `${'Step details. '.repeat(390)}\nFINAL CHECK: Require the owner to review the result before publishing.`;
  expect(body.length).toBeGreaterThan(4000);
  expect(body.length).toBeLessThan(8000);
  const result = await request('POST', '/skills', owner, { name: 'Complete procedure', body, visibility: 'private' });
  expect(result.status).toBe(201);
  const { skill } = await result.json();
  expect((await request('POST', `/hx/agents/${agentId}/skills`, owner, { skillId: skill.id })).status).toBe(200);
  const prepared = await prepareAgent(env, orgId, { id: agentId, instructions: 'Help' }, null, { userId: '9401', channel: `ag:${agentId}|owner` });
  expect(prepared.agent.instructions).toContain(body);
  const shared = await prepareAgent(env, orgId, { id: agentId, instructions: 'Help' }, null, { userId: '9401', channel: 'b:public' });
  expect(shared.agent.instructions).not.toContain('FINAL CHECK');
});


test('on-demand skill reader rechecks installation, agent access and membership each time', async () => {
  const skill = await create();
  await request('POST', `/hx/agents/${agentId}/skills`, owner, {skillId:skill.id});
  const read = installedSkillTools(env.DB, orgId, agentId, {userId:'9401',channel:`ag:${agentId}|owner`}).read_installed_skill.run;
  expect(await read({skill_id:skill.id})).toContain('Confidential instructions');
  await env.DB.prepare('DELETE FROM hx_agent_skills WHERE org_id = ?1 AND agent_id = ?2 AND skill_id = ?3').bind(orgId,agentId,skill.id).run();
  expect(await read({skill_id:skill.id})).toBe('Installed skill unavailable.');
  await request('POST', `/hx/agents/${agentId}/skills`, owner, {skillId:skill.id});
  await env.DB.prepare('DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2').bind(orgId,'9401').run();
  expect(await read({skill_id:skill.id})).toBe('Installed skill unavailable.');
});

test('on-demand reader cannot borrow identity or private context through model arguments', async () => {
  const skill = await create();
  await request('POST', `/hx/agents/${agentId}/skills`, owner, {skillId:skill.id});
  const read = installedSkillTools(env.DB, orgId, agentId, {userId:'9402',channel:`ag:${agentId}|member`}).read_installed_skill.run;
  expect(await read({skill_id:skill.id,userId:'9401',channel:`ag:${agentId}|owner`})).toBe('Installed skill unavailable.');
  const unbound = installedSkillTools(env.DB, orgId, agentId, {}).read_installed_skill.run;
  expect(await unbound({skill_id:skill.id})).toBe('Installed skill unavailable.');
});

test('on-demand reader stops serving a shared skill when the agent grant is revoked', async () => {
  const skill = await create('workspace');
  await request('POST', `/hx/agents/${agentId}/skills`, owner, {skillId:skill.id});
  const read = installedSkillTools(env.DB, orgId, agentId, {userId:'9402'}).read_installed_skill.run;
  expect(await read({skill_id:skill.id})).toContain(`Skill ID: ${skill.id}`);
  expect((await request('PUT', `/hx/agents/${agentId}/profile`, owner, {access:'private'})).status).toBe(200);
  expect(await read({skill_id:skill.id})).toBe('Installed skill unavailable.');
});


test('on-demand output preserves a maximum-length procedure without JSON expansion', async () => {
  const body = `${'"\n'.repeat(3990)}FINAL CHECK`;
  const result = await request('POST','/skills',owner,{name:'Long procedure',description:'Complete instructions',body,visibility:'private'});
  expect(result.status).toBe(201);
  const {skill}=await result.json();
  await request('POST',`/hx/agents/${agentId}/skills`,owner,{skillId:skill.id});
  const prepared=await prepareAgent(env,orgId,{id:agentId,instructions:'Help'},null,{userId:'9401',channel:`ag:${agentId}|owner`});
  expect(prepared.agent.researchInstructions).toContain(skill.id);
  expect(prepared.agent.researchInstructions).not.toContain('FINAL CHECK');
  const output=await prepared.skillTools.read_installed_skill.run({skill_id:skill.id});
  expect(output).toContain(body);
  expect(output.length).toBeLessThan(20000);
  expect(output.endsWith('FINAL CHECK')).toBe(true);
});

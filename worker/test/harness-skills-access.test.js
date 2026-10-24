import { writeSkillZip, parseSkillZip } from '../src/harness/skillZip.js';
import { encodeSkillBytes, readSkillFile, listSkillFiles } from '../src/harness/skillFiles.js';
import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { installedSkillTools } from '../src/harness/skillReader.js';
import { prepareAgent } from '../src/harness/agents.js';
import { createSkill, executionSkills, getSkill } from '../src/harness/skills.js';

const orgId = 'skills-access';
let owner, member, admin, agentId;
const request = (method, path, token, body) => worker.fetch(new Request(`https://example.com${path}${method === 'GET' || method === 'DELETE' ? `${path.includes('?') ? '&' : '?'}orgId=${orgId}` : ''}`, {
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

test('workflow skill readers retain private-skill exclusion even for the owner', async () => {
  const skill=await create();
  await request('POST',`/hx/agents/${agentId}/skills`,owner,{skillId:skill.id});
  const context={userId:'9401',channel:`ag:${agentId}|owner`,allowPrivate:false};
  const prepared=await prepareAgent(env,orgId,{id:agentId,instructions:'Help'},null,context);
  expect(prepared.agent.instructions).not.toContain('Confidential instructions');
  const read=installedSkillTools(env.DB,orgId,agentId,context).read_installed_skill.run;
  expect(await read({skill_id:skill.id,allowPrivate:true})).toBe('Installed skill unavailable.');
});


test('skill creator display names are resolved without changing ownership or private visibility', async () => {
  await env.DB.prepare('UPDATE users SET name=?1 WHERE github_id=?2').bind('Mika Tanaka','9401').run();
  const skill=await create();
  expect(skill).toMatchObject({createdBy:'9401',createdByName:'Mika Tanaka'});
  expect((await (await request('GET','/skills',owner)).json()).skills[0]).toMatchObject({createdByName:'Mika Tanaka'});
  expect((await (await request('GET','/skills',member)).json()).skills).toEqual([]);
  await request('POST',`/hx/agents/${agentId}/skills`,owner,{skillId:skill.id});
  expect((await (await request('GET',`/hx/agents/${agentId}/skills`,owner)).json()).skills[0]).toMatchObject({createdBy:'9401',createdByName:'Mika Tanaka'});
});


test('support files save atomically, preserve bytes, enforce private access and cascade on deletion', async () => {
  const saved=await request('POST','/skills',owner,{name:'Package',description:'A complete package',body:'Read templates/report.txt',visibility:'private',files:[{path:'templates/report.txt',base64:btoa('Report template')},{path:'images/pixel.bin',base64:btoa(String.fromCharCode(0,255,128))}]});
  expect(saved.status).toBe(201);
  const {skill}=await saved.json();
  const {listSkillFiles,readSkillFile}=await import('../src/harness/skillFiles.js');
  expect(await listSkillFiles(env.DB,orgId,skill.id,'9401')).toHaveLength(2);
  expect((await readSkillFile(env.DB,orgId,skill.id,'images/pixel.bin','9401')).bytes).toEqual(new Uint8Array([0,255,128]));
  expect(await readSkillFile(env.DB,orgId,skill.id,'images/pixel.bin','9402')).toBeNull();
  expect((await request('GET',`/skills/${skill.id}/files`,member)).status).toBe(404);
  const download=await worker.fetch(new Request(`https://example.com/skills/${skill.id}/files?orgId=${orgId}&path=images%2Fpixel.bin`,{headers:{'x-session-token':owner}}),env,{waitUntil(){}});
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0,255,128]));
  expect(download.headers.get('content-disposition')).toContain('attachment');
  expect((await request('PUT',`/skills/${skill.id}`,owner,{body:'Updated instructions'})).status).toBe(200);
  expect(await listSkillFiles(env.DB,orgId,skill.id,'9401')).toHaveLength(2);
  const invalid=await request('POST','/skills',owner,{name:'Bad',description:'Bad package',body:'Instructions',files:[{path:'../escape',base64:btoa('x')}]});
  expect(invalid.status).toBe(400);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills').first()).n).toBe(1);
  await request('DELETE',`/skills/${skill.id}`,owner);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_files').first()).n).toBe(0);
});

test('installed support files are paged and recheck access for every read', async () => {
  const text='x'.repeat(13000)+'FINAL TEMPLATE';
  const saved=await request('POST','/skills',owner,{name:'Files',description:'Read templates',body:'Use the template.',visibility:'private',files:[{path:'template.txt',base64:btoa(text)},{path:'image.bin',base64:btoa(String.fromCharCode(255,0,128))}]});
  const {skill}=await saved.json();
  await request('POST',`/hx/agents/${agentId}/skills`,owner,{skillId:skill.id});
  const tools=installedSkillTools(env.DB,orgId,agentId,{userId:'9401',channel:`ag:${agentId}|owner`});
  expect(await tools.list_installed_skill_files.run({skill_id:skill.id})).toContain('template.txt');
  const read=tools.read_installed_skill_file.run;
  const first=await read({skill_id:skill.id,path:'template.txt',offset:0});
  expect(first).toContain('Next offset: 12000');expect(first).not.toContain('FINAL TEMPLATE');
  expect(await read({skill_id:skill.id,path:'template.txt',offset:12000})).toContain('FINAL TEMPLATE');
  expect(await read({skill_id:skill.id,path:'image.bin',offset:0})).toContain('/wCA');
  expect(await read({skill_id:skill.id,path:'../template.txt',offset:0})).toBe('Skill file unavailable.');
  await env.DB.prepare('DELETE FROM hx_agent_skills WHERE org_id=?1 AND agent_id=?2').bind(orgId,agentId).run();
  expect(await read({skill_id:skill.id,path:'template.txt',offset:12000})).toBe('Installed skill unavailable.');
});


test('ZIP and folder preview preserve binary assets without saving; private export round-trips', async () => {
  const entries = [{path:'SKILL.md',bytes:new TextEncoder().encode('---\nname: package\ndescription: Reports\n---\nRead references/report.txt.')}, {path:'references/report.txt',bytes:new TextEncoder().encode('Report template')}, {path:'assets/pixel.bin',bytes:new Uint8Array([0,255,128,13,10])}];
  const zipped=writeSkillZip(entries);
  expect(zipped.error).toBeUndefined();
  const preview=await request('POST','/skills/preview-import',owner,{zipBase64:encodeSkillBytes(zipped.bytes)});
  expect(preview.status).toBe(200);
  const {draft}=await preview.json();
  const folder=await request('POST','/skills/preview-import',owner,{files:entries.map(f=>({path:'package/'+f.path,base64:encodeSkillBytes(f.bytes)}))});
  expect((await folder.json()).draft).toEqual(draft);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills').first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skill_files').first()).n).toBe(0);
  const saved=await request('POST','/skills',owner,{...draft,visibility:'private'});
  expect(saved.status).toBe(201);
  const {skill}=await saved.json();
  const exported=await request('GET',`/skills/${skill.id}/export?format=zip`,owner);
  expect(exported.status).toBe(200);
  expect(exported.headers.get('content-type')).toBe('application/zip');
  const parsed=parseSkillZip(new Uint8Array(await exported.arrayBuffer()));
  expect(parsed.draft.name).toBe('package');
  for(const file of entries.slice(1))expect(parsed.files.find(f=>f.path===file.path).bytes).toEqual(file.bytes);
  expect((await request('GET',`/skills/${skill.id}/export?format=zip`,member)).status).toBe(404);
});

test('malformed or ambiguous package previews cannot create skills',async()=>{
  for(const input of [{zipBase64:'broken'}, {files:[{path:'../SKILL.md',base64:btoa('bad')}]}, {markdown:'bad',files:[]}, {files:[]}]) {
    expect((await request('POST','/skills/preview-import',owner,input)).status).toBe(400);
  }
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills').first()).n).toBe(0);
});
test('folder preview canonicalizes Mac filenames and refuses normalized collisions without saving',async()=>{
  const root={path:'報告/SKILL.md',base64:encodeSkillBytes(new TextEncoder().encode('---\nname: report\ndescription: Report helper\n---\nRead ガイド.txt.'))};
  const file={path:'報告/ガイド.txt'.normalize('NFD'),base64:encodeSkillBytes(new TextEncoder().encode('手順'))};
  const response=await request('POST','/skills/preview-import',owner,{files:[root,file]});
  expect(response.status).toBe(200);
  expect((await response.json()).draft.files.map(f=>f.path)).toEqual(['ガイド.txt']);
  const collision=await request('POST','/skills/preview-import',owner,{files:[root,file,{...file,path:'報告/ガイド.txt'}]});
  expect(collision.status).toBe(400);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills').first()).n).toBe(0);
});

test('a skill ownership change between read and write blocks the former owner from changing sharing or content',async()=>{
  const {setSkillAccess}=await import('../src/harness/skillAccess.js');
  const {updateSkill}=await import('../src/harness/skills.js');
  for(const operation of ['sharing','content']) {
    const skill=await create(operation==='content'?'workspace':'private');
    const db={prepare:sql=>{
      const statement=env.DB.prepare(sql);
      if(!(operation==='sharing'?sql.startsWith('UPDATE hx_skill_access'):sql.startsWith('UPDATE hx_skills SET')))return statement;
      return {bind:(...args)=>{
        const bound=statement.bind(...args);
        return {run:async()=>{
          await env.DB.prepare('UPDATE hx_skills SET owner_id=?2 WHERE id=?1').bind(skill.id,'9402').run();
          return bound.run();
        }};
      }};
    }};
    const result=operation==='sharing'
      ?await setSkillAccess(db,orgId,skill.id,'9401',{visibility:'workspace',version:1})
      :await updateSkill(db,orgId,skill.id,{body:'Overwritten after transfer'},'9401');
    expect(result.error).toBeTruthy();
    expect((await env.DB.prepare('SELECT body FROM hx_skills WHERE id=?1').bind(skill.id).first()).body).toBe('Confidential instructions');
    if(operation==='sharing')expect((await env.DB.prepare('SELECT visibility FROM hx_skill_access WHERE skill_id=?1').bind(skill.id).first()).visibility).toBe('private');
  }
});

test('a new skill owner may edit and share while the creator attribution remains unchanged',async()=>{
  const skill=await create();
  await env.DB.prepare('UPDATE hx_skills SET owner_id=?2 WHERE id=?1').bind(skill.id,'9402').run();
  const listed=(await (await request('GET','/skills',member)).json()).skills.find(s=>s.id===skill.id);
  expect(listed).toMatchObject({createdBy:'9401',canEdit:true,canShare:true});
  expect(listed).not.toHaveProperty('ownerId');
  expect((await request('GET',`/skills/${skill.id}`,owner)).status).toBe(404);
  expect((await request('PUT',`/skills/${skill.id}`,member,{body:'New owner edit'})).status).toBe(200);
  expect((await request('PUT',`/skills/${skill.id}/access`,member,{visibility:'workspace',version:1})).status).toBe(200);
  expect((await request('PUT',`/skills/${skill.id}`,owner,{body:'Former owner edit'})).status).toBe(403);
  expect((await request('DELETE',`/skills/${skill.id}`,owner)).status).toBe(403);
  expect((await request('DELETE',`/skills/${skill.id}`,member)).status).toBe(200);
});

test('preserves full memory-sized skill fields and rejects oversized writes without mutation', async () => {
  const fields = { name: '名'.repeat(120), description: '説'.repeat(500), body: '記'.repeat(16000), visibility: 'private' };
  const made = await request('POST', '/skills', owner, fields);
  expect(made.status).toBe(201);
  const { skill } = await made.json();
  expect(skill).toMatchObject(fields);
  const exported = await request('GET', `/skills/${skill.id}/export`, owner);
  const preview = await request('POST', '/skills/preview-import', owner, { markdown: (await exported.json()).markdown });
  expect((await preview.json()).draft).toMatchObject({ name: fields.name, description: fields.description, body: fields.body });
  for (const key of ['name', 'description', 'body']) {
    const invalid = { ...fields, [key]: fields[key] + '超' };
    expect((await request('POST', '/skills', owner, invalid)).status).toBe(400);
    expect((await request('PUT', `/skills/${skill.id}`, owner, invalid)).status).toBe(400);
    expect(await getSkill(env.DB, orgId, skill.id, '9401')).toMatchObject(fields);
  }
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id = ?').bind(orgId).first()).n).toBe(1);
});

test('rejects an unexportable combined metadata and body size before writing', async () => {
  const input = { name: 'Limit', description: 'Combined byte limit', body: '記'.repeat(16000), metadata: { note: '説'.repeat(7900) } };
  const made = await request('POST', '/skills', owner, input);
  expect(made.status).toBe(400);
  expect((await createSkill(env.DB, orgId, input, '9401')).error).toContain('64 KiB');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id = ?').bind(orgId).first()).n).toBe(0);
});

test('source-scoped skills preserve room access across listing, export, installation and execution', async () => {
  const skill = await create();
  await request('PUT',`/skills/${skill.id}`,owner,{description:'Scoped procedure'});
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_at) VALUES (?,'source-room','Source room',1,?)").bind(orgId,new Date().toISOString()).run();
  for (const login of ['owner','member']) await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES (?,'b:source-room',?,'owner',?)").bind(orgId,login,new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO hx_skill_source_scopes(org_id,skill_id,agent_id,channel,memory_id,memory_version,created_by,created_at) VALUES (?,?,?,'b:source-room','source-memory',3,'9401',?)").bind(orgId,skill.id,agentId,new Date().toISOString()).run();
  expect((await request('POST', `/hx/agents/${agentId}/skills`, owner, {skillId:skill.id})).status).toBe(200);
  expect(await getSkill(env.DB,orgId,skill.id,'9402')).toMatchObject({canShare:false,sourceScope:{agentId,channel:'b:source-room'}});
  expect((await (await request('GET','/skills',member)).json()).skills.map(s=>s.id)).toContain(skill.id);
  expect((await request('GET',`/skills/${skill.id}/export`,member)).status).toBe(200);
  expect((await request('GET',`/skills/${skill.id}/export`,admin)).status).toBe(404);
  expect((await request('PUT',`/skills/${skill.id}/access`,owner,{visibility:'workspace',version:1})).status).toBe(409);
  const other=(await(await request('POST','/channels/agents',owner,{name:'Other',handle:'other',instructions:'Help',scope:'team'})).json()).agent;
  expect((await request('POST',`/hx/agents/${other.id}/skills`,owner,{skillId:skill.id})).status).toBe(409);
  expect((await executionSkills(env.DB,orgId,agentId,{userId:'9402',channel:'b:source-room'})).map(s=>s.id)).toContain(skill.id);
  for (const context of [{userId:'9402'}, {userId:'9402',channel:'b:elsewhere'}, {userId:'9401',channel:`ag:${agentId}|owner`}, {userId:'9402',channel:'b:source-room',allowPrivate:false}]) {
    expect(await executionSkills(env.DB,orgId,agentId,context)).toEqual([]);
  }
  await env.DB.prepare('INSERT INTO hx_skill_files(org_id,skill_id,path,size,content) VALUES (?,?,?,3,?)').bind(orgId,skill.id,'notes.txt',new TextEncoder().encode('abc').buffer).run();
  expect(await listSkillFiles(env.DB,orgId,skill.id,'9402')).toHaveLength(1);
  expect(await readSkillFile(env.DB,orgId,skill.id,'notes.txt','9402')).not.toBeNull();
  const reader=installedSkillTools(env.DB,orgId,agentId,{userId:'9402',channel:'b:source-room'});
  expect(await reader.read_installed_skill.run({skill_id:skill.id})).toContain('Confidential instructions');
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:source-room' AND login='member'").bind(orgId).run();
  expect(await getSkill(env.DB,orgId,skill.id,'9402')).toBeNull();
  expect((await(await request('GET','/skills',member)).json()).skills).toEqual([]);
  expect((await request('GET',`/skills/${skill.id}/export`,member)).status).toBe(404);
  expect(await reader.read_installed_skill.run({skill_id:skill.id})).toBe('Installed skill unavailable.');
  expect(await listSkillFiles(env.DB,orgId,skill.id,'9402')).toBeNull();
  expect(await readSkillFile(env.DB,orgId,skill.id,'notes.txt','9402')).toBeNull();
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:source-room' AND login='owner'").bind(orgId).run();
  expect(await getSkill(env.DB,orgId,skill.id,'9401')).toBeNull();
  expect((await request('PUT',`/skills/${skill.id}`,owner,{body:'Lost access'})).status).toBe(404);
  expect((await request('DELETE',`/skills/${skill.id}`,owner)).status).toBe(404);
});

test('agent-wide source skills track current agent and workspace grants',async()=>{
  const skill=await create();
  await env.DB.prepare("INSERT INTO hx_skill_source_scopes(org_id,skill_id,agent_id,channel,memory_id,memory_version,created_by,created_at) VALUES (?,?,?,'','global-memory',0,'9401',?)").bind(orgId,skill.id,agentId,new Date().toISOString()).run();
  await request('POST',`/hx/agents/${agentId}/skills`,owner,{skillId:skill.id});
  expect(await getSkill(env.DB,orgId,skill.id,'9402')).not.toBeNull();
  expect(await getSkill(env.DB,orgId,skill.id,'')).toBeNull();
  await request('PUT','/channels/agents',owner,{id:agentId,scope:'personal'});
  expect(await getSkill(env.DB,orgId,skill.id,'9402')).toBeNull();
  expect(await executionSkills(env.DB,orgId,agentId,{userId:'9402',channel:`ag:${agentId}|member`})).toEqual([]);
  expect((await executionSkills(env.DB,orgId,agentId,{userId:'9401',channel:`ag:${agentId}|owner`})).map(s=>s.id)).toContain(skill.id);
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(orgId,'9401').run();
  expect(await getSkill(env.DB,orgId,skill.id,'9401')).toBeNull();
});

test('memory conversion preserves full content, installs atomically and replays after source removal',async()=>{
  const {addAgentMemory}=await import('../src/harness/agents.js');
  const fields={title:'名'.repeat(120),description:'説'.repeat(500),body:'記'.repeat(16000)};
  const {memory}=await addAgentMemory(env.DB,orgId,agentId,fields,{by:'9401'});
  const path=`/hx/agents/${agentId}/memory/${memory.id}/to-skill`;
  const input={expectedVersion:memory.version,requestId:'conversion-full-1',keepEntry:false};
  expect((await request('POST',path,member,input)).status).toBe(403);
  const response=await request('POST',path,owner,input);
  expect(response.status).toBe(201);
  const result=await response.json();
  expect(result.skill).toMatchObject({name:fields.title,description:fields.description,body:fields.body,sourceScope:{agentId,channel:null},canShare:false});
  expect(await env.DB.prepare('SELECT id FROM hx_agent_memories WHERE id=?').bind(memory.id).first()).toBeNull();
  expect(await env.DB.prepare('SELECT skill_id FROM hx_agent_skills WHERE org_id=? AND agent_id=? AND skill_id=?').bind(orgId,agentId,result.skill.id).first()).not.toBeNull();
  const again=await request('POST',path,owner,input);
  expect(again.status).toBe(200);
  expect((await again.json()).skill.id).toBe(result.skill.id);
  expect((await request('POST',path,owner,{...input,keepEntry:true})).status).toBe(409);
  const exported=await(await request('GET',`/skills/${result.skill.id}/export`,owner)).json();
  const imported=await(await request('POST','/skills/preview-import',owner,{markdown:exported.markdown})).json();
  expect(imported.draft).toMatchObject({name:fields.title,description:fields.description,body:fields.body});
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?').bind(orgId).first()).n).toBe(1);
});

test('conversion keeps legacy memory on request and rejects stale or repeated versions',async()=>{
  const {addAgentMemory}=await import('../src/harness/agents.js');
  const {memory}=await addAgentMemory(env.DB,orgId,agentId,'Legacy instructions',{by:'9401'});
  const path=`/hx/agents/${agentId}/memory/${memory.id}/to-skill`;
  const input={expectedVersion:0,requestId:'conversion-legacy',keepEntry:true};
  expect((await request('POST',path,owner,{...input,expectedVersion:1})).status).toBe(409);
  const r=await request('POST',path,owner,input);
  expect(r.status).toBe(201);
  const result=await r.json();
  expect(result.skill.metadata['source-memory']).toMatchObject({description:'',version:0});
  expect((await request('GET',`/skills/${result.skill.id}/export`,owner)).status).toBe(200);
  expect(await env.DB.prepare('SELECT text FROM hx_agent_memories WHERE id=?').bind(memory.id).first()).toEqual({text:'Legacy instructions'});
  expect((await request('POST',path,owner,{...input,requestId:'conversion-other'})).status).toBe(409);
});

test('conversion installation failure rolls back skill, scope, replay record and source deletion',async()=>{
  const {addAgentMemory}=await import('../src/harness/agents.js');
  const {convertMemoryToSkill}=await import('../src/harness/memorySkillConversion.js');
  const {memory}=await addAgentMemory(env.DB,orgId,agentId,'Keep on failure',{by:'9401'});
  await env.DB.exec("CREATE TRIGGER fail_conversion_install BEFORE INSERT ON hx_agent_skills BEGIN SELECT RAISE(ABORT,'injected install failure'); END;");
  try {
    await expect(convertMemoryToSkill(env.DB,orgId,agentId,memory.id,{expectedVersion:0,requestId:'conversion-failure',keepEntry:false},{by:'9401'})).rejects.toThrow();
    for (const table of ['hx_skills','hx_skill_source_scopes','hx_memory_skill_conversions']) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`).bind(orgId).first()).n).toBe(0);
    }
    expect(await env.DB.prepare('SELECT id FROM hx_agent_memories WHERE id=?').bind(memory.id).first()).not.toBeNull();
  } finally {await env.DB.exec('DROP TRIGGER fail_conversion_install;');}
});

test('concurrent repeated conversion produces exactly one installed skill',async()=>{
  const {addAgentMemory}=await import('../src/harness/agents.js');
  const {convertMemoryToSkill}=await import('../src/harness/memorySkillConversion.js');
  const {memory}=await addAgentMemory(env.DB,orgId,agentId,'Concurrent conversion',{by:'9401'});
  const run=()=>convertMemoryToSkill(env.DB,orgId,agentId,memory.id,{expectedVersion:0,requestId:'conversion-race',keepEntry:false},{by:'9401'});
  const results=await Promise.all([run(),run()]);
  expect(results.every(r=>r.skill)).toBe(true);
  expect(new Set(results.map(r=>r.skill.id)).size).toBe(1);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_agent_skills WHERE org_id=?').bind(orgId).first()).n).toBe(1);
});

test('conversation memory conversion requires the exact source scope and keeps its execution boundary',async()=>{
  const {addAgentMemory}=await import('../src/harness/agents.js');
  const channel=`ag:${agentId}|owner`;
  const {memory}=await addAgentMemory(env.DB,orgId,agentId,'Private source instructions',{by:'9401',channel});
  const path=`/hx/agents/${agentId}/memory/${memory.id}/to-skill`;
  const input={expectedVersion:0,requestId:'conversion-scoped',keepEntry:true};
  expect((await request('POST',path,owner,input)).status).toBe(404);
  const converted=await request('POST',path,owner,{...input,channel:`ag:${agentId}`});
  expect(converted.status).toBe(201);
  const {skill}=await converted.json();
  expect(skill.sourceScope).toEqual({agentId,channel});
  expect(await getSkill(env.DB,orgId,skill.id,'9402')).toBeNull();
  expect(await executionSkills(env.DB,orgId,agentId,{userId:'9401',channel:'b:shared'})).toEqual([]);
  expect((await executionSkills(env.DB,orgId,agentId,{userId:'9401',channel})).map(s=>s.id)).toContain(skill.id);
});

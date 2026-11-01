import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {agentRoleState,explicitAgentRoles,setAgentRole,transferAgentOwnership} from '../src/harness/agentRoles.js';
import {upsertUser,upsertMembership} from '../src/db.js';
import {saveAgent,listAgents,toClientAgent} from '../src/customAgents.js';
import {mayAccessAgent,mayRunAgent} from '../src/harness/agents.js';
const ORG='personal:roles',AGENT='roles-agent';
beforeEach(async()=>{
 for(const [id,login,role] of [['a','maker','member'],['b','delegate','member'],['c','reader','member'],['g','guest','guest']]) {
  await upsertUser(env.DB,{githubId:id,login,name:login,avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,ORG,id,role);
 }
 await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,?2,'role-agent','Role agent','Help','team','maker','now','now')`).bind(ORG,AGENT).run();
 await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','now')`).bind(ORG,AGENT).run();
});
const change=(actorId,targetId,role,expectedVersion)=>setAgentRole(env.DB,ORG,AGENT,{actorId,targetId,role,expectedVersion});
const transfer=(actorId,targetId,expectedVersion)=>transferAgentOwnership(env.DB,ORG,AGENT,{actorId,targetId,expectedVersion});
test('ownership transfer preserves the creator and lets the former owner leave',async()=>{
 await change('a','b','admin',0);
 expect(await transfer('a','b',1)).toEqual({version:2});
 const members=(await agentRoleState(env.DB,ORG,AGENT)).members;
 expect(members.find(m=>m.userId==='b')).toMatchObject({owner:1,role:'admin'});
 expect(members.find(m=>m.userId==='a')).toMatchObject({owner:0,role:'admin'});
 const agent=(await listAgents(env.DB,ORG,'delegate')).find(a=>a.id===AGENT);
 expect(toClientAgent(agent,[{login:'maker',name:'Original',ref:'original'},{login:'delegate',name:'New owner',ref:'new'}],'delegate')).toMatchObject({mine:true,createdBy:'original',createdByName:'Original',createdByMe:false});
 expect((await change('a','b','none',2)).status).toBe(409);
 expect(await change('a','a','none',2)).toEqual({version:3});
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'maker')).size).toBe(0);
});
test('only the owner transfers to a current human admin and concurrent transfers have one winner',async()=>{
 await change('a','b','admin',0);await change('a','c','member',1);
 expect((await transfer('b','c',2)).status).toBe(403);
 expect((await transfer('a','c',2)).status).toBe(409);
 expect((await transfer('a','g',2)).status).toBe(409);
 await change('a','c','admin',2);
 const results=await Promise.all([transfer('a','b',3),transfer('a','c',3)]);
 expect(results.filter(r=>r.version===4)).toHaveLength(1);
 expect(results.filter(r=>r.status===409||r.status===403)).toHaveLength(1);
 const state=await agentRoleState(env.DB,ORG,AGENT);
 expect(state.members.filter(m=>m.owner)).toHaveLength(1);
 expect((await env.DB.prepare('SELECT created_by_login FROM custom_agents WHERE org_id=?1 AND id=?2').bind(ORG,AGENT).first()).created_by_login).toBe('maker');
});
test('the maker delegates independent roles, members cannot administer, and live membership gates roles',async()=>{
 expect((await agentRoleState(env.DB,ORG,AGENT)).members).toMatchObject([{userId:'a',role:'admin',owner:1}]);
 expect(await change('a','b','admin',0)).toEqual({version:1});
 expect(await change('b','c','member',1)).toEqual({version:2});
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).get(AGENT)).toBe('admin');
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'reader')).get(AGENT)).toBe('member');
 expect((await change('c','b','none',2)).status).toBe(403);
 expect((await change('b','g','member',2)).status).toBe(404);
 expect((await change('b','a','member',2)).status).toBe(409);
 expect((await change('a','c','admin',0)).status).toBe(409);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'b').run();
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
 expect((await change('b','c','admin',2)).status).toBe(403);
 expect((await explicitAgentRoles(env.DB,'other',[AGENT],'reader')).size).toBe(0);
});
test('the last active human admin cannot leave or demote until another admin exists',async()=>{
 await change('a','b','admin',0);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'a').run();
 expect((await change('b','b','none',1)).status).toBe(409);
 expect((await change('b','b','member',1)).status).toBe(409);
 expect(await change('b','c','admin',1)).toEqual({version:2});
 expect(await change('b','b','none',2)).toEqual({version:3});
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'reader')).get(AGENT)).toBe('admin');
});
test('concurrent changes have one winner and a stale writer cannot overwrite grants',async()=>{
 const results=await Promise.all([change('a','b','admin',0),change('a','c','member',0)]);
 expect(results.filter(r=>r.version===1)).toHaveLength(1);
 expect(results.filter(r=>r.status===409)).toHaveLength(1);
 const state=await agentRoleState(env.DB,ORG,AGENT);
 expect(state.version).toBe(1);expect(state.members).toHaveLength(2);
 const winner=results[0].version===1?'b':'c';
 expect(state.members.some(m=>m.userId===winner)).toBe(true);
});
test('personal sharing assigns only the chosen role while unmanaged legacy agents require setup',async()=>{
 await env.DB.prepare("UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id=?2").bind(ORG,AGENT).run();
 await env.DB.prepare("UPDATE hx_agent_profiles SET access='everyone',people='[\"reader\"]' WHERE org_id=?1 AND agent_id=?2").bind(ORG,AGENT).run();
 expect(await change('a','b','admin',0)).toEqual({version:1});
 expect((await env.DB.prepare('SELECT access FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(ORG,AGENT).first()).access).toBe('private');
 expect((await agentRoleState(env.DB,ORG,AGENT)).scope).toBe('team');
 expect(await mayAccessAgent(env.DB,ORG,{id:AGENT,scope:'team',ownerLogin:'maker'},'reader')).toBe(false);
 await env.DB.prepare("UPDATE custom_agents SET scope='team' WHERE org_id=?1 AND id=?2").bind(ORG,AGENT).run();
 await env.DB.prepare('DELETE FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(ORG,AGENT).run();
 expect((await change('a','b','admin',1)).status).toBe(409);
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
});

test('ordinary members add and remove members and leave, without changing admin roles',async()=>{
 expect(await change('a','b','member',0)).toEqual({version:1});
 expect(await change('b','c','member',1)).toEqual({version:2});
 expect((await change('b','c','admin',2)).status).toBe(403);
 expect((await change('b','a','none',2)).status).toBe(403);
 expect(await change('b','c','none',2)).toEqual({version:3});
 expect(await change('b','b','none',3)).toEqual({version:4});
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
 expect((await change('b','c','member',4)).status).toBe(403);
});

test('a concurrent admin promotion cannot be undone by an ordinary member removal',async()=>{
 await change('a','b','member',0);await change('a','c','member',1);
 const results=await Promise.all([change('a','c','admin',2),change('b','c','none',2)]);
 expect(results.filter(r=>r.version===3)).toHaveLength(1);
 expect(results.filter(r=>r.status===409)).toHaveLength(1);
 if(results[0].version===3){
  expect((await change('b','c','none',3)).status).toBe(403);
  expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'reader')).get(AGENT)).toBe('admin');
 }
});

test('concurrent self-demotions cannot remove every active admin',async()=>{
 await change('a','b','admin',0);
 await change('a','c','admin',1);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'a').run();
 const results=await Promise.all([change('b','b','member',2),change('c','c','member',2)]);
 expect(results.filter(r=>r.version===3)).toHaveLength(1);
 expect(results.filter(r=>r.status===409)).toHaveLength(1);
 const state=await agentRoleState(env.DB,ORG,AGENT);
 expect(state.members.filter(m=>m.role==='admin')).toHaveLength(1);
 const remaining=state.members.find(m=>m.role==='admin').userId;
 expect((await change(remaining,remaining,'none',3)).status).toBe(409);
});

test('leaving and rejoining does not revive a previous delegated role',async()=>{
 await change('a','b','admin',0);
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'b').run();
 await upsertMembership(env.DB,ORG,'b','member');
 await env.DB.prepare("UPDATE memberships SET created_at='2099-01-01' WHERE org_id=?1 AND user_github_id=?2").bind(ORG,'b').run();
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
 expect((await agentRoleState(env.DB,ORG,AGENT)).members.some(m=>m.userId==='b')).toBe(false);
 expect((await change('b','c','admin',1)).status).toBe(403);
 expect(await change('a','b','member',1)).toEqual({version:2});
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).get(AGENT)).toBe('member');
});

test('mixed-case Guest membership revokes explicit Agent roles immediately',async()=>{
 await change('a','b','admin',0);
 await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1 AND user_github_id=?2").bind(ORG,'b').run();
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
 expect((await agentRoleState(env.DB,ORG,AGENT)).members.some(m=>m.userId==='b')).toBe(false);
 expect(await mayAccessAgent(env.DB,ORG,{id:AGENT,scope:'team',ownerLogin:'maker'},'delegate')).toBe(false);
 await env.DB.prepare("UPDATE hx_agent_profiles SET access='everyone' WHERE org_id=?1 AND agent_id=?2").bind(ORG,AGENT).run();
 expect(await mayRunAgent(env.DB,ORG,{id:AGENT,scope:'team',owner_login:'delegate'},'b')).toBe(false);
 expect((await change('a','b','member',1)).status).toBe(404);
});

test('returning to personal clears grants and sharing again does not revive them',async()=>{
 await change('a','b','admin',0);
 const personal=await saveAgent(env.DB,ORG,{id:AGENT,input:{scope:'personal'},login:'maker',members:[],isAdmin:false});
 expect(personal.error).toBeUndefined();
 expect(personal.agent.scope).toBe('personal');
 expect((await agentRoleState(env.DB,ORG,AGENT)).version).toBe(2);
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
 expect(await change('a','c','member',2)).toEqual({version:3});
 const shared={...personal.agent,scope:'team'};
 expect(await mayAccessAgent(env.DB,ORG,shared,'reader')).toBe(true);
 expect(await mayAccessAgent(env.DB,ORG,shared,'delegate')).toBe(false);
 expect((await agentRoleState(env.DB,ORG,AGENT)).members.map(m=>m.userId).sort()).toEqual(['a','c']);
});

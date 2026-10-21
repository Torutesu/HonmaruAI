import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {agentRoleState,explicitAgentRoles,setAgentRole} from '../src/harness/agentRoles.js';
import {upsertUser,upsertMembership} from '../src/db.js';
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
test('personal and unmanaged legacy agents do not silently broaden their access',async()=>{
 await env.DB.prepare("UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id=?2").bind(ORG,AGENT).run();
 expect((await change('a','b','admin',0)).status).toBe(409);
 await env.DB.prepare("UPDATE custom_agents SET scope='team' WHERE org_id=?1 AND id=?2").bind(ORG,AGENT).run();
 await env.DB.prepare('DELETE FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(ORG,AGENT).run();
 expect((await change('a','b','admin',0)).status).toBe(409);
 expect((await explicitAgentRoles(env.DB,ORG,[AGENT],'delegate')).size).toBe(0);
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

import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {agentPeerRoleState,setAgentPeerRole} from '../src/harness/agentPeerRoles.js';
import {beginAssignment,commitHandoff} from '../src/harness/agentAssignments.js';
import {createSession} from '../src/db.js';
import worker from '../src/index.js';
import migrationsSql from '../migrations.sql?raw';

const org='peer-roles';
const row={id:'peer-request',channel:'b:room',author_login:'alice',parent_id:null,kind:'message',body:'Coordinate'};
let ownerToken,memberToken,outsiderToken;
beforeEach(async()=>{
  await env.DB.exec(schema.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'human',login:'owner',name:'Owner',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,org,'human','admin');
  await upsertUser(env.DB,{githubId:'member',login:'member',name:'Member',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,org,'member','member');
  await upsertUser(env.DB,{githubId:'outsider',login:'outsider',name:'Outsider',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,org,'outsider','member');
  ownerToken=await createSession(env.DB,'human','owner-session');
  memberToken=await createSession(env.DB,'member','member-session');
  outsiderToken=await createSession(env.DB,'outsider','outsider-session');
  for(const id of ['researcher','reviewer']) {
    await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
      VALUES (?1,?2,?2,?2,'Help','team','owner','now','now')`).bind(org,id).run();
    await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','now')`).bind(org,id).run();
    await env.DB.prepare(`INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,'b:room',?2,'owner','now')`).bind(org,id).run();
  }
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at)
    VALUES (?1,?2,?3,?4,'message',?5,'now')`).bind(row.id,org,row.channel,row.author_login,row.body).run();
});

test('handoff to a managed Agent requires an explicit Agent member role and a current CAS version',async()=>{
  const assignment=(await beginAssignment(env.DB,{orgId:org,row,agentId:'researcher',actorId:'human',sessionKey:'h1:peer'})).assignment;
  const move={orgId:org,assignmentId:assignment.id,generation:0,sourceAgentId:'researcher',targetAgentId:'reviewer',operationId:'peer-op',brief:'Review',messageBody:'Please review'};
  expect(await commitHandoff(env.DB,move)).toMatchObject({status:403});
  expect(await agentPeerRoleState(env.DB,org,'reviewer')).toMatchObject({version:0,scope:'team',managed:true,members:[]});
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'researcher',role:'member',expectedVersion:0})).toEqual({version:1});
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'researcher',role:'member',expectedVersion:0})).toMatchObject({status:409});
  expect(await commitHandoff(env.DB,move)).toMatchObject({replayed:false,operation:{target_agent_id:'reviewer'}});
});

test('peer role mutations require a human Agent Admin and reject self or non-managed members',async()=>{
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'unknown',memberAgentId:'researcher',role:'member',expectedVersion:0})).toMatchObject({status:403});
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'reviewer',role:'member',expectedVersion:0})).toMatchObject({status:400});
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'missing',role:'member',expectedVersion:0})).toMatchObject({status:404});
});

test('handoff rechecks the peer grant atomically after the preflight read',async()=>{
  const assignment=(await beginAssignment(env.DB,{orgId:org,row,agentId:'researcher',actorId:'human',sessionKey:'h1:race'})).assignment;
  await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'researcher',role:'member',expectedVersion:0});
  const db={
    prepare:(...args)=>env.DB.prepare(...args),
    batch:async statements=>{
      await env.DB.prepare('DELETE FROM hx_agent_agent_members WHERE org_id=?1 AND agent_id=?2 AND member_agent_id=?3').bind(org,'reviewer','researcher').run();
      return env.DB.batch(statements);
    },
  };
  const result=await commitHandoff(db,{orgId:org,assignmentId:assignment.id,generation:0,sourceAgentId:'researcher',targetAgentId:'reviewer',operationId:'peer-revoked-in-flight',brief:'Review',messageBody:'Please review'});
  expect(result).toMatchObject({status:409});
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2').bind(org,'peer-revoked-in-flight').first()).toBeNull();
  expect(await env.DB.prepare('SELECT status FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(org,assignment.id).first()).toMatchObject({status:'running'});
  expect(await env.DB.prepare('SELECT 1 FROM channel_messages WHERE org_id=?1 AND author_login=?2').bind(org,'agent:researcher').first()).toBeNull();
});

test('a stale peer grant cannot be used after either Agent stops being managed team Agent',async()=>{
  const assignment=(await beginAssignment(env.DB,{orgId:org,row,agentId:'researcher',actorId:'human',sessionKey:'h1:stale'})).assignment;
  await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'researcher',role:'member',expectedVersion:0});
  await env.DB.prepare("UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id='researcher'").bind(org).run();
  const result=await commitHandoff(env.DB,{orgId:org,assignmentId:assignment.id,generation:0,sourceAgentId:'researcher',targetAgentId:'reviewer',operationId:'peer-source-downgraded',brief:'Review',messageBody:'Please review'});
  expect(result).toMatchObject({status:403});
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2').bind(org,'peer-source-downgraded').first()).toBeNull();
});

test('the HTTP peer route requires access to the root Agent and limits writes to its human Agent Admins',async()=>{
  const path=`/hx/agents/reviewer/agent-members?orgId=${encodeURIComponent(org)}`;
  const call=(method,token,body)=>worker.fetch(new Request(`https://example.com${path}`,{
    method,headers:{'content-type':'application/json','x-session-token':token},...(body?{body:JSON.stringify({...body,orgId:org})}:{}),
  }),env,{waitUntil(){}});
  expect((await call('GET',outsiderToken)).status).toBe(404);
  const membership=await env.DB.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id='member'").bind(org).first();
  await env.DB.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
    VALUES (?1,'reviewer','member','member','human','now',?2)`).bind(org,membership.created_at).run();
  const before=await (await call('GET',memberToken)).json();
  expect(before).toMatchObject({managed:true,scope:'team',canManage:false,candidates:[],members:[]});
  const denied=await call('PUT',memberToken,{memberAgentId:'researcher',role:'member',expectedVersion:0});
  expect(denied.status,JSON.stringify(await denied.clone().json())).toBe(403);
  const saved=await call('PUT',ownerToken,{memberAgentId:'researcher',role:'member',expectedVersion:0});
  expect(saved.status).toBe(200);
  const after=await (await call('GET',ownerToken)).json();
  expect(after.members).toEqual([{agentId:'researcher',name:'researcher',role:'member'}]);
  const hidden=await (await call('GET',memberToken)).json();
  expect(hidden.members).toEqual([]);
  expect(hidden.candidates).toEqual([]);
});

test('candidate access revocation racing with a peer assignment fails closed',async()=>{
  await env.DB.prepare("UPDATE hx_agent_profiles SET access='private' WHERE org_id=?1 AND agent_id='researcher'").bind(org).run();
  const add=async(agentId,userId,role)=>{
    const memberSince=await env.DB.prepare('SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(org,userId).first();
    await env.DB.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
      VALUES (?1,?2,?3,?4,'human','now',?5)`).bind(org,agentId,userId,role,memberSince.created_at).run();
  };
  await add('reviewer','member','admin');
  await add('researcher','member','member');
  const db={
    prepare:(...args)=>env.DB.prepare(...args),
    batch:async statements=>{
      await env.DB.prepare("DELETE FROM hx_agent_members WHERE org_id=?1 AND agent_id='researcher' AND user_id='member'").bind(org).run();
      return env.DB.batch(statements);
    },
  };
  const result=await setAgentPeerRole(db,org,'reviewer',{actorId:'member',memberAgentId:'researcher',role:'member',expectedVersion:0});
  expect(result).toMatchObject({status:409});
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_agent_members WHERE org_id=?1 AND agent_id=?2 AND member_agent_id=?3').bind(org,'reviewer','researcher').first()).toBeNull();
});

test('the deploy parser includes executable peer table and index statements',()=>{
  const statements=migrationsSql.split('\n').filter(line=>/^(ALTER TABLE|CREATE |INSERT OR IGNORE INTO|DROP TABLE)/.test(line)).map(line=>line.trim());
  expect(statements.some(sql=>sql.startsWith('CREATE TABLE IF NOT EXISTS hx_agent_agent_members '))).toBe(true);
  expect(statements.some(sql=>sql.startsWith('CREATE INDEX IF NOT EXISTS idx_hx_agent_agent_members_peer '))).toBe(true);
  expect(statements.filter(sql=>sql.includes('hx_agent_agent_members'))).toHaveLength(2);
});

test('legacy team Agents without a managed profile are marked ineligible for the peer-role UI',async()=>{
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
    VALUES (?1,'legacy','legacy','Legacy','Help','team','owner','now','now')`).bind(org).run();
  expect(await agentPeerRoleState(env.DB,org,'legacy')).toMatchObject({scope:'team',managed:false});
});

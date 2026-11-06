import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {agentPeerRoleState,setAgentPeerRole} from '../src/harness/agentPeerRoles.js';
import {beginAssignment,commitHandoff} from '../src/harness/agentAssignments.js';

const org='peer-roles';
const row={id:'peer-request',channel:'b:room',author_login:'alice',parent_id:null,kind:'message',body:'Coordinate'};
beforeEach(async()=>{
  await env.DB.exec(schema.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'human',login:'owner',name:'Owner',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,org,'human','member');
  for(const id of ['researcher','reviewer']) {
    await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
      VALUES (?1,?2,?2,?2,'Help','team','owner','now','now')`).bind(org,id).run();
    await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','now')`).bind(org,id).run();
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
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'researcher',role:'admin',expectedVersion:0})).toMatchObject({status:409});
  expect(await commitHandoff(env.DB,move)).toMatchObject({replayed:false,operation:{target_agent_id:'reviewer'}});
});

test('peer role mutations require a human Agent Admin and reject self or non-managed members',async()=>{
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'unknown',memberAgentId:'researcher',role:'member',expectedVersion:0})).toMatchObject({status:403});
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'reviewer',role:'member',expectedVersion:0})).toMatchObject({status:400});
  expect(await setAgentPeerRole(env.DB,org,'reviewer',{actorId:'human',memberAgentId:'missing',role:'member',expectedVersion:0})).toMatchObject({status:404});
});

test('legacy team Agents without a managed profile are marked ineligible for the peer-role UI',async()=>{
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
    VALUES (?1,'legacy','legacy','Legacy','Help','team','owner','now','now')`).bind(org).run();
  expect(await agentPeerRoleState(env.DB,org,'legacy')).toMatchObject({scope:'team',managed:false});
});

import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schema from '../schema.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {beginAssignment,commitHandoff} from '../src/harness/agentAssignments.js';
import {requestAgentWakeApproval,decideAgentWakeApproval,activeAgentWakeGrant,validAgentWakeGrantForHandoff} from '../src/harness/agentWakeApprovals.js';

const org='wake-approvals';
const origin={id:'human-request',channel:'b:room',author_login:'owner',parent_id:null,kind:'message',body:'Please investigate'};
let assignment,move;

beforeEach(async()=>{
  await env.DB.exec(schema.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'wake-human',login:'owner',name:'Owner',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,org,'wake-human','admin');
  await env.DB.prepare(`INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES (?1,'room','Room','owner','now')`).bind(org).run();
  for(const id of ['source','target']) {
    await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,?2,?2,?2,'Help','team','owner','now','now')`).bind(org,id).run();
    await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,?2,'private','now')`).bind(org,id).run();
    await env.DB.prepare(`INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,'b:room',?2,'owner','now')`).bind(org,id).run();
  }
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES (?1,?2,?3,?4,'message',?5,'now')`).bind(origin.id,org,origin.channel,origin.author_login,origin.body).run();
  assignment=(await beginAssignment(env.DB,{orgId:org,row:origin,agentId:'source',actorId:'wake-human',sessionKey:'h1:test'})).assignment;
  move={orgId:org,assignmentId:assignment.id,generation:0,sourceAgentId:'source',targetAgentId:'target',operationId:'wake-op',brief:'Find the deployment issue',messageBody:'Handing off for investigation'};
});

async function request() {
  return requestAgentWakeApproval(env,assignment,{requesterLogin:'owner',targetName:'Target Agent',...move});
}

test('missing peer grant creates one private pending card and no handoff or dispatch before approval',async()=>{
  const first=await request(),replay=await request();
  expect(first).toMatchObject({created:true,approval:{status:'pending'}});
  expect(replay).toMatchObject({created:false,approval:{id:first.approval.id}});
  expect(await requestAgentWakeApproval(env,assignment,{requesterLogin:'owner',...move,targetAgentId:'other'})).toMatchObject({status:409});
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_handoffs WHERE org_id=?1').bind(org).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM hx_agent_handoff_dispatch WHERE org_id=?1').bind(org).first()).toBeNull();
  const card=await env.DB.prepare('SELECT recipient_user_id,status FROM cards WHERE org_id=?1 AND card_id=?2').bind(org,first.approval.cardId).first();
  expect(card).toMatchObject({recipient_user_id:'owner',status:'pending'});
});

test.each([
  [undefined,'ten_minutes'],['once','once'],['ten_minutes','ten_minutes'],['thread','thread'],['room','room'],
])('approval stores the selected scope in D1 (option %s)',async(optionId,scope)=>{
  const pending=await request();
  const card={id:pending.approval.cardId,recipientUserID:'owner',senderUserID:'agent:source',decision:{action:'approve',actorUserID:'owner',...(optionId?{optionId}:{})}};
  const result=await decideAgentWakeApproval(env.DB,org,card,'owner','wake-human');
  expect(result).toMatchObject({settled:true,scope});
  const stored=await env.DB.prepare('SELECT scope,use_limit,expires_at,requester_membership FROM hx_agent_wake_grants WHERE org_id=?1 AND approval_id=?2').bind(org,pending.approval.id).first();
  expect(stored.scope).toBe(scope);
  expect(stored.requester_membership).toBe(assignment.actor_membership);
  if(scope==='once')expect(stored.use_limit).toBe(1);
  if(scope==='ten_minutes')expect(Date.parse(stored.expires_at)).toBeGreaterThan(Date.now());
  const grantId=await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:assignment.id,sourceAgentId:'source',targetAgentId:'target',operationId:move.operationId});
  expect(grantId).toBeTruthy();
  const committed=await commitHandoff(env.DB,{...move,wakeGrantId:grantId});
  expect(committed).toMatchObject({replayed:false,operation:{target_agent_id:'target',wake_grant_id:grantId}});
  expect(await validAgentWakeGrantForHandoff(env.DB,committed.operation)).toBe(true);
  expect((await env.DB.prepare('SELECT * FROM hx_agent_handoff_dispatch WHERE org_id=?1').bind(org).all()).results).toHaveLength(1);
  expect(await commitHandoff(env.DB,{...move,wakeGrantId:grantId})).toMatchObject({replayed:true});
  expect((await env.DB.prepare('SELECT * FROM hx_agent_handoff_dispatch WHERE org_id=?1').bind(org).all()).results).toHaveLength(1);
});

test('once grant cannot authorize another assignment, and replay with changed operation identity is rejected',async()=>{
  const pending=await request();
  const card={id:pending.approval.cardId,recipientUserID:'owner',senderUserID:'agent:source',decision:{action:'approve',actorUserID:'owner',optionId:'once'}};
  await decideAgentWakeApproval(env.DB,org,card,'owner','wake-human');
  const grantId=await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:assignment.id,sourceAgentId:'source',targetAgentId:'target',operationId:move.operationId});
  expect(grantId).toBeTruthy();
  await commitHandoff(env.DB,{...move,wakeGrantId:grantId});
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES ('next-request',?1,?2,?3,'message',?4,'now')`).bind(org,origin.channel,origin.author_login,origin.body).run();
  const next=(await beginAssignment(env.DB,{orgId:org,row:{...origin,id:'next-request'},agentId:'source',actorId:'wake-human',sessionKey:'h1:next'})).assignment;
  expect(await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:next.id,sourceAgentId:'source',targetAgentId:'target',operationId:'next-op'})).toBeNull();
  expect(await commitHandoff(env.DB,{...move,brief:'replay forgery'})).toMatchObject({status:409});
});

test('requester membership leave and rejoin invalidates an approved grant',async()=>{
  const pending=await request();
  const card={id:pending.approval.cardId,recipientUserID:'owner',senderUserID:'agent:source',decision:{action:'approve',actorUserID:'owner',optionId:'room'}};
  await decideAgentWakeApproval(env.DB,org,card,'owner','wake-human');
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(org,'wake-human').run();
  await upsertMembership(env.DB,org,'wake-human','admin');
  await env.DB.prepare(`UPDATE memberships SET created_at='rejoined-later' WHERE org_id=?1 AND user_github_id='wake-human'`).bind(org).run();
  expect(await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:assignment.id,sourceAgentId:'source',targetAgentId:'target',operationId:move.operationId})).toBeNull();
});

test('atomic handoff rejects an Agent access revocation after the grant was approved',async()=>{
  const pending=await request();
  const card={id:pending.approval.cardId,recipientUserID:'owner',senderUserID:'agent:source',decision:{action:'approve',actorUserID:'owner',optionId:'room'}};
  await decideAgentWakeApproval(env.DB,org,card,'owner','wake-human');
  const grantId=await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:assignment.id,sourceAgentId:'source',targetAgentId:'target',operationId:move.operationId});
  expect(grantId).toBeTruthy();
  await env.DB.prepare(`UPDATE custom_agents SET owner_login='someone-else' WHERE org_id=?1 AND id='target'`).bind(org).run();
  await env.DB.prepare(`UPDATE hx_agent_profiles SET access='private',people='[]' WHERE org_id=?1 AND agent_id='target'`).bind(org).run();
  const result=await commitHandoff(env.DB,{...move,wakeGrantId:grantId});
  expect(result).toMatchObject({status:409});
  expect(await env.DB.prepare(`SELECT 1 FROM hx_agent_handoffs WHERE org_id=?1`).bind(org).first()).toBeNull();
  expect(await env.DB.prepare(`SELECT status FROM hx_agent_assignments WHERE org_id=?1 AND id=?2`).bind(org,assignment.id).first()).toMatchObject({status:'running'});
});

test('queued wake grant is rechecked against its exact room, thread, membership and approval',async()=>{
  const pending=await request();
  const card={id:pending.approval.cardId,recipientUserID:'owner',senderUserID:'agent:source',decision:{action:'approve',actorUserID:'owner',optionId:'once'}};
  await decideAgentWakeApproval(env.DB,org,card,'owner','wake-human');
  const grantId=await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:assignment.id,sourceAgentId:'source',targetAgentId:'target',operationId:move.operationId});
  const committed=await commitHandoff(env.DB,{...move,wakeGrantId:grantId});
  expect(await validAgentWakeGrantForHandoff(env.DB,committed.operation)).toBe(true); // exact once operation may retry delivery
  await env.DB.prepare(`UPDATE hx_agent_wake_approvals SET status='revoked' WHERE org_id=?1 AND id=?2`).bind(org,pending.approval.id).run();
  expect(await validAgentWakeGrantForHandoff(env.DB,committed.operation)).toBe(false);
});

test('static peer grant is rechecked at dispatch time',async()=>{
  await env.DB.prepare(`INSERT INTO hx_agent_agent_members(org_id,agent_id,member_agent_id,role,updated_by,updated_at) VALUES (?1,'target','source','member','owner','now')`).bind(org).run();
  const committed=await commitHandoff(env.DB,{...move});
  expect(committed.operation.wake_grant_id).toBeNull();
  expect(await validAgentWakeGrantForHandoff(env.DB,committed.operation)).toBe(true);
  await env.DB.prepare(`DELETE FROM hx_agent_agent_members WHERE org_id=?1 AND agent_id='target' AND member_agent_id='source'`).bind(org).run();
  expect(await validAgentWakeGrantForHandoff(env.DB,committed.operation)).toBe(false);
});

test('room-scoped approval remains usable for later assignments in the same room',async()=>{
  const pending=await request();
  const card={id:pending.approval.cardId,recipientUserID:'owner',senderUserID:'agent:source',decision:{action:'approve',actorUserID:'owner',optionId:'room'}};
  await decideAgentWakeApproval(env.DB,org,card,'owner','wake-human');
  const grantId=await activeAgentWakeGrant(env.DB,{orgId:org,assignmentId:assignment.id,sourceAgentId:'source',targetAgentId:'target',operationId:move.operationId});
  await commitHandoff(env.DB,{...move,wakeGrantId:grantId});
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES ('later-request',?1,?2,?3,'message','Another task','now')`).bind(org,origin.channel,origin.author_login).run();
  const later=(await beginAssignment(env.DB,{orgId:org,row:{...origin,id:'later-request',body:'Another task'},agentId:'source',actorId:'wake-human',sessionKey:'h1:later'})).assignment;
  const laterOperation=await commitHandoff(env.DB,{orgId:org,assignmentId:later.id,generation:0,sourceAgentId:'source',targetAgentId:'target',operationId:'later-op',brief:'Another task',messageBody:'Passing it on',wakeGrantId:grantId});
  expect(laterOperation.operation).toBeTruthy();
  expect(await validAgentWakeGrantForHandoff(env.DB,laterOperation.operation)).toBe(true);
});

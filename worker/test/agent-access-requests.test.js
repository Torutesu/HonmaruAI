import {env} from 'cloudflare:test';
import {beforeEach,test,expect,vi} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createAgentAccessRequest,requestableAgentOptions,settleAgentAccessRequest} from '../src/harness/agentAccessRequests.js';
import {mayAccessAgent} from '../src/harness/agents.js';
import {OrgRelay} from '../src/relay.js';
import schemaSql from '../schema.sql?raw';

const ORG='agent-access-requests';
const agentAccessRequestSql=schemaSql.slice(schemaSql.indexOf('CREATE TABLE IF NOT EXISTS hx_agent_access_requests ('));
beforeEach(async()=>{
 for(const [id,login,role] of [['owner','owner','member'],['requester','requester','member'],['admin','agent-admin','member'],['guest','guest','guest']]){
  await upsertUser(env.DB,{githubId:id,login,name:login,locale:'en'});
  await upsertMembership(env.DB,ORG,id,role);
 }
 await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
  VALUES (?1,'team-agent','team-agent','Team Agent','Keep its instructions private','team','owner','now','now')`).bind(ORG).run();
 await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at)
  VALUES (?1,'team-agent','private','[]','now')`).bind(ORG).run();
 await env.DB.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,member_since,updated_by,updated_at)
  SELECT ?1,'team-agent','admin','admin',created_at,'owner','now' FROM memberships WHERE org_id=?1 AND user_github_id='admin'`).bind(ORG).run();
 await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
  VALUES (?1,'personal-agent','personal-agent','Private Agent','Private','personal','owner','now','now')`).bind(ORG).run();
});

const request=(agentId='team-agent',requestKey='access-request-key-0001',requesterId='requester')=>
 createAgentAccessRequest(env.DB,ORG,{agentId,requesterId,requestKey});

test('the additive access-request migration can be replayed safely',async()=>{
 for(const sql of agentAccessRequestSql.split(';').map(part=>part.trim()).filter(Boolean)) await env.DB.exec(sql.replace(/\n/g,' '));
 expect(await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('hx_agent_access_requests','hx_agent_access_request_approvers')").first()).toMatchObject({n:2});
});

test('only inaccessible shared team agents are discoverable as access request options',async()=>{
 expect(await requestableAgentOptions(env.DB,ORG,'requester')).toMatchObject([{id:'team-agent',name:'Team Agent',accessRequestStatus:'none'}]);
 expect(await requestableAgentOptions(env.DB,ORG,'owner')).toEqual([]);
 expect(await requestableAgentOptions(env.DB,ORG,'agent-admin')).toEqual([]);
 expect(await requestableAgentOptions(env.DB,ORG,'guest')).toEqual([]);
});

test('room setup options include only Agents the caller can use and named eligible members lacking access',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {createSession}=await import('../src/db.js');
 const {memberRef}=await import('../src/team.js');
 const context={waitUntil:()=>{}};
 const read=async login=>{
  const response=await worker.fetch(new Request(`https://example.com/hx/agent-access-options?orgId=${ORG}`,{headers:{'x-session-token':await createSession(env.DB,login,'test')}}),env,context);
  expect(response.status).toBe(200);return response.json();
 };
 const owner=await read('owner');
 expect(owner.addableAgents.find(agent=>agent.id==='team-agent')).toMatchObject({canGrantAccess:true,missingAccessMembers:[{ref:await memberRef(ORG,'requester'),name:'requester'}]});
 expect((await read('requester')).agents).toMatchObject([{id:'team-agent',accessRequestStatus:'none'}]);
 expect((await read('requester')).addableAgents).toEqual([]);
});

test('an access request is a recipient-private approval card and retries reuse the pending request',async()=>{
 const first=await request();
 expect(first).toMatchObject({created:true,request:{status:'pending'}});
 expect(first.card).toMatchObject({visibility:'personal',senderUserID:'requester',recipientUserID:'owner',agentAccessRequest:{agentId:'team-agent'}});
 expect(await env.DB.prepare('SELECT count(*) AS n FROM cards WHERE org_id=?1 AND card_id=?2').bind(ORG,first.card.id).first()).toMatchObject({n:1});
 expect(await request()).toMatchObject({created:false,request:{id:first.request.id,cardId:first.card.id,status:'pending'}});
 expect(await request('team-agent','another-idempotency-key-0001')).toMatchObject({created:false,request:{id:first.request.id,cardId:first.card.id,status:'pending'}});
 expect(await env.DB.prepare("SELECT count(*) AS n FROM hx_agent_access_requests WHERE org_id=?1 AND status='pending'").bind(ORG).first()).toMatchObject({n:1});
 expect(await requestableAgentOptions(env.DB,ORG,'requester')).toMatchObject([{accessRequestStatus:'pending'}]);
});

test('personal, guest and already accessible agents cannot be requested',async()=>{
 expect((await request('personal-agent')).status).toBe(404);
 expect((await request('team-agent','guest-request-key-00001','guest')).status).toBe(404);
 await env.DB.prepare("UPDATE hx_agent_profiles SET access='people',people='[\"requester\"]' WHERE org_id=?1 AND agent_id='team-agent'").bind(ORG).run();
 expect((await request('team-agent','already-access-key-0001')).status).toBe(409);
});

test('only the addressed current agent owner can approve and the grant is idempotent',async()=>{
 const created=await request();
 const card={...created.card,decision:{action:'approve',actorUserID:'requester',decidedAt:'2026-10-26T00:00:00.000Z'}};
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toBe(false);
 card.decision.actorUserID='owner';
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toMatchObject({settled:true,action:'approve',actorLogin:'owner',cards:[{recipientUserID:'agent-admin',status:'approved'}]});
 expect(await mayAccessAgent(env.DB,ORG,{id:'team-agent',scope:'team',ownerLogin:'owner'},'requester')).toBe(true);
 expect(await env.DB.prepare("SELECT role,member_since FROM hx_agent_members WHERE org_id=?1 AND agent_id='team-agent' AND user_id='requester'").bind(ORG).first()).toMatchObject({role:'member'});
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toBe(false);
 expect(await env.DB.prepare('SELECT status FROM hx_agent_access_requests WHERE org_id=?1 AND id=?2').bind(ORG,created.request.id).first()).toMatchObject({status:'approved'});
 expect(await request()).toMatchObject({created:false,request:{id:created.request.id,status:'approved'}});
 expect((await request('team-agent','new-after-approval-key-001')).status).toBe(409);
});

test('a current human Agent admin can approve and resolves the owner copy of the private card',async()=>{
 const created=await request();
 expect(created.cards.map(card=>card.recipientUserID).sort()).toEqual(['agent-admin','owner']);
 const losingOwnerDecision={...created.card,status:'rejected',decision:{action:'decline',actorUserID:'owner',decidedAt:'2026-10-26T00:00:01.000Z'}};
 await env.DB.prepare("UPDATE cards SET status='rejected',data=?3 WHERE org_id=?1 AND card_id=?2").bind(ORG,created.card.id,JSON.stringify(losingOwnerDecision)).run();
 const card={...created.cards.find(item=>item.recipientUserID==='agent-admin'),decision:{action:'approve',actorUserID:'agent-admin',decidedAt:'2026-10-26T00:00:00.000Z'}};
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toMatchObject({settled:true,action:'approve',actorLogin:'agent-admin',cards:[{recipientUserID:'owner',status:'approved'}]});
 expect(await mayAccessAgent(env.DB,ORG,{id:'team-agent',scope:'team',ownerLogin:'owner'},'requester')).toBe(true);
 const resolvedOwnerCard=await env.DB.prepare("SELECT status,data FROM cards WHERE org_id=?1 AND card_id=?2").bind(ORG,created.card.id).first();
 expect(resolvedOwnerCard).toMatchObject({status:'approved'});
 expect(JSON.parse(resolvedOwnerCard.data).decision).toMatchObject({action:'approve',actorUserID:'agent-admin'});
 expect(await env.DB.prepare("SELECT status FROM hx_agent_access_request_approvers WHERE org_id=?1 AND request_id=?2").bind(ORG,created.request.id).first()).toMatchObject({status:'approved'});
});

test('declining an access request closes other approver copies without granting access',async()=>{
 const created=await request();
 const card={...created.card,decision:{action:'decline',actorUserID:'owner',decidedAt:'2026-10-26T00:00:00.000Z'}};
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toMatchObject({settled:true,action:'decline',actorLogin:'owner',cards:[{recipientUserID:'agent-admin',status:'rejected'}]});
 expect(await mayAccessAgent(env.DB,ORG,{id:'team-agent',scope:'team',ownerLogin:'owner'},'requester')).toBe(false);
 expect(await env.DB.prepare("SELECT status FROM cards WHERE org_id=?1 AND card_id=?2").bind(ORG,created.cards.find(item=>item.recipientUserID==='agent-admin').id).first()).toMatchObject({status:'rejected'});
});

test('deciding through the relay records and sends the resolved private copy to the other approver',async()=>{
 const created=await request();
 const card={...created.cards.find(item=>item.recipientUserID==='agent-admin'),decision:{action:'approve',actorUserID:'agent-admin',decidedAt:'2026-10-26T00:00:00.000Z'}};
 const relay=Object.create(OrgRelay.prototype);
 relay.db=env.DB;relay.env={DB:env.DB};relay.state={waitUntil:vi.fn()};
 relay.log=vi.fn(async()=>{});relay.broadcastCard=vi.fn(async()=>{});relay.sendTo=vi.fn();relay.deliver=vi.fn(async()=>{});
 await relay.afterDecision(ORG,card,'agent-admin','admin');
 expect(relay.log).toHaveBeenCalledWith(ORG,expect.objectContaining({type:'decided',cardId:created.card.id,actorUserId:'agent-admin',action:'approve',snapshot:expect.objectContaining({status:'approved'})}));
 expect(relay.broadcastCard).toHaveBeenCalledWith(ORG,expect.objectContaining({id:created.card.id,recipientUserID:'owner',status:'approved'}),expect.any(Object));
 expect(relay.state.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
});

test('an Agent admin who loses that role before deciding cannot grant access',async()=>{
 const created=await request();
 const card={...created.cards.find(item=>item.recipientUserID==='agent-admin'),decision:{action:'approve',actorUserID:'agent-admin',decidedAt:'2026-10-26T00:00:00.000Z'}};
 await env.DB.prepare("DELETE FROM hx_agent_members WHERE org_id=?1 AND agent_id='team-agent' AND user_id='admin'").bind(ORG).run();
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toBe(false);
 expect(await env.DB.prepare('SELECT status FROM hx_agent_access_requests WHERE org_id=?1 AND id=?2').bind(ORG,created.request.id).first()).toMatchObject({status:'pending'});
 expect(await env.DB.prepare("SELECT 1 FROM hx_agent_members WHERE org_id=?1 AND agent_id='team-agent' AND user_id='requester'").bind(ORG).first()).toBeNull();
});

test('approval cannot grant an old membership after the requester leaves and rejoins',async()=>{
 const created=await request();
 await env.DB.prepare("UPDATE memberships SET created_at='rejoined' WHERE org_id=?1 AND user_github_id='requester'").bind(ORG).run();
 const card={...created.card,decision:{action:'approve',actorUserID:'owner',decidedAt:'2026-10-26T00:00:00.000Z'}};
 expect(await settleAgentAccessRequest(env.DB,ORG,card)).toBe(false);
 expect(await env.DB.prepare("SELECT 1 FROM hx_agent_members WHERE org_id=?1 AND agent_id='team-agent' AND user_id='requester'").bind(ORG).first()).toBeNull();
 expect(await env.DB.prepare('SELECT status FROM hx_agent_access_requests WHERE org_id=?1 AND id=?2').bind(ORG,created.request.id).first()).toMatchObject({status:'pending'});
});

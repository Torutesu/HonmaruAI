import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';
import { listPublicAppShareApprovals, publicAppShareAgentTools, requestPublicAppShareApproval, reviewPublicAppShareApproval } from '../src/harness/appShareApproval.js';

const ORG = 'personal:app-share-approval';
const SOURCE = 'source-turn-1';
let ownerToken, requesterToken;
const context = {
  kind: 'business', mode: 'harness', orgId: ORG, userId: '9102', login: 'mika', requesterName: 'Mika',
  agentId: 'managed-agent', agentScope: 'team', agentName: 'Managed Agent', channel: 'b:review',
  sourceMessageId: SOURCE, sourceThreadId: SOURCE, sourceBody: 'Please share this app publicly.',
};
const auth = token => ({ 'content-type': 'application/json', 'x-session-token': token });

async function fixture() {
  const at = new Date().toISOString();
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  for (const table of ['card_events','cards','hx_app_public_share_requests','hx_app_public_shares','hx_app_links','hx_app_access','hx_apps','channel_messages','channel_agents','custom_agents','conversation_members','businesses']) {
    await env.DB.prepare('DELETE FROM ' + table + ' WHERE org_id=?1').bind(ORG).run();
  }
  await upsertUser(env.DB,{githubId:'9101',login:'toru',name:'Toru',avatarUrl:null,locale:'en'});
  await upsertUser(env.DB,{githubId:'9102',login:'mika',name:'Mika',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,ORG,'9101','admin');
  await upsertMembership(env.DB,ORG,'9102','member');
  ownerToken = await createSession(env.DB,'9101','gho_owner');
  requesterToken = await createSession(env.DB,'9102','gho_requester');
  await env.DB.prepare('INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?1,?2,?3,?4,?5,1)').bind(ORG,'review','Review','9101',at).run();
  await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,?2,?3,?4,?5)').bind(ORG,'b:review','mika','9101',at).run();
  await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'team',?6,?7,?7)").bind(ORG,'managed-agent','managed','Managed Agent','','toru',at).run();
  await env.DB.prepare('INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES(?1,?2,?3,?4,?5)').bind(ORG,'b:review','managed-agent','9101',at).run();
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES(?1,?2,?3,?4,'message',?5,?6)").bind(SOURCE,ORG,'b:review','mika',context.sourceBody,at).run();
  const definition=JSON.stringify({custom:{published:'<html><body>Published</body></html>',publishedAssets:[]}});
  await env.DB.prepare('INSERT INTO hx_apps(id,org_id,name,table_id,version,definition,created_by,created_at,updated_at) VALUES(?1,?2,?3,?4,4,?5,?6,?7,?7)').bind('app-1',ORG,'Review App','table-1',definition,'9101',at).run();
  await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version,room_channel) VALUES(?1,?2,'private',8,?3)").bind(ORG,'app-1','b:review').run();
  await env.DB.prepare('INSERT INTO hx_app_links(org_id,app_id,channel,created_by,created_at) VALUES(?1,?2,?3,?4,?5)').bind(ORG,'app-1','b:review','9101',at).run();
}

beforeEach(fixture);

test('managed room Agent request is bound to exact App revision and creates an owner approval card but no link',async()=>{
  const tool=publicAppShareAgentTools(env,context).request_public_app_link;
  expect(tool).toBeTruthy();
  const result=await tool.run({appId:'app-1'});
  expect(result).toContain('No link has been created');
  const queue=await listPublicAppShareApprovals(env.DB,ORG,'app-1');
  expect(queue.requests).toHaveLength(1);
  const request=queue.requests[0];
  expect(request).toMatchObject({agentId:'managed-agent',roomChannel:'b:review',sourceMessageId:SOURCE,sourceThreadId:SOURCE,appVersion:4,accessVersion:8,status:'pending'});
  expect(request).not.toHaveProperty('token');
  const row=await env.DB.prepare('SELECT data FROM cards WHERE org_id=?1 AND card_id=?2').bind(ORG,'app-share-approval-'+request.id).first();
  const card=JSON.parse(row.data);
  expect(card).toMatchObject({type:'approval',recipientUserID:'toru',sourceApp:'Review App',appPublicShareRequest:{requestId:request.id,appId:'app-1',agentId:'managed-agent',roomChannel:'b:review',sourceMessageId:SOURCE,sourceThreadId:SOURCE,appVersion:4,accessVersion:8}});
  expect(card.context).toContain('does not create a URL or token');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_public_shares WHERE org_id=?1').bind(ORG).first()).n).toBe(0);
});

test('personal, unauthorized and stale room Agents cannot create public link requests',async()=>{
  expect(publicAppShareAgentTools(env,{...context,agentScope:'personal'})).toEqual({});
  expect((await requestPublicAppShareApproval(env,{...context,userId:'9999'},'app-1')).status).toBe(403);
  await env.DB.prepare("UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id=?2").bind(ORG,'managed-agent').run();
  expect((await requestPublicAppShareApproval(env,context,'app-1')).status).toBe(403);
});

test('approval rechecks room assignment and revision before status changes, without issuing a token',async()=>{
  await requestPublicAppShareApproval(env,context,'app-1');
  await env.DB.prepare('DELETE FROM channel_agents WHERE org_id=?1 AND channel=?2 AND agent_id=?3').bind(ORG,'b:review','managed-agent').run();
  const queue=await listPublicAppShareApprovals(env.DB,ORG,'app-1');
  const result=await reviewPublicAppShareApproval(env.DB,ORG,'app-1',queue.requests[0].id,'9101','approve',env);
  expect(result).toMatchObject({status:'stale',tokenCreated:false});
  expect((await env.DB.prepare('SELECT status FROM hx_app_public_share_requests WHERE org_id=?1').bind(ORG).first()).status).toBe('stale');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_public_shares WHERE org_id=?1').bind(ORG).first()).n).toBe(0);
});

test('the owner can decline a live request without creating a link',async()=>{
  await requestPublicAppShareApproval(env,context,'app-1');
  const queue=await listPublicAppShareApprovals(env.DB,ORG,'app-1');
  const result=await reviewPublicAppShareApproval(env.DB,ORG,'app-1',queue.requests[0].id,'9101','decline',env);
  expect(result).toMatchObject({status:'declined',tokenCreated:false});
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_public_shares WHERE org_id=?1').bind(ORG).first()).n).toBe(0);
});

test('the owner/Admin review API serializes safe request fields and rejects the source requester',async()=>{
  await requestPublicAppShareApproval(env,context,'app-1');
  const get=await worker.fetch(new Request('https://example.com/apps/app-1/public-share-approvals?orgId='+ORG,{headers:auth(ownerToken)}),{...env});
  expect(get.status).toBe(200);
  const {requests}=await get.json();
  expect(requests[0]).toMatchObject({agentId:'managed-agent',roomChannel:'b:review',status:'pending'});
  expect(requests[0]).not.toHaveProperty('sourceHash');
  expect(requests[0]).not.toHaveProperty('token');
  const requestId=requests[0].id;
  const denied=await worker.fetch(new Request('https://example.com/apps/app-1/public-share-approvals?orgId='+ORG,{method:'POST',headers:auth(requesterToken),body:JSON.stringify({orgId:ORG,requestId,decision:'approve'})}),{...env});
  expect(denied.status).toBe(403);
  const approved=await worker.fetch(new Request('https://example.com/apps/app-1/public-share-approvals?orgId='+ORG,{method:'POST',headers:auth(ownerToken),body:JSON.stringify({orgId:ORG,requestId,decision:'approve'})}),{...env});
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({status:'approved',tokenCreated:false});
  const card=JSON.parse((await env.DB.prepare('SELECT data FROM cards WHERE org_id=?1 AND card_id=?2').bind(ORG,'app-share-approval-'+requestId).first()).data);
  expect(card.status).toBe('approved');
  expect(card.decision).toMatchObject({action:'approve',actorUserID:'9101'});
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_public_shares WHERE org_id=?1').bind(ORG).first()).n).toBe(0);
});

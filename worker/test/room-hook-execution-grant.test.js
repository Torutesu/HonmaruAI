import { postMessage } from '../src/channels.js';
import { fetchMock } from './helpers/fetch-mock.js';
import { runRoomHookAgents } from '../src/harness/roomHookAgentRun.js';
import { runAgents } from '../src/channelRoutes.js';
import { addChannelAgent } from '../src/customAgents.js';
import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { upsertUser, upsertMembership } from '../src/db.js';
import { createManagedRoom } from '../src/harness/roomCreation.js';
import { createRoomHook, authenticateRoomHook, receiveRoomHookEvent, changeRoomHook } from '../src/harness/roomHooks.js';
import { roomHookExecutionGrant } from '../src/harness/roomHookExecutionGrant.js';
async function fixture(body='Deployment completed') {
 const org='hook-execution';
 await upsertUser(env.DB,{githubId:'maker',login:'maker',name:'Maker'});
 await upsertMembership(env.DB,org,'maker','admin');
 const channel=(await createManagedRoom(env.DB,org,'maker',{requestId:'hook-execution-room',name:'Events',private:true,guidelines:'',color:'teal',memberRefs:[],agentIds:[]})).room.channel;
 const created=await createRoomHook(env.DB,org,channel,'maker','Deploy');
 const hook=await authenticateRoomHook(env.DB,created.hook.id,created.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'deploy-1',body});
 return {org,channel,hook,messageId:event.messageId};
}
test('resolves a stored event without creating a session or exposing hook secrets',async()=>{
 const f=await fixture();const grant=await roomHookExecutionGrant(env.DB,f.org,f.messageId);
 expect(grant).toMatchObject({creatorId:'maker',channel:f.channel,row:{id:f.messageId,body:'Deployment completed',author_login:`webhook:${f.hook.id}`}});
 expect(grant).not.toHaveProperty('token');expect(grant).not.toHaveProperty('secret');
 expect(await roomHookExecutionGrant(env.DB,'other',f.messageId)).toBeNull();
 expect(await roomHookExecutionGrant(env.DB,f.org,'missing')).toBeNull();
});
test('revocation after receipt prevents execution',async()=>{
 const f=await fixture();await changeRoomHook(env.DB,f.org,f.channel,'maker',f.hook.id,1,'revoke');
 expect(await roomHookExecutionGrant(env.DB,f.org,f.messageId)).toBeNull();
});
test('current permissions reject a mixed-case guest role after receipt',async()=>{
 const f=await fixture();await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1").bind(f.org).run();
 expect(await roomHookExecutionGrant(env.DB,f.org,f.messageId)).toBeNull();
});
test('rejoining does not restore an old event execution grant',async()=>{
 const f=await fixture();await env.DB.prepare("UPDATE conversation_members SET added_at='2099-01-01' WHERE org_id=?1 AND channel=?2").bind(f.org,f.channel).run();
 expect(await roomHookExecutionGrant(env.DB,f.org,f.messageId)).toBeNull();
});
test('archived rooms and deleted source messages cannot execute',async()=>{
 const f=await fixture();await env.DB.prepare("UPDATE businesses SET archived_at='2099-01-01' WHERE org_id=?1").bind(f.org).run();
 expect(await roomHookExecutionGrant(env.DB,f.org,f.messageId)).toBeNull();
 await env.DB.prepare('UPDATE businesses SET archived_at=NULL WHERE org_id=?1').bind(f.org).run();
 await env.DB.prepare("UPDATE channel_messages SET deleted_at='2099-01-01' WHERE id=?1").bind(f.messageId).run();
 expect(await roomHookExecutionGrant(env.DB,f.org,f.messageId)).toBeNull();
});


test('stored webhook events select permitted agents and pass identity without a login token',async()=>{
 const f=await fixture('@helper please review this deployment');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','maker','now','now')").bind(f.org).run();
 await addChannelAgent(env.DB,{orgId:f.org,key:f.channel,agentId:'helper',login:'maker'});
 let seen;
 expect(await runRoomHookAgents(env,{orgId:f.org,rowId:f.messageId},{execute:async(_,context)=>{seen=context;return 1}})).toEqual({status:'finished',answered:1});
 expect(seen.agents.map(a=>a.id)).toEqual(['helper']);
 expect(seen.session).toEqual({github_id:'maker'});
 expect(seen.row.author_login).toBe(`webhook:${f.hook.id}`);
 expect(await seen.authorize()).toBe(true);
 await changeRoomHook(env.DB,f.org,f.channel,'maker',f.hook.id,1,'revoke');
 expect(await seen.authorize()).toBe(false);
 expect(await runRoomHookAgents(env,{orgId:f.org,rowId:f.messageId},{execute:async()=>{throw Error('must not execute')}})).toEqual({status:'cancelled',answered:0});
});
test('rooms without a selected agent do not invoke the model',async()=>{
 const f=await fixture();
 expect(await runRoomHookAgents(env,{orgId:f.org,rowId:f.messageId},{execute:async()=>{throw Error('must not execute')}})).toEqual({status:'no_agents',answered:0});
});
test('the shared runner honors a denied execution grant before any provider access',async()=>{
 expect(await runAgents({}, {authorize:async()=>false})).toBe(0);
});


test('a webhook agent reply is persisted under its own event thread without an external model call',async()=>{
 const f=await fixture('@helper please review this deployment');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','maker','now','now')").bind(f.org).run();
 await addChannelAgent(env.DB,{orgId:f.org,key:f.channel,agentId:'helper',login:'maker'});
 fetchMock.activate();
 try {
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,{
   id:'mock-hook-response',model:'gpt-5-mini',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Deployment reviewed successfully.'}]}],usage:{input_tokens:20,output_tokens:10},
  });
  expect(await runRoomHookAgents({...env,OPENAI_API_KEY:'sk-test',OPENROUTER_API_KEY:undefined},{orgId:f.org,rowId:f.messageId})).toEqual({status:'finished',answered:1});
  fetchMock.assertNoPendingInterceptors();
  const replies=await env.DB.prepare('SELECT parent_id,author_login,body FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(f.org,f.messageId).all();
  expect(replies.results).toEqual([{parent_id:f.messageId,author_login:'agent:helper',body:'Deployment reviewed successfully.'}]);
 } finally { fetchMock.deactivate(); }
});


test('revocation while the model is answering suppresses reply persistence and the success count',async()=>{
 const f=await fixture('@helper please review this deployment');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','maker','now','now')").bind(f.org).run();
 await addChannelAgent(env.DB,{orgId:f.org,key:f.channel,agentId:'helper',login:'maker'});
 fetchMock.activate();
 try {
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,async()=>{
   await changeRoomHook(env.DB,f.org,f.channel,'maker',f.hook.id,1,'revoke');
   return {id:'mock-revoked-response',model:'gpt-5-mini',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'This reply must not be saved.'}]}],usage:{input_tokens:20,output_tokens:10}};
  });
  expect(await runRoomHookAgents({...env,OPENAI_API_KEY:'sk-test',OPENROUTER_API_KEY:undefined},{orgId:f.org,rowId:f.messageId})).toEqual({status:'cancelled',answered:0});
  fetchMock.assertNoPendingInterceptors();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(f.org,f.messageId).first()).n).toBe(0);
 } finally { fetchMock.deactivate(); }
});


test.each(['restricted','deleted'])('an agent %s while answering cannot publish its webhook reply',async(change)=>{
 const f=await fixture('@helper please review this deployment');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','other-owner','now','now')").bind(f.org).run();
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,'helper','everyone','now')").bind(f.org).run();
 fetchMock.activate();
 try {
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,async()=>{
   if(change==='restricted')await env.DB.prepare("UPDATE hx_agent_profiles SET access='private' WHERE org_id=?1 AND agent_id='helper'").bind(f.org).run();
   else await env.DB.prepare("UPDATE custom_agents SET deleted_at='now' WHERE org_id=?1 AND id='helper'").bind(f.org).run();
   return {id:'mock-access-change',model:'gpt-5-mini',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'This reply must not be saved.'}]}],usage:{input_tokens:20,output_tokens:10}};
  });
  expect(await runRoomHookAgents({...env,OPENAI_API_KEY:'sk-test',OPENROUTER_API_KEY:undefined},{orgId:f.org,rowId:f.messageId})).toEqual({status:'finished',answered:0});
  fetchMock.assertNoPendingInterceptors();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(f.org,f.messageId).first()).n).toBe(0);
 } finally { fetchMock.deactivate(); }
});

test('revocation immediately before the INSERT atomically prevents a webhook reply',async()=>{
 const f=await fixture();
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','maker','now','now')").bind(f.org).run();
 expect(await roomHookExecutionGrant(env.DB,f.org,f.messageId)).not.toBeNull();
 let intercepted=false;
 const db={prepare(sql){
  const statement=env.DB.prepare(sql);
  if(!sql.startsWith('INSERT INTO channel_messages'))return statement;
  return {bind(...values){const bound=statement.bind(...values);return {async run(){
   intercepted=true;
   await changeRoomHook(env.DB,f.org,f.channel,'maker',f.hook.id,1,'revoke');
   return bound.run();
  }}}};
 }};
 const out=await postMessage(db,{orgId:f.org,key:f.channel,authorLogin:'agent:helper',kind:'agent',body:'Do not save',parentId:f.messageId,roomHookSource:true});
 expect(intercepted).toBe(true);
 expect(out).toMatchObject({status:403,code:'webhook_revoked'});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(f.org,f.messageId).first()).n).toBe(0);
});

test.each(['private','deleted','personal'])('agent becoming %s immediately before INSERT prevents reply persistence',async(change)=>{
 const f=await fixture('@helper review deployment');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','other','now','now')").bind(f.org).run();
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES (?1,'helper','everyone','now')").bind(f.org).run();
 let intercepted=false;
 const db={prepare(sql){
  const statement=env.DB.prepare(sql);
  if(!sql.startsWith('INSERT INTO channel_messages'))return statement;
  return {bind(...values){const bound=statement.bind(...values);return {async run(){
   intercepted=true;
   const mutation=change==='private'?"UPDATE hx_agent_profiles SET access='private' WHERE org_id=?1 AND agent_id='helper'":change==='deleted'?"UPDATE custom_agents SET deleted_at='now' WHERE org_id=?1 AND id='helper'":"UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id='helper'";
   await env.DB.prepare(mutation).bind(f.org).run();
   return bound.run();
  }}}};
 }};
 const out=await postMessage(db,{orgId:f.org,key:f.channel,authorLogin:'agent:helper',kind:'agent',body:'Do not save',parentId:f.messageId,roomHookSource:true});
 expect(intercepted).toBe(true);
 expect(out).toMatchObject({status:403,code:'webhook_revoked'});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(f.org,f.messageId).first()).n).toBe(0);
});

test.each(['owner','people','role','legacy-placement'])('atomic webhook replies preserve existing %s permission',async(permission)=>{
 const f=await fixture('@helper review deployment');
 const owner=permission==='owner'?'maker':'other';
 const scope=permission==='legacy-placement'?'personal':'team';
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help',?2,?3,'now','now')").bind(f.org,scope,owner).run();
 if(permission==='legacy-placement')await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,?2,'helper','other','before')").bind(f.org,f.channel).run();
 else await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES (?1,'helper',?2,?3,'now')").bind(f.org,permission==='people'?'people':'private',JSON.stringify(['maker'])).run();
 if(permission==='role')await env.DB.prepare("INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,member_since,updated_by,updated_at) SELECT ?1,'helper','maker','member',created_at,'maker','now' FROM memberships WHERE org_id=?1 AND user_github_id='maker'").bind(f.org).run();
 const args={orgId:f.org,key:f.channel,authorLogin:'agent:helper',kind:'agent',body:'Allowed reply',parentId:f.messageId,roomHookSource:true};
 expect(await postMessage(env.DB,args)).toHaveProperty('row');
 if(permission==='role'){
  await env.DB.prepare("UPDATE hx_agent_members SET member_since='old membership' WHERE org_id=?1 AND agent_id='helper'").bind(f.org).run();
  expect(await postMessage(env.DB,args)).toMatchObject({status:403,code:'webhook_revoked'});
 }
 if(permission==='legacy-placement'){
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1 AND channel=?2 AND agent_id='helper'").bind(f.org,f.channel).run();
  expect(await postMessage(env.DB,args)).toMatchObject({status:403,code:'webhook_revoked'});
 }
});

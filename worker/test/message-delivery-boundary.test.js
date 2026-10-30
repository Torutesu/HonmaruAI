import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import worker from '../src/index.js';
import {postMessage,getMessage,resolveChannel} from '../src/channels.js';
import {deliverAcceptedMessages} from '../src/channelRoutes.js';
import {createSession,upsertMembership,upsertUser} from '../src/db.js';

const org='delivery-boundary';
async function people(){
  for(const login of ['alice','bob','carl']) {
    await upsertUser(env.DB,{githubId:login,login,name:login[0].toUpperCase()+login.slice(1),locale:'en'});
    await upsertMembership(env.DB,org,login,login==='alice'?'admin':'member');
  }
  return createSession(env.DB,'alice','fixture-token');
}
function relay(){let status=503;const events=[];return {events,set status(value){status=value;},binding:{idFromName:x=>x,get:()=>({fetch:async(url,init)=>{events.push(JSON.parse(init.body));return new Response('{}',{status});}})}};}
async function call(path,token,body,method,relay){
  const tasks=[];const response=await worker.fetch(new Request('https://example.com'+path,{method,headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify(body)}),{...env,ORG_RELAY:relay.binding},{waitUntil:p=>tasks.push(p)});
  await Promise.allSettled(tasks);return response;
}
const drain=relay=>Promise.all(['live','push'].map(kind=>deliverAcceptedMessages({...env,ORG_RELAY:relay.binding},{kind,now:Date.now()+120000})));
const queued=async()=> (await env.DB.prepare('SELECT message_id FROM push_queue WHERE sent_at IS NULL').all()).results;

test.each(['removed','recreated'])('Accepted private legacy room deletion (%s) cannot broaden durable live/push audience',async mutation=>{
  const token=await people();const capture=relay();
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES (?1,'private','Private','alice','2026-01-01',1)").bind(org).run();
  for(const login of ['alice','bob'])await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,'b:private',?2,'2026-01-01')").bind(org,login).run();
  expect(await env.DB.prepare('SELECT 1 FROM hx_room_access WHERE org_id=?1').bind(org).first()).toBeNull();
  const sent=await call('/channels/messages',token,{orgId:org,channel:'b:private',body:'@Bob @Carl private fixture',clientId:'tmp-private-boundary'},'POST',capture);
  expect(sent.status).toBe(201);const {message}=await sent.json();
  expect((await queued()).map(x=>x.message_id)).toEqual([message.id]);
  const removed=await call('/businesses',token,{orgId:org,slug:'private'},'DELETE',capture);expect(removed.status).toBe(200);
  expect(await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=?1 AND slug='private'").bind(org).first()).toBeNull();
  expect((await getMessage(env.DB,org,message.id)).deleted_at).toBeNull();
  if(mutation==='recreated')await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at,private) VALUES (?1,'private','Replacement','2026-02-01',0)").bind(org).run();
  capture.events.length=0;capture.status=200;await drain(capture);
  expect(capture.events).toEqual([]);expect(await queued()).toEqual([]);
  expect((await env.DB.prepare('SELECT status FROM channel_message_delivery WHERE message_id=?1').bind(message.id).all()).results).toEqual([{status:'done'},{status:'done'}]);
});

test.each(['b:general','b:implicit-room'])('Supported implicit public channel %s still delivers without a business row',async channel=>{
  const token=await people();const capture=relay();capture.status=200;
  const sent=await call('/channels/messages',token,{orgId:org,channel,body:'@Bob public fixture'},'POST',capture);
  expect(sent.status).toBe(201);const {message}=await sent.json();
  expect(await env.DB.prepare('SELECT 1 FROM businesses WHERE org_id=?1').bind(org).first()).toBeNull();
  expect(capture.events.flatMap(x=>x.events||[]).some(x=>x.name==='channel_message'&&x.value.message.id===message.id)).toBe(true);
  expect((await queued()).map(x=>x.message_id)).toEqual([message.id]);
});

test.each(['deleted','missing','other-org','other-channel','nested'])('Late committed child of %s root cannot replay live or push after interrupted cleanup',async mutation=>{
  await people();const capture=relay();capture.status=200;
  const root=(await postMessage(env.DB,{orgId:org,key:'b:general',authorLogin:'alice',body:'Root fixture'})).row;
  const child=(await postMessage(env.DB,{orgId:org,key:'b:general',authorLogin:'alice',body:'@Bob late fixture',parentId:root.id,deliveryTasks:true})).row;
  await env.DB.prepare("INSERT INTO push_queue(org_id,login,message_id,reason,created_at,due_at) VALUES (?1,'bob',?2,'thread','2026-01-01','2026-01-01')").bind(org,child.id).run();
  const sql={deleted:"UPDATE channel_messages SET body='',deleted_at='gone' WHERE id=?1",missing:'DELETE FROM channel_messages WHERE id=?1','other-org':"UPDATE channel_messages SET org_id='foreign' WHERE id=?1",'other-channel':"UPDATE channel_messages SET channel='b:foreign' WHERE id=?1",nested:"UPDATE channel_messages SET parent_id='other-root' WHERE id=?1"}[mutation];
  await env.DB.prepare(sql).bind(root.id).run();
  expect((await getMessage(env.DB,org,child.id)).deleted_at).toBeNull();
  await drain(capture);expect(capture.events).toEqual([]);expect(await queued()).toEqual([]);
});


test('Room deletion between authorized resolution and source commit never becomes virtual provenance',async()=>{
  const token=await people();const capture=relay();capture.status=200;
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES (?1,'private','Private','alice','2026-01-01',1)").bind(org).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,'b:private','alice','2026-01-01')").bind(org).run();
  const resolved=await resolveChannel(env.DB,org,{login:'alice'},'b:private',[]);
  expect(resolved.deliveryBoundary).toEqual({businessCreatedAt:'2026-01-01',allowVirtual:false});
  expect((await call('/businesses',token,{orgId:org,slug:'private'},'DELETE',capture)).status).toBe(200);
  const sent=await postMessage(env.DB,{orgId:org,key:'b:private',authorLogin:'alice',body:'Private fixture',deliveryTasks:true,deliveryBoundary:resolved.deliveryBoundary});
  expect(sent.row).toBeTruthy();capture.events.length=0;await drain(capture);expect(capture.events).toEqual([]);
  expect((await env.DB.prepare('SELECT business_created_at,allow_virtual FROM channel_message_delivery WHERE message_id=?1').bind(sent.row.id).all()).results).toEqual([{business_created_at:'2026-01-01',allow_virtual:0},{business_created_at:'2026-01-01',allow_virtual:0}]);
});

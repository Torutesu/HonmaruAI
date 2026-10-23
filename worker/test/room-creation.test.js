import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {upsertUser,upsertMembership,listBusinesses} from '../src/db.js';
import {memberRef} from '../src/team.js';
import {createManagedRoom} from '../src/harness/roomCreation.js';
import {roomRoleState,deleteManagedRoom} from '../src/harness/roomRoles.js';
const org='room-creation';
const draft=overrides=>({requestId:'creation-request-123',name:'Planning',private:true,guidelines:'Use clear decisions.',color:'teal',memberRefs:[],agentIds:[],...overrides});
test('legacy role casing and numeric-looking IDs use the same snapshot as member presentation',async()=>{
 for(const [id,role] of [['2001','Admin'],['2002','Engineer']]){
  await upsertUser(env.DB,{githubId:id,login:`user-${id}`,name:id,locale:'en'});
  await upsertMembership(env.DB,org,id,role);
 }
 const result=await createManagedRoom(env.DB,org,'2001',draft({memberRefs:[await memberRef(org,'2002')]}));
 expect(result.error).toBeUndefined();
 expect(result.created).toBe(true);
});
beforeEach(async()=>{
 for(const [id,role] of [['creator','member'],['reader','member'],['guest','guest']]){
  await upsertUser(env.DB,{githubId:id,login:id,name:id,locale:'en'});
  await upsertMembership(env.DB,org,id,role);
 }
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','creator','created','created')").bind(org).run();
});
test('creates a complete private room with selected people, agents, color, guidelines and exactly one human admin',async()=>{
 const result=await createManagedRoom(env.DB,org,'creator',draft({memberRefs:[await memberRef(org,'reader')],agentIds:['helper']}));
 expect(result.created).toBe(true);
 const state=await roomRoleState(env.DB,org,result.room.channel);
 expect(state.private).toBe(true);expect(state.managed).toBe(true);
 expect(state.members.map(m=>[m.id,m.role]).sort()).toEqual([['creator','admin'],['helper','member'],['reader','member']]);
 expect(await env.DB.prepare('SELECT body FROM hx_room_guidelines WHERE org_id=?1 AND channel=?2').bind(org,result.room.channel).first('body')).toBe('Use clear decisions.');
 expect(result.room.color).toBe('teal');
 expect((await listBusinesses(env.DB,org,{viewer:'creator'})).find(room=>room.slug===result.room.slug)?.color).toBe('teal');
 expect(await listBusinesses(env.DB,org,{viewer:'guest'})).toEqual([]);
});
test('concurrent identical retries create only one room; changed payload cannot reuse the request',async()=>{
 const results=await Promise.all([createManagedRoom(env.DB,org,'creator',draft()),createManagedRoom(env.DB,org,'creator',draft())]);
 expect(results[0].room.channel).toBe(results[1].room.channel);
 expect(results.map(r=>r.created).sort()).toEqual([false,true]);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM businesses WHERE org_id=?1').bind(org).first('n')).toBe(1);
 expect((await createManagedRoom(env.DB,org,'creator',draft({name:'Different'}))).status).toBe(409);
});
test('same display name uses distinct identities and deleted room retry cannot recreate history',async()=>{
 const first=await createManagedRoom(env.DB,org,'creator',draft());
 await deleteManagedRoom(env.DB,org,first.room.channel,{actorId:'creator',version:1});
 expect((await createManagedRoom(env.DB,org,'creator',draft())).status).toBe(409);
 const next=await createManagedRoom(env.DB,org,'creator',draft({requestId:'another-request-123'}));
 expect(next.created).toBe(true);expect(next.room.channel).not.toBe(first.room.channel);
});
test('public viewing does not implicitly join the whole workspace',async()=>{
 const result=await createManagedRoom(env.DB,org,'creator',draft({private:false}));
 const state=await roomRoleState(env.DB,org,result.room.channel);
 expect(state.private).toBe(false);expect(state.members.map(m=>m.id)).toEqual(['creator']);
});
test('invalid drafts, guests, missing selected people and unavailable agents create nothing',async()=>{
 expect((await createManagedRoom(env.DB,org,'creator',draft({name:' '}))).status).toBe(400);
 expect((await createManagedRoom(env.DB,org,'guest',draft())).status).toBe(403);
 expect((await createManagedRoom(env.DB,org,'creator',draft({memberRefs:['missing']}))).status).toBe(409);
 expect((await createManagedRoom(env.DB,org,'creator',draft({agentIds:['missing']}))).status).toBe(409);
 for(const table of ['businesses','hx_room_creations','hx_room_access','conversation_members','hx_room_roles'])
  expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?1`).bind(org).first('n')).toBe(0);
});
test('membership changes between selection and commit roll back every part of creation',async()=>{
 const raced={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
  await env.DB.prepare("UPDATE memberships SET created_at='rejoined' WHERE org_id=?1 AND user_github_id='reader'").bind(org).run();
  return env.DB.batch(statements);
 }};
 expect((await createManagedRoom(raced,org,'creator',draft({memberRefs:[await memberRef(org,'reader')]}))).status).toBe(409);
 for(const table of ['businesses','hx_room_creations','hx_room_access','hx_room_guidelines'])
  expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?1`).bind(org).first('n')).toBe(0);
});
test('agent access is checked at commit and a rejoined creator cannot replay an old request',async()=>{
 const raced={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
  await env.DB.prepare("UPDATE custom_agents SET scope='personal',owner_login='reader' WHERE org_id=?1").bind(org).run();
  return env.DB.batch(statements);
 }};
 expect((await createManagedRoom(raced,org,'creator',draft({agentIds:['helper']}))).status).toBe(409);
 expect((await createManagedRoom(env.DB,org,'creator',draft())).created).toBe(true);
 await env.DB.prepare("UPDATE memberships SET created_at='new creator join' WHERE org_id=?1 AND user_github_id='creator'").bind(org).run();
 expect((await createManagedRoom(env.DB,org,'creator',draft())).status).toBe(409);
});

test('a failed transaction leaves no receipt, room, members or guidelines behind',async()=>{
 const broken={prepare:sql=>env.DB.prepare(sql),batch:statements=>env.DB.batch([...statements,env.DB.prepare('INSERT INTO missing_creation_test_table(id) VALUES (1)')])};
 await expect(createManagedRoom(broken,org,'creator',draft({memberRefs:[await memberRef(org,'reader')],agentIds:['helper']}))).rejects.toThrow();
 for(const table of ['hx_room_creations','businesses','hx_room_access','conversation_members','channel_agents','hx_room_roles','hx_room_guidelines'])
  expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?1`).bind(org).first('n')).toBe(0);
 expect((await createManagedRoom(env.DB,org,'creator',draft())).created).toBe(true);
});

test('creation HTTP API authenticates, replays the same room, and keeps private rooms off other members lists',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {createSession}=await import('../src/db.js');
 const pending=[],context={waitUntil:p=>pending.push(p)};
 const token=await createSession(env.DB,'creator','test');
 const call=(token,body=draft())=>worker.fetch(new Request('https://example.com/channels/rooms',{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:org,...body})}),env,context);
 expect((await call('invalid')).status).toBe(401);
 expect((await call(await createSession(env.DB,'guest','test'))).status).toBe(403);
 const first=await call(token);expect(first.status).toBe(201);const data=await first.json();
 expect(data.businesses.map(b=>b.slug)).toContain(data.room.slug);
 const retry=await call(token);expect(retry.status).toBe(200);expect((await retry.json()).room.channel).toBe(data.room.channel);
 const reader=await createSession(env.DB,'reader','test');
 const listing=await worker.fetch(new Request('https://example.com/businesses?orgId='+org,{headers:{'x-session-token':reader}}),env,context);
 expect((await listing.json()).businesses).toEqual([]);
 await Promise.all(pending);
});

test('managed room details show explicit people and assigned agents, with room-specific capabilities',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {createSession}=await import('../src/db.js');
 const {setRoomRole,joinPublicRoom}=await import('../src/harness/roomRoles.js');
 const room=await createManagedRoom(env.DB,org,'creator',draft({private:false,agentIds:['helper'],memberRefs:[await memberRef(org,'guest')]}));
 const pending=[],context={waitUntil:p=>pending.push(p)};
 const read=async id=>{
  const token=await createSession(env.DB,id,'test');
  const response=await worker.fetch(new Request('https://example.com/channels/details?'+new URLSearchParams({orgId:org,channel:room.room.channel}),{headers:{'x-session-token':token}}),env,context);
  expect(response.status).toBe(200);return response.json();
 };
 const creator=await read('creator');
 expect(creator.channel).toMatchObject({managed:true,joined:true,canInvite:true});
 expect(creator.members.people.map(p=>[p.name,p.roomRole]).sort()).toEqual([['creator','admin'],['guest','member']]);
 expect(creator.members.agents.map(a=>[a.id,a.kind,a.canRemove])).toEqual([['helper','custom',true]]);
 expect(creator.counts.members).toBe(3);
 expect((await listBusinesses(env.DB,org,{viewer:'creator'})).find(b=>b.slug===room.room.slug)).toMatchObject({managed:true,memberCount:3});
 const reader=await read('reader');
 expect(reader.channel).toMatchObject({joined:false,canInvite:false});
 expect(reader.members.agents[0].canRemove).toBe(false);expect(reader.addableAgents).toEqual([]);
 const guest=await read('guest');expect(guest.channel.canInvite).toBe(false);expect(guest.members.agents[0].canRemove).toBe(false);
 await setRoomRole(env.DB,org,room.room.channel,{actorId:'creator',kind:'agent',id:'helper',role:'admin',version:1});
 await joinPublicRoom(env.DB,org,room.room.channel,'reader');
 const joined=await read('reader');expect(joined.channel.canInvite).toBe(true);
 expect(joined.members.agents[0]).toMatchObject({roomRole:'admin',canRemove:false});
 expect(joined.counts.members).toBe(4);
 await Promise.all(pending);
});

test('room role HTTP updates require the current human admin and reviewed version',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {createSession}=await import('../src/db.js');
 const room=await createManagedRoom(env.DB,org,'creator',draft({private:false,memberRefs:[await memberRef(org,'reader')],agentIds:['helper']}));
 const pending=[],context={waitUntil:p=>pending.push(p)};
 const change=async(actor,body)=>worker.fetch(new Request('https://example.com/channels/room-role',{method:'PUT',headers:{'content-type':'application/json','x-session-token':await createSession(env.DB,actor,'test')},body:JSON.stringify({orgId:org,channel:room.room.channel,...body})}),env,context);
 const readerRef=await memberRef(org,'reader'),creatorRef=await memberRef(org,'creator');
 expect((await change('reader',{kind:'person',id:readerRef,role:'admin',version:1})).status).toBe(403);
 expect((await change('creator',{kind:'person',id:'reader',role:'admin',version:1})).status).toBe(404);
 expect((await change('creator',{kind:'person',id:readerRef,role:'admin',version:1})).status).toBe(200);
 expect((await change('creator',{kind:'person',id:readerRef,role:'member',version:1})).status).toBe(409);
 expect((await change('creator',{kind:'person',id:creatorRef,role:'member',version:2})).status).toBe(200);
 expect((await change('reader',{kind:'person',id:readerRef,role:'member',version:3})).status).toBe(409);
 expect((await change('creator',{kind:'agent',id:'helper',role:'admin',version:3})).status).toBe(403);
 expect((await change('reader',{kind:'agent',id:'helper',role:'admin',version:3})).status).toBe(200);
 const state=await roomRoleState(env.DB,org,room.room.channel);
 expect(state.version).toBe(4);expect(state.members.filter(m=>m.kind==='person'&&m.role==='admin').map(m=>m.id)).toEqual(['reader']);
 await Promise.all(pending);
});
test.each(['rose','yellow','green','lake','indigo'])('persists the added %s color through room listing and a creation retry',async color=>{
 const input=draft({color});const created=await createManagedRoom(env.DB,org,'creator',input);
 expect(created.created).toBe(true);expect(created.room.color).toBe(color);
 expect((await listBusinesses(env.DB,org,{viewer:'creator'})).find(room=>room.slug===created.room.slug)?.color).toBe(color);
 const retry=await createManagedRoom(env.DB,org,'creator',input);expect(retry.created).toBe(false);expect(retry.room.color).toBe(color);
});

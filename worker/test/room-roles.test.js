import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {roomRoleState,initializeRoomRoles,setRoomRole,removeRoomSubject} from '../src/harness/roomRoles.js';
const org='room-roles',channel='b:planning';
beforeEach(async()=>{
  for(const [id,role] of [['creator','member'],['reader','member'],['outsider','admin'],['guest','guest']]) {
    await upsertUser(env.DB,{githubId:id,login:id,name:id,locale:'en'});
    await upsertMembership(env.DB,org,id,role);
  }
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES (?1,'planning','Planning','creator','now',1)").bind(org).run();
  for(const login of ['creator','reader','guest'])await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,?2,?3,'joined')").bind(org,channel,login).run();
  await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES (?1,'helper','helper','Helper','Help','team','creator','created','created')").bind(org).run();
  await env.DB.prepare("INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) VALUES (?1,?2,'helper','creator','assigned')").bind(org,channel).run();
});
const change=(actorId,kind,id,role,version)=>setRoomRole(env.DB,org,channel,{actorId,kind,id,role,version});
test('legacy rooms remain unmanaged and only an active room creator can initialize independent roles',async()=>{
  expect((await roomRoleState(env.DB,org,channel)).managed).toBe(false);
  expect((await initializeRoomRoles(env.DB,org,channel,'outsider')).status).toBe(403);
  expect((await initializeRoomRoles(env.DB,org,channel,'reader')).status).toBe(403);
  expect(await initializeRoomRoles(env.DB,org,channel,'creator')).toEqual({version:1});
  expect(await initializeRoomRoles(env.DB,org,channel,'creator')).toEqual({version:1});
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.members.find(m=>m.id==='creator')).toMatchObject({kind:'person',role:'admin'});
  expect(state.members.some(m=>m.id==='outsider')).toBe(false);
  expect((await change('reader','person','creator','member',1)).status).toBe(403);
});
test('agents can administer a room but cannot replace its last human admin',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(await change('creator','agent','helper','admin',1)).toEqual({version:2});
  expect((await change('creator','person','creator','member',2)).status).toBe(409);
  expect((await change('creator','person','guest','admin',2)).status).toBe(403);
  expect(await change('creator','person','reader','admin',2)).toEqual({version:3});
  expect(await change('reader','person','creator','member',3)).toEqual({version:4});
  expect((await change('creator','person','reader','member',4)).status).toBe(403);
});
test('private-room rejoining and agent reassignment do not revive old admin grants',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','person','reader','admin',1);
  await change('creator','agent','helper','admin',2);
  await env.DB.prepare("UPDATE conversation_members SET added_at='rejoined' WHERE org_id=?1 AND channel=?2 AND login='reader'").bind(org,channel).run();
  await env.DB.prepare("UPDATE channel_agents SET added_at='reassigned' WHERE org_id=?1 AND channel=?2 AND agent_id='helper'").bind(org,channel).run();
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.members.find(m=>m.id==='reader').role).toBe('member');
  expect(state.members.find(m=>m.id==='helper').role).toBe('member');
  expect((await change('reader','person','creator','member',3)).status).toBe(403);
});
test('concurrent role changes have one winner and a workspace admin cannot bypass room roles',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1 AND slug='planning'").bind(org).run();
  // A privacy transition must deliberately rebind roles; it never silently
  // revives a previous private-membership grant.
  expect((await change('outsider','person','reader','admin',1)).status).toBe(403);
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1 AND slug='planning'").bind(org).run();
  const results=await Promise.all([change('creator','person','reader','admin',1),change('creator','agent','helper','admin',1)]);
  expect(results.filter(r=>r.version===2)).toHaveLength(1);
  expect(results.filter(r=>r.status===409)).toHaveLength(1);
});

test('a target rejoining between the role read and transaction receives no stale grant',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await env.DB.prepare("UPDATE conversation_members SET added_at='new membership' WHERE org_id=?1 AND channel=?2 AND login='reader'").bind(org,channel).run();
    return env.DB.batch(statements);
  }};
  expect(await setRoomRole(db,org,channel,{actorId:'creator',kind:'person',id:'reader',role:'admin',version:1})).toMatchObject({status:409});
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.version).toBe(1);
  expect(state.members.find(m=>m.id==='reader').role).toBe('member');
});

const remove=(actorId,kind,id,version)=>removeRoomSubject(env.DB,org,channel,{actorId,kind,id,version});
test('managed removal protects admins and the last human while legacy removal stays unchanged',async()=>{
  expect(await remove('reader','person','creator')).toEqual({managed:false});
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect((await remove('reader','person','creator')).status).toBe(403);
  expect((await remove('creator','person','creator')).status).toBe(409);
  await change('creator','agent','helper','admin',1);
  expect((await remove('reader','agent','helper')).status).toBe(403);
  expect(await remove('creator','agent','helper',2)).toMatchObject({removed:true,version:3});
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='helper')).toBe(false);
  expect(await remove('creator','person','reader',3)).toMatchObject({removed:true,version:4});
});
test('members may remove ordinary members and admins may leave after a handoff',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(await remove('reader','agent','helper',1)).toMatchObject({removed:true,version:2});
  await change('creator','person','reader','admin',2);
  expect(await remove('creator','person','creator',3)).toMatchObject({removed:true,version:4});
  expect((await roomRoleState(env.DB,org,channel)).members.find(m=>m.id==='reader').role).toBe('admin');
});
test('a rejoin during removal cannot delete the new membership',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await env.DB.prepare("UPDATE conversation_members SET added_at='rejoined during removal' WHERE org_id=?1 AND channel=?2 AND login='reader'").bind(org,channel).run();
    return env.DB.batch(statements);
  }};
  expect(await removeRoomSubject(db,org,channel,{actorId:'creator',kind:'person',id:'reader',version:1})).toMatchObject({status:409});
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='reader')).toBe(true);
});

test('channel endpoints enforce managed room roles for both humans and agents',async()=>{
  const {default:worker}=await import('../src/index.js');
  const {createSession}=await import('../src/db.js');
  const {memberRef}=await import('../src/team.js');
  const sessions={creator:await createSession(env.DB,'creator','test'),reader:await createSession(env.DB,'reader','test')};
  const call=async(actor,path,body)=>{
    const pending=[];
    const response=await worker.fetch(new Request(`https://example.com${path}`,{method:'DELETE',headers:{'content-type':'application/json','x-session-token':sessions[actor]},body:JSON.stringify({orgId:org,channel,...body})}),env,{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);return response;
  };
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','agent','helper','admin',1);
  expect((await call('reader','/channels/channel-agents',{agentId:'helper'})).status).toBe(403);
  expect((await call('reader','/channels/members',{ref:await memberRef(org,'creator')})).status).toBe(403);
  expect((await call('creator','/channels/members',{})).status).toBe(409);
  expect((await call('creator','/channels/channel-agents',{agentId:'helper',version:2})).status).toBe(200);
  expect((await call('creator','/channels/members',{ref:await memberRef(org,'reader'),version:3})).status).toBe(200);
});

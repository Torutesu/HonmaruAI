import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {roomRoleState,initializeRoomRoles,setRoomRole,removeRoomSubject,deleteManagedRoom,changeManagedRoomMembers} from '../src/harness/roomRoles.js';
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
  // Public visibility does not make workspace admins joined room admins.
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

test('public rooms distinguish access from joined membership and revoke roles on leave',async()=>{
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1 AND slug='planning'").bind(org).run();
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org,channel).run();
  expect(await initializeRoomRoles(env.DB,org,channel,'creator')).toEqual({version:1});
  let state=await roomRoleState(env.DB,org,channel);
  expect(state.members.some(m=>m.id==='outsider')).toBe(false);
  expect(state.members.find(m=>m.id==='creator').role).toBe('admin');
  await change('creator','person','reader','admin',1);
  expect(await remove('reader','person','reader',2)).toMatchObject({removed:true,version:3});
  // Public read access remains, but the explicit role and joined state are gone.
  const {mayRead,accessFor}=await import('../src/access.js');
  expect(mayRead(channel,await accessFor(env.DB,org,'reader'))).toBe(true);
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,?2,'reader','rejoined public')").bind(org,channel).run();
  state=await roomRoleState(env.DB,org,channel);
  expect(state.members.find(m=>m.id==='reader').role).toBe('member');
});

test('visibility changes preserve current joined grants without restoring stale grants',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','person','reader','admin',1);
  await env.DB.prepare("UPDATE conversation_members SET added_at='new join' WHERE org_id=?1 AND channel=?2 AND login='reader'").bind(org,channel).run();
  for(const privateRoom of [0,1]) {
    await env.DB.prepare("UPDATE businesses SET private=?2 WHERE org_id=?1 AND slug='planning'").bind(org,privateRoom).run();
    const state=await roomRoleState(env.DB,org,channel);
    expect(state.members.find(m=>m.id==='creator').role).toBe('admin');
    expect(state.members.find(m=>m.id==='reader').role).toBe('member');
  }
});

test('the public managed-room leave endpoint removes joined state without revoking public reading',async()=>{
  const {default:worker}=await import('../src/index.js');
  const {createSession}=await import('../src/db.js');
  const {accessFor,mayRead}=await import('../src/access.js');
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1 AND slug='planning'").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const token=await createSession(env.DB,'reader','test'),pending=[];
  const response=await worker.fetch(new Request('https://example.com/channels/members',{method:'DELETE',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:org,channel})}),env,{waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  expect(response.status).toBe(200);
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='reader')).toBe(false);
  expect(mayRead(channel,await accessFor(env.DB,org,'reader'))).toBe(true);
});

test('room deletion requires administration and atomically clears membership and role state',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect((await deleteManagedRoom(env.DB,org,channel,{actorId:'reader'})).status).toBe(403);
  expect((await deleteManagedRoom(env.DB,org,channel,{actorId:'guest'})).status).toBe(403);
  expect(await deleteManagedRoom(env.DB,org,channel,{actorId:'creator',version:1})).toMatchObject({deleted:true});
  expect(await roomRoleState(env.DB,org,channel,{includeArchived:true})).toBeNull();
  for(const table of ['conversation_members','channel_agents','hx_room_roles']) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?1 AND channel=?2`).bind(org,channel).first('n')).toBe(0);
  }
});
test('workspace admins can delete archived private rooms without joining or receiving reading rights',async()=>{
  const {mayRead,accessFor}=await import('../src/access.js');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(mayRead(channel,await accessFor(env.DB,org,'outsider'))).toBe(false);
  await env.DB.prepare("UPDATE businesses SET archived_at='archived' WHERE org_id=?1 AND slug='planning'").bind(org).run();
  expect(await deleteManagedRoom(env.DB,org,channel,{actorId:'outsider',version:1})).toMatchObject({deleted:true});
});
test('deletion fails when the room admin loses their role before the transaction',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','person','reader','admin',1);
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await change('reader','person','creator','member',2);
    return env.DB.batch(statements);
  }};
  expect(await deleteManagedRoom(db,org,channel,{actorId:'creator',version:2})).toMatchObject({status:409});
  expect((await roomRoleState(env.DB,org,channel)).managed).toBe(true);
});
test('the deletion HTTP endpoint permits lifecycle administration without private-room reading',async()=>{
  const {default:worker}=await import('../src/index.js');
  const {createSession}=await import('../src/db.js');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const call=async actor=>{
    const token=await createSession(env.DB,actor,'test'),pending=[];
    const response=await worker.fetch(new Request('https://example.com/businesses',{method:'DELETE',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:org,slug:'planning',version:1})}),env,{waitUntil:p=>pending.push(p)});
    await Promise.all(pending);return response;
  };
  expect((await call('reader')).status).toBe(403);
  expect((await call('outsider')).status).toBe(200);
  expect(await roomRoleState(env.DB,org,channel,{includeArchived:true})).toBeNull();
});

test('deleted managed rooms cannot expose old messages or revive by the same name',async()=>{
  const {accessFor,mayRead,addMembers}=await import('../src/access.js');
  const {resolveChannel}=await import('../src/channels.js');
  const {upsertBusiness}=await import('../src/db.js');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await deleteManagedRoom(env.DB,org,channel,{actorId:'creator',version:1});
  expect(await env.DB.prepare('SELECT deleted_at FROM hx_room_access WHERE org_id=?1 AND channel=?2').bind(org,channel).first('deleted_at')).toBeTruthy();
  expect(await upsertBusiness(env.DB,org,{name:'Planning',createdBy:'outsider'})).toBeNull();
  expect(await addMembers(env.DB,{orgId:org,key:channel,logins:['outsider'],addedBy:'outsider'})).toBe(0);
  for(const login of ['creator','reader','outsider']) {
    expect(mayRead(channel,await accessFor(env.DB,org,login))).toBe(false);
    expect(await resolveChannel(env.DB,org,{login},channel,[])).toBeNull();
  }
});

test('a deletion retry never falls back to physically deleting a managed tombstone',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await deleteManagedRoom(env.DB,org,channel,{actorId:'creator',version:1});
  expect(await deleteManagedRoom(env.DB,org,channel,{actorId:'outsider',version:1})).toMatchObject({status:409});
  expect(await env.DB.prepare("SELECT private FROM businesses WHERE org_id=?1 AND slug='planning'").bind(org).first('private')).toBe(1);
});

test('legacy physical removal cannot race with managed initialization',async()=>{
  const {removeBusiness}=await import('../src/db.js');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(await removeBusiness(env.DB,org,'planning')).toBe(false);
  expect((await roomRoleState(env.DB,org,channel)).managed).toBe(true);
  await deleteManagedRoom(env.DB,org,channel,{actorId:'creator',version:1});
  expect(await removeBusiness(env.DB,org,'planning')).toBe(false);
});

test('bulk member edits reject the last admin without partially adding another person',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const result=await changeManagedRoomMembers(env.DB,org,channel,{actorId:'creator',adding:[{userId:'outsider'}],removing:[{userId:'creator'}]});
  expect(result.status).toBe(409);
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='outsider')).toBe(false);
});
test('bulk member edits apply additions and removals together and reject membership races',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const input={actorId:'creator',adding:[{userId:'outsider'}],removing:[{userId:'reader'}]};
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await env.DB.prepare("UPDATE memberships SET created_at='rejoined' WHERE org_id=?1 AND user_github_id='outsider'").bind(org).run();
    return env.DB.batch(statements);
  }};
  expect((await changeManagedRoomMembers(db,org,channel,input)).status).toBe(409);
  let state=await roomRoleState(env.DB,org,channel);
  expect(state.members.some(m=>m.id==='reader')).toBe(true);
  expect(state.members.some(m=>m.id==='outsider')).toBe(false);
  expect(await changeManagedRoomMembers(env.DB,org,channel,input)).toEqual({managed:true});
  state=await roomRoleState(env.DB,org,channel);
  expect(state.members.some(m=>m.id==='reader')).toBe(false);
  expect(state.members.find(m=>m.id==='outsider').role).toBe('member');
});

test('bulk edits compare the exact transaction snapshot to the authorized membership state',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  let changed=false;
  const db={prepare:(sql)=>{
    const statement=env.DB.prepare(sql);
    if(!sql.startsWith('SELECT json_group_array(json_array(kind,id,membership,role,eligible))'))return statement;
    return {bind:(...args)=>({first:async()=>{
      changed=true;
      await env.DB.prepare("UPDATE conversation_members SET added_at='different join' WHERE org_id=?1 AND channel=?2 AND login='reader'").bind(org,channel).run();
      return statement.bind(...args).first();
    }})};
  },batch:(...args)=>env.DB.batch(...args)};
  const result=await changeManagedRoomMembers(db,org,channel,{actorId:'creator',adding:[{userId:'outsider'}],removing:[{userId:'reader'}]});
  expect(changed).toBe(true);
  expect(result.status).toBe(409);
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.version).toBe(1);
  expect(state.members.some(m=>m.id==='reader')).toBe(true);
  expect(state.members.some(m=>m.id==='outsider')).toBe(false);
});

test('guest demotion cannot strand a room and never revives old admin grants',async()=>{
  const {changeRole,memberRef}=await import('../src/team.js');
  await upsertMembership(env.DB,org,'outsider','owner');
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,?2,'outsider','owner joined')").bind(org,channel).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const input={orgId:org,actorId:'outsider',ref:await memberRef(org,'creator'),role:'guest',channels:['planning']};
  expect(await changeRole(env,input)).toMatchObject({status:409,code:'last-room-admin'});
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE org_id=?1 AND user_github_id='creator'").bind(org).first('role')).toBe('member');
  await change('creator','person','reader','admin',1);
  expect(await changeRole(env,input)).toMatchObject({ok:true});
  expect(await changeRole(env,{...input,role:'member'})).toMatchObject({ok:true});
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.members.find(m=>m.id==='creator').role).toBe('member');
  expect(state.members.find(m=>m.id==='reader').role).toBe('admin');
});

test('simultaneous guest demotions leave one human admin in an archived room',async()=>{
  const {changeRole,memberRef}=await import('../src/team.js');
  await upsertMembership(env.DB,org,'outsider','owner');
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,?2,'outsider','owner joined')").bind(org,channel).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','person','reader','admin',1);
  await change('creator','agent','helper','admin',2);
  await env.DB.prepare("UPDATE businesses SET archived_at='archived' WHERE org_id=?1 AND slug='planning'").bind(org).run();
  const refs=await Promise.all(['creator','reader'].map(id=>memberRef(org,id)));
  const results=await Promise.all(refs.map(ref=>changeRole(env,{orgId:org,actorId:'outsider',ref,role:'guest',channels:['planning']})));
  expect(results.filter(r=>r.ok)).toHaveLength(1);
  expect(results.filter(r=>r.code==='last-room-admin')).toHaveLength(1);
  const state=await roomRoleState(env.DB,org,channel,{includeArchived:true});
  expect(state.members.filter(m=>m.kind==='person'&&m.role==='admin'&&m.eligible)).toHaveLength(1);
});

test('workspace departure hands archived room administration only to an existing participant',async()=>{
  const {previewMemberDeparture,removeMember,memberRef}=await import('../src/team.js');
  await upsertMembership(env.DB,org,'outsider','owner');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await env.DB.prepare("UPDATE businesses SET archived_at='archived' WHERE org_id=?1 AND slug='planning'").bind(org).run();
  const input={orgId:org,actorId:'outsider',targetId:'creator'};
  const preview=await previewMemberDeparture(env,input);
  expect(preview.rooms).toEqual([{channel,name:'Planning',version:1}]);
  expect(preview.candidates.map(m=>m.ref)).toEqual([await memberRef(org,'reader')]);
  expect(await removeMember(env,{...input,previewVersion:preview.version,transferTo:await memberRef(org,'outsider')})).toMatchObject({status:409,code:'room-handoff-membership'});
  expect(await removeMember(env,{...input,previewVersion:preview.version,transferTo:await memberRef(org,'reader')})).toMatchObject({ok:true});
  const state=await roomRoleState(env.DB,org,channel,{includeArchived:true});
  expect(state.members.find(m=>m.id==='reader').role).toBe('admin');
  expect(state.members.some(m=>m.id==='creator')).toBe(false);
});

test('departure rejects a successor rejoining a room between preview validation and commit',async()=>{
  const {previewMemberDeparture,listMembers,memberRef}=await import('../src/team.js');
  const {removeWithResourceHandoff}=await import('../src/harness/memberDeparture.js');
  await upsertMembership(env.DB,org,'outsider','owner');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const preview=await previewMemberDeparture(env,{orgId:org,actorId:'outsider',targetId:'creator'});
  const members=await listMembers(env.DB,org,'outsider');
  const context={actor:members.find(m=>m.userId==='outsider'),target:members.find(m=>m.userId==='creator'),members};
  const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{
    await env.DB.prepare("UPDATE conversation_members SET added_at='rejoined before handoff' WHERE org_id=?1 AND channel=?2 AND login='reader'").bind(org,channel).run();
    return env.DB.batch(statements);
  }};
  expect(await removeWithResourceHandoff(db,org,context,{transferTo:await memberRef(org,'reader'),previewVersion:preview.version})).toMatchObject({status:409,code:'departure-conflict'});
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.members.find(m=>m.id==='creator').role).toBe('admin');
  expect(state.members.find(m=>m.id==='reader').role).toBe('member');
  expect(state.version).toBe(1);
});

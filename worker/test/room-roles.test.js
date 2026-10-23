import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {roomRoleState,initializeRoomRoles,setRoomRole,removeRoomSubject,deleteManagedRoom,changeManagedRoomMembers,joinPublicRoom,publicRooms,addManagedRoomAgent,archiveManagedRoom,setRoomPrivacy} from '../src/harness/roomRoles.js';
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


test('public joining is idempotent and returning never revives an obsolete admin grant',async()=>{
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','person','reader','admin',1);
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=?1 AND login='reader'").bind(org).run();
  const results=await Promise.all([joinPublicRoom(env.DB,org,channel,'reader'),joinPublicRoom(env.DB,org,channel,'reader')]);
  expect(results.map(r=>r.joined).sort()).toEqual([false,true]);
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.version).toBe(3);
  expect(state.members.find(m=>m.id==='reader').role).toBe('member');
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_room_roles WHERE org_id=?1 AND subject_id='reader'").bind(org).first('n')).toBe(0);
});

test('self-joining cannot enroll guests, nonmembers, or anyone into private, archived, deleted or legacy rooms',async()=>{
  expect((await joinPublicRoom(env.DB,org,channel,'outsider')).status).toBe(404);
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect((await joinPublicRoom(env.DB,org,channel,'outsider')).status).toBe(404);
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  for(const id of ['guest','missing'])expect((await joinPublicRoom(env.DB,org,channel,id)).status).toBe(404);
  await env.DB.prepare("UPDATE businesses SET archived_at='archived' WHERE org_id=?1").bind(org).run();
  expect((await joinPublicRoom(env.DB,org,channel,'outsider')).status).toBe(404);
  await env.DB.prepare("UPDATE businesses SET archived_at=NULL WHERE org_id=?1").bind(org).run();
  await env.DB.prepare("UPDATE hx_room_access SET deleted_at='deleted' WHERE org_id=?1").bind(org).run();
  expect((await joinPublicRoom(env.DB,org,channel,'outsider')).status).toBe(404);
  expect(await env.DB.prepare("SELECT version FROM hx_room_access WHERE org_id=?1").bind(org).first('version')).toBe(1);
});

test('join endpoint enrolls only the authenticated caller and requires workspace membership',async()=>{
  const {default:worker}=await import('../src/index.js');
  const {createSession}=await import('../src/db.js');
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const token=await createSession(env.DB,'outsider','test'),pending=[];
  const call=(token,orgId=org)=>worker.fetch(new Request('https://example.com/channels/join',{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId,channel,userId:'guest'})}),env,{waitUntil:p=>pending.push(p)});
  expect((await call('invalid')).status).toBe(401);
  expect((await call(token,'different-workspace')).status).toBe(403);
  const first=await call(token);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({joined:true});
  expect(await (await call(token)).json()).toEqual({joined:false});
  await Promise.all(pending);
  expect((await roomRoleState(env.DB,org,channel)).members.find(m=>m.id==='outsider').role).toBe('member');
});


test('a room made private before the join transaction cannot gain a public participant',async()=>{
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const raced={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
    await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1").bind(org).run();
    return env.DB.batch(statements);
  }};
  expect((await joinPublicRoom(raced,org,channel,'outsider')).status).toBe(404);
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='outsider')).toBe(false);
  expect(await env.DB.prepare("SELECT version FROM hx_room_access WHERE org_id=?1").bind(org).first('version')).toBe(1);
});


test('public room discovery exposes joined state without private rooms or stale workspace members',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(await publicRooms(env.DB,org,'outsider')).toEqual([]);
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  expect(await publicRooms(env.DB,org,'outsider')).toEqual([{channel,name:'Planning',joined:false,memberCount:4}]);
  expect((await publicRooms(env.DB,org,'reader'))[0].joined).toBe(true);
  expect(await publicRooms(env.DB,org,'guest')).toEqual([]);
  expect(await publicRooms(env.DB,org,'missing')).toEqual([]);
  await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id='reader'").bind(org).run();
  expect((await publicRooms(env.DB,org,'outsider'))[0].memberCount).toBe(3);
  await env.DB.prepare("UPDATE custom_agents SET deleted_at='deleted' WHERE org_id=?1 AND id='helper'").bind(org).run();
  expect((await publicRooms(env.DB,org,'outsider'))[0].memberCount).toBe(2);
  await env.DB.prepare("UPDATE businesses SET archived_at='archived' WHERE org_id=?1").bind(org).run();
  expect(await publicRooms(env.DB,org,'outsider')).toEqual([]);
  await env.DB.prepare("UPDATE businesses SET archived_at=NULL WHERE org_id=?1").bind(org).run();
  await env.DB.prepare("UPDATE hx_room_access SET deleted_at='deleted' WHERE org_id=?1").bind(org).run();
  expect(await publicRooms(env.DB,org,'outsider')).toEqual([]);
});


test('ordinary joined members can invite people through the managed public-room endpoint, but readers and guests cannot',async()=>{
  const {default:worker}=await import('../src/index.js');
  const {createSession}=await import('../src/db.js');
  const {memberRef}=await import('../src/team.js');
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  const ref=await memberRef(org,'outsider'),pending=[];
  const call=async actor=>worker.fetch(new Request('https://example.com/channels/members',{method:'POST',headers:{'content-type':'application/json','x-session-token':await createSession(env.DB,actor,'test')},body:JSON.stringify({orgId:org,channel,refs:[ref]})}),env,{waitUntil:p=>pending.push(p)});
  expect((await call('outsider')).status).toBe(403);
  expect((await call('guest')).status).toBe(403);
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='outsider')).toBe(false);
  const added=await call('reader');
  expect(added.status).toBe(200);
  expect(await added.json()).toEqual({added:1});
  expect((await roomRoleState(env.DB,org,channel)).members.find(m=>m.id==='outsider').role).toBe('member');
  expect(await (await call('reader')).json()).toEqual({added:0});
  await Promise.all(pending);
});


test('managed agent invitations require a current participant and never resurrect old agent admin grants',async()=>{
  await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await change('creator','agent','helper','admin',1);
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1").bind(org).run();
  expect((await addManagedRoomAgent(env.DB,org,channel,{actorId:'outsider',agentId:'helper'})).status).toBe(403);
  expect(await addManagedRoomAgent(env.DB,org,channel,{actorId:'reader',agentId:'helper'})).toEqual({managed:true,added:true});
  expect((await roomRoleState(env.DB,org,channel)).members.find(m=>m.id==='helper').role).toBe('member');
  expect(await addManagedRoomAgent(env.DB,org,channel,{actorId:'reader',agentId:'helper'})).toEqual({managed:true,added:false});
});

test('agent access revoked before the invitation transaction rejects every write',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1").bind(org).run();
  const raced={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
    await env.DB.prepare("UPDATE custom_agents SET scope='personal' WHERE org_id=?1 AND id='helper'").bind(org).run();
    return env.DB.batch(statements);
  }};
  expect((await addManagedRoomAgent(raced,org,channel,{actorId:'reader',agentId:'helper'})).status).toBe(409);
  const state=await roomRoleState(env.DB,org,channel);
  expect(state.version).toBe(1);expect(state.members.some(m=>m.id==='helper')).toBe(false);
});

test('restricted agent invitations honor people sharing and current explicit grants',async()=>{
  await initializeRoomRoles(env.DB,org,channel,'creator');
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1").bind(org).run();
  await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES (?1,'helper','private','[]','now')").bind(org).run();
  const add=()=>addManagedRoomAgent(env.DB,org,channel,{actorId:'reader',agentId:'helper'});
  expect((await add()).status).toBe(409);
  await env.DB.prepare("UPDATE hx_agent_profiles SET access='people',people='[\"reader\"]' WHERE org_id=?1").bind(org).run();
  expect(await add()).toEqual({managed:true,added:true});
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1").bind(org).run();
  await env.DB.prepare("UPDATE hx_agent_profiles SET access='private',people='[]' WHERE org_id=?1").bind(org).run();
  await env.DB.prepare("INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since) SELECT ?1,'helper','reader','member','creator','now',created_at FROM memberships WHERE org_id=?1 AND user_github_id='reader'").bind(org).run();
  expect(await add()).toEqual({managed:true,added:true});
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1").bind(org).run();
  await env.DB.prepare("UPDATE hx_agent_members SET member_since='obsolete' WHERE org_id=?1").bind(org).run();
  expect((await add()).status).toBe(409);
});


test('legacy agent insertion cannot bypass a managed policy initialized after an earlier read',async()=>{
  const {addChannelAgent}=await import('../src/customAgents.js');
  await env.DB.prepare("DELETE FROM channel_agents WHERE org_id=?1").bind(org).run();
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(await addChannelAgent(env.DB,{orgId:org,key:channel,agentId:'helper',login:'outsider'})).toBe(false);
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='helper')).toBe(false);
});


test('legacy-only human invitations cannot bypass newly initialized room roles',async()=>{
  const {addMembers}=await import('../src/access.js');
  await initializeRoomRoles(env.DB,org,channel,'creator');
  expect(await addMembers(env.DB,{orgId:org,key:channel,logins:['outsider'],addedBy:'reader',legacyOnly:true})).toBe(0);
  expect((await roomRoleState(env.DB,org,channel)).members.some(m=>m.id==='outsider')).toBe(false);
  // Trusted onboarding callers keep their existing invitation behavior.
  expect(await addMembers(env.DB,{orgId:org,key:channel,logins:['outsider'],addedBy:'creator'})).toBe(1);
});


test('managed room archive and restore distinguish participants from public readers',async()=>{
 await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
 await initializeRoomRoles(env.DB,org,channel,'creator');
 await env.DB.prepare("UPDATE memberships SET role='member' WHERE org_id=?1 AND user_github_id='outsider'").bind(org).run();
 expect((await archiveManagedRoom(env.DB,org,channel,{actorId:'outsider',archived:true})).status).toBe(403);
 expect((await archiveManagedRoom(env.DB,org,channel,{actorId:'guest',archived:true})).status).toBe(403);
 expect(await archiveManagedRoom(env.DB,org,channel,{actorId:'reader',archived:true,version:1})).toMatchObject({managed:true,archived:true,version:2});
 expect(await roomRoleState(env.DB,org,channel)).toBeNull();
 expect((await archiveManagedRoom(env.DB,org,channel,{actorId:'reader',archived:false,version:1})).status).toBe(409);
 expect(await archiveManagedRoom(env.DB,org,channel,{actorId:'reader',archived:false,version:2})).toMatchObject({archived:false,version:3});
 expect((await roomRoleState(env.DB,org,channel)).members.find(m=>m.id==='creator').role).toBe('admin');
});

test('workspace admin can archive a private room without joining and cannot restore a deleted room',async()=>{
 await initializeRoomRoles(env.DB,org,channel,'creator');
 expect((await archiveManagedRoom(env.DB,org,channel,{actorId:'outsider',archived:true})).archived).toBe(true);
 expect((await roomRoleState(env.DB,org,channel,{includeArchived:true})).members.some(m=>m.id==='outsider')).toBe(false);
 await deleteManagedRoom(env.DB,org,channel,{actorId:'outsider',version:2});
 expect((await archiveManagedRoom(env.DB,org,channel,{actorId:'outsider',archived:false})).status).toBe(404);
 expect(await env.DB.prepare("SELECT archived_at FROM businesses WHERE org_id=?1").bind(org).first('archived_at')).toBeTruthy();
});

test('archive HTTP route rejects a public reader and permits a joined member to restore',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {createSession}=await import('../src/db.js');
 await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
 await env.DB.prepare("UPDATE memberships SET role='member' WHERE org_id=?1 AND user_github_id='outsider'").bind(org).run();
 await initializeRoomRoles(env.DB,org,channel,'creator');
 const pending=[];
 const call=async(actor,path,body)=>worker.fetch(new Request('https://example.com'+path,{method:'POST',headers:{'content-type':'application/json','x-session-token':await createSession(env.DB,actor,'test')},body:JSON.stringify({orgId:org,...body})}),env,{waitUntil:p=>pending.push(p)});
 expect((await call('outsider','/businesses/archive',{slugs:['planning']})).status).toBe(403);
 expect((await call('reader','/businesses/archive',{slugs:['planning']})).status).toBe(200);
 expect((await call('reader','/businesses/unarchive',{slug:'planning'})).status).toBe(200);
 expect((await roomRoleState(env.DB,org,channel)).version).toBe(3);
 await Promise.all(pending);
});


test('interactive renaming requires room membership, preserves archived state and increments the policy version',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {createSession,renameBusiness}=await import('../src/db.js');
 await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
 await initializeRoomRoles(env.DB,org,channel,'creator');
 const pending=[];
 const call=async(actor,name)=>worker.fetch(new Request('https://example.com/businesses',{method:'PUT',headers:{'content-type':'application/json','x-session-token':await createSession(env.DB,actor,'test')},body:JSON.stringify({orgId:org,slug:'planning',name})}),env,{waitUntil:p=>pending.push(p)});
 expect((await call('outsider','Unauthorized')).status).toBe(403);
 // The legacy guest guard rejects before the managed mutation.
 expect((await call('guest','Unauthorized')).status).toBe(400);
 expect((await roomRoleState(env.DB,org,channel)).version).toBe(1);
 await archiveManagedRoom(env.DB,org,channel,{actorId:'reader',archived:true});
 expect((await call('reader','Renamed planning')).status).toBe(200);
 const room=await env.DB.prepare("SELECT name,archived_at FROM businesses WHERE org_id=?1").bind(org).first();
 expect(room.name).toBe('Renamed planning');expect(room.archived_at).toBeTruthy();
 expect((await roomRoleState(env.DB,org,channel,{includeArchived:true})).version).toBe(3);
 expect(await renameBusiness(env.DB,org,'planning','Legacy bypass')).toBeNull();
 await Promise.all(pending);
});


test('only a current room admin can change visibility while preserving explicit members and roles',async()=>{
 const {accessFor,mayRead}=await import('../src/access.js');
 await initializeRoomRoles(env.DB,org,channel,'creator');
 const changePrivacy=(actorId,privateRoom,version)=>setRoomPrivacy(env.DB,org,channel,{actorId,private:privateRoom,version});
 expect((await changePrivacy('outsider',false,1)).status).toBe(403);
 expect((await changePrivacy('reader',false,1)).status).toBe(403);
 expect(await changePrivacy('creator',false,1)).toEqual({private:false,version:2});
 expect(mayRead(channel,await accessFor(env.DB,org,'outsider'))).toBe(true);
 expect((await changePrivacy('creator',true,1)).status).toBe(409);
 expect(await changePrivacy('creator',true,2)).toEqual({private:true,version:3});
 expect(mayRead(channel,await accessFor(env.DB,org,'outsider'))).toBe(false);
 const state=await roomRoleState(env.DB,org,channel);
 expect(state.members.find(m=>m.id==='creator').role).toBe('admin');
 expect(state.members.find(m=>m.id==='reader').role).toBe('member');
 expect(state.members.find(m=>m.id==='guest').role).toBe('member');
});

test('visibility cannot change after the authorizing admin leaves and rejoins',async()=>{
 await initializeRoomRoles(env.DB,org,channel,'creator');
 const raced={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
  await env.DB.prepare("UPDATE conversation_members SET added_at='new creator join' WHERE org_id=?1 AND login='creator'").bind(org).run();
  return env.DB.batch(statements);
 }};
 expect((await setRoomPrivacy(raced,org,channel,{actorId:'creator',private:false,version:1})).status).toBe(409);
 const state=await roomRoleState(env.DB,org,channel);
 expect(state.private).toBe(true);expect(state.version).toBe(1);
});

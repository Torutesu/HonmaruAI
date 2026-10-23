import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import worker from '../src/index.js';
import {upsertUser,upsertMembership,listBusinesses,createSession} from '../src/db.js';
import {createManagedRoom} from '../src/harness/roomCreation.js';
import {managedRoomSettings,saveManagedRoomSettings} from '../src/harness/roomSettings.js';
import {saveRoomResponses,roomResponses} from '../src/harness/roomResponses.js';
import {archiveManagedRoom} from '../src/harness/roomRoles.js';
const org='room-settings';
const draft={requestId:'settings-creation-key',name:'Original',private:true,guidelines:'',color:'teal',memberRefs:[],agentIds:[]};
let channel,creator,outsider,guest;
beforeEach(async()=>{
 for(const [id,role] of [['creator','member'],['outsider','admin'],['guest','guest']]){
  await upsertUser(env.DB,{githubId:id,login:id,name:id,locale:'en'});
  await upsertMembership(env.DB,org,id,role);
 }
 creator=await createSession(env.DB,'creator','test');outsider=await createSession(env.DB,'outsider','test');guest=await createSession(env.DB,'guest','test');
 channel=(await createManagedRoom(env.DB,org,'creator',draft)).room.channel;
});
const read=()=>managedRoomSettings(env.DB,org,channel,'creator');
const input=async(overrides={})=>({...((await read()).settings),name:'Renamed',color:'lake',mentionedOnly:true,...overrides});
const call=(method,token,data,view=channel)=>worker.fetch(new Request('https://test/hx/rooms/settings'+(method==='GET'?`?orgId=${org}&channel=${encodeURIComponent(view)}`:''),{method,headers:{'x-session-token':token,'content-type':'application/json'},...(data?{body:JSON.stringify({orgId:org,channel:view,...data})}:{})}),env);
test('saves the name, appearance and response policy together without changing creation receipts',async()=>{
 const before=await env.DB.prepare('SELECT * FROM hx_room_creations WHERE org_id=?1').bind(org).first();
 expect((await read()).settings).toEqual({name:'Original',color:'teal',mentionedOnly:false,version:1,responseVersion:0});
 const saved=await saveManagedRoomSettings(env.DB,org,channel,'creator',await input());
 expect(saved.settings).toEqual({name:'Renamed',color:'lake',mentionedOnly:true,version:2,responseVersion:1});
 expect((await listBusinesses(env.DB,org,{viewer:'creator'}))[0]).toMatchObject({name:'Renamed',color:'lake'});
 expect(await roomResponses(env.DB,org,channel)).toEqual({mentionedOnly:true,version:1});
 expect(await env.DB.prepare('SELECT * FROM hx_room_creations WHERE org_id=?1').bind(org).first()).toEqual(before);
 expect(await createManagedRoom(env.DB,org,'creator',draft)).toMatchObject({created:false,room:{name:'Renamed',color:'lake'}});
});
test('stale rename or response forms cannot overwrite any field',async()=>{
 const stale=await input();
 await archiveManagedRoom(env.DB,org,channel,{actorId:'creator',archived:false,name:'Other tab'});
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',stale)).status).toBe(409);
 expect((await read()).settings).toMatchObject({name:'Other tab',color:'teal',mentionedOnly:false});
 const staleResponse=await input();
 expect(await saveRoomResponses(env.DB,org,channel,{mentionedOnly:true,version:0},'creator')).toMatchObject({responses:{version:1}});
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',staleResponse)).status).toBe(409);
 expect((await read()).settings).toMatchObject({name:'Other tab',color:'teal',mentionedOnly:true});
});
test('public visibility and workspace administration do not grant room editing',async()=>{
 await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=?1").bind(org).run();
 expect((await managedRoomSettings(env.DB,org,channel,'outsider')).canEdit).toBe(false);
 expect((await saveManagedRoomSettings(env.DB,org,channel,'outsider',await input())).status).toBe(403);
 expect((await saveRoomResponses(env.DB,org,channel,{mentionedOnly:true,version:0},'outsider')).status).toBe(403);
});
test('response capability can be denied independently of ordinary room editing',async()=>{
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',await input(),{canChangeResponses:false})).status).toBe(403);
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',await input({mentionedOnly:false}),{canChangeResponses:false})).settings).toMatchObject({name:'Renamed',color:'lake',mentionedOnly:false});
});
test('a departure/rejoin between reading and commit rejects every edit',async()=>{
 const data=await input();
 const raced={prepare:s=>env.DB.prepare(s),batch:async statements=>{
  await env.DB.prepare("UPDATE conversation_members SET added_at='rejoined' WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org,channel).run();
  return env.DB.batch(statements);
 }};
 expect((await saveManagedRoomSettings(raced,org,channel,'creator',data)).status).toBe(409);
 expect((await read()).settings).toMatchObject({name:'Original',color:'teal',mentionedOnly:false,version:1,responseVersion:0});
});
test('a simultaneous legacy response write loses no settings and causes a conflict',async()=>{
 const data=await input();
 const raced={prepare:s=>env.DB.prepare(s),batch:async statements=>{
  await env.DB.prepare("INSERT INTO hx_room_responses(org_id,channel,mentioned_only,version,updated_by,updated_at) VALUES (?1,?2,1,1,'creator','now')").bind(org,channel).run();
  return env.DB.batch(statements);
 }};
 expect((await saveManagedRoomSettings(raced,org,channel,'creator',data)).status).toBe(409);
 expect((await read()).settings).toMatchObject({name:'Original',color:'teal',mentionedOnly:true,version:1,responseVersion:1});
});
test('a transaction failure rolls back the name, appearance and response policy',async()=>{
 const broken={prepare:s=>env.DB.prepare(s),batch:statements=>env.DB.batch([...statements,env.DB.prepare('INSERT INTO missing_room_settings_table VALUES (1)')])};
 await expect(saveManagedRoomSettings(broken,org,channel,'creator',await input())).rejects.toThrow();
 expect((await read()).settings).toMatchObject({name:'Original',color:'teal',mentionedOnly:false,version:1,responseVersion:0});
});
test.each([{name:''},{name:'a'.repeat(121)},{color:'unknown'},{mentionedOnly:'true'},{version:0},{responseVersion:-1}])('rejects invalid settings %j',async overrides=>{
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',await input(overrides))).status).toBe(400);
});
test('HTTP routes enforce room access and return only the public settings contract',async()=>{
 expect((await call('GET',outsider)).status).toBe(404);
 expect((await call('PUT',outsider,await input())).status).toBe(404);
 expect((await call('GET',guest)).status).toBe(403);
 const initial=await (await call('GET',creator)).json();
 expect(initial.canEdit).toBe(true);expect(initial.canChangeResponses).toBe(true);expect(initial.actor).toBeUndefined();
 expect((await call('PUT',creator,await input())).status).toBe(200);
 expect((await (await call('GET',creator)).json()).settings).toMatchObject({name:'Renamed',color:'lake',mentionedOnly:true});
 expect((await call('GET',creator,undefined,'b:missing')).status).toBe(404);
});
test('archived rooms cannot be edited through either response endpoint',async()=>{
 const data=await input();
 await archiveManagedRoom(env.DB,org,channel,{actorId:'creator',archived:true});
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',data)).status).toBe(404);
 expect((await saveRoomResponses(env.DB,org,channel,{mentionedOnly:true,version:0},'creator')).status).toBe(404);
});

test('concurrent editors commit one complete version, never a mixture of fields',async()=>{
 const first=await input(),second={...first,name:'Second edit',color:'pink',mentionedOnly:false};
 const results=await Promise.all([saveManagedRoomSettings(env.DB,org,channel,'creator',first),saveManagedRoomSettings(env.DB,org,channel,'creator',second)]);
 expect(results.filter(r=>r.settings)).toHaveLength(1);expect(results.filter(r=>r.status===409)).toHaveLength(1);
 expect((await read()).settings).toEqual(results.find(r=>r.settings).settings);
});
test('guest downgrade during save prevents all settings writes',async()=>{
 const data=await input();const raced={prepare:s=>env.DB.prepare(s),batch:async statements=>{
  await env.DB.prepare("UPDATE memberships SET role='guest' WHERE org_id=?1 AND user_github_id='creator'").bind(org).run();return env.DB.batch(statements);
 }};
 expect((await saveManagedRoomSettings(raced,org,channel,'creator',data)).status).toBe(409);
 expect((await read()).settings).toMatchObject({name:'Original',color:'teal',mentionedOnly:false,version:1});
});

test.each(['Guest','GUEST'])('mixed-case %s membership cannot edit or archive a managed room',async role=>{
 const data=await input();
 await env.DB.prepare('UPDATE memberships SET role=?2 WHERE org_id=?1 AND user_github_id=\'creator\'').bind(org,role).run();
 expect((await read()).canEdit).toBe(false);
 expect((await saveManagedRoomSettings(env.DB,org,channel,'creator',data)).status).toBe(403);
 expect((await saveRoomResponses(env.DB,org,channel,{mentionedOnly:true,version:0},'creator')).status).toBe(403);
 expect((await archiveManagedRoom(env.DB,org,channel,{actorId:'creator',archived:true})).status).toBe(403);
 expect((await read()).settings).toMatchObject({name:'Original',mentionedOnly:false,version:1});
});

test('a guest demotion immediately before the settings transaction blocks every field change',async()=>{
 const data=await input();
 const raced={prepare:s=>env.DB.prepare(s),batch:async statements=>{
  await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1 AND user_github_id='creator'").bind(org).run();
  return env.DB.batch(statements);
 }};
 expect((await saveManagedRoomSettings(raced,org,channel,'creator',data)).status).toBe(409);
 expect((await read()).settings).toMatchObject({name:'Original',color:'teal',mentionedOnly:false,version:1,responseVersion:0});
});

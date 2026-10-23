import worker from '../src/index.js';
import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import {upsertUser,upsertMembership,createSession} from '../src/db.js';
import {createManagedRoom} from '../src/harness/roomCreation.js';
import {roomVisualState,setRoomVisual} from '../src/harness/roomVisuals.js';
const org='room-visuals',key='room-visual-11111111-1111-1111-1111-111111111111';
let channel;
beforeEach(async()=>{
 for(const [id,role] of [['creator','member'],['outsider','admin']]){
  await upsertUser(env.DB,{githubId:id,login:id,name:id,locale:'en'});
  await upsertMembership(env.DB,org,id,role);
 }
 channel=(await createManagedRoom(env.DB,org,'creator',{requestId:'visual-room-request',name:'Visual',private:true,guidelines:'',color:'teal',memberRefs:[],agentIds:[]})).room.channel;
});
const save=(version,extra={})=>setRoomVisual(env.DB,org,channel,'creator',{version,objectKey:key,contentType:'image/png',...extra});
test('replaces and removes visual metadata with room version concurrency',async()=>{
 expect(await save(1)).toMatchObject({version:2,previous:null,objectKey:key});
 expect((await save(1,{objectKey:null})).status).toBe(409);
 expect((await roomVisualState(env.DB,org,channel,'creator')).visual.object_key).toBe(key);
 expect(await save(2,{objectKey:null})).toMatchObject({version:3,previous:key,objectKey:null});
 expect((await roomVisualState(env.DB,org,channel,'creator')).visual).toBeNull();
});
test('workspace admin without room membership cannot inspect or replace a private visual',async()=>{
 await save(1);
 expect((await roomVisualState(env.DB,org,channel,'outsider')).status).toBe(403);
 expect((await setRoomVisual(env.DB,org,channel,'outsider',{version:2,objectKey:null})).status).toBe(403);
 expect((await roomVisualState(env.DB,'another-org',channel,'creator')).status).toBe(404);
});
test('rejects arbitrary object keys and active image content types',async()=>{
 expect((await save(1,{objectKey:'https://example.com/private.png'})).status).toBe(400);
 expect((await save(1,{contentType:'image/svg+xml'})).status).toBe(400);
 expect((await roomVisualState(env.DB,org,channel,'creator')).version).toBe(1);
});
test('a departure and rejoin during upload cannot commit with a stale membership',async()=>{
 const raced={prepare:s=>env.DB.prepare(s),batch:async statements=>{
  await env.DB.prepare("UPDATE conversation_members SET added_at='new-membership' WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org,channel).run();
  return env.DB.batch(statements);
 }};
 expect((await setRoomVisual(raced,org,channel,'creator',{version:1,objectKey:key,contentType:'image/png'})).status).toBe(409);
 expect((await roomVisualState(env.DB,org,channel,'creator')).visual).toBeNull();
});
test('an archived room rejects visual changes',async()=>{
 await env.DB.prepare("UPDATE businesses SET archived_at='now' WHERE org_id=?1").bind(org).run();
 expect((await save(1)).status).toBe(404);
});

const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
const call=(method,token,version=1,bytes=png,type='image/png',runtime=env)=>worker.fetch(new Request(`https://test/hx/rooms/visual?orgId=${org}&channel=${encodeURIComponent(channel)}&version=${version}`,{method,headers:{'x-session-token':token,'content-type':type},...(method==='POST'?{body:bytes}:{})}),runtime);
test('authenticated image roundtrip does not expose a public object address',async()=>{
 const token=await createSession(env.DB,'creator','test'),outside=await createSession(env.DB,'outsider','test');
 const saved=await call('POST',token);expect(saved.status).toBe(200);
 expect(await saved.json()).toEqual({version:2,hasVisual:true});
 const image=await call('GET',token);expect(image.status).toBe(200);
 expect(image.headers.get('cache-control')).toBe('private, no-store');
 expect(image.headers.get('x-content-type-options')).toBe('nosniff');
 expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
 expect((await call('GET',outside)).status).toBe(404);
 expect((await call('GET','invalid')).status).toBe(401);
 const stored=(await roomVisualState(env.DB,org,channel,'creator')).visual.object_key;
 expect((await worker.fetch(new Request(`https://test/media/${stored}`),env)).status).toBe(404);
 expect((await call('DELETE',token,1)).status).toBe(409);
 expect((await call('DELETE',token,2)).status).toBe(200);
 expect(await env.MEDIA.get(stored)).toBeNull();expect((await call('GET',token)).status).toBe(404);
});
test('image type spoofing is rejected before storing an object',async()=>{
 const token=await createSession(env.DB,'creator','test');
 expect((await call('POST',token,1,new TextEncoder().encode('<svg/>'))).status).toBe(415);
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
test('revoking membership during object retrieval prevents image delivery',async()=>{
 const token=await createSession(env.DB,'creator','test');await call('POST',token);
 const runtime={...env,MEDIA:{get:async key=>{
  const object=await env.MEDIA.get(key);
  await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org,channel).run();
  return object;
 }}};
 expect((await call('GET',token,2,png,'image/png',runtime)).status).toBe(409);
});

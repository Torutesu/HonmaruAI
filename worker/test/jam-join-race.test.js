import {env} from 'cloudflare:test';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import schemaSql from '../schema.sql?raw';
import {upsertMembership,upsertUser,removeBusiness} from '../src/db.js';
import {handleJamMessage,jamPeers,invalidateJamJoins} from '../src/jam.js';

const org='jam-join-fence',channel='b:board';
let createdAt;
beforeEach(async()=>{
  await env.DB.exec(schemaSql.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'4101',login:'alice',name:'Alice',locale:'en'});
  await upsertMembership(env.DB,org,'4101','member');
  createdAt=new Date().toISOString();
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES (?,'board','Board','4101',?,1)").bind(org,createdAt).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,'b:board','alice',?)").bind(org,createdAt).run();
});
afterEach(()=>vi.unstubAllGlobals());

function fixture({onPut,turn=false}={}) {
  const events=[],entries=new Map();
  let attachment={orgId:org,userId:'alice',githubId:'4101'};
  const ws={send:value=>events.push(JSON.parse(value)),serializeAttachment:value=>{attachment=structuredClone(value);},deserializeAttachment:()=>structuredClone(attachment)};
  const storage={
    get:async key=>entries.has(key)?structuredClone(entries.get(key)):undefined,
    put:async(key,value)=>{entries.set(key,structuredClone(value));if(onPut)await onPut();},
    delete:async key=>entries.delete(key),
    transaction:async fn=>fn(storage),
  };
  const relay={db:env.DB,env:turn?{...env,CF_TURN_KEY_ID:'fixture',CF_TURN_API_TOKEN:'fixture'}:env,
    state:{storage,getWebSockets:()=>[ws],waitUntil:()=>{}},broadcast:()=>{},sendTo:()=>{}};
  return {relay,ws,events,entries};
}
const remove=()=>removeBusiness(env.DB,org,'board',{actorId:'4101',createdAt,wasPrivate:true});

test.each(['deleted','removed','made-public','replaced'])('%s before attachment cannot revive a stale Jam join',async change=>{
  let changed=false;
  const f=fixture({onPut:async()=>{if(!changed){
    changed=true;
    if(change==='deleted')expect(await remove()).toBeTruthy();
    if(change==='removed')await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login='alice'").bind(org,channel).run();
    if(change==='made-public')await env.DB.prepare("UPDATE businesses SET private=0 WHERE org_id=? AND slug='board'").bind(org).run();
    if(change==='replaced')await env.DB.prepare("UPDATE businesses SET created_at='replacement-generation' WHERE org_id=? AND slug='board'").bind(org).run();
  }}});
  await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  expect(f.ws.deserializeAttachment().jam).toBeNull();
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.events.some(event=>event.name==='jam_error')).toBe(true);
  expect(f.entries.size).toBe(0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?').bind(org).first('n')).toBe(0);
});

test('an eviction before attachment invalidates an in-flight join even if access is restored',async()=>{
  let f,invalidated=false;
  f=fixture({onPut:async()=>{if(!invalidated){invalidated=true;invalidateJamJoins(f.relay,org,channel);}}});
  await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  expect(invalidated).toBe(true);
  expect(f.ws.deserializeAttachment().jam).toBeNull();
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.events.some(event=>event.name==='jam_error')).toBe(true);
  expect(f.entries.size).toBe(0);
});

test('pending joins are not peers and cannot send a late success after eviction',async()=>{
  let signalStarted,finishFetch;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  vi.stubGlobal('fetch',()=>{signalStarted();return new Promise(resolve=>{finishFetch=resolve;});});
  const f=fixture({turn:true});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await started;
  expect(f.ws.deserializeAttachment().jam.pending).toBe(true);
  expect(jamPeers([f.ws],org,channel)).toEqual([]);
  expect(await remove()).toBeTruthy();
  // The relay's room eviction ran while TURN credentials were pending.
  f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:null});
  finishFetch(new Response(JSON.stringify({iceServers:[]}),{status:200,headers:{'content-type':'application/json'}}));
  await run;
  expect(f.ws.deserializeAttachment().jam).toBeNull();
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.entries.size).toBe(0);
});

test.each(['leave','closed'])('a %s during a pending join does not resume it or leave a phantom Jam',async action=>{
  let signalStarted,finishFetch;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  vi.stubGlobal('fetch',()=>{signalStarted();return new Promise(resolve=>{finishFetch=resolve;});});
  const f=fixture({turn:true});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await started;
  if(action==='leave')await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_leave',{});
  else f.ws.readyState=3;
  finishFetch(new Response(JSON.stringify({iceServers:[]}),{status:200,headers:{'content-type':'application/json'}}));
  await run;
  expect(f.ws.deserializeAttachment().jam).toBeNull();
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.entries.size).toBe(0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?').bind(org).first('n')).toBe(0);
});

test('a socket closing while Jam metadata is saved does not leave a phantom Jam',async()=>{
  let f,original;
  f=fixture({onPut:async()=>{f.ws.readyState=3;}});
  original=f.ws.serializeAttachment;
  f.ws.serializeAttachment=value=>{if(f.ws.readyState===3)throw new Error('closed');original(value);};
  await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.entries.size).toBe(0);
});

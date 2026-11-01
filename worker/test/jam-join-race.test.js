import {env} from 'cloudflare:test';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import schemaSql from '../schema.sql?raw';
import {upsertMembership,upsertUser,removeBusiness} from '../src/db.js';
import {handleJamMessage,jamPeers,invalidateJamJoins,leaveJam} from '../src/jam.js';
import {OrgRelay} from '../src/relay.js';

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

test('one socket cannot start another room while its first join is in flight',async()=>{
  let started,finish,blocked=false;
  const entered=new Promise(resolve=>{started=resolve;});
  const f=fixture({onPut:async()=>{if(!blocked){blocked=true;started();await new Promise(resolve=>{finish=resolve;});}}});
  const first=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await entered;
  await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel:'b:general'});
  expect(f.events.filter(event=>event.name==='jam_error')).toHaveLength(1);
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  finish();await first;
  expect(f.events.filter(event=>event.name==='jam_joined')).toHaveLength(1);
  expect(f.ws.deserializeAttachment().jam.key).toBe(channel);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND channel=?').bind(org,'b:general').first('n')).toBe(0);
});

test('leave before attachment cancels an in-flight join',async()=>{
  let started,finish;
  const entered=new Promise(resolve=>{started=resolve;});
  const f=fixture({onPut:async()=>{started();await new Promise(resolve=>{finish=resolve;});}});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await entered;
  await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_leave',{});
  finish();await run;
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.entries.size).toBe(0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?').bind(org).first('n')).toBe(0);
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

test.each(['leave','closed'])('last peer %s cannot delete metadata while a join is pending',async action=>{
  let signalStarted,finishFetch;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  vi.stubGlobal('fetch',()=>{signalStarted();return new Promise(resolve=>{finishFetch=resolve;});});
  const f=fixture({turn:true});
  let otherAttachment={orgId:org,userId:'alice',githubId:'4101',jam:{key:channel,peerId:'existing-peer',since:'2026-01-01T00:00:00Z',mode:'notes'}};
  const other={deserializeAttachment:()=>structuredClone(otherAttachment),serializeAttachment:value=>{otherAttachment=structuredClone(value);}};
  let closed=false;
  f.relay.state.getWebSockets=()=>closed?[f.ws]:[f.ws,other];
  const key=`jam:${org}:${channel}`;
  f.entries.set(key,{startedAt:'2026-01-01T00:00:00Z',startedBy:'alice',mode:'notes',people:['alice'],messageId:'existing-message'});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await started;
  if(action==='closed')closed=true;
  let leaveFinished=false;
  const leave=leaveJam(f.relay,other,other.deserializeAttachment(),{closing:action==='closed'}).then(()=>{leaveFinished=true;});
  await Promise.resolve();
  expect(leaveFinished).toBe(false);
  if(action==='leave')expect(other.deserializeAttachment().jam).toBeNull();
  finishFetch(new Response(JSON.stringify({iceServers:[]}),{status:200,headers:{'content-type':'application/json'}}));
  await run;await leave;
  const joined=f.events.find(event=>event.name==='jam_joined');
  expect(joined.value.peers).toEqual([]);
  expect(f.ws.deserializeAttachment().jam.pending).toBe(false);
  expect(f.entries.get(key)).toMatchObject({messageId:'existing-message',people:['alice']});
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?').bind(org).first('n')).toBe(0);
});

test('a cancelled pending join lets the last peer end the existing Jam exactly once',async()=>{
  let signalStarted,finishFetch;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  vi.stubGlobal('fetch',()=>{signalStarted();return new Promise(resolve=>{finishFetch=resolve;});});
  const f=fixture({turn:true});
  let otherAttachment={orgId:org,userId:'alice',githubId:'4101',jam:{key:channel,peerId:'existing-peer',since:'2026-01-01T00:00:00Z',mode:'notes'}};
  const other={deserializeAttachment:()=>structuredClone(otherAttachment),serializeAttachment:value=>{otherAttachment=structuredClone(value);}};
  f.relay.state.getWebSockets=()=>[f.ws,other];
  const key=`jam:${org}:${channel}`;
  f.entries.set(key,{startedAt:'2026-01-01T00:00:00Z',startedBy:'alice',mode:'notes',people:['alice']});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await started;
  const original=other.deserializeAttachment();
  const leave=leaveJam(f.relay,other,original);
  const duplicate=leaveJam(f.relay,other,original);
  await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_leave',{});
  finishFetch(new Response(JSON.stringify({iceServers:[]}),{status:200,headers:{'content-type':'application/json'}}));
  await Promise.all([run,leave,duplicate]);
  expect(f.entries.has(key)).toBe(false);
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND body LIKE 'Jam ended%'").bind(org).first('n')).toBe(1);
});

test('room eviction detaches and notifies every peer before waiting for a pending join',async()=>{
  let signalStarted,finishFetch,allNotified;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  const notified=new Promise(resolve=>{allNotified=resolve;});
  vi.stubGlobal('fetch',()=>{signalStarted();return new Promise(resolve=>{finishFetch=resolve;});});
  const f=fixture({turn:true});
  let delivered=0;
  const peer=id=>{
    let attachment={orgId:org,userId:'alice',githubId:'4101',jam:{key:channel,peerId:id,since:'2026-01-01T00:00:00Z',mode:'notes'}};
    return {send:()=>{if(++delivered===2)allNotified();},deserializeAttachment:()=>structuredClone(attachment),serializeAttachment:value=>{attachment=structuredClone(value);}};
  };
  const one=peer('one'),two=peer('two');
  f.relay.state.getWebSockets=()=>[f.ws,one,two];
  f.entries.set(`jam:${org}:${channel}`,{startedAt:'2026-01-01T00:00:00Z',startedBy:'alice',mode:'notes',people:['alice']});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await started;
  const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channel,allInChannel:true})});
  const eviction=OrgRelay.prototype.fetch.call(f.relay,request);
  await notified;
  expect(one.deserializeAttachment().jam).toBeNull();
  expect(two.deserializeAttachment().jam).toBeNull();
  finishFetch(new Response(JSON.stringify({iceServers:[]}),{status:200,headers:{'content-type':'application/json'}}));
  await Promise.all([run,eviction]);
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
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

test.each(['reinvited','recreated'])('eviction during the initial room lookup cancels a join even if access is %s',async change=>{
  const f=fixture();
  let release,started,blocked=false;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.relay.db=new Proxy(env.DB,{get(db,key){
    if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
    return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT private, created_at FROM businesses'))return statement;
      return {bind(...args){const bound=statement.bind(...args);return {async first(){
        const row=await bound.first();
        if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}
        return row;
      }}}};
    };
  }});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await waiting;
  if(change==='reinvited'){
    await env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(org,channel,'alice').run();
    invalidateJamJoins(f.relay,org,channel);
    await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,?,?,?)').bind(org,channel,'alice',createdAt).run();
  }else{
    await env.DB.prepare("DELETE FROM businesses WHERE org_id=? AND slug='board'").bind(org).run();
    invalidateJamJoins(f.relay,org,channel);
    await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES (?,'board','Board','4101',?,1)").bind(org,createdAt).run();
  }
  release();await run;
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.ws.deserializeAttachment().jam).toBeFalsy();
  expect(f.entries.size).toBe(0);
});

test.each(['workspace','canonical-channel','session'])('%s eviction cancels a resolving join even after membership is restored',async kind=>{
  const f=fixture();
  let release,started,blocked=false;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.relay.db=new Proxy(env.DB,{get(db,key){
    if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
    return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT private, created_at FROM businesses'))return statement;
      return {bind(...args){const bound=statement.bind(...args);return {async first(){const row=await bound.first();if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}return row;}}}};
    };
  }});
  // Simulate the interval before a socket close takes effect; cancellation is
  // authoritative even if the account is added again before lookups resume.
  f.relay.refuse=()=>{};
  if(kind==='session')f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'revoked-session'});
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await waiting;
  if(kind==='workspace')await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,'4101').run();
  const body=kind==='workspace'?{login:'alice'}:kind==='session'?{sessions:['revoked-session']}:{login:'alice',channel:'dm:alice|bob'};
  await OrgRelay.prototype.fetch.call(f.relay,new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  if(kind==='workspace')await upsertMembership(env.DB,org,'4101','member');
  release();await run;
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.ws.deserializeAttachment().jam).toBeFalsy();
  expect(f.entries.size).toBe(0);
});

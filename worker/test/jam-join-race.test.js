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
  expect(f.ws.deserializeAttachment().jam).toBeFalsy();
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
  const body=kind==='workspace'?{login:'alice'}:kind==='session'?{sessions:['revoked-session']}:{login:'alice',channel};
  await OrgRelay.prototype.fetch.call(f.relay,new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  if(kind==='workspace')await upsertMembership(env.DB,org,'4101','member');
  release();await run;
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
  expect(f.ws.deserializeAttachment().jam).toBeFalsy();
  expect(f.entries.size).toBe(0);
});

test('an unexpected storage error after a provisional write cleans up without a phantom Jam',async()=>{
 let failed=false;
 const f=fixture({onPut:async()=>{if(!failed){failed=true;throw new Error('write failed after storage');}}});
 await expect(handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel})).rejects.toThrow('write failed after storage');
 expect(f.entries.size).toBe(0);
 expect(f.ws.deserializeAttachment().jam).toBeFalsy();
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
});

test('a socket can rejoin after a restarted object leaves its provisional attachment',async()=>{
 const f=fixture(),peerId='abandoned_peer',key=`jam:${org}:${channel}`;
 f.entries.set(key,{startedAt:createdAt,startedBy:'alice',mode:'notes',people:['alice'],startedAnnounced:false,pendingJoin:{peerId,login:'alice',added:true,starting:true}});
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:{key:channel,peerId,pending:true,since:createdAt,mode:'notes'}});
 await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 expect(f.events.filter(event=>event.name==='jam_joined')).toHaveLength(1);
 expect(f.ws.deserializeAttachment().jam.pending).toBe(false);
 expect(f.ws.deserializeAttachment().jam.peerId).not.toBe(peerId);
 expect(f.entries.get(key).pendingJoin).toBeUndefined();
});

test('recovering an abandoned join preserves another live Jam and its transcript',async()=>{
 const f=fixture(),key=`jam:${org}:${channel}`,peerId='abandoned_peer';
 let otherAtt={orgId:org,userId:'bob',githubId:'4102',jam:{key:channel,peerId:'active_peer',pending:false,since:createdAt,mode:'notes'}};
 const other={deserializeAttachment:()=>structuredClone(otherAtt),serializeAttachment:value=>{otherAtt=structuredClone(value)}};
 f.relay.state.getWebSockets=()=>[f.ws,other];
 f.entries.set(key,{startedAt:createdAt,startedBy:'bob',mode:'notes',people:['bob','alice'],messageId:'msg_existing',transcript:[{text:'Keep me'}],pendingJoin:{peerId,login:'alice',added:true,starting:false}});
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:{key:channel,peerId,pending:true,since:createdAt,mode:'notes'}});
 await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 expect(f.events.filter(event=>event.name==='jam_joined')).toHaveLength(1);
 expect(f.entries.get(key).messageId).toBe('msg_existing');
 expect(f.entries.get(key).transcript).toEqual([{text:'Keep me'}]);
 expect(f.entries.get(key).people).toEqual(['bob','alice']);
 expect(f.entries.get(key).pendingJoin).toBeUndefined();
});

test('a committed Jam whose start was never announced does not announce an end',async()=>{
 const f=fixture(),key=`jam:${org}:${channel}`;
 f.entries.set(key,{startedAt:createdAt,startedBy:'alice',mode:'notes',people:['alice'],startedAnnounced:false});
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:{key:channel,peerId:'committed',pending:false,since:createdAt,mode:'notes'}});
 await leaveJam(f.relay,f.ws,f.ws.deserializeAttachment());
 expect(f.entries.size).toBe(0);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?').bind(org).first('n')).toBe(0);
});

test('a new socket removes a different abandoned provisional participant while preserving live data',async()=>{
 const f=fixture(),key=`jam:${org}:${channel}`;
 let otherAtt={orgId:org,userId:'bob',githubId:'4102',jam:{key:channel,peerId:'active_peer',pending:false,since:createdAt,mode:'notes'}};
 const other={deserializeAttachment:()=>structuredClone(otherAtt),serializeAttachment:value=>{otherAtt=structuredClone(value)}};
 f.relay.state.getWebSockets=()=>[f.ws,other];
 f.entries.set(key,{startedAt:createdAt,startedBy:'bob',mode:'notes',people:['bob','carol'],messageId:'msg_existing',transcript:[{text:'Keep me'}],pendingJoin:{peerId:'lost_peer',login:'carol',added:true,starting:false}});
 await handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 expect(f.events.filter(event=>event.name==='jam_joined')).toHaveLength(1);
 expect(f.entries.get(key).people).toEqual(['bob','alice']);
 expect(f.entries.get(key).transcript).toEqual([{text:'Keep me'}]);
 expect(f.entries.get(key).pendingJoin).toBeUndefined();
});

test('a delayed session recheck cannot restore a Jam attachment after channel eviction',async()=>{
  const f=fixture(),peerId='active-peer';
  f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'existing-session',checkedAt:0,authed:true,agui:true,jam:{key:channel,peerId,pending:false,since:createdAt,mode:'notes'}});
  let started, release;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.relay.stillSignedIn=async()=>{started();await new Promise(resolve=>{release=resolve;});return {ok:true};};
  f.relay.overBudget=()=>false;
  const message=OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'jam_signal',payload:{to:'none',data:{type:'candidate'}}}));
  await waiting;
  const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel})});
  expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
  expect(f.ws.deserializeAttachment().jam).toBeNull();
  release();await message;
  expect(f.ws.deserializeAttachment().jam).toBeNull();
});

test.each([true,false])('a delayed old session check cannot change or close a reauthenticated socket (old check %s)',async ok=>{
  const f=fixture();
  f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'old-session',checkedAt:0,authed:true,agui:true,jam:{key:channel,peerId:'old-peer'}});
  let started,release,processed=false,refused=false;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.relay.stillSignedIn=async()=>{started();await new Promise(resolve=>{release=resolve;});return {ok,here:true};};
  f.relay.overBudget=()=>{processed=true;return false;};
  f.relay.refuse=()=>{refused=true;};
  const pending=OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'jam_signal',payload:{to:'nobody',data:{type:'candidate'}}}));
  await waiting;
  const replacement={...f.ws.deserializeAttachment(),session:'new-session',userId:'bob',githubId:'4102',checkedAt:100,jam:{key:'b:other',peerId:'new-peer'}};
  f.ws.serializeAttachment(replacement);
  release();await pending;
  expect(f.ws.deserializeAttachment()).toEqual(replacement);
  expect(processed).toBe(false);
  expect(refused).toBe(false);
});

test('a delayed session check preserves current unrelated socket state',async()=>{
  const f=fixture();
  f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'old-session',checkedAt:0,authed:true,agui:true,jam:null});
  let started,release;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.relay.stillSignedIn=async()=>{started();await new Promise(resolve=>{release=resolve;});return {ok:true};};
  f.relay.overBudget=()=>false;
  const pending=OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'jam_signal',payload:{to:'nobody',data:{type:'candidate'}}}));
  await waiting;
  const other={...f.ws.deserializeAttachment(),activityAt:1234,guest:true,jam:{key:'b:other',peerId:'new-peer'}};
  f.ws.serializeAttachment(other);
  release();await pending;
  expect(f.ws.deserializeAttachment()).toMatchObject({activityAt:1234,guest:true,jam:{key:'b:other',peerId:'new-peer'}});
});

test('a reaction still loading members is not broadcast after its sender is evicted',async()=>{
 await upsertUser(env.DB,{githubId:'4102',login:'bob',name:'Bob'});
 await upsertMembership(env.DB,org,'4102','member');
 await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,?,?,?)').bind(org,channel,'bob',createdAt).run();
 const f=fixture();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:{key:channel,peerId:'peer-alice',pending:false,since:createdAt,mode:'notes'}});
 let release,started,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.db=new Proxy(env.DB,{get(db,key){
   if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
   return sql=>{const statement=db.prepare(sql);if(!sql.includes('SELECT m.user_github_id'))return statement;
     return {bind(...args){const bound=statement.bind(...args);return {async all(){
       const rows=await bound.all();
       if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}
       return rows;
     }}}};
   };
 }});
 const sent=[];f.relay.sendTo=(...args)=>sent.push(args);
 const pending=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_react',{emoji:'👍'});
 await waiting;
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login='alice'").bind(org,channel).run();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:null});
 release();await pending;
 expect(sent.some(([,recipient,event])=>recipient==='bob'&&event.name==='jam_reaction')).toBe(false);
});

test.each(['jam_react','jam_transcript'])('%s is not broadcast after eviction during audience lookup',async type=>{
 await upsertUser(env.DB,{githubId:'4102',login:'bob',name:'Bob'});
 await upsertMembership(env.DB,org,'4102','member');
 await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,?,?,?)').bind(org,channel,'bob',createdAt).run();
 const f=fixture();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:{key:channel,peerId:'peer-alice',pending:false,since:createdAt,mode:'notes'}});
 let release,started,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.db=new Proxy(env.DB,{get(db,key){
   if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
   return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT login FROM conversation_members WHERE'))return statement;
     return {bind(...args){const bound=statement.bind(...args);return {async all(){
       const rows=await bound.all();
       if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}
       return rows;
     }}}};
   };
 }});
 const sent=[];f.relay.sendTo=(...args)=>sent.push(args);
 const payload=type==='jam_react'?{emoji:'👍'}:{text:'hello',final:false};
 const pending=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),type,payload);
 await waiting;
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login='alice'").bind(org,channel).run();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:null});
 release();await pending;
 expect(sent.some(([,recipient,event])=>recipient==='bob'&&(event.name==='jam_reaction'||event.name==='jam_transcript'))).toBe(false);
});

test('a final transcript is not stored after eviction during storage lookup',async()=>{
 const f=fixture(),key=`jam:${org}:${channel}`;
 f.entries.set(key,{startedAt:createdAt,startedBy:'alice',mode:'notes',people:['alice'],transcript:[]});
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:{key:channel,peerId:'peer-alice',pending:false,since:createdAt,mode:'notes'}});
 let release,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 const get=f.relay.state.storage.get;
 f.relay.state.storage.get=async k=>{const value=await get(k);started();await new Promise(resolve=>{release=resolve;});return value;};
 const pending=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_transcript',{text:'after eviction',final:true});
 await waiting;
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),jam:null});
 release();await pending;
 expect(f.entries.get(key).transcript).toEqual([]);
});

test.each(['room','membership','session'])('%s eviction notifies a still-resolving Jam before its lookup returns',async kind=>{
  const f=fixture();
  f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'active-session'});
  let release,started,blocked=false;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.relay.db=new Proxy(env.DB,{get(db,key){
    if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
    return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT private, created_at FROM businesses'))return statement;
      return {bind(...args){const bound=statement.bind(...args);return {async first(){
        const row=await bound.first();if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}return row;
      }}}};
    };
  }});
  f.relay.refuse=()=>{};
  const run=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
  await waiting;
  const body=kind==='room'?{allInChannel:true,channel}:kind==='membership'?{login:'alice',channel}:{sessions:['active-session']};
  await OrgRelay.prototype.fetch.call(f.relay,new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  expect(f.events.some(event=>event.name==='jam_error'&&event.value.channel===channel)).toBe(true);
  release();await run;
  expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
});

test('evicting one member does not cancel a different member joining the same Jam',async()=>{
 let started,finish,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 const f=fixture({onPut:async()=>{if(!blocked){blocked=true;started();await new Promise(resolve=>{finish=resolve;});}}});
 const join=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 await waiting;
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'bob',channel})});
 expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
 expect(f.events.some(event=>event.name==='jam_error')).toBe(false);
 finish();await join;
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(true);
});

test('evicting the same member from a different room does not cancel their current join',async()=>{
 let started,finish,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 const f=fixture({onPut:async()=>{if(!blocked){blocked=true;started();await new Promise(resolve=>{finish=resolve;});}}});
 const join=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 await waiting;
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel:'b:other'})});
 expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
 expect(f.events.some(event=>event.name==='jam_error')).toBe(false);
 finish();await join;
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(true);
});

test('canonical DM eviction cancels and notifies a join still resolving its display alias',async()=>{
 await upsertUser(env.DB,{githubId:'4102',login:'bob',name:'Bob'});
 await upsertMembership(env.DB,org,'4102','member');
 const {memberRef}=await import('../src/team.js');
 const view=`dm:${await memberRef(org,'4102')}`;
 const f=fixture();
 let release,started,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.db=new Proxy(env.DB,{get(db,key){
   if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
   return sql=>{const statement=db.prepare(sql);if(!sql.includes('SELECT m.user_github_id'))return statement;
     return {bind(...args){const bound=statement.bind(...args);return {async all(){
       const rows=await bound.all();if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}return rows;
     }}}};
   };
 }});
 const join=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel:view});
 await waiting;
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel:'dm:alice|bob'})});
 expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
 expect(f.events.some(event=>event.name==='jam_error'&&event.value.channel===view)).toBe(true);
 release();await join;
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
});

test('eviction after commit but before joined response sends one error and no stale success',async()=>{
 const f=fixture();
 let release,started,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 const transaction=f.relay.state.storage.transaction;
 f.relay.state.storage.transaction=async fn=>{
   if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}
   return transaction(fn);
 };
 const join=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 await waiting;
 expect(f.ws.deserializeAttachment().jam.pending).toBe(false);
 let sawError;
 const errorSent=new Promise(resolve=>{sawError=resolve;});
 const send=f.ws.send;
 f.ws.send=value=>{send(value);if(JSON.parse(value).name==='jam_error')sawError();};
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel})});
 const eviction=OrgRelay.prototype.fetch.call(f.relay,request);
 await errorSent;
 expect(f.events.filter(event=>event.name==='jam_error')).toHaveLength(1);
 release();await Promise.all([join,eviction]);
 expect(f.events.filter(event=>event.name==='jam_error')).toHaveLength(1);
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
 expect(f.ws.deserializeAttachment().jam).toBeNull();
});

test.each(['room','member'])('%s eviction sends one error to a provisionally attached join',async kind=>{
 let signalStarted,finishFetch;
 const waiting=new Promise(resolve=>{signalStarted=resolve;});
 vi.stubGlobal('fetch',()=>{signalStarted();return new Promise(resolve=>{finishFetch=resolve;});});
 const f=fixture({turn:true});
 const join=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 await waiting;
 expect(f.ws.deserializeAttachment().jam.pending).toBe(true);
 const body=kind==='room'?{allInChannel:true,channel}:{login:'alice',channel};
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
 expect(f.events.filter(event=>event.name==='jam_error')).toHaveLength(1);
 finishFetch(new Response(JSON.stringify({iceServers:[]}),{status:200,headers:{'content-type':'application/json'}}));
 await join;
 expect(f.events.filter(event=>event.name==='jam_error')).toHaveLength(1);
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(false);
});

test('a revoked newly joined peer is not announced after a slow audience lookup',async()=>{
 await upsertUser(env.DB,{githubId:'4102',login:'bob',name:'Bob'});
 await upsertMembership(env.DB,org,'4102','member');
 await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?,?,?,?)').bind(org,channel,'bob',createdAt).run();
 const f=fixture(),sent=[];
 f.relay.sendTo=(...args)=>sent.push(args);
 let release,started,count=0;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.db=new Proxy(env.DB,{get(db,key){
   if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
   return sql=>{const statement=db.prepare(sql);if(!sql.includes('ORDER BY added_at, login'))return statement;
     return {bind(...args){const bound=statement.bind(...args);return {async all(){
       const rows=await bound.all();if(++count===3){started();await new Promise(resolve=>{release=resolve;});}return rows;
     }}}};
   };
 }});
 const join=handleJamMessage(f.relay,f.ws,f.ws.deserializeAttachment(),'jam_join',{channel});
 await waiting;
 expect(f.events.some(event=>event.name==='jam_joined')).toBe(true);
 let notified;
 const errorSent=new Promise(resolve=>{notified=resolve;});
 const send=f.ws.send;f.ws.send=value=>{send(value);if(JSON.parse(value).name==='jam_error')notified();};
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel})});
 const eviction=OrgRelay.prototype.fetch.call(f.relay,request);
 await errorSent;
 release();await Promise.all([join,eviction]);
 expect(sent.some(([,recipient,event])=>recipient==='bob'&&event.name==='jam_state'&&event.value.active)).toBe(false);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?').bind(org).first('n')).toBe(0);
});

test('a delayed alarm session recheck cannot restore a Jam after eviction',async()=>{
 const f=fixture();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'session',checkedAt:0,authed:true,agui:true,jam:{key:channel,peerId:'peer',pending:false,since:createdAt,mode:'notes'}});
 f.relay.state.storage.setAlarm=async()=>{};
 let release,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.stillSignedIn=async()=>{started();await new Promise(resolve=>{release=resolve;});return {ok:true};};
 const alarm=OrgRelay.prototype.alarm.call(f.relay);
 await waiting;
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel})});
 expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
 expect(f.ws.deserializeAttachment().jam).toBeNull();
 release();await alarm;
 expect(f.ws.deserializeAttachment().jam).toBeNull();
});

test.each([true,false])('an old alarm lookup cannot modify a reauthenticated socket (old result %s)',async ok=>{
 const f=fixture();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'old-session',checkedAt:0,authed:true,agui:true,jam:{key:channel,peerId:'old-peer'}});
 let release,started,refused=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 const alarms=[];f.relay.state.storage.setAlarm=async at=>{alarms.push(at);};
 f.relay.stillSignedIn=async()=>{started();await new Promise(resolve=>{release=resolve;});return {ok,here:true};};
 f.relay.refuse=()=>{refused=true;};
 const alarm=OrgRelay.prototype.alarm.call(f.relay);
 await waiting;
 const next={...f.ws.deserializeAttachment(),session:'new-session',userId:'bob',githubId:'4102',checkedAt:100,jam:{key:'b:other',peerId:'new-peer'}};
 f.ws.serializeAttachment(next);
 release();await alarm;
 expect(f.ws.deserializeAttachment()).toEqual(next);
 expect(refused).toBe(false);
 expect(alarms.length).toBe(1);
});

test('reauthentication in flight cannot restore a Jam removed during session lookup',async()=>{
 const {createSession}=await import('../src/db.js');
 const token=await createSession(env.DB,'4101','existing-provider-token');
 const f=fixture();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'old-session',checkedAt:Date.now(),authed:true,agui:true,joins:0,jam:{key:channel,peerId:'peer',pending:false,since:createdAt,mode:'notes'}});
 let release,started,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.db=new Proxy(env.DB,{get(db,key){
   if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
   return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT token, github_id, github_access_token, created_at, expires_at, last_seen_at, client, reauth_at'))return statement;
     return {bind(...args){const bound=statement.bind(...args);return {async first(){
       const row=await bound.first();if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}return row;
     }}}};
   };
 }});
 f.relay.wakeBy=async()=>{};
 f.relay.overBudget=()=>false;
 const join=OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'join',payload:{sessionToken:token,protocol:'agui/1'}}));
 await waiting;
 const request=new Request(`https://relay.internal/internal/evict?orgId=${org}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'alice',channel})});
 expect((await OrgRelay.prototype.fetch.call(f.relay,request)).status).toBe(200);
 expect(f.ws.deserializeAttachment().jam).toBeNull();
 release();await join;
 expect(f.ws.deserializeAttachment().jam).toBeNull();
});

test('a reauthentication cannot transfer an active Jam to another user',async()=>{
 await upsertUser(env.DB,{githubId:'4102',login:'bob',name:'Bob'});
 await upsertMembership(env.DB,org,'4102','member');
 const {createSession}=await import('../src/db.js');
 const token=await createSession(env.DB,'4102','provider-bob');
 const f=fixture();
 f.ws.readyState=1;f.ws.close=()=>{f.ws.readyState=3;};
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'old-session',checkedAt:Date.now(),authed:true,agui:true,joins:0,jam:{key:channel,peerId:'peer',pending:false,since:createdAt,mode:'notes'}});
 f.relay.wakeBy=async()=>{};f.relay.overBudget=()=>false;f.relay.refuse=OrgRelay.prototype.refuse.bind(f.relay);
 await OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'join',payload:{sessionToken:token,protocol:'agui/1'}}));
 expect(f.ws.readyState).toBe(3);
 expect(f.ws.deserializeAttachment().authed).toBe(false);
 expect(f.ws.deserializeAttachment().userId).toBe('alice');
});

test('the most recent concurrent WebSocket reauthentication wins',async()=>{
 const {createSession}=await import('../src/db.js');
 const first=await createSession(env.DB,'4101','provider-first');
 const second=await createSession(env.DB,'4101','provider-second');
 const f=fixture();
 f.ws.serializeAttachment({...f.ws.deserializeAttachment(),session:'old-session',checkedAt:Date.now(),authed:true,agui:true,joins:0,jam:null});
 let release,started,blocked=false;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.relay.db=new Proxy(env.DB,{get(db,key){
   if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
   return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT token, github_id, github_access_token, created_at, expires_at, last_seen_at, client, reauth_at'))return statement;
     return {bind(...args){const bound=statement.bind(...args);return {async first(){
       const row=await bound.first();if(!blocked){blocked=true;started();await new Promise(resolve=>{release=resolve;});}return row;
     }}}};
   };
 }});
 f.relay.wakeBy=async()=>{};f.relay.overBudget=()=>false;
 const a=OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'join',payload:{sessionToken:first,protocol:'agui/1'}}));
 await waiting;
 await OrgRelay.prototype.webSocketMessage.call(f.relay,f.ws,JSON.stringify({type:'join',payload:{sessionToken:second,protocol:'agui/1'}}));
 const afterNew=f.ws.deserializeAttachment();
 expect(afterNew.joins).toBe(2);
 expect(afterNew.session).not.toBe('old-session');
 release();await a;
 expect(f.ws.deserializeAttachment()).toEqual(afterNew);
});

import { drainRoomHookDispatch } from '../src/harness/roomHookDispatch.js';
import { env,runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import { upsertUser, upsertMembership, createSession } from '../src/db.js';
import worker from '../src/index.js';
import { getMessage, present } from '../src/channels.js';
import { broadcastRoomHookMessage } from '../src/harness/roomHookBroadcast.js';
import { createManagedRoom } from '../src/harness/roomCreation.js';
import { createRoomHook, listRoomHooks, changeRoomHook, authenticateRoomHook, receiveRoomHookEvent } from '../src/harness/roomHooks.js';
const org = 'room-hook-test';
let channel;
beforeEach(async () => {
  for (const id of ['creator', 'outsider']) {
    await upsertUser(env.DB, { githubId: id, login: id, name: id, locale: 'en' });
    await upsertMembership(env.DB, org, id, 'admin');
  }
  channel = (await createManagedRoom(env.DB, org, 'creator', { requestId: 'room-hooks-request', name: 'Hooks', private: true, guidelines: '', color: 'teal', memberRefs: [], agentIds: [] })).room.channel;
});
test('creates, lists without secrets, rotates and revokes with version guards', async () => {
  const created = await createRoomHook(env.DB, org, channel, 'creator', ' Deploy ');
  expect(created.hook.name).toBe('Deploy');
  expect(await authenticateRoomHook(env.DB, created.hook.id, created.secret)).toMatchObject({ orgId: org, channel, version: 1 });
  const listed = await listRoomHooks(env.DB, org, channel, 'creator');
  expect(JSON.stringify(listed)).not.toContain(created.secret);
  expect(Object.keys(listed.hooks[0]).sort()).toEqual(['createdAt','id','name','provider','revokedAt','version']);
  const rotated = await changeRoomHook(env.DB, org, channel, 'creator', created.hook.id, 1, 'rotate');
  expect(rotated.version).toBe(2);
  expect(await authenticateRoomHook(env.DB, created.hook.id, created.secret)).toBeNull();
  expect(await authenticateRoomHook(env.DB, created.hook.id, rotated.secret)).toMatchObject({ version: 2 });
  expect((await changeRoomHook(env.DB, org, channel, 'creator', created.hook.id, 1, 'revoke')).status).toBe(409);
  expect(await changeRoomHook(env.DB, org, channel, 'creator', created.hook.id, 2, 'revoke')).toEqual({ version: 3 });
  expect(await authenticateRoomHook(env.DB, created.hook.id, rotated.secret)).toBeNull();
});
test('workspace admins outside a private room cannot manage its hooks', async () => {
  expect((await createRoomHook(env.DB, org, channel, 'outsider', 'Hook')).status).toBe(403);
  expect((await listRoomHooks(env.DB, org, channel, 'outsider')).status).toBe(403);
  expect((await listRoomHooks(env.DB, 'other', channel, 'creator')).status).toBe(404);
});
test('departure/rejoin never revives the creator grant, and archive disables delivery', async () => {
  const created = await createRoomHook(env.DB, org, channel, 'creator', 'Hook');
  await env.DB.prepare("UPDATE conversation_members SET added_at='2099-01-01' WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org, channel).run();
  expect(await authenticateRoomHook(env.DB, created.hook.id, created.secret)).toBeNull();
  expect((await changeRoomHook(env.DB, org, channel, 'creator', created.hook.id, 1, 'rotate')).status).toBe(409);
  const current = await createRoomHook(env.DB, org, channel, 'creator', 'New grant');
  await env.DB.prepare("UPDATE businesses SET archived_at='2099-01-02' WHERE org_id=?1 AND 'b:'||slug=?2").bind(org, channel).run();
  expect(await authenticateRoomHook(env.DB, current.hook.id, current.secret)).toBeNull();
});

test('event retries create one root and reject conflicting content without changing it', async () => {
  const created = await createRoomHook(env.DB, org, channel, 'creator', 'Hook');
  const hook = await authenticateRoomHook(env.DB, created.hook.id, created.secret);
  const input = { eventId: 'deployment:42', body: 'Deployment completed' };
  const first = await receiveRoomHookEvent(env.DB, hook, input);
  expect(first.replay).toBe(false);
  expect(await receiveRoomHookEvent(env.DB, hook, input)).toEqual({ ...first, replay: true });
  expect((await receiveRoomHookEvent(env.DB, hook, { ...input, body: 'Changed' })).status).toBe(409);
  const rows = await env.DB.prepare('SELECT id,body,parent_id,author_login FROM channel_messages WHERE org_id=?1 AND channel=?2').bind(org, channel).all();
  expect(rows.results).toEqual([{ id: first.messageId, body: input.body, parent_id: null, author_login: `webhook:${hook.id}` }]);
});

test('revocation after authentication prevents both receipt and message creation', async () => {
  const created = await createRoomHook(env.DB, org, channel, 'creator', 'Hook');
  const hook = await authenticateRoomHook(env.DB, created.hook.id, created.secret);
  await changeRoomHook(env.DB, org, channel, 'creator', hook.id, 1, 'revoke');
  expect((await receiveRoomHookEvent(env.DB, hook, { eventId: 'event', body: 'Rejected' })).status).toBe(403);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_room_hook_events WHERE org_id=?1').bind(org).first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1').bind(org).first()).n).toBe(0);
});

test('concurrent retries share one receipt and a rejoined creator cannot use a prior authenticated grant', async () => {
  const created = await createRoomHook(env.DB, org, channel, 'creator', 'Hook');
  const hook = await authenticateRoomHook(env.DB, created.hook.id, created.secret);
  const copies = await Promise.all(Array.from({length: 4}, () => receiveRoomHookEvent(env.DB, hook, {eventId:'same',body:'Only once'})));
  expect(new Set(copies.map(copy => copy.messageId)).size).toBe(1);
  expect(copies.filter(copy => !copy.replay)).toHaveLength(1);
  await env.DB.prepare("UPDATE conversation_members SET added_at='2099-01-01' WHERE org_id=?1 AND channel=?2 AND login='creator'").bind(org,channel).run();
  expect((await receiveRoomHookEvent(env.DB, hook, {eventId:'later',body:'Must fail'})).status).toBe(403);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1').bind(org).first()).n).toBe(1);
});

test('management API authenticates room access and never caches returned secrets', async () => {
  const session = await createSession(env.DB, 'creator', 'test-token');
  const call = (method, input, token = session) => worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`, {
    method, headers: {'content-type':'application/json','x-session-token':token},
    ...(method === 'GET' ? {} : {body:JSON.stringify({orgId:org,channel,...input})}),
  }), env, {waitUntil(){}});
  expect((await call('GET',null,'invalid')).status).toBe(401);
  const response = await call('POST',{name:'API hook'});
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const created = await response.json();
  expect(created.secret).toMatch(/^rh_/);
  const listed = await call('GET');
  expect(JSON.stringify(await listed.json())).not.toContain(created.secret);
  const outsider = await createSession(env.DB,'outsider','test-token');
  expect((await call('GET',null,outsider)).status).toBe(404);
});

test('public delivery requires bearer auth, deduplicates and rejects revoked credentials', async () => {
  const runner=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(org));
  await runInDurableObject(runner,(_,state)=>state.storage.setAlarm(Date.now()+3600000));
  const created = await createRoomHook(env.DB,org,channel,'creator','Delivery');
  const send = (secret, body = {eventId:'http:1',body:'A deployment'}) => worker.fetch(new Request(`https://example.test/hooks/rooms/${created.hook.id}`, {
    method:'POST',headers:{'authorization':`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(body),
  }),env,{waitUntil(){}});
  expect((await send('invalid')).status).toBe(401);
  const first = await send(created.secret);
  expect(first.status).toBe(201);
  expect(first.headers.get('cache-control')).toBe('no-store');
  const root = await first.json();
  expect((await env.DB.prepare('SELECT status FROM hx_room_hook_dispatch WHERE message_id=?1').bind(root.messageId).first()).status).toBe('accepted');
  const retry = await send(created.secret);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({...root,replay:true});
  expect(await runInDurableObject(runner,async(_,state)=>(await state.storage.list({prefix:'job:'})).size)).toBe(1);
  await runInDurableObject(runner,instance=>instance.alarm());
  expect(await runInDurableObject(runner,(_,state)=>state.storage.get(`result:${JSON.stringify([org,'room_hook',root.messageId])}`))).toMatchObject({status:'no_agents',answered:0});
  expect((await send(created.secret,{eventId:'http:1',body:'Different'})).status).toBe(409);
  await changeRoomHook(env.DB,org,channel,'creator',created.hook.id,1,'revoke');
  expect((await send(created.secret)).status).toBe(401);
});

test('webhook messages retain an explicit source name without impersonating a person', async () => {
  const created = await createRoomHook(env.DB,org,channel,'creator','Deployments');
  const hook = await authenticateRoomHook(env.DB,created.hook.id,created.secret);
  const receipt = await receiveRoomHookEvent(env.DB,hook,{eventId:'name',body:'Ready'});
  await changeRoomHook(env.DB,org,channel,'creator',hook.id,1,'revoke');
  const row = await getMessage(env.DB,org,receipt.messageId);
  expect(row.author_name).toBe('Webhook · Deployments');
  const [message] = await present(env.DB,org,[row],'creator',channel,[{login:'creator',name:'Person',ref:'person'}]);
  expect(message).toMatchObject({authorName:'Webhook · Deployments',authorRef:null,mine:false});
  expect(JSON.stringify(message)).not.toContain(created.secret);
  expect(await getMessage(env.DB,'other-org',receipt.messageId)).toBeNull();
});

test('LINE room hooks verify raw signatures, deduplicate inbound events and do not start AI jobs', async () => {
  const session=await createSession(env.DB,'creator','line-hook-session');
  const channelSecret='line-channel-secret-'.padEnd(32,'x');
  const create=await worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`,{
    method:'POST',headers:{'content-type':'application/json','x-session-token':session},
    body:JSON.stringify({orgId:org,channel,name:'LINE support',provider:'line',channelSecret}),
  }),env,{waitUntil(){}});
  expect(create.status).toBe(200);
  const connection=await create.json();
  expect(connection.secret).toBeUndefined();
  expect(connection.hook).toMatchObject({provider:'line',name:'LINE support'});
  const list=await worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`,{headers:{'x-session-token':session}}),env,{waitUntil(){}});
  expect((await list.json()).hooks[0].provider).toBe('line');

  const payload=JSON.stringify({destination:'bot',events:[{
    type:'message',webhookEventId:'01H810YECXQQZ37VAXPF6H9E6T',timestamp:1_692_251_666_727,
    source:{type:'user',userId:'U-do-not-store-this-id'},message:{id:'123',type:'text',text:'Need a delivery update'},
  }]});
  const sign=async(secret,text)=>{
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)));
    return btoa(String.fromCharCode(...bytes));
  };
  const deliver=async(secret,text=payload,signedText=text)=>worker.fetch(new Request(`https://example.test/hooks/line/${connection.hook.id}`,{
    method:'POST',headers:{'content-type':'application/json','x-line-signature':await sign(secret,signedText)},body:text,
  }),env,{waitUntil(){}});
  expect((await deliver(channelSecret,`${payload} `,payload)).status).toBe(401); // Signature covers the exact body bytes.
  const first=await deliver(channelSecret);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({received:1,duplicates:0,ignored:0});
  const replay=await deliver(channelSecret);
  expect(await replay.json()).toEqual({received:0,duplicates:1,ignored:0});
  const rows=await env.DB.prepare('SELECT id,body,author_login FROM channel_messages WHERE org_id=?1 AND channel=?2').bind(org,channel).all();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0].body).toContain('Need a delivery update');
  expect(rows.results[0].body).not.toContain('U-do-not-store-this-id');
  expect(rows.results[0].author_login).toBe(`webhook:${connection.hook.id}`);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_room_hook_dispatch WHERE message_id=?1').bind(rows.results[0].id).first()).n).toBe(0);
  const replaced=await worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`,{
    method:'PUT',headers:{'content-type':'application/json','x-session-token':session},
    body:JSON.stringify({orgId:org,channel,id:connection.hook.id,version:1,action:'replace-line-secret',channelSecret:'replacement-secret-'.padEnd(32,'y')}),
  }),env,{waitUntil(){}});
  expect(replaced.status).toBe(200);
  expect((await deliver(channelSecret)).status).toBe(401);
  const stale=await worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`,{
    method:'PUT',headers:{'content-type':'application/json','x-session-token':session},
    body:JSON.stringify({orgId:org,channel,id:connection.hook.id,version:1,action:'replace-line-secret',channelSecret:'stale-secret-'.padEnd(32,'z')}),
  }),env,{waitUntil(){}});
  expect(stale.status).toBe(409);
  expect((await deliver('replacement-secret-'.padEnd(32,'y'))).status).toBe(200);
  const revoke=await worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`,{
    method:'PUT',headers:{'content-type':'application/json','x-session-token':session},
    body:JSON.stringify({orgId:org,channel,id:connection.hook.id,version:2,action:'revoke'}),
  }),env,{waitUntil(){}});
  expect(revoke.status).toBe(200);
  expect((await deliver('replacement-secret-'.padEnd(32,'y'))).status).toBe(401);
});

test('live delivery targets current private-room readers and suppresses archived rooms', async () => {
  const created = await createRoomHook(env.DB,org,channel,'creator','Live');
  const hook = await authenticateRoomHook(env.DB,created.hook.id,created.secret);
  const receipt = await receiveRoomHookEvent(env.DB,hook,{eventId:'live',body:'Private'});
  const sent = [];
  const relay = {...env,ORG_RELAY:{idFromName:name=>name,get:()=>({fetch:async(_url,options)=>{sent.push(JSON.parse(options.body));return new Response('{}');}})}};
  await broadcastRoomHookMessage(relay,org,channel,receipt.messageId);
  expect(sent).toHaveLength(1);
  expect(sent[0].deliveries.map(d=>d.to)).toEqual(['creator']);
  expect(JSON.stringify(sent)).toContain('Webhook · Live');
  expect(JSON.stringify(sent)).not.toContain(created.secret);
  await env.DB.prepare("UPDATE businesses SET archived_at='2099-01-02' WHERE org_id=?1 AND 'b:'||slug=?2").bind(org,channel).run();
  expect(await broadcastRoomHookMessage(relay,org,channel,receipt.messageId)).toEqual({announced:0});
  expect(sent).toHaveLength(1);
});


test('a mixed-case guest downgrade invalidates authentication and an already authenticated write',async()=>{
 const created=await createRoomHook(env.DB,org,channel,'creator','Hook');
 const hook=await authenticateRoomHook(env.DB,created.hook.id,created.secret);
 await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1 AND user_github_id='creator'").bind(org).run();
 expect(await authenticateRoomHook(env.DB,created.hook.id,created.secret)).toBeNull();
 expect((await receiveRoomHookEvent(env.DB,hook,{eventId:'after-downgrade',body:'Must not appear'})).status).toBe(403);
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_room_hook_events WHERE org_id=?1').bind(org).first()).n).toBe(0);
});


test('event receipt, root and pending dispatch commit together and retries do not duplicate work',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','Dispatch');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const first=await receiveRoomHookEvent(env.DB,hook,{eventId:'dispatch',body:'Work'});
 await receiveRoomHookEvent(env.DB,hook,{eventId:'dispatch',body:'Work'});
 const rows=await env.DB.prepare('SELECT message_id,status,attempts FROM hx_room_hook_dispatch WHERE org_id=?1').bind(org).all();
 expect(rows.results).toEqual([{message_id:first.messageId,status:'pending',attempts:0}]);
});
test('a failed dispatch insert rolls back the message and event receipt',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','Dispatch');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 await env.DB.exec("CREATE TRIGGER fail_dispatch BEFORE INSERT ON hx_room_hook_dispatch BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
 await expect(receiveRoomHookEvent(env.DB,hook,{eventId:'rollback',body:'Work'})).rejects.toThrow();
 for(const table of ['channel_messages','hx_room_hook_events','hx_room_hook_dispatch'])
  expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?1`).bind(org).first()).n).toBe(0);
});
test('handoff retries after failure, avoids concurrent duplicate sends and records acceptance',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','Dispatch');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'retry',body:'Work'});
 const calls=[];let available=false;
 const runner={idFromName:id=>id,get:()=>({fetch:async(url,options)=>{calls.push(JSON.parse(options.body));return new Response('',{status:available?202:503})}})};
 const scoped={...env,AGENT_RUNNER:runner};
 expect(await drainRoomHookDispatch(scoped,{now:100000})).toMatchObject({retried:1});
 expect(await drainRoomHookDispatch(scoped,{now:100001})).toMatchObject({retried:0,accepted:0});
 available=true;
 const outcomes=await Promise.all([drainRoomHookDispatch(scoped,{now:120000}),drainRoomHookDispatch(scoped,{now:120000})]);
 expect(outcomes.reduce((n,r)=>n+r.accepted,0)).toBe(1);
 expect(calls).toEqual(Array(2).fill({kind:'room_hook',orgId:org,rowId:event.messageId}));
 expect((await env.DB.prepare('SELECT status,attempts FROM hx_room_hook_dispatch WHERE message_id=?1').bind(event.messageId).first())).toEqual({status:'accepted',attempts:2});
});
test('revoked grants cancel pending handoff without contacting the runner',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','Dispatch');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 await receiveRoomHookEvent(env.DB,hook,{eventId:'cancel',body:'Work'});
 await changeRoomHook(env.DB,org,channel,'creator',hook.id,1,'revoke');
 const runner={idFromName(){throw Error('Must not call runner')}};
 expect(await drainRoomHookDispatch({...env,AGENT_RUNNER:runner},{now:100000})).toEqual({accepted:0,cancelled:1,retried:0});
});

test('an abandoned handoff lease is recovered only after expiry',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','Dispatch');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'lease',body:'Work'});
 await env.DB.prepare("UPDATE hx_room_hook_dispatch SET lease='abandoned',lease_until=200000 WHERE message_id=?1").bind(event.messageId).run();
 let calls=0;
 const runner={idFromName:id=>id,get:()=>({fetch:async()=>{calls++;return new Response('',{status:202})}})};
 expect(await drainRoomHookDispatch({...env,AGENT_RUNNER:runner},{now:199999})).toEqual({accepted:0,cancelled:0,retried:0});
 expect(calls).toBe(0);
 expect(await drainRoomHookDispatch({...env,AGENT_RUNNER:runner},{now:200000})).toEqual({accepted:1,cancelled:0,retried:0});
 expect(calls).toBe(1);
});

test('recent event external-run counts are scoped to the original workspace and channel',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','External');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'external-state',body:'Work'});
 for(const [id,workspace,key,status] of [['own',org,channel,'running'],['other-org','other',channel,'failed'],['other-room',org,'b:elsewhere','failed']])
  await env.DB.prepare("INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,created_at,updated_at,room_hook_source) VALUES (?1,?2,'claude',?3,?4,?1,?5,'now','now',?4)").bind(id,workspace,key,event.messageId,status).run();
 const listed=await listRoomHooks(env.DB,org,channel,'creator');
 expect(listed.events).toHaveLength(1);
 expect(listed.events[0]).toMatchObject({messageId:event.messageId,externalRuns:1,externalRunning:1,externalFailed:0});
});


test('management retry requires the creator, observed state and interrupted acknowledgement',async()=>{
 const made=await createRoomHook(env.DB,org,channel,'creator','Retry');
 const hook=await authenticateRoomHook(env.DB,made.hook.id,made.secret);
 const event=await receiveRoomHookEvent(env.DB,hook,{eventId:'retry-route',body:'Work'});
 const stub=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(org));
 await runInDurableObject(stub,async(_,state)=>{await state.storage.setAlarm(Date.now()+3600000);await state.storage.put(`result:${JSON.stringify([org,'room_hook',event.messageId])}`,{status:'interrupted',at:123})});
 const token=await createSession(env.DB,'creator','test-token');
 const call=(method,input)=>worker.fetch(new Request(`https://example.test/hx/rooms/webhooks?orgId=${org}&channel=${encodeURIComponent(channel)}`,{method,headers:{'content-type':'application/json','x-session-token':token},...(method==='GET'?{}:{body:JSON.stringify({orgId:org,channel,...input})})}),env,{waitUntil(){}});
 const listed=await (await call('GET')).json();
 expect(listed.events[0]).toMatchObject({version:123,canRetry:true,status:'interrupted'});
 const input={action:'retry',messageId:event.messageId,version:123};
 expect((await call('PUT',input)).status).toBe(409);
 expect((await call('PUT',{...input,confirmInterrupted:true})).status).toBe(200);
 expect((await call('PUT',{...input,confirmInterrupted:true})).status).toBe(409);
 expect((await (await call('GET')).json()).events[0]).toMatchObject({status:'queued',canRetry:false});
});

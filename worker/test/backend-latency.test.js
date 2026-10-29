import {env} from 'cloudflare:test';
import {expect,test,vi} from 'vitest';
import {postMessage,getMessage,hydrate,present,threadsFor,deleteMessage} from '../src/channels.js';
import {drainMessageDelivery} from '../src/messageDelivery.js';
import {deliverAcceptedMessages} from '../src/channelRoutes.js';
import worker from '../src/index.js';
import {upsertUser,upsertMembership,createSession} from '../src/db.js';

const org='latency-fixture';
const members=[{login:'alice',ref:'alice-ref',name:'Alice'},{login:'bob',ref:'bob-ref',name:'Bob'}];
const input={orgId:org,key:'b:room',authorLogin:'alice',body:'Hello',deliveryTasks:true};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
function measured(db) {
  const metrics=[];
  return {metrics, prepare(sql) {const statement=db.prepare(sql);return {bind(...args) {
    const bound=statement.bind(...args);const invoke=async method=>{const started=performance.now();const result=await bound[method]();metrics.push({sql,binds:args.length,ms:performance.now()-started,rows:result?.results?.length||0,read:result?.meta?.rows_read||0,bytes:JSON.stringify(result?.results||result).length});return result;};
    return {all:()=>invoke('all'),first:()=>invoke('first'),run:()=>invoke('run')};
  }};}};
}
async function fixture(n,{replies=2}={}) {
  const rows=[];const now=Date.now()-60000;
  for(let i=0;i<n;i++) {
    rows.push({id:`p${i}`,parent:null,author:'alice',at:new Date(now-i*1000).toISOString()});
    for(let j=0;j<replies;j++) rows.push({id:`r${i}-${j}`,parent:`p${i}`,author:j%2?'bob':'alice',at:new Date(now-i*1000+j+1).toISOString()});
  }
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,body,created_at,parent_id)
    SELECT json_extract(value,'$.id'),?1,'b:room',json_extract(value,'$.author'),'fixture',json_extract(value,'$.at'),json_extract(value,'$.parent') FROM json_each(?2)`)
    .bind(org,JSON.stringify(rows)).run();
}

test.each([1,10,30])('Threads batches %i eligible threads, preserves previews/unread/counts under 20 statements',async n=>{
  await fixture(n);const db=measured(env.DB);
  const result=await threadsFor(db,org,'alice',members);
  expect(result).toHaveLength(n);
  for(const item of result){expect(item.replies).toHaveLength(2);expect(item.replyCount).toBe(2);expect(item.parent.replyCount).toBe(2);expect(item.unread).toBe(true);}
  expect(db.metrics.length).toBeLessThanOrEqual(12);
  // Participant windows are grouped once, never re-evaluated per parent.
  expect(db.metrics.reduce((sum,row)=>sum+row.read,0)).toBeLessThan(5000);
  console.log('threads-d1',JSON.stringify({threads:n,statements:db.metrics.length,rowsReturned:db.metrics.reduce((s,x)=>s+x.rows,0),rowsRead:db.metrics.reduce((s,x)=>s+x.read,0)}));
});

test('Threads keeps mention/participation, private access, deleted parents, latest order and read suppression',async()=>{
  await fixture(5);
  await env.DB.prepare("UPDATE channel_messages SET channel='b:private' WHERE id='p0' OR parent_id='p0'").run();
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at,private) VALUES (?1,'private','Private','2026-01-01',1)").bind(org).run();
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='gone' WHERE id='p1'").run();
  await env.DB.prepare("UPDATE channel_messages SET author_login='bob' WHERE id='p2' OR parent_id='p2' OR id='p3' OR parent_id='p3'").run();
  await env.DB.prepare("UPDATE channel_messages SET body='@Alice please' WHERE id='r3-0'").run();
  await env.DB.prepare("INSERT INTO channel_reads(org_id,login,channel,last_read_at) VALUES (?1,'alice','t:p3','9999')").bind(org).run();
  const result=await threadsFor(env.DB,org,'alice',members);
  expect(result.map(t=>t.parent.id)).toEqual(['p3','p4']);
  expect(result[0].unread).toBe(false);expect(result[1].unread).toBe(true);
  // A foreign workspace cannot contribute parents or previews.
  expect(await threadsFor(env.DB,'foreign','alice',members)).toEqual([]);
});

test.each([10,1000,10000])('Summary returns one bounded metadata row for %i replies, exact count/time and five ordered visible identities',async count=>{
  await fixture(1,{replies:count});
  const identities=['former-1','former-2','bob',null,'agent:a','alice','extra'];
  // AI has no login; departed humans cannot consume a displayed face slot.
  for(let i=0;i<identities.length;i++) await env.DB.prepare("UPDATE channel_messages SET author_login=?2,kind=?3 WHERE id=?1").bind(`r0-${i}`,identities[i],i===3?'ai':i===4?'agent':'message').run();
  const root=await getMessage(env.DB,org,'p0');const db=measured(env.DB);
  const output=(await present(db,org,[root],'alice','b:room',members))[0];
  expect(output.replyCount).toBe(count);expect(output.replyRefs).toEqual(['bob-ref','ai','agent:a','alice-ref']);
  expect(output.lastReplyAt).toBe((await getMessage(env.DB,org,`r0-${count-1}`)).created_at);
  const summary=db.metrics.find(x=>x.sql.includes('WITH replies AS'));
  expect(summary.rows).toBe(1);expect(summary.bytes).toBeLessThan(250);
  if(count===10000)console.log('summary-query-plan',JSON.stringify((await env.DB.prepare('EXPLAIN QUERY PLAN '+summary.sql).bind(org,'p0',JSON.stringify(members.map(m=>m.login))).all()).results));
  console.log('summary-d1',JSON.stringify({replies:count,returnedRows:summary.rows,returnedBytes:summary.bytes,rowsRead:summary.read,ms:summary.ms}));
});

test('Summary reconciles retries, concurrent sends, reply/parent deletion and physical retention without summary backfill',async()=>{
  const root=await postMessage(env.DB,input);
  const reply={...input,parentId:root.row.id,clientId:'tmp-summary-retry'};
  const first=await postMessage(env.DB,reply);expect((await postMessage(env.DB,reply)).row.id).toBe(first.row.id);
  await Promise.all(Array.from({length:4},(_,i)=>postMessage(env.DB,{...input,parentId:root.row.id,clientId:`tmp-concurrent-${i}`})));
  expect((await hydrate(env.DB,org,[root.row])).get(root.row.id).replyCount).toBe(5);
  await deleteMessage(env.DB,{orgId:org,id:first.row.id,authorLogin:'alice'});
  expect((await hydrate(env.DB,org,[root.row])).get(root.row.id).replyCount).toBe(4);
  await env.DB.prepare('DELETE FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(org,root.row.id).run();
  expect((await hydrate(env.DB,org,[root.row])).get(root.row.id).replyCount).toBe(0);
  await postMessage(env.DB,{...input,parentId:root.row.id});
  await deleteMessage(env.DB,{orgId:org,id:root.row.id,authorLogin:'alice',withThread:true});
  expect((await hydrate(env.DB,org,[root.row])).get(root.row.id).replyCount).toBe(0);
});

test('Delivery intent commits atomically; duplicate clientId and failed attachment claim create no extra tasks',async()=>{
  const first=await postMessage(env.DB,{...input,clientId:'tmp-delivery-retry'});
  expect((await postMessage(env.DB,{...input,clientId:'tmp-delivery-retry'})).row.id).toBe(first.row.id);
  expect((await env.DB.prepare('SELECT * FROM channel_message_delivery').all()).results).toHaveLength(2);
  await env.DB.prepare("INSERT INTO message_files(id,org_id,channel,uploader,name,type,size,created_at) VALUES ('delivery-file',?1,'b:room','alice','fixture.txt','text/plain',10,'2026-01-01')").bind(org).run();
  await env.DB.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON channel_message_delivery BEGIN SELECT RAISE(ABORT,'delivery failed'); END;");
  await expect(postMessage(env.DB,{...input,withFiles:true,files:{login:'alice',ids:['delivery-file']}})).rejects.toThrow();
  expect((await env.DB.prepare("SELECT message_id FROM message_files WHERE id='delivery-file'").first()).message_id).toBeNull();
  expect((await env.DB.prepare('SELECT id FROM channel_messages').all()).results).toHaveLength(1);
});

test.each(['live','push'])('%s failure or blocked work cannot hold the other path; lease/retry deduplicates and exhausts at ten attempts',async blocked=>{
  const {row}=await postMessage(env.DB,input);const hold=gate();let started=false,otherCalls=0;
  const one=drainMessageDelivery(env.DB,async()=>{started=true;await hold.promise;throw new Error('injected');},{kind:blocked,now:1000});
  while(!started) await new Promise(resolve=>setTimeout(resolve,0));
  const other=blocked==='live'?'push':'live';
  await drainMessageDelivery(env.DB,async()=>{otherCalls++;},{kind:other,now:1000});
  expect(otherCalls).toBe(1);
  // A second sweep cannot claim work while the first lease remains live.
  await drainMessageDelivery(env.DB,async()=>{throw new Error('duplicate');},{kind:blocked,now:1001});
  hold.release();await one;
  expect(await env.DB.prepare('SELECT status,attempts FROM channel_message_delivery WHERE message_id=?1 AND kind=?2').bind(row.id,blocked).first()).toMatchObject({status:'pending',attempts:1});
  await drainMessageDelivery(env.DB,async()=>{otherCalls++;},{kind:other,now:999999});expect(otherCalls).toBe(1);
  await env.DB.prepare('UPDATE channel_message_delivery SET attempts=9,next_attempt=0 WHERE kind=?1').bind(blocked).run();
  await drainMessageDelivery(env.DB,async()=>{throw new Error('injected');},{kind:blocked,now:999999});
  expect((await env.DB.prepare('SELECT status FROM channel_message_delivery WHERE kind=?1').bind(blocked).first()).status).toBe('failed');
  // A Worker interrupted on its tenth attempt cannot silently attempt eleven.
  await env.DB.prepare("UPDATE channel_message_delivery SET status='pending',attempts=10,lease='crashed',lease_until=2000000 WHERE kind=?1").bind(blocked).run();
  await drainMessageDelivery(env.DB,async()=>{throw new Error('eleventh attempt');},{kind:blocked,now:2000001});
  expect(await env.DB.prepare('SELECT status,attempts FROM channel_message_delivery WHERE kind=?1').bind(blocked).first()).toEqual({status:'failed',attempts:10});
});

test('Live relay HTTP failure stays retryable; notification queue still completes, then live retry succeeds',async()=>{
  for(const login of ['alice','bob']) {
    await upsertUser(env.DB,{githubId:login,login,name:login==='alice'?'Alice':'Bob',locale:'en'});
    await upsertMembership(env.DB,org,login,'member');
  }
  const {row}=await postMessage(env.DB,{...input,body:'@Bob fixture'});let status=503;const events=[];
  const relay={idFromName:x=>x,get:()=>({fetch:async(url,init)=>{events.push(JSON.parse(init.body));return new Response('{}',{status});}})};
  await Promise.all(['live','push'].map(kind=>deliverAcceptedMessages({...env,ORG_RELAY:relay},{kind,orgId:org,messageId:row.id,now:1})));
  const jobs=(await env.DB.prepare('SELECT kind,status FROM channel_message_delivery').all()).results;
  expect(jobs).toContainEqual({kind:'push',status:'pending'});expect(jobs).toContainEqual({kind:'live',status:'pending'});
  expect((await env.DB.prepare('SELECT login,message_id FROM push_queue').all()).results).toEqual([{login:'bob',message_id:row.id}]);
  status=200;await Promise.all(['live','push'].map(kind=>deliverAcceptedMessages({...env,ORG_RELAY:relay},{kind,now:20000})));
  expect((await env.DB.prepare('SELECT login,message_id FROM push_queue').all()).results).toHaveLength(1);
  expect((await env.DB.prepare("SELECT status FROM channel_message_delivery WHERE kind='push'").first()).status).toBe('done');
  expect((await env.DB.prepare("SELECT status FROM channel_message_delivery WHERE kind='live'").first()).status).toBe('done');
  expect(events.flatMap(x=>x.events||[]).filter(e=>e.name==='channel_message').every(e=>e.value.message.id===row.id)).toBe(true);
});

test('Committed ordinary send ACK and live event do not await blocked optional settings or push audience',async()=>{
  await upsertUser(env.DB,{githubId:'latency-user',login:'alice',name:'Alice',locale:'en'});
  await upsertMembership(env.DB,org,'latency-user','member');const token=await createSession(env.DB,'latency-user','token');
  const hold=gate();const pending=[];let settings=false,push=false;const live=[];
  const db={prepare(sql){const statement=env.DB.prepare(sql);return {bind(...args){const bound=statement.bind(...args);return new Proxy(bound,{get(target,key){if((sql.includes('SELECT mentioned_only')||sql.includes('u.notify_keywords FROM memberships'))&&['first','all'].includes(key))return async()=>{if(sql.includes('mentioned_only'))settings=true;else push=true;await hold.promise;return target[key]();};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};},batch:args=>env.DB.batch(args)};
  const relay={idFromName:x=>x,get:()=>({fetch:async(url,init)=>{live.push(JSON.parse(init.body));return new Response('{}');}})};
  const response=await worker.fetch(new Request('https://example.com/channels/messages',{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:org,channel:'b:room',body:'human hello',clientId:'tmp-ack-delay'})}),{...env,DB:db,ORG_RELAY:relay},{waitUntil:p=>pending.push(p)});
  expect(response.status).toBe(201);expect(response.headers.get('server-timing')).toContain('policy;dur=');
  const message=(await response.json()).message;
  // Wait for the independent live task while both optional branches are held.
  for(let i=0;i<100&&!live.some(x=>(x.events||[]).some(e=>e.name==='channel_message'));i++)await new Promise(resolve=>setTimeout(resolve,1));
  expect(live.some(x=>(x.events||[]).some(e=>e.value?.message?.id===message.id))).toBe(true);
  expect(settings).toBe(true);expect(push).toBe(true);
  hold.release();await Promise.allSettled(pending);
});

test('Durable replay refreshes private audience and drops tombstones instead of retaining a captured message',async()=>{
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at,private) VALUES (?1,'private','Private','2026-01-01',1)").bind(org).run();
  for(const login of ['alice','bob'])await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES (?1,'b:private',?2,'2026-01-01')").bind(org,login).run();
  const {row}=await postMessage(env.DB,{...input,key:'b:private'});
  await env.DB.prepare("DELETE FROM conversation_members WHERE login='bob'").run();
  const deliveries=[];const relay={idFromName:x=>x,get:()=>({fetch:async(url,init)=>{deliveries.push(...(JSON.parse(init.body).deliveries||[]));return new Response('{}');}})};
  await deliverAcceptedMessages({...env,ORG_RELAY:relay},{kind:'live'});
  expect(deliveries.length).toBe(1);expect(deliveries[0].to).toBe('alice');
  const gone=await postMessage(env.DB,{...input,key:'b:private'});
  await env.DB.prepare("UPDATE channel_messages SET body='',deleted_at='gone' WHERE id=?1").bind(gone.row.id).run();
  deliveries.length=0;await deliverAcceptedMessages({...env,ORG_RELAY:relay},{kind:'live'});expect(deliveries).toEqual([]);
});


test('Rejected candidates cross bounded D1 chunks; a read before a later reply does not suppress unread',async()=>{
  await fixture(100);
  await env.DB.prepare("UPDATE channel_messages SET author_login='bob' WHERE CAST(substr(COALESCE(parent_id,id),2) AS INTEGER)<70").run();
  const first=await getMessage(env.DB,org,'r70-0');
  await env.DB.prepare("INSERT INTO channel_reads(org_id,login,channel,last_read_at) VALUES (?1,'alice','t:p70',?2)").bind(org,first.created_at).run();
  const db=measured(env.DB);const result=await threadsFor(db,org,'alice',members);
  expect(result).toHaveLength(30);expect(result[0].parent.id).toBe('p70');expect(result[0].unread).toBe(true);
  expect(db.metrics.every(row=>row.binds<=100)).toBe(true);
  expect(db.metrics.filter(row=>row.sql.includes('cr.last_read_at AS thread_read_at'))).toHaveLength(2);
});


test('Later jobs acquire a fresh lease after a slow earlier delivery, with retry backoff measured from completion',async()=>{
  await postMessage(env.DB,input);await postMessage(env.DB,input);
  const stamp=Date.now();let elapsed=0,calls=0;
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>stamp+elapsed);
  try {
    await drainMessageDelivery(env.DB,async(orgId,messageId)=>{
      calls++;
      const job=await env.DB.prepare("SELECT lease_until FROM channel_message_delivery WHERE org_id=?1 AND message_id=?2 AND kind='live'").bind(orgId,messageId).first();
      expect(job.lease_until).toBeGreaterThan(1000+elapsed);
      if(calls===1){elapsed=65000;throw new Error('slow failure');}
    },{kind:'live',now:1000});
    expect(calls).toBe(2);
    const retry=await env.DB.prepare("SELECT next_attempt FROM channel_message_delivery WHERE kind='live' AND status='pending'").first();
    expect(retry.next_attempt).toBeGreaterThan(1000+elapsed);
  } finally {clock.mockRestore();}
});

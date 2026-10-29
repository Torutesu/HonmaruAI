// Copied to test/ by benchmark-backend-latency.sh; never used in normal tests.
import {env} from 'cloudflare:test';
import {test,expect} from 'vitest';
import {threadsFor as beforeThreads,hydrate as beforeHydrate} from '../src/channels-latency-before.js';
import {threadsFor as afterThreads,hydrate as afterHydrate} from '../src/channels.js';
import {handleChannels as beforeRoute} from '../src/channelRoutes-latency-before.js';
import {handleChannels as afterRoute} from '../src/channelRoutes.js';
import {upsertUser,upsertMembership,createSession} from '../src/db.js';
const org='benchmark-only';
const members=[{login:'alice',ref:'alice-ref',name:'Alice'},{login:'bob',ref:'bob-ref',name:'Bob'}];
const report=async value=>{expect((await env.BENCHMARK_CAPTURE.fetch('https://capture.invalid',{method:'POST',body:JSON.stringify(value)})).ok).toBe(true);};
const quantile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(p*xs.length)-1];
function trace(delay=0) {
 let statements=0,returnedRows=0,returnedBytes=0,rowsRead=0,phases=0,inFlight=0,peak=0;
 return {get metrics(){return {statements,returnedRows,returnedBytes,rowsRead,dependencyWaves:phases,maxInFlight:peak};},prepare(sql){const statement=env.DB.prepare(sql);return {bind(...args){const bound=statement.bind(...args);return new Proxy(bound,{get(target,key){if(['first','all','run'].includes(key))return async()=>{statements++;if(!inFlight)phases++;inFlight++;peak=Math.max(peak,inFlight);if(delay&&(sql.includes('SELECT mentioned_only')||sql.includes('FROM custom_agents WHERE org_id')))await new Promise(r=>setTimeout(r,delay));const raw=await target[key==='first'?'all':key]();returnedRows+=raw?.results?.length||0;returnedBytes+=JSON.stringify(raw?.results||[]).length;rowsRead+=raw?.meta?.rows_read||0;inFlight--;return key==='first'?(raw.results?.[0]||null):raw;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};},async batch(batch){statements+=batch.length;if(!inFlight)phases++;inFlight++;peak=Math.max(peak,inFlight);const results=await env.DB.batch(batch);for(const result of results){returnedRows+=result?.results?.length||0;returnedBytes+=JSON.stringify(result?.results||[]).length;rowsRead+=result?.meta?.rows_read||0;}inFlight--;return results;}};
}

test('before/after full Threads function on real local D1 at 1/10/30 threads',async()=>{
 for(const n of [1,10,30]) {
  await env.DB.prepare('DELETE FROM channel_messages').run();const rows=[];const now=Date.now()-100000;
  for(let i=0;i<n;i++)for(let j=0;j<3;j++)rows.push({id:`p${i}-${j}`,parent:j?`p${i}-0`:null,author:j===2?'bob':'alice',at:new Date(now-i*1000+j).toISOString()});
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,body,created_at,parent_id) SELECT json_extract(value,'$.id'),?1,'b:room',json_extract(value,'$.author'),'fixture',json_extract(value,'$.at'),json_extract(value,'$.parent') FROM json_each(?2)`).bind(org,JSON.stringify(rows)).run();
  let baselineResponse;
  for(const [version,fn] of [['before',beforeThreads],['after',afterThreads]]) {
   const samples=[];let metric;
   for(let i=-2;i<10;i++){const db=trace();const start=performance.now();const response=await fn(db,org,'alice',members);const ms=performance.now()-start;expect(response).toHaveLength(n);expect(response.every(t=>t.replyCount===2&&t.replies.length===2&&t.unread)).toBe(true);if(version==='before')baselineResponse=response;else expect(response).toEqual(baselineResponse);if(i>=0)samples.push(ms);metric=db.metrics;}
   await report({case:'threads',version,threads:n,...metric,p50Ms:quantile(samples,.5),p95Ms:quantile(samples,.95),samples});
  }
 }
},120000);

test('before/after ordinary send route ACK; identical 0ms/40ms optional discovery delay',async()=>{
 await upsertUser(env.DB,{githubId:'fixture',login:'alice',name:'Alice',locale:'en'});await upsertMembership(env.DB,org,'fixture','member');const token=await createSession(env.DB,'fixture','fixture');
 for(const delayMs of [0,40])for(const [version,fn] of [['before',beforeRoute],['after',afterRoute]]) {
  const samples=[];let metric;
  for(let i=-2;i<10;i++) {
   const db=trace(delayMs);const request=new Request('https://example.com/channels/messages',{method:'POST',headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({orgId:org,channel:'b:room',body:'ordinary fixture',clientId:`tmp-${version}-${delayMs}-${i}`})});
   const started=performance.now();const response=await fn(request,{...env,DB:db},new URL(request.url),{after:()=>{},route:()=>{throw Error('unexpected model route');}});const ms=performance.now()-started;expect(response.status).toBe(201);if(i>=0)samples.push(ms);metric=db.metrics;
  }
  await report({case:'send_ack',version,optionalDelayMs:delayMs,...metric,p50Ms:quantile(samples,.5),p95Ms:quantile(samples,.95),samples,scope:'handler with real local D1; after callbacks captured without executing; no browser/network/model/push provider'});
 }
},120000);


test('before/after reply summary on real local D1 at 10/1000/10000 replies',async()=>{
 for(const n of [10,1000,10000]) {
  await env.DB.prepare('DELETE FROM channel_messages').run();const root={id:'root'};
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,body,created_at) VALUES ('root',?1,'b:room','alice','fixture','0')").bind(org).run();
  const replies=Array.from({length:n},(_,i)=>({id:`r${i}`,author:`member${i%7}`,at:String(i).padStart(9,'0')}));
  await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,parent_id,author_login,body,created_at) SELECT json_extract(value,'$.id'),?1,'b:room','root',json_extract(value,'$.author'),'fixture',json_extract(value,'$.at') FROM json_each(?2)").bind(org,JSON.stringify(replies)).run();
  for(const [version,fn] of [['before',beforeHydrate],['after',afterHydrate]]) {
   const samples=[];let metric;
   for(let i=-2;i<10;i++){const db=trace();const start=performance.now();const response=(await fn(db,org,[root])).get('root');const ms=performance.now()-start;expect(response.replyCount).toBe(n);expect(response.lastReplyAt).toBe(String(n-1).padStart(9,'0'));expect(response.replyLogins.slice(0,5)).toEqual(['member0','member1','member2','member3','member4']);if(i>=0)samples.push(ms);metric=db.metrics;}
   await report({case:'summary',version,replies:n,...metric,p50Ms:quantile(samples,.5),p95Ms:quantile(samples,.95),samples});
  }
 }
},180000);

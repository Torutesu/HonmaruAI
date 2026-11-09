import {env} from 'cloudflare:test';
import {expect,test,vi} from 'vitest';
import worker from '../src/index.js';
import {upsertUser,upsertMembership,createSession} from '../src/db.js';
import {present} from '../src/channels.js';
import {useMediaEnv,mediaEnv} from '../src/mediaToken.js';
const org='loading-latency';
const members=[{login:'alice',ref:'alice-ref',name:'Alice'}];
function observed(db,observe){return {prepare(sql){const stmt=db.prepare(sql);return {bind(...args){const bound=stmt.bind(...args);return new Proxy(bound,{get(target,key){const value=target[key];if(['first','all','run'].includes(key))return async(...a)=>{await observe(sql,key);return value.apply(target,a)};return typeof value==='function'?value.bind(target):value}})}}},batch:args=>db.batch(args)}}
test.each([1,50])('a page of %i messages from one agent checks its avatar authority once per presentation',async count=>{
 await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at,avatar_url)
 VALUES (?1,'helper','helper','Helper','help','team','alice','2026-01-01','2026-01-01',?2)`)
 .bind(org,'https://example.com/agents/avatar/agent-avatar-11111111-1111-4111-8111-111111111111').run();
 const reads=[];const db=observed(env.DB,sql=>{reads.push(sql)});
 const previous=mediaEnv();useMediaEnv({DB:db,API_ORIGIN:'https://example.com'});
 try{
  const rows=Array.from({length:count},(_,i)=>({id:`agent-${i}`,channel:'b:room',kind:'agent',author_login:'agent:helper',body:'Hello',created_at:'2026-01-01'}));
  const shown=await present(db,org,rows,'alice','b:room',members);
  expect(shown).toHaveLength(count);
  expect(shown.every(m=>m.agent.avatarUrl?.includes('agent=helper'))).toBe(true);
  const profiles=reads.filter(sql=>sql.includes('SELECT * FROM hx_agent_profiles'));
  console.log(JSON.stringify({messages:count,avatarProfileReads:profiles.length,statements:reads.length}));
  expect(profiles).toHaveLength(1);
  expect(reads).toHaveLength(7);
  await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES (?1,'helper','people','[]','2026-01-01')").bind(org).run();
  expect((await present(db,org,rows.slice(0,1),'alice','b:room',members))[0].agent.avatarUrl).toBeNull();
 }finally{useMediaEnv(previous)}
});
test('channel directory returns before optional provider discovery for uncached translated previews',async()=>{
 await upsertUser(env.DB,{githubId:'reader',login:'alice',name:'Alice',locale:'en'});
 await upsertMembership(env.DB,org,'reader','member');
 const token=await createSession(env.DB,'reader','unused');
 await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,body,created_at) VALUES ('foreign-preview',?1,'b:room','other','金曜日から始めます','2026-11-09')").bind(org).run();
 let release,blocked;const hold=new Promise(r=>{release=r});const entered=new Promise(r=>{blocked=r});
 const db=observed(env.DB,async sql=>{if(sql.includes('org_ai_settings')){blocked('provider');await hold}});
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'{"items":[]}'}}]})));
 const pending=[];const response=worker.fetch(new Request(`https://example.com/channels?orgId=${org}`,{headers:{'x-session-token':token}}),{...env,DB:db,OPENAI_API_KEY:'test-only'},{waitUntil:p=>pending.push(p)});
 try{
  expect(await Promise.race([response.then(()=>'response'),entered])).toBe('response');
  const data=await(await response).json();expect(data.members).toHaveLength(1);
  expect(data.activity.find(x=>x.channel==='b:room')).toMatchObject({preview:'金曜日から始めます',originalPreview:'金曜日から始めます',last:{id:'foreign-preview',body:'金曜日から始めます',lang:'ja',mine:false}});
 }finally{release();await response;await Promise.allSettled(pending);fetch.mockRestore()}
});

test('channel metadata and deletion fence are read together before a send or history read',async()=>{
 const {resolveChannel}=await import('../src/channels.js');
 const started=[];let release;const gate=new Promise(r=>{release=r});
 const db={prepare(sql){return {bind(){return {first:async()=>{started.push(sql);await gate;return sql.includes('FROM businesses')?{private:0,created_at:'2026-01-01'}:sql.includes('hx_room_access')?{deleted:1}:null}}}}}};
 const answer=resolveChannel(db,org,{login:'alice'},'b:room',members);
 try{expect(started).toHaveLength(2)}finally{release()}
 expect(await answer).toBeNull();
});

test('message caller overlaps independent membership and user reads without admitting a nonmember',async()=>{
 const {caller}=await import('../src/channelRoutes.js');
 await upsertUser(env.DB,{githubId:'sender',login:'sender',name:'Sender'});
 const token=await createSession(env.DB,'sender','unused');
 let release,entered;const hold=new Promise(r=>{release=r});const membershipStarted=new Promise(r=>{entered=r});let userRead=false;
 const db=observed(env.DB,async sql=>{
  if(sql.includes('SELECT 1 AS ok FROM memberships')){entered();await hold}
  if(sql.includes('SELECT github_id, login, name, avatar_url'))userRead=true;
 });
 const answer=caller({...env,DB:db},new Request('https://example.com/channels/messages',{headers:{'x-session-token':token}}),org);
 await membershipStarted;
 try{expect(userRead).toBe(true)}finally{release()}
 expect((await answer).denied.status).toBe(403);
});


test('history response exposes server stages without returning authorization internals',async()=>{
 await upsertUser(env.DB,{githubId:'timing-reader',login:'reader',name:'Reader'});
 await upsertMembership(env.DB,org,'timing-reader','member');
 const token=await createSession(env.DB,'timing-reader','unused');
 const response=await worker.fetch(new Request(`https://example.com/channels/messages?orgId=${org}&channel=b:room`,{headers:{'x-session-token':token}}),env,{waitUntil(){}});
 expect(response.status).toBe(200);
 for(const stage of ['caller','members','resolve','messages','total'])expect(response.headers.get('server-timing')).toMatch(new RegExp(`${stage};dur=\\d+`));
 expect(await response.json()).toEqual({messages:[],more:false});
});

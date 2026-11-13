import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import {upsertMembership,upsertUser} from '../src/db.js';
import {cancelFollowup,listFollowups,runDueFollowups} from '../src/harness/followups.js';

// The cron claims a due follow-up by setting it running. When the invocation
// is cut off before it records an outcome, the row must not stay running
// forever: a later tick settles it, the requester can see and cancel it.
const ORG='personal:followup-lease',OWNER='9701',CHANNEL='b:followups';
const MINUTE=60_000;

beforeEach(async()=>{
 await upsertUser(env.DB,{githubId:OWNER,login:'leaseowner',name:'Owner',avatarUrl:null,locale:'en'});
 await upsertMembership(env.DB,ORG,OWNER,'admin');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at) VALUES(?1,'followups','Follow-ups',?2,'2026-01-01')").bind(ORG,OWNER).run();
});

async function followup(id,{status='scheduled',dueAt=new Date(Date.now()-MINUTE).toISOString(),claimedAt=null,createdBy=OWNER}={}){
 await env.DB.prepare(`INSERT INTO hx_followups(id,org_id,channel,instruction,due_at,status,created_by,created_at,claimed_at)
  VALUES(?1,?2,?3,'Check whether Acme paid',?4,?5,?6,'2026-01-01T00:00:00.000Z',?7)`).bind(id,ORG,CHANNEL,dueAt,status,createdBy,claimedAt).run();
}
const row=id=>env.DB.prepare('SELECT status,result,claimed_at FROM hx_followups WHERE id=?1 AND org_id=?2').bind(id,ORG).first();

// Fails every statement that records a follow-up's outcome, as a cut-off
// invocation would leave it.
function withoutOutcomeWrites(){
 const DB=new Proxy(env.DB,{get(target,key){
  if(key==='prepare')return sql=>/UPDATE hx_followups SET status = '(done|failed)'/.test(sql)?{bind:()=>({run:async()=>{throw new Error('D1 unavailable');}})}:target.prepare(sql);
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});
 return {...env,DB};
}

test('an interrupted follow-up keeps its claim time and a later tick fails it as interrupted',async()=>{
 const at=new Date();
 await followup('fu_interrupted',{createdBy:'9799'});
 await expect(runDueFollowups(withoutOutcomeWrites(),{now:at})).rejects.toThrow('D1 unavailable');
 expect(await row('fu_interrupted')).toMatchObject({status:'running',claimed_at:at.toISOString()});
 await runDueFollowups(env,{now:new Date(at.getTime()+5*MINUTE)});
 expect((await row('fu_interrupted')).status).toBe('running');
 await runDueFollowups(env,{now:new Date(at.getTime()+31*MINUTE)});
 const settled=await row('fu_interrupted');
 expect(settled.status).toBe('failed');
 expect(settled.result).toMatch(/interrupted/i);
});

test('a running follow-up left by an older claim without a claim time is failed',async()=>{
 await followup('fu_legacy',{status:'running'});
 await runDueFollowups(env);
 expect(await row('fu_legacy')).toMatchObject({status:'failed'});
});

test('the default list shows running follow-ups and only a stale one can be cancelled',async()=>{
 const fresh=new Date().toISOString(),stale=new Date(Date.now()-31*MINUTE).toISOString();
 await followup('fu_live',{status:'running',claimedAt:fresh});
 await followup('fu_stuck',{status:'running',claimedAt:stale});
 await followup('fu_later',{dueAt:new Date(Date.now()+60*MINUTE).toISOString()});
 expect((await listFollowups(env.DB,ORG,{viewerId:OWNER})).map(f=>f.id).sort()).toEqual(['fu_later','fu_live','fu_stuck']);
 expect((await cancelFollowup(env.DB,ORG,'fu_live')).status).toBe(409);
 expect((await row('fu_live')).status).toBe('running');
 expect(await cancelFollowup(env.DB,ORG,'fu_stuck')).toEqual({cancelled:true});
 expect((await row('fu_stuck')).status).toBe('cancelled');
});

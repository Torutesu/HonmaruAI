import {env} from 'cloudflare:test';
import {beforeEach,test,expect,vi} from 'vitest';
import {upsertUser,upsertMembership,upsertBusiness} from '../src/db.js';
import {generateWorkflow} from '../src/harness/workflowCreation.js';
import {workflowSource} from '../src/harness/workflowSource.js';
const org='personal:workflow-origin',by='9811';
const who={session:{github_id:by},user:{github_id:by,login:'origin-owner',name:'Owner'}};
const request=new Request('https://example.com/workflows/generate');
const spec={name:'Reminder',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Review invoices'}]};
const input={prompt:'Remind the team to review invoices',channel:'b:ops',requestId:'workflow-origin-request-001',captureSource:true};
const make=async(args=input,complete=async()=>JSON.stringify(spec))=>generateWorkflow(env,request,org,who,args,{makeCompleter:async()=>complete});
const count=async table=>(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`).bind(org).first()).n;
beforeEach(async()=>{
 await upsertUser(env.DB,{githubId:by,login:who.user.login,name:'Owner',locale:'en'});
 await upsertMembership(env.DB,org,by,'admin');
 await upsertBusiness(env.DB,org,{name:'Ops',createdBy:by});
});
test('captures one source and paused workflow across retries; changed requests conflict',async()=>{
 const model=vi.fn(async()=>JSON.stringify(spec));
 const first=await make(input,model),again=await make(input,model);
 expect(first.workflow.enabled).toBe(false);
 expect(again).toMatchObject({replay:true,workflow:{id:first.workflow.id}});
 expect(model).toHaveBeenCalledTimes(1);
 expect(await count('hx_workflows')).toBe(1);
 expect(await count('channel_messages')).toBe(2);
 const source=await workflowSource(env.DB,org,by,first.workflow.id);
 expect(source.source).toMatchObject({channel:'b:ops',body:input.prompt});
 const reply=await env.DB.prepare("SELECT body,parent_id FROM channel_messages WHERE org_id=? AND kind='ai'").bind(org).first();
 expect(reply.parent_id).toBe(source.source.threadId);
 expect(reply.body).toContain('#/workflows/'+first.workflow.id+'/'+encodeURIComponent(org));
 expect(reply.body).toContain('Automatic triggers are paused');
 expect((await make({...input,prompt:'Different request'},model)).status).toBe(409);
 expect(model).toHaveBeenCalledTimes(1);
});
test('a concurrent request does not invoke another model or create another thread',async()=>{
 let finish,started;
 const entered=new Promise(r=>started=r),model=vi.fn(()=>{started();return new Promise(r=>finish=r)});
 const first=make(input,model);await entered;
 expect((await make(input,model)).status).toBe(409);
 finish(JSON.stringify(spec));expect((await first).workflow).toBeTruthy();
 expect(model).toHaveBeenCalledTimes(1);
 expect(await count('channel_messages')).toBe(2);
});
test('an expired generation owner cannot publish after another request takes over',async()=>{
 let finish,started;const entered=new Promise(r=>started=r);
 const first=make(input,()=>{started();return new Promise(r=>finish=r)});await entered;
 await env.DB.prepare('UPDATE hx_workflow_generation_jobs SET lease_until=0 WHERE org_id=?').bind(org).run();
 const winner=await make();expect(winner.workflow).toBeTruthy();
 finish(JSON.stringify({...spec,name:'Stale'}));expect((await first).status).toBe(409);
 expect(await count('hx_workflows')).toBe(1);
 expect(await count('hx_workflow_sources')).toBe(1);
});
test('membership revocation during model work prevents publication',async()=>{
 const result=await make(input,async()=>{
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(org,by).run();
  return JSON.stringify(spec);
 });
 expect(result.status).toBe(403);
 expect(await count('hx_workflows')).toBe(0);
 expect(await count('hx_workflow_sources')).toBe(0);
});
test('deleted source during generation cannot become an orphan workflow',async()=>{
 const result=await make(input,async()=>{
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='now' WHERE org_id=?").bind(org).run();return JSON.stringify(spec);
 });
 expect(result.status).toBe(409);
 expect(await count('hx_workflows')).toBe(0);
});
test('failed model work retains one source and can be retried with the same request',async()=>{
 expect((await make(input,async()=>'{"error":"Try again"}')).error).toBe('Try again');
 const retry=await make();expect(retry.workflow).toBeTruthy();
 expect(await count('channel_messages')).toBe(2);
});
test('publication rolls back the workflow when its source disappears at commit',async()=>{
 const {createWorkflow}=await import('../src/harness/workflows.js');
 await expect(createWorkflow(env.DB,org,{...spec,enabled:false},by,{source:{channel:'b:ops',threadId:'missing',body:'Original prompt'},announcementLocale:'ja'})).rejects.toThrow();
 expect(await count('hx_workflows')).toBe(0);
 expect(await count('hx_workflow_sources')).toBe(0);
 expect(await count('channel_messages')).toBe(0);
});
test('publication rolls back when the request lease fence fails',async()=>{
 const {createWorkflow}=await import('../src/harness/workflows.js');
 await expect(createWorkflow(env.DB,org,{...spec,enabled:false},by,{commitGuard:()=>env.DB.prepare("INSERT INTO hx_workflow_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status) VALUES(?,?,'guard','fp','stale',0,'complete')").bind(org,by)})).rejects.toThrow();
 expect(await count('hx_workflows')).toBe(0);
 expect(await count('hx_workflow_generation_jobs')).toBe(0);
});
test('private origins restrict workflow details, listings and frozen execution history',async()=>{
 const other='9812';
 await upsertUser(env.DB,{githubId:other,login:'origin-reader',name:'Reader',locale:'en'});
 await upsertMembership(env.DB,org,other,'member');
 await upsertBusiness(env.DB,org,{name:'Public',createdBy:by});
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='ops'").bind(org).run();
 await env.DB.prepare("INSERT OR IGNORE INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?,'b:ops',?,'origin-owner','now')").bind(org,who.user.login).run();
 const made=await make(input,async()=>JSON.stringify({...spec,steps:[{type:'post',channel:'b:public',text:'Public result'}]}));
 expect(made.workflow).toBeTruthy();
 const {getWorkflow,listWorkflows,startRun,getRun}=await import('../src/harness/workflows.js');
 expect(await getWorkflow(env.DB,org,made.workflow.id,{viewerId:other})).toBeNull();
 expect(await listWorkflows(env.DB,org,{viewerId:other})).toEqual([]);
 const run=await startRun(env,{orgId:org,workflow:made.workflow,trigger:'manual',startedBy:by});
 expect(await getRun(env.DB,org,run.id,{viewerId:other})).toBeNull();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?,'b:ops','origin-reader','origin-owner','now')").bind(org).run();
 expect((await getWorkflow(env.DB,org,made.workflow.id,{viewerId:other})).id).toBe(made.workflow.id);
 expect((await getRun(env.DB,org,run.id,{viewerId:other})).id).toBe(run.id);
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=? AND channel='b:ops' AND login='origin-reader'").bind(org).run();
 expect(await getWorkflow(env.DB,org,made.workflow.id,{viewerId:other})).toBeNull();
 expect(await getRun(env.DB,org,run.id,{viewerId:other})).toBeNull();
});

test('creation replies use the creator locale and escape workflow names in links',async()=>{
 const result=await generateWorkflow(env,request,org,{...who,user:{...who.user,locale:'ja'}},input,{makeCompleter:async()=>async()=>JSON.stringify({...spec,name:'請求 [確認]'})});
 expect(result.workflow).toBeTruthy();
 const reply=await env.DB.prepare("SELECT body FROM channel_messages WHERE org_id=? AND kind='ai'").bind(org).first();
 expect(reply.body).toContain('を作成しました。');
 expect(reply.body).toContain('自動実行は停止中です');
 expect(reply.body).toContain('請求 \\[確認\\]');
});

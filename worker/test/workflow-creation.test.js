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
 expect(await count('channel_messages')).toBe(1);
 const source=await workflowSource(env.DB,org,by,first.workflow.id);
 expect(source.source).toMatchObject({channel:'b:ops',body:input.prompt});
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
 expect(await count('channel_messages')).toBe(1);
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
 expect(await count('channel_messages')).toBe(1);
});
test('publication rolls back the workflow when its source disappears at commit',async()=>{
 const {createWorkflow}=await import('../src/harness/workflows.js');
 await expect(createWorkflow(env.DB,org,{...spec,enabled:false},by,{source:{channel:'b:ops',threadId:'missing',body:'Original prompt'}})).rejects.toThrow();
 expect(await count('hx_workflows')).toBe(0);
 expect(await count('hx_workflow_sources')).toBe(0);
});
test('publication rolls back when the request lease fence fails',async()=>{
 const {createWorkflow}=await import('../src/harness/workflows.js');
 await expect(createWorkflow(env.DB,org,{...spec,enabled:false},by,{commitGuard:()=>env.DB.prepare("INSERT INTO hx_workflow_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status) VALUES(?,?,'guard','fp','stale',0,'complete')").bind(org,by)})).rejects.toThrow();
 expect(await count('hx_workflows')).toBe(0);
 expect(await count('hx_workflow_generation_jobs')).toBe(0);
});

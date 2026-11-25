import {env} from 'cloudflare:test';
import {test,expect,beforeEach,vi} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {enqueueWorkflowProgram,settleWorkflowProgram,workflowProgramAccessCTE,workflowProgramJobAccess,workflowProgramTrigger} from '../src/harness/workflowCodeJobs.js';
import {ensureWorkflowSafety} from '../src/harness/workflowSafety.js';
import {readExecution,cancelExecution,enqueueExecution} from '../src/harness/executions.js';
import {expireGatewayJobs} from '../src/harness/gateways.js';
import worker from '../src/index.js';
import {createWorkflow,updateWorkflow,startRun,continueRun,normalizeSteps,cancelWorkflowRun,settleWorkflowApproval} from '../src/harness/workflows.js';
import {setMode} from '../src/harness/mode.js';
import {saveWorkspaceAIBudget} from '../src/workspaceAIBudget.js';
let definition;
beforeEach(async()=>{
 await upsertUser(env.DB,{githubId:'program-owner',login:'program-owner',name:'Owner'});
 await upsertMembership(env.DB,'program-org','program-owner','admin');
 const steps=[{type:'code',code:"import {state} from '@honmaru/workflow-sdk'; await state.get();",gatewayId:'program-node'}];
 await env.DB.prepare("INSERT INTO hx_gateways(id,org_id,name,token_hash,created_by,created_at) VALUES('program-node','program-org','Node','program-token','program-owner',1000)").run();
 await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES('program-wf','program-org','Program',1,'{\"type\":\"manual\"}',?1,'program-owner','now','now')").bind(JSON.stringify(steps)).run();
 const safety=await ensureWorkflowSafety(env.DB,'program-org','program-wf');
 definition={id:'program-wf',createdBy:'program-owner',steps,trigger:{type:'manual'},safetyGeneration:safety.generation};
 await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,input,log,started_at) VALUES('program-run','program-org','program-wf','manual','running','{\"count\":1}','[]','now')").run();
 await env.DB.prepare("INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES('program-run','program-org',?1,'now')").bind(JSON.stringify(definition)).run();
});
const enqueue=(extra={})=>enqueueWorkflowProgram(env.DB,{orgId:'program-org',runId:'program-run',at:2000,...extra});
test.each(['designer','engineer','triager','maintainer'])('a %s workflow maker can enqueue on an admin-owned node, but loses access after guest downgrade',async role=>{
 await upsertUser(env.DB,{githubId:'node-admin',login:'node-admin',name:'Node Admin'});
 await upsertMembership(env.DB,'program-org','node-admin','admin');
 await env.DB.prepare("UPDATE hx_gateways SET created_by='node-admin' WHERE id='program-node'").run();
 await env.DB.prepare("UPDATE memberships SET role=?1 WHERE org_id='program-org' AND user_github_id='program-owner'").bind(role).run();
 const result=await enqueue();
 expect(result).toMatchObject({status:'pending',jobId:expect.any(String)});
 const access=()=>env.DB.prepare(`${workflowProgramAccessCTE('?1')} SELECT (${workflowProgramJobAccess}) AS allowed FROM hx_gateway_jobs WHERE id=?2`).bind(3000,result.jobId).first();
 expect((await access()).allowed).toBe(1);
 await env.DB.prepare("UPDATE memberships SET role='guest' WHERE org_id='program-org' AND user_github_id='program-owner'").run();
 expect((await access()).allowed).toBe(0);
});

test('an otherwise permitted maker cannot use a node whose owner is not a workspace admin',async()=>{
 await upsertUser(env.DB,{githubId:'node-member',login:'node-member',name:'Node Member'});
 await upsertMembership(env.DB,'program-org','node-member','member');
 await env.DB.prepare("UPDATE hx_gateways SET created_by='node-member' WHERE id='program-node'").run();
 await env.DB.prepare("UPDATE memberships SET role='designer' WHERE org_id='program-org' AND user_github_id='program-owner'").run();
 expect(await enqueue()).toMatchObject({status:'failed',error:'Execution node is unavailable.'});
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_gateway_jobs WHERE org_id='program-org'").first()).n).toBe(0);
});

test('a permitted engineer workflow accepts an authorized program result',async()=>{
 await upsertUser(env.DB,{githubId:'node-admin',login:'node-admin',name:'Node Admin'});
 await upsertMembership(env.DB,'program-org','node-admin','admin');
 await env.DB.prepare("UPDATE hx_gateways SET created_by='node-admin' WHERE id='program-node'").run();
 await env.DB.prepare("UPDATE memberships SET role='engineer' WHERE org_id='program-org' AND user_github_id='program-owner'").run();
 const {jobId}=await enqueue();
 expect(jobId).toBeTruthy();
 await finishJob(jobId);
 expect(await settleWorkflowProgram(env.DB,jobId)).toEqual({settled:true});
 const run=await env.DB.prepare("SELECT status,log FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe('done');
 expect(JSON.parse(run.log)[0]).toMatchObject({output:'Program result',operationId:'workflow:program-run:step:1',startedAt:'1970-01-01T00:00:03.000Z',finishedAt:'1970-01-01T00:00:04.000Z',durationMs:1000});
});
test('normal workflow create, edit and start preserve a whole TypeScript program',async()=>{
 const created=await createWorkflow(env.DB,'program-org',{name:'Saved code',trigger:{type:'manual'},steps:definition.steps},'program-owner');
 expect(created.error).toBeUndefined();
 const code="const count: number = 7; console.log(count);";
 const updated=await updateWorkflow(env.DB,'program-org',created.workflow.id,{steps:[{...definition.steps[0],code}],expectedUpdatedAt:created.workflow.updatedAt});
 expect(updated.workflow.steps[0].code).toBe(code);
 const run=await startRun(env,{orgId:'program-org',workflow:updated.workflow,trigger:'manual',startedBy:'program-owner'});
 expect(run.status).toBe('running');expect(run.log[0]).toMatchObject({type:'code',status:'pending',operationId:`workflow:${run.id}:step:1`,startedAt:expect.any(String)});
 const jobId=run.log[0].jobId;
 expect(JSON.parse((await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).payload).code).toBe(code);
 await updateWorkflow(env.DB,'program-org',created.workflow.id,{steps:[{...definition.steps[0],code:'console.log("new revision")'}]});
 await continueRun(env,{orgId:'program-org',runId:run.id});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs').first()).n).toBe(1);
});
test('budget crossed after run admission blocks a TypeScript job before it enters the node queue',async()=>{
 await setMode(env.DB,'program-org','harness','program-owner');
 const at=new Date(Date.now()-1_000).toISOString();
 await saveWorkspaceAIBudget(env.DB,'program-org',{revision:0,dailyLimitUsd:0.000001,weeklyLimitUsd:0,monthlyLimitUsd:0,action:'pause'},'program-owner',at);
 const created=await createWorkflow(env.DB,'program-org',{name:'Budget raced code',trigger:{type:'manual'},steps:[{type:'code',code:'return 1;',gatewayId:'program-node'}]},'program-owner');
 expect(created.error).toBeUndefined();
 let crossed=false;
 const racingDb=new Proxy(env.DB,{get(db,key){
  if(key==='batch')return async statements=>{
   const result=await db.batch(statements);
   if(!crossed){
    crossed=true;
    await db.prepare(`INSERT INTO ai_calls(org_id,user_github_id,purpose,provider,model,input_tokens,output_tokens,usd,byok,created_at)
      VALUES('program-org','program-owner','ask','OpenAI','gpt-4o-mini',10,10,0.000002,0,?1)`).bind(at).run();
   }
   return result;
  };
  const value=db[key];return typeof value==='function'?value.bind(db):value;
 }});
 const run=await startRun({...env,DB:racingDb},{orgId:'program-org',workflow:created.workflow,trigger:'manual',startedBy:'program-owner'});
 expect(crossed).toBe(true);
 expect(run.status).toBe('failed');
 expect(run.log[0]).toMatchObject({type:'code',status:'failed',reason:'workspace_ai_budget'});
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs WHERE org_id=?1').bind('program-org').first()).toMatchObject({n:0});
});
test('program definitions reject mixed steps, missing nodes and source truncation',async()=>{
 expect(normalizeSteps([...definition.steps,{type:'post',channel:'b:ops',text:'hi'}]).error).toBeTruthy();
 expect(normalizeSteps([{...definition.steps[0],code:'あ'.repeat(16001)}]).error).toBeTruthy();
 const result=await createWorkflow(env.DB,'program-org',{name:'No node',trigger:{type:'manual'},steps:[{...definition.steps[0],gatewayId:'foreign-node'}]},'program-owner');
 expect(result.error).toBeTruthy();
});
test('queued programs are stopped if source permissions change before node claim',async()=>{
 const {jobId}=await enqueue();
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('program-org','program-wf','b:private','thread','program-owner')").run();
 await expireGatewayJobs(env.DB,3000);
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).status).toBe('failed');
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('failed');
});
test('row-trigger input is fenced when its app becomes private',async()=>{
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('program-table','program-org','Source','[]','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('program-app','program-org','Source','program-table','{}','someone-else','now','now')").run();
 definition.trigger={type:'row',tableId:'program-table'};
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 const {jobId}=await enqueue();expect(jobId).toBeTruthy();
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES('program-org','program-app','private',1)").run();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
 await expireGatewayJobs(env.DB,3000);
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).status).toBe('failed');
});
const finishJob=async(jobId,status='succeeded',finishedAt=4000)=>env.DB.prepare("UPDATE hx_gateway_jobs SET status=?2,started_at=3000,finished_at=?3,lease_until=90000,deadline=120000,result='{\"stdout\":\"Program result\",\"stderr\":\"\",\"exitCode\":0}' WHERE id=?1").bind(jobId,status,finishedAt).run();
test('workflow program claims allow fifteen minutes and heartbeat renews the job and activation checkpoint together',async()=>{
 const token=`hgw_${crypto.randomUUID()}${crypto.randomUUID()}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare("UPDATE hx_gateways SET token_hash=?1 WHERE id='program-node'").bind(hash).run();
 const {jobId}=await enqueue({at:Date.now()});
 const api=(path,body={})=>worker.fetch(new Request(`https://example.com/gateways${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 const claimed=await api('/claim',{capabilities:['workflow-program-v1']});expect(claimed.status).toBe(200);
 const {job}=await claimed.json();expect(job.id).toBe(jobId);expect(job.workflow).toBe(true);expect(job.timeoutMs).toBe(900000);
 const before=await env.DB.prepare("SELECT j.started_at,j.deadline,c.lease_until AS checkpoint_lease,j.lease_until AS job_lease FROM hx_gateway_jobs j JOIN hx_workflow_activations a ON a.job_id=j.id JOIN hx_workflow_node_checkpoints c ON c.org_id=a.org_id AND c.run_id=a.run_id AND c.node_id=a.node_id WHERE j.id=?1").bind(jobId).first();
 expect(before.deadline-before.started_at).toBe(930000);
 await env.DB.prepare("UPDATE hx_gateway_jobs SET lease_until=?2 WHERE id=?1").bind(jobId,Date.now()+50000).run();
 await env.DB.prepare("UPDATE hx_workflow_node_checkpoints SET lease_until=?1 WHERE org_id='program-org' AND run_id='program-run' AND node_id='program'").bind(Date.now()+50000).run();
 const heartbeat=await api(`/jobs/${jobId}/heartbeat`,{lease:job.lease});expect(heartbeat.status).toBe(200);
 const after=await env.DB.prepare("SELECT j.lease_until AS job_lease,c.lease_until AS checkpoint_lease FROM hx_gateway_jobs j JOIN hx_workflow_activations a ON a.job_id=j.id JOIN hx_workflow_node_checkpoints c ON c.org_id=a.org_id AND c.run_id=a.run_id AND c.node_id=a.node_id WHERE j.id=?1").bind(jobId).first();
 expect(after.job_lease).toBeGreaterThan(before.started_at+50000);
 expect(after.checkpoint_lease).toBeGreaterThan(after.job_lease);
});
test('an in-flight app-record program loses its heartbeat when the exact App entity is rebound',async()=>{
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('program-table','program-org','Details','[]','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('primary-table','program-org','Primary','[]','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('program-app','program-org','Source','primary-table','{}','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_app_entities(org_id,app_id,entity_key,table_id) VALUES('program-org','program-app','details','program-table')").run();
 definition.trigger={type:'app_record_change',appId:'program-app',entityId:'details',events:['update']};
 await env.DB.prepare("UPDATE hx_workflow_runs SET trigger='app_record_change',input=?1 WHERE id='program-run'").bind(JSON.stringify({tableId:'program-table',records:[{event:'update',appId:'program-app',entityId:'details',recordId:'row-1',data:{status:'open'}}],totalCount:1,truncated:false})).run();
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 const token=`hgw_${crypto.randomUUID()}${crypto.randomUUID()}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare("UPDATE hx_gateways SET token_hash=?1 WHERE id='program-node'").bind(hash).run();
 const {jobId}=await enqueue({at:Date.now()});expect(jobId).toBeTruthy();
 const api=(path,body={})=>worker.fetch(new Request(`https://example.com/gateways${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 const claimed=await api('/claim',{capabilities:['workflow-program-v1']});expect(claimed.status).toBe(200);
 const {job}=await claimed.json();expect(job.id).toBe(jobId);expect(job.workflow).toBe(true);
 await env.DB.prepare("UPDATE hx_app_entities SET table_id='primary-table' WHERE org_id='program-org' AND app_id='program-app' AND entity_key='details'").run();
 expect((await api(`/jobs/${jobId}/heartbeat`,{lease:job.lease})).status).toBe(409);
 expect((await api(`/jobs/${jobId}/finish`,{lease:job.lease,status:'succeeded',stdout:'must be rejected',stderr:'',exitCode:0})).status).toBe(409);
});
test.each([false,true])('node finish HTTP settles a program even after an interrupted reply: %s',async interrupted=>{
 const token=`hgw_${crypto.randomUUID()}${crypto.randomUUID()}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare("UPDATE hx_gateways SET token_hash=?1 WHERE id='program-node'").bind(hash).run();
 const {jobId}=await enqueue({at:Date.now()});
 const api=(path,body={})=>worker.fetch(new Request(`https://example.com/gateways${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 const legacy=await api('/claim');expect(legacy.status).toBe(200);expect((await legacy.json()).job).toBeNull();
 const ordinary=await enqueueExecution(env.DB,'program-org','program-owner',{gatewayId:'program-node',code:'return 42'});
 const legacyJob=(await (await api('/claim')).json()).job;
 expect(legacyJob.id).toBe(ordinary.job.id);expect(legacyJob.workflow).toBe(false);
 await cancelExecution(env.DB,'program-org','program-owner',ordinary.job.id);
 const claimed=await api('/claim',{capabilities:['workflow-program-v1']});expect(claimed.status).toBe(200);
 const {job}=await claimed.json();expect(job.id).toBe(jobId);expect(job.workflow).toBe(true);
 const result={stdout:'HTTP result',stderr:'',exitCode:0,messages:[{text:'The review is ready.',mention:['program-owner']}]};
 if(interrupted)await env.DB.prepare("UPDATE hx_gateway_jobs SET status='succeeded',result=?2,finished_at=?3 WHERE id=?1").bind(jobId,JSON.stringify(result),Date.now()).run();
 const complete=()=>api(`/jobs/${jobId}/finish`,{lease:job.lease,status:'succeeded',...result});
 expect((await complete()).status).toBe(interrupted?409:200);
 expect((await complete()).status).toBe(409);
 const run=await env.DB.prepare("SELECT status,log FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe('done');expect(JSON.parse(run.log)[0]).toMatchObject({output:'HTTP result',messages:[{text:'The review is ready.',mention:['program-owner']}]});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_outcomes').first()).n).toBe(1);
});
test('periodic reconciliation recovers terminal results and expires queued programs before checkpoint loss',async()=>{
 const {jobId}=await enqueue();await finishJob(jobId);
 await expireGatewayJobs(env.DB,5000);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('done');
});
test('offline program node cannot leave its workflow running forever',async()=>{
 await enqueue();await expireGatewayJobs(env.DB,183000);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('failed');
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs').first()).status).toBe('failed');
});
test('authorized cancellation settles the associated workflow',async()=>{
 const {jobId}=await enqueue();
 expect((await cancelExecution(env.DB,'program-org','program-owner',jobId)).job.status).toBe('cancelled');
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('cancelled');
});
test('cancelling a workflow immediately revokes its active code job lease',async()=>{
 const {jobId}=await enqueue();
 const at='2026-11-10T00:00:00.000Z';
 const startedAt='2026-11-09T23:59:00.000Z';
 await env.DB.prepare("UPDATE hx_workflow_runs SET started_at=?1 WHERE id='program-run'").bind(startedAt).run();
 const cancelled=await cancelWorkflowRun(env.DB,{orgId:'program-org',workflowId:'program-wf',runId:'program-run',expectedStartedAt:startedAt,actorId:'program-owner',at});
 expect(cancelled.error).toBeUndefined();
 expect((await env.DB.prepare('SELECT status,lease_hash,finished_at FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()))
  .toEqual({status:'cancelled',lease_hash:null,finished_at:Date.parse(at)});
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('cancelled');
});
test('terminal program result settles the run and checkpoint exactly once',async()=>{
 const {jobId}=await enqueue();
 expect(await settleWorkflowProgram(env.DB,jobId)).toEqual({settled:false});
 await finishJob(jobId);
 const results=await Promise.all([settleWorkflowProgram(env.DB,jobId),settleWorkflowProgram(env.DB,jobId)]);
 expect(results.filter(result=>result.settled)).toHaveLength(1);
 const run=await env.DB.prepare("SELECT * FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe('done');expect(run.next_step).toBe(1);expect(run.finished_at).toBe('1970-01-01T00:00:04.000Z');
 expect(JSON.parse(run.log)[0]).toMatchObject({type:'code',jobId,output:'Program result',status:'done'});
 const checkpoint=await env.DB.prepare("SELECT * FROM hx_workflow_node_checkpoints WHERE run_id='program-run'").first();
 expect(checkpoint.status).toBe('done');expect(JSON.parse(checkpoint.result).output).toBe('Program result');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_outcomes').first()).n).toBe(1);
});
test.each(['failed','timed_out','cancelled'])('%s program outcomes are terminal without duplicate failure accounting',async status=>{
 const {jobId}=await enqueue();await finishJob(jobId,status);
 await settleWorkflowProgram(env.DB,jobId);await settleWorkflowProgram(env.DB,jobId);
 const run=await env.DB.prepare("SELECT * FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe(status==='cancelled'?'cancelled':'failed');
 expect(JSON.parse(run.log)[0].error).toBeTruthy();
 expect((await env.DB.prepare("SELECT failure_streak FROM hx_workflow_safety WHERE workflow_id='program-wf'").first()).failure_streak).toBe(status==='cancelled'?0:1);
});
test.each(['lease','safety','node','source'])('successful job cannot bypass changed %s authority',async change=>{
 const {jobId}=await enqueue();await finishJob(jobId,'succeeded',change==='lease'?120000:4000);
 if(change==='safety')await env.DB.prepare("UPDATE hx_workflow_safety SET generation='new-generation' WHERE workflow_id='program-wf'").run();
 if(change==='node')await env.DB.prepare("UPDATE hx_gateways SET revoked_at=3500 WHERE id='program-node'").run();
 if(change==='source')await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('program-org','program-wf','b:private','thread','program-owner')").run();
 expect((await settleWorkflowProgram(env.DB,jobId)).settled).toBe(true);
 const run=await env.DB.prepare("SELECT * FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe('failed');expect(JSON.parse(run.log)[0].output).toBeNull();
});
test('late completion cannot overwrite a cancelled run or a reassigned checkpoint',async()=>{
 const {jobId}=await enqueue();await finishJob(jobId);
 await env.DB.prepare("UPDATE hx_workflow_node_checkpoints SET owner='replacement' WHERE run_id='program-run'").run();
 expect((await settleWorkflowProgram(env.DB,jobId)).settled).toBe(false);
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='cancelled' WHERE id='program-run'").run();
 expect((await settleWorkflowProgram(env.DB,jobId)).settled).toBe(false);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('cancelled');
});
test('program output and cancellation follow revoked source access, including a moved source',async()=>{
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_at) VALUES('program-org','private','Private',1,'now')").run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES('program-org','b:private','program-owner','now')").run();
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('program-org','program-wf','b:private','thread','program-owner')").run();
 const {jobId}=await enqueue();expect(jobId).toBeTruthy();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).job.id).toBe(jobId);
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id='program-org' AND channel='b:private'").run();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
 expect((await cancelExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
 await env.DB.prepare("DELETE FROM hx_workflow_sources WHERE workflow_id='program-wf'").run();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).status).toBe('queued');
});
test('app record programs receive Kylon records and are fenced if the app becomes private',async()=>{
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('program-table','program-org','Source','[]','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('program-app','program-org','Source','program-table','{}','someone-else','now','now')").run();
 definition.trigger={type:'app_record_change',appId:'program-app',entityId:'primary',events:['insert']};
 await env.DB.prepare("UPDATE hx_workflow_runs SET trigger='app_record_change',input=?1 WHERE id='program-run'").bind(JSON.stringify({tableId:'program-table',records:[{event:'insert',appId:'program-app',entityId:'primary',recordId:'row-1',data:{status:'open'}}],totalCount:1,truncated:false})).run();
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 const {jobId}=await enqueue();expect(jobId).toBeTruthy();
 const payload=JSON.parse((await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).payload);
 expect(payload.context.trigger).toEqual({kind:'app_record_change',records:[{event:'insert',appId:'program-app',entityId:'primary',recordId:'row-1',data:{status:'open'}}],totalCount:1,truncated:false});
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES('program-org','program-app','private',1)").run();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
 const authorization=await env.DB.prepare(`${workflowProgramAccessCTE('?1')} SELECT id,(${workflowProgramJobAccess}) AS allowed,NOT (${workflowProgramJobAccess}) AS blocked FROM hx_gateway_jobs WHERE id=?2`).bind(3000,jobId).first();
 expect(authorization).toMatchObject({id:jobId,allowed:0,blocked:1});
 const token=`hgw_${crypto.randomUUID()}${crypto.randomUUID()}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare("UPDATE hx_gateways SET token_hash=?1 WHERE id='program-node'").bind(hash).run();
 const response=await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({capabilities:['workflow-program-v1']})}),env,{waitUntil(){}});
 expect(response.status).toBe(200);expect((await response.json()).job).toBeNull();
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).status).toBe('failed');
});
test('TypeScript row triggers expose Kylon rows and preserve the original input',async()=>{
 const input={tableId:'source-table',recordId:'row-42',row:{id:'row-42',__rowId:'row-42',title:'Open order',Title:'Open order',status:'open',updatedAt:'2026-11-15T00:00:00.000Z'}};
 expect(workflowProgramTrigger('row',input)).toEqual({kind:'row',rows:[{event:'added',rowId:'row-42',title:'Open order',cells:{id:'row-42',title:'Open order',Title:'Open order',status:'open'}}],totalCount:1,truncated:false,input});
 expect(workflowProgramTrigger('row',{...input,before:{id:'row-42'}}).rows[0].event).toBe('changed');
 expect(workflowProgramTrigger('row',{tableId:'source-table',recordId:'row-42',event:'deleted',row:{id:'row-42'}})).toEqual({kind:'row',rows:[{event:'deleted',rowId:'row-42',title:null,cells:{}}],totalCount:1,truncated:false,input:{tableId:'source-table',recordId:'row-42',event:'deleted',row:{id:'row-42'}}});
});
test('queued row programs receive normalized SDK trigger fields',async()=>{
 const input={tableId:'source-table',recordId:'row-42',row:{id:'row-42',__rowId:'row-42',title:'Open order',status:'open'}};
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('source-table','program-org','Source','[]','program-owner','now','now')").run();
 definition.trigger={type:'row',tableId:'source-table'};
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 await env.DB.prepare("UPDATE hx_workflow_runs SET trigger='row',input=?1 WHERE id='program-run'").bind(JSON.stringify(input)).run();
 const result=await enqueue();expect(result.status).toBe('pending');const {jobId}=result;
 const payload=JSON.parse((await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).payload);
 expect(payload.context.trigger).toEqual(workflowProgramTrigger('row',input));
});
test('program output fails closed when its frozen definition is missing',async()=>{
 const {jobId}=await enqueue();
 await env.DB.prepare("DELETE FROM hx_workflow_run_definitions WHERE run_id='program-run'").run();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
});
test('run retention cannot turn a program output into an unscoped generic job',async()=>{
 const {jobId}=await enqueue();
 await env.DB.prepare("DELETE FROM hx_workflow_runs WHERE id='program-run'").run();
 expect((await readExecution(env.DB,'program-org','program-owner',jobId)).status).toBe(404);
});
test('program admission atomically binds one job to immutable code and initial input',async()=>{
 await env.DB.prepare("UPDATE hx_workflows SET steps='[]' WHERE id='program-wf'").run();
 const [a,b]=await Promise.all([enqueue({code:'not accepted'}),enqueue()]);
 expect([a,b].every(result=>result.status==='pending')).toBe(true);
 const jobs=(await env.DB.prepare('SELECT * FROM hx_gateway_jobs').all()).results;expect(jobs).toHaveLength(1);
 expect(JSON.parse(jobs[0].payload)).toEqual({workflowProgram:true,code:definition.steps[0].code,context:{workspaceId:'program-org',timezone:'UTC',trigger:{kind:'manual',input:{count:1}}}});
 const binding=await env.DB.prepare('SELECT * FROM hx_workflow_activations').first();expect(binding.job_id).toBe(jobs[0].id);
 expect(JSON.stringify(jobs[0].payload)).not.toContain(binding.node_owner);
 expect((await enqueue()).jobId).toBe(jobs[0].id);
});
test('revoked source access does not grant an execution',async()=>{
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_at) VALUES('program-org','private','Private',1,'now')").run();
 await env.DB.prepare("INSERT INTO hx_workflow_sources(org_id,workflow_id,channel,thread_id,created_by) VALUES('program-org','program-wf','b:private','thread','program-owner')").run();
 expect((await enqueue()).status).toBe('failed');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs').first()).n).toBe(0);
});
test('safety generation changes and unavailable nodes refuse admission',async()=>{
 await env.DB.prepare("UPDATE hx_workflow_safety SET generation='replacement' WHERE workflow_id='program-wf'").run();
 expect((await enqueue()).status).toBe('failed');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_activations').first()).n).toBe(0);
 await env.DB.prepare("UPDATE hx_gateways SET revoked_at=1500 WHERE id='program-node'").run();
 expect((await enqueue()).status).toBe('failed');
});
test('expired uncertain executions are not silently repeated',async()=>{
 const first=await enqueue();expect(first.status).toBe('pending');
 expect((await enqueue({at:302000})).status).toBe('failed');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs').first()).n).toBe(1);
});

test('a program requires a sole code definition and rejects oversized inputs without queuing',async()=>{
 const source=structuredClone(definition);source.steps.push({type:'post',channel:'b:ops',text:'Unexpected'});
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(source)).run();
 expect((await enqueue()).status).toBe('failed');
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 await env.DB.prepare("UPDATE hx_workflow_runs SET input=?1 WHERE id='program-run'").bind(JSON.stringify({text:'x'.repeat(66000)})).run();
 expect((await enqueue()).status).toBe('failed');
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs').first()).n).toBe(0);
});

async function setupProgramTableSource({privateApp=false,multiSource=false,writable=false,mutable=false}={}){
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('query-table','program-org','Query Source','[{\"id\":\"status\",\"name\":\"Status\",\"type\":\"text\"}]','program-owner','now','now')").run();
 await upsertUser(env.DB,{githubId:'query-app-owner',login:'query-app-owner',name:'App Owner'});
 await upsertMembership(env.DB,'program-org','query-app-owner','admin');
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('query-app','program-org','Query App','query-table','{}','query-app-owner','now','now')").run();
 if(multiSource){
  await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('query-details','program-org','Query Details','[{\"id\":\"kind\",\"name\":\"Kind\",\"type\":\"text\"}]','query-app-owner','now','now')").run();
  await env.DB.prepare("INSERT INTO hx_app_entities(org_id,app_id,entity_key,table_id) VALUES('program-org','query-app','details','query-details')").run();
  for(let index=1;index<=2;index++){
   const at=new Date(Date.now()-10000+index*1000).toISOString();
   await env.DB.prepare(`INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES(?1,'query-details','program-org',?2,?3,'query-app-owner',?4,?4)`)
    .bind(`query-detail-${index}`,JSON.stringify({kind:`detail-${index}`}),index,at).run();
  }
 }
 if(privateApp){
  await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES('program-org','query-app','private',1)").run();
  await env.DB.prepare("INSERT INTO hx_app_person_access(org_id,app_id,user_github_id,permission,updated_at) VALUES('program-org','query-app','program-owner','view','now')").run();
 }
 for(let index=1;index<=3;index++){
  const at=new Date(Date.now()-10000+index*1000).toISOString();
  await env.DB.prepare(`INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,created_at,updated_at)
   VALUES(?1,'query-table','program-org',?2,?3,'query-app-owner',?4,?4)`).bind(`query-row-${index}`,JSON.stringify({status:index===2?'closed':'open'}),index,at).run();
 }
 definition.steps=[{...definition.steps[0],sourceAppId:'query-app',...(writable||mutable?{sourceTables:[{entityId:'primary',tableId:'query-table',...(writable?{write:true}:{}),...(mutable?{mutate:true}:{})}]}:multiSource?{sourceTables:[{entityId:'primary',tableId:'query-table'},{entityId:'details',tableId:'query-details'}]}:{sourceEntityId:'primary',sourceTableId:'query-table'})}];
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 const queued=await enqueue({at:Date.now()});expect(queued.status).toBe('pending');
 const token=`hgw_${crypto.randomUUID()}${crypto.randomUUID()}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare("UPDATE hx_gateways SET token_hash=?1 WHERE id='program-node'").bind(hash).run();
 const api=(path,body={})=>worker.fetch(new Request(`https://example.com/gateways${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 const claimed=await api('/claim',{capabilities:['workflow-program-v1']});expect(claimed.status).toBe(200);
 const job=(await claimed.json()).job;expect(job.id).toBe(queued.jobId);expect(job.workflow).toBe(true);
 return {api,job,privateApp};
}

async function setupProgramConnectionSource({method='GET',write=false}={}){
 await upsertUser(env.DB,{githubId:'app-owner',login:'app-owner',name:'App Owner'});
 await upsertMembership(env.DB,'program-org','app-owner','admin');
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('connection-app','program-org','Connection App','connection-table','{}','app-owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES('program-org','connection-app','workspace',1)").run();
 await env.DB.prepare("INSERT INTO hx_app_connections(org_id,app_id,created_by,name,version,endpoint,method,enabled) VALUES('program-org','connection-app','program-owner','github_issues',1,'https://api.github.com/repos/example/project/issues',?1,1)").bind(method).run();
 definition.steps=[{...definition.steps[0],sourceConnections:[{appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method,...(write?{write:true}:{})}]}];
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 const queued=await enqueue({at:Date.now()});expect(queued.status).toBe('pending');
 const token=`hgw_${crypto.randomUUID()}${crypto.randomUUID()}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
 await env.DB.prepare("UPDATE hx_gateways SET token_hash=?1 WHERE id='program-node'").bind(hash).run();
 const api=(path,body={})=>worker.fetch(new Request(`https://example.com/gateways${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}),env,{waitUntil(){}});
 const claimed=await api('/claim',{capabilities:['workflow-program-v1']});expect(claimed.status).toBe(200);
 const job=(await claimed.json()).job;expect(job.id).toBe(queued.jobId);expect(job.workflow).toBe(true);
 return {api,job};
}

test('Workflow App connection references are frozen to their current owner and version',async()=>{
 await upsertUser(env.DB,{githubId:'app-owner',login:'app-owner',name:'App Owner'});
 await upsertMembership(env.DB,'program-org','app-owner','admin');
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('bound-app','program-org','Bound App','bound-table','{}','app-owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_app_connections(org_id,app_id,created_by,name,version,endpoint,method,enabled) VALUES('program-org','bound-app','program-owner','github_issues',1,'https://api.github.com/repos/example/project/issues','GET',1)").run();
 const code='import {connection} from \'@honmaru/workflow-sdk\';';
 const inputStep={type:'code',code,gatewayId:'program-node',sourceConnections:[{appId:'bound-app',name:'github_issues'}]};
 const created=await createWorkflow(env.DB,'program-org',{name:'Bound App connection',trigger:{type:'manual'},steps:[inputStep]},'program-owner');
 expect(created.error).toBeUndefined();
 expect(created.workflow.steps[0].sourceConnections).toEqual([{appId:'bound-app',name:'github_issues',ownerId:'program-owner',version:1,method:'GET'}]);
 await env.DB.prepare("INSERT INTO hx_app_connections(org_id,app_id,created_by,name,version,endpoint,method,enabled) VALUES('program-org','bound-app','program-owner','write_api',1,'https://api.github.com/repos/example/project/issues','POST',1)").run();
 const invalidWrite=await createWorkflow(env.DB,'program-org',{name:'Write connection',trigger:{type:'manual'},steps:[{...inputStep,sourceConnections:[{appId:'bound-app',name:'write_api',method:'POST'}]}]},'program-owner');
 const write=await createWorkflow(env.DB,'program-org',{name:'Write connection',trigger:{type:'manual'},steps:[{...inputStep,sourceConnections:[{appId:'bound-app',name:'write_api',method:'POST',write:true}]}]},'program-owner');
 expect(invalidWrite.error).toContain('non-GET connections require explicit write permission');
 expect(write.error).toBeUndefined();
 expect(write.workflow.steps[0].sourceConnections).toEqual([{appId:'bound-app',name:'write_api',ownerId:'program-owner',version:1,method:'POST',write:true}]);
 await env.DB.prepare("UPDATE hx_app_connections SET version=2 WHERE org_id='program-org' AND app_id='bound-app' AND name='github_issues'").run();
 const stale=await updateWorkflow(env.DB,'program-org',created.workflow.id,{steps:created.workflow.steps,expectedUpdatedAt:created.workflow.updatedAt});
 expect(stale.error).toContain('Re-select any connection that changed');
});

test('Workflow connection.request uses its pinned URL and drops the response when App access is revoked in flight',async()=>{
 const {api,job}=await setupProgramConnectionSource();
 let revoke=false;const fetch=vi.fn(async(url)=>{
  expect(new URL(String(url)).searchParams.get('state')).toBe('open');
  if(revoke)await env.DB.prepare("UPDATE hx_app_access SET visibility='private',version=version+1 WHERE org_id='program-org' AND app_id='connection-app'").run();
  return new Response(JSON.stringify({private:'provider response'}),{headers:{'content-type':'application/json'}});
 });
 vi.stubGlobal('fetch',fetch);
 try{
  const request={lease:job.lease,operation:'connection.request',params:{appId:'connection-app',name:'github_issues',query:{state:'open'}}};
  const allowed=await api(`/jobs/${job.id}/state`,request);
  expect(allowed.status).toBe(200);expect(await allowed.json()).toMatchObject({data:{private:'provider response'}});
  revoke=true;
  const response=await api(`/jobs/${job.id}/state`,request);
  expect(response.status).toBe(403);
  const denied=await response.json();
  expect(denied).toMatchObject({message:expect.stringContaining('result was discarded')});
  expect(JSON.stringify(denied)).not.toContain('provider response');
  expect(fetch).toHaveBeenCalledTimes(2);
  const injected=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'connection.request',params:{appId:'foreign-app',name:'github_issues'}});
  expect(injected.status).toBe(403);
 }finally{vi.unstubAllGlobals()}
});

test('Workflow App connection writes are staged for owner approval and never dispatched by the activation',async()=>{
 const {api,job}=await setupProgramConnectionSource({method:'POST',write:true});
 const fetch=vi.fn(async(url,init)=>{
  expect(String(url)).toBe('https://api.github.com/repos/example/project/issues');
  expect(init.method).toBe('POST');expect(JSON.parse(init.body)).toEqual({title:'Approved issue'});
  return new Response(JSON.stringify({number:41}),{headers:{'content-type':'application/json'}});
 });
 vi.stubGlobal('fetch',fetch);
 try{
  const params={appId:'connection-app',name:'github_issues',body:{title:'Approved issue'},operationId:'issue-41'};
  const direct=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'connection.request',params});
  expect(direct.status).toBe(400);
  const staged=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'connection.stageWrite',params});
  expect(staged.status).toBe(200);expect(await staged.json()).toMatchObject({staged:true});
  const invalidFinish=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'',stderr:'',exitCode:0,connectionWrites:[{appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'GET',operationId:'issue-41',body:{title:'x'}}]});
  expect(invalidFinish.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org' AND app_id='connection-app'").first()).n).toBe(0);
 }finally{vi.unstubAllGlobals()}
});

test('a staged App write waits for its owner and is sent once only after approval',async()=>{
 const {job,api}=await setupProgramConnectionSource({method:'POST',write:true});
 const requests=[{appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'POST',operationId:'issue-41',body:{title:'Approved issue'}},{appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'POST',operationId:'issue-42',body:{title:'Second approved issue'}}];
 const finished=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'Program result',stderr:'',exitCode:0,messages:[],connectionWrites:requests});
 expect(finished.status).toBe(200);
 const result=await env.DB.prepare("SELECT status,card_id FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(result.status).toBe('waiting');expect(result.card_id).toEqual(expect.any(String));
 const saved=await env.DB.prepare("SELECT recipient_user_id,data FROM cards WHERE org_id='program-org' AND card_id=?1").bind(result.card_id).first();
 const card=JSON.parse(saved.data);
 expect(saved.recipient_user_id).toBe('program-owner');
 expect(card.workflowApproval).toMatchObject({runId:'program-run',workflowId:'program-wf',codeWrite:{jobId:job.id,appId:'connection-app',name:'github_issues',method:'POST',writes:requests}});
 expect(card.context).toContain('Second approved issue');
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org'").first()).n).toBe(0);
 const fetch=vi.fn(async(_url,init)=>{
  expect(init.method).toBe('POST');
  const body=JSON.parse(init.body);
  expect(['Approved issue','Second approved issue']).toContain(body.title);
  return new Response(JSON.stringify({number:body.title==='Approved issue'?41:42}),{headers:{'content-type':'application/json'}});
 });vi.stubGlobal('fetch',fetch);
 try{
  const approved={...card,status:'approved',decision:{action:'approve',actorUserID:'program-owner',decidedAt:new Date().toISOString()}};
  await env.DB.prepare("UPDATE cards SET data=?1,status='approved' WHERE org_id='program-org' AND card_id=?2").bind(JSON.stringify(approved),result.card_id).run();
  const [settled,redelivery]=await Promise.all([settleWorkflowApproval(env,'program-org',approved),settleWorkflowProgram(env.DB,job.id)]);
  expect(settled.status).toBe('done');expect(redelivery.status).toBe('awaiting-approval-settlement');expect(fetch).toHaveBeenCalledTimes(2);
  expect(settled.log[0].externalWrites).toEqual(requests.map(({appId,name,method,operationId})=>({appId,name,method,operationId,status:'sent'})));
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org' AND app_id='connection-app' AND status='succeeded'").first()).n).toBe(2);
  expect(await settleWorkflowApproval(env,'program-org',approved)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
 }finally{vi.unstubAllGlobals()}
});

test('a pending single-write approval from before batch rollout remains executable',async()=>{
 const {job,api}=await setupProgramConnectionSource({method:'POST',write:true});
 const request={appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'POST',operationId:'legacy-issue-41',body:{title:'Legacy approved issue'}};
 const finished=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'Program result',stderr:'',exitCode:0,messages:[],connectionWrites:[request]});
 expect(finished.status).toBe(200);
 const run=await env.DB.prepare("SELECT status,card_id FROM hx_workflow_runs WHERE id='program-run'").first();
 const saved=await env.DB.prepare("SELECT data FROM cards WHERE org_id='program-org' AND card_id=?1").bind(run.card_id).first();
 const card=JSON.parse(saved.data),legacyCard={...card,workflowApproval:{...card.workflowApproval,codeWrite:{jobId:job.id,...request}}};
 await env.DB.prepare("UPDATE cards SET data=?1 WHERE org_id='program-org' AND card_id=?2").bind(JSON.stringify(legacyCard),run.card_id).run();
 const fetch=vi.fn(async()=>new Response('{}',{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
 try{
  const approved={...legacyCard,status:'approved',decision:{action:'approve',actorUserID:'program-owner',decidedAt:new Date().toISOString()}};
  await env.DB.prepare("UPDATE cards SET data=?1,status='approved' WHERE org_id='program-org' AND card_id=?2").bind(JSON.stringify(approved),run.card_id).run();
  const settled=await settleWorkflowApproval(env,'program-org',approved);
  expect(settled.status).toBe('done');expect(fetch).toHaveBeenCalledTimes(1);
  expect(settled.log[0].externalWrites).toEqual([{appId:request.appId,name:request.name,method:request.method,operationId:request.operationId,status:'sent'}]);
 }finally{vi.unstubAllGlobals()}
});

test('a failed write in an approved App batch records the uncertain tail and never replays it',async()=>{
 const {job,api}=await setupProgramConnectionSource({method:'POST',write:true});
 const requests=['one','two','three'].map((title,index)=>({appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'POST',operationId:`issue-${index+1}`,body:{title}}));
 const finished=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'Program result',stderr:'',exitCode:0,messages:[],connectionWrites:requests});
 expect(finished.status).toBe(200);
 const run=await env.DB.prepare("SELECT status,card_id FROM hx_workflow_runs WHERE id='program-run'").first();
 const saved=await env.DB.prepare("SELECT data FROM cards WHERE org_id='program-org' AND card_id=?1").bind(run.card_id).first();
 const card=JSON.parse(saved.data),fetch=vi.fn(async(_url,init)=>{
  const body=JSON.parse(init.body);
  if(body.title==='two')throw Error('provider response was lost');
  return new Response('{}',{headers:{'content-type':'application/json'}});
 });
 vi.stubGlobal('fetch',fetch);
 try{
  const approved={...card,status:'approved',decision:{action:'approve',actorUserID:'program-owner',decidedAt:new Date().toISOString()}};
  await env.DB.prepare("UPDATE cards SET data=?1,status='approved' WHERE org_id='program-org' AND card_id=?2").bind(JSON.stringify(approved),run.card_id).run();
  const settled=await settleWorkflowApproval(env,'program-org',approved);
  expect(settled.status).toBe('failed');
  expect(settled.log[0].externalWrites).toEqual([
   {appId:'connection-app',name:'github_issues',method:'POST',operationId:'issue-1',status:'sent'},
   {appId:'connection-app',name:'github_issues',method:'POST',operationId:'issue-2',status:'unknown'},
   {appId:'connection-app',name:'github_issues',method:'POST',operationId:'issue-3',status:'not_sent'},
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  await settleWorkflowApproval(env,'program-org',approved);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org' AND app_id='connection-app' AND status='succeeded'").first()).n).toBe(1);
 }finally{vi.unstubAllGlobals()}
});

test('the Worker rejects duplicate operation IDs and batches that mix App connections',async()=>{
 const {job,api}=await setupProgramConnectionSource({method:'POST',write:true});
 const base={appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'POST',body:{title:'x'}};
 const duplicate=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'',stderr:'',exitCode:0,connectionWrites:[{...base,operationId:'same'},{...base,operationId:'same'}]});
 expect(duplicate.status).toBe(400);
 const mixed=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'',stderr:'',exitCode:0,connectionWrites:[{...base,operationId:'one'},{...base,name:'other_connection',operationId:'two'}]});
 expect(mixed.status).toBe(400);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id='program-org'").first()).n).toBe(0);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org'").first()).n).toBe(0);
});

test('an empty staged App-write batch settles as a no-op',async()=>{
 const {job,api}=await setupProgramConnectionSource({method:'POST',write:true});
 const finished=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'No writes requested',stderr:'',exitCode:0,messages:[],connectionWrites:[]});
 expect(finished.status).toBe(200);
 const run=await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe('done');
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id='program-org'").first()).n).toBe(0);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org'").first()).n).toBe(0);
});

test('declining an external App write ends the run without dispatching or applying it',async()=>{
 const {job,api}=await setupProgramConnectionSource({method:'POST',write:true});
 const request={appId:'connection-app',name:'github_issues',ownerId:'program-owner',version:1,method:'POST',operationId:'issue-decline',body:{title:'Do not send'}};
 const finished=await api(`/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'',stderr:'',exitCode:0,messages:[],connectionWrites:[request]});
 expect(finished.status).toBe(200);
 const run=await env.DB.prepare("SELECT status,card_id FROM hx_workflow_runs WHERE id='program-run'").first();
 const stored=await env.DB.prepare("SELECT data FROM cards WHERE org_id='program-org' AND card_id=?1").bind(run.card_id).first();
 const card=JSON.parse(stored.data),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 try{
  const declined=await settleWorkflowApproval(env,'program-org',{...card,status:'declined',decision:{action:'decline',actorUserID:'program-owner'}});
  expect(declined.status).toBe('declined');expect(fetch).not.toHaveBeenCalled();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_app_connection_requests WHERE org_id='program-org'").first()).n).toBe(0);
 }finally{vi.unstubAllGlobals()}
});

test('saved TypeScript sources are normalized to explicit App entities and cannot name another workspace resource',async()=>{
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('saved-primary','program-org','Primary','[]','program-owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('saved-details','program-org','Details','[]','program-owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,table_id,definition,created_by,created_at,updated_at) VALUES('saved-app','program-org','Saved App','saved-primary','{}','program-owner','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_app_entities(org_id,app_id,entity_key,table_id) VALUES('program-org','saved-app','details','saved-details')").run();
 const step={type:'code',code:'import {table} from \'@honmaru/workflow-sdk\';',gatewayId:'program-node',sourceAppId:'saved-app',sourceEntityId:'details',sourceTableId:'saved-details'};
 const created=await createWorkflow(env.DB,'program-org',{name:'Bound source',trigger:{type:'manual'},steps:[step]},'program-owner');
 expect(created.error).toBeUndefined();expect(created.workflow.steps[0]).toMatchObject({sourceAppId:'saved-app',sourceEntityId:'details',sourceTableId:'saved-details'});
 const many=await createWorkflow(env.DB,'program-org',{name:'Bound multiple sources',trigger:{type:'manual'},steps:[{type:'code',code:step.code,gatewayId:'program-node',sourceAppId:'saved-app',sourceTables:[{entityId:'primary',tableId:'saved-primary'},{entityId:'details',tableId:'saved-details',write:true,mutate:true}]}]},'program-owner');
 expect(many.error).toBeUndefined();expect(many.workflow.steps[0].sourceTables).toEqual([{entityId:'primary',tableId:'saved-primary'},{entityId:'details',tableId:'saved-details',write:true,mutate:true}]);
 const invalidWrite=await normalizeSteps([{type:'code',code:step.code,gatewayId:'program-node',sourceAppId:'saved-app',sourceTables:[{entityId:'details',tableId:'saved-details',write:'yes'}]}]);
 expect(invalidWrite.error).toContain('distinct, complete App entities');
 const invalidMutation=await normalizeSteps([{type:'code',code:step.code,gatewayId:'program-node',sourceAppId:'saved-app',sourceTables:[{entityId:'details',tableId:'saved-details',mutate:'yes'}]}]);
 expect(invalidMutation.error).toContain('distinct, complete App entities');
 const duplicate=await createWorkflow(env.DB,'program-org',{name:'Duplicate sources',trigger:{type:'manual'},steps:[{type:'code',code:step.code,gatewayId:'program-node',sourceAppId:'saved-app',sourceTables:[{entityId:'primary',tableId:'saved-primary'},{entityId:'primary',tableId:'saved-primary'}]}]},'program-owner');
 expect(duplicate.error).toContain('distinct, complete App entities');
 const foreign=await env.DB.prepare("INSERT INTO hx_tables(id,org_id,name,columns,created_by,created_at,updated_at) VALUES('foreign-table','other-org','Foreign','[]','someone','now','now')").run();
 expect(foreign.meta.changes).toBe(1);
 const rejected=await createWorkflow(env.DB,'program-org',{name:'Foreign source',trigger:{type:'manual'},steps:[{...step,sourceAppId:'foreign-app',sourceTableId:'foreign-table'}]},'program-owner');
 expect(rejected.error).toContain('App/Table source');
});

test('saved TypeScript Agent bindings are explicit, bounded and rechecked at enqueue',async()=>{
 const code='await agent.invoke({agentId:"worker",prompt:"run",schema:{type:"object",properties:{},additionalProperties:false}});';
 expect(normalizeSteps([{type:'code',code,gatewayId:'program-node',sourceAgents:['agent-a','agent-b']}]).steps[0].sourceAgents).toEqual(['agent-a','agent-b']);
 for(const sourceAgents of [[],['agent-a','agent-a'],['  '],Array.from({length:21},(_,index)=>`agent-${index}`)])
  expect(normalizeSteps([{type:'code',code,gatewayId:'program-node',sourceAgents}]).error).toContain('distinct Agents');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES('program-org','worker-agent','worker','Worker','Do work','team','program-owner','now','now')").run();
 definition.steps=[{type:'code',code,gatewayId:'program-node',sourceAgents:['worker-agent']}];
 await env.DB.prepare("UPDATE hx_workflow_run_definitions SET definition=?1 WHERE run_id='program-run'").bind(JSON.stringify(definition)).run();
 expect((await enqueue({at:3000})).status).toBe('pending');
 await env.DB.prepare("UPDATE custom_agents SET deleted_at='now' WHERE org_id='program-org' AND id='worker-agent'").run();
 expect(await enqueue({at:4000})).toMatchObject({status:'failed',error:'A Workflow Agent binding is no longer accessible.'});
});

test('multi-entity table queries require a bound entity and scope cursors to the exact entity',async()=>{
 const {api,job}=await setupProgramTableSource({multiSource:true});
 const ambiguous=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:1}});
 expect(ambiguous.status).toBe(400);
 const first=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{entityId:'details',pageSize:1}});
 expect(first.status).toBe(200);const page=await first.json();
 expect(page.rows).toMatchObject([{id:'query-detail-1',tableId:'query-details',values:{kind:'detail-1'}}]);expect(page.complete).toBe(false);
 const next=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{entityId:'details',pageSize:1,cursor:page.cursor}});
 expect(await next.json()).toMatchObject({rows:[{id:'query-detail-2'}],complete:true});
 const injected=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{entityId:'unbound',pageSize:1}});
 expect(injected.status).toBe(404);
 const crossSourceCursor=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{entityId:'primary',pageSize:1,cursor:page.cursor}});
 expect(crossSourceCursor.status).toBe(400);
 const scopeInjection=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{entityId:'details',tableId:'other-table',pageSize:1}});
 expect(scopeInjection.status).toBe(400);
});

test('workflow table query pages the exact frozen App/Table source and denies scope or cursor injection',async()=>{
 const {api,job}=await setupProgramTableSource();
 const first=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:2}});
 expect(first.status).toBe(200);const page1=await first.json();
 expect(page1.rows.map(row=>row.id)).toEqual(['query-row-1','query-row-2']);
 expect(page1.complete).toBe(false);expect(page1.cursor).toEqual(expect.any(String));
 const second=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:2,cursor:page1.cursor}});
 expect(second.status).toBe(200);expect(await second.json()).toMatchObject({rows:[{id:'query-row-3'}],complete:true,cursor:null});
 const [payload,signature]=page1.cursor.split('.');
 const decode=value=>JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)));
 const encode=value=>btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/g,'');
 const cursorValue=decode(payload);
 for(const changed of [{...cursorValue,dataVersion:cursorValue.dataVersion+1},{...cursorValue,id:'query-row-999'}]){
  const tampered=`${encode(changed)}.${signature}`;
  const rejected=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:2,cursor:tampered}});
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({message:'Invalid App/Table query or cursor.'});
 }
 const filtered=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:2,where:{status:['closed']}}});
 expect((await filtered.json()).rows.map(row=>row.id)).toEqual(['query-row-2']);
 const escaped=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:2,tableId:'foreign-table',orgId:'other-org'}});
 expect(escaped.status).toBe(400);
 const invalidCursor=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:2,cursor:'not-a-cursor'}});
 expect(invalidCursor.status).toBe(400);
 const tooLarge=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:101}});
 expect(tooLarge.status).toBe(400);
});

test.each(['insert','update','delete'])('paged Workflow App reads restart when a row is %s between pages',async operation=>{
 const {api,job}=await setupProgramTableSource();
 const first=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:1}});
 expect(first.status).toBe(200);const page=await first.json();expect(page.complete).toBe(false);
 if(operation==='insert')await env.DB.prepare("INSERT INTO hx_rows(id,table_id,org_id,data,position,created_by,created_at,updated_at) VALUES('query-row-new','query-table','program-org','{}',4,'query-app-owner',?1,?1)").bind(new Date().toISOString()).run();
 if(operation==='update')await env.DB.prepare("UPDATE hx_rows SET data='{}',updated_at=?1 WHERE org_id='program-org' AND table_id='query-table' AND id='query-row-1'").bind(new Date().toISOString()).run();
 if(operation==='delete')await env.DB.prepare("DELETE FROM hx_rows WHERE org_id='program-org' AND table_id='query-table' AND id='query-row-1'").run();
 const next=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:1,cursor:page.cursor}});
 expect(next.status).toBe(409);
 expect(await next.json()).toMatchObject({message:'The App/Table changed during this scan. Restart the query to read a consistent result.'});
});

test('a TypeScript table.insert is staged by the authorized source and commits atomically with program settlement',async()=>{
 const {api,job}=await setupProgramTableSource({writable:true});
 const write=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.insert',params:{entityId:'primary',values:{status:'created'}}});
 expect(write.status).toBe(200);
 expect((await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.insert',params:{entityId:'primary',values:{status:'second'}}})).status).toBe(200);
 await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES('write-watcher','program-org','Write watcher',1,?1,'[]','program-owner','now','now')")
  .bind(JSON.stringify({type:'row',tableId:'query-table',on:'added'})).run();
 const completion={lease:job.lease,status:'succeeded',stdout:'Created',stderr:'',exitCode:0,tableWrites:[{entityId:'primary',values:{status:'created'}},{entityId:'primary',values:{status:'second'}}]};
 expect((await api(`/jobs/${job.id}/finish`,completion)).status).toBe(200);
 expect((await api(`/jobs/${job.id}/finish`,completion)).status).toBe(409);
 expect((await env.DB.prepare("SELECT position FROM hx_rows WHERE org_id='program-org' AND table_id='query-table' AND json_extract(data,'$.status') IN ('created','second') ORDER BY position").all()).results.map(row=>row.position)).toEqual([4,5]);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_workflow_row_event_outbox WHERE org_id='program-org' AND table_id='query-table' AND status='done'").first()).n).toBe(2);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('done');
});

test('staged row writes roll back when App edit access is revoked before final settlement',async()=>{
 const {api,job}=await setupProgramTableSource({writable:true});
 expect((await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.insert',params:{entityId:'primary',values:{status:'created'}}})).status).toBe(200);
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES('program-org','query-app','private',1)").run();
 await env.DB.prepare("INSERT INTO hx_app_person_access(org_id,app_id,user_github_id,permission,updated_at) VALUES('program-org','query-app','program-owner','view','now')").run();
 await env.DB.prepare("UPDATE hx_gateway_jobs SET status='succeeded',started_at=3000,finished_at=4000,lease_until=90000,deadline=120000,result=?2 WHERE id=?1")
  .bind(job.id,JSON.stringify({stdout:'Created',stderr:'',exitCode:0,tableWrites:[{entityId:'primary',values:{status:'created'}}]})).run();
 expect(await settleWorkflowProgram(env.DB,job.id)).toEqual({settled:true});
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_rows WHERE org_id='program-org' AND table_id='query-table' AND data='{\"status\":\"created\"}'").first()).n).toBe(0);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('failed');
});

test('explicitly authorized table.update and table.delete commit together after program success',async()=>{
 const {api,job}=await setupProgramTableSource({mutable:true});
 const before=(await env.DB.prepare("SELECT updated_at FROM hx_rows WHERE id='query-row-1'").first()).updated_at;
 const update=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.update',params:{entityId:'primary',rowId:'query-row-1',expectedUpdatedAt:before,values:{status:'updated'}}});
 expect(update.status).toBe(200);
 const remove=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.delete',params:{entityId:'primary',rowId:'query-row-2',expectedUpdatedAt:(await env.DB.prepare("SELECT updated_at FROM hx_rows WHERE id='query-row-2'").first()).updated_at}});
 expect(remove.status).toBe(200);
 const completion={lease:job.lease,status:'succeeded',stdout:'Changed records',stderr:'',exitCode:0,tableMutations:[
  {operation:'update',entityId:'primary',rowId:'query-row-1',expectedUpdatedAt:before,values:{status:'updated'}},
  {operation:'delete',entityId:'primary',rowId:'query-row-2',expectedUpdatedAt:(await env.DB.prepare("SELECT updated_at FROM hx_rows WHERE id='query-row-2'").first()).updated_at},
 ]};
 expect((await api(`/jobs/${job.id}/finish`,completion)).status).toBe(200);
 expect((await env.DB.prepare("SELECT json_extract(data,'$.status') AS status FROM hx_rows WHERE id='query-row-1'").first()).status).toBe('updated');
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_rows WHERE id='query-row-2'").first()).n).toBe(0);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE id='program-run'").first()).status).toBe('done');
});

test('table.update and table.delete require their separate explicit source permission',async()=>{
 const {api,job}=await setupProgramTableSource({writable:true});
 const response=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.delete',params:{entityId:'primary',rowId:'query-row-1',expectedUpdatedAt:(await env.DB.prepare("SELECT updated_at FROM hx_rows WHERE id='query-row-1'").first()).updated_at}});
 expect(response.status).toBe(403);
});

test('workflow table query marks a page-limited result incomplete and denies a revoked App source grant mid-run',async()=>{
 const {api,job}=await setupProgramTableSource({privateApp:true});
 const first=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:1}});
 expect(first.status).toBe(200);const page=await first.json();expect(page.complete).toBe(false);expect(page.cursor).toEqual(expect.any(String));
 await env.DB.prepare("DELETE FROM hx_app_person_access WHERE org_id='program-org' AND app_id='query-app' AND user_github_id='program-owner'").run();
 const second=await api(`/jobs/${job.id}/state`,{lease:job.lease,operation:'table.query',params:{pageSize:1,cursor:page.cursor}});
 expect(second.status).toBe(404);expect((await second.json()).message).toContain('no longer accessible');
});

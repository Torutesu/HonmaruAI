import {env} from 'cloudflare:test';
import {test,expect,beforeEach} from 'vitest';
import {upsertUser,upsertMembership} from '../src/db.js';
import {enqueueWorkflowProgram,settleWorkflowProgram} from '../src/harness/workflowCodeJobs.js';
import {ensureWorkflowSafety} from '../src/harness/workflowSafety.js';
import {readExecution,cancelExecution,enqueueExecution} from '../src/harness/executions.js';
import {expireGatewayJobs} from '../src/harness/gateways.js';
import worker from '../src/index.js';
import {createWorkflow,updateWorkflow,startRun,continueRun,normalizeSteps} from '../src/harness/workflows.js';
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
test('normal workflow create, edit and start preserve a whole TypeScript program',async()=>{
 const created=await createWorkflow(env.DB,'program-org',{name:'Saved code',trigger:{type:'manual'},steps:definition.steps},'program-owner');
 expect(created.error).toBeUndefined();
 const code="const count: number = 7; console.log(count);";
 const updated=await updateWorkflow(env.DB,'program-org',created.workflow.id,{steps:[{...definition.steps[0],code}],expectedUpdatedAt:created.workflow.updatedAt});
 expect(updated.workflow.steps[0].code).toBe(code);
 const run=await startRun(env,{orgId:'program-org',workflow:updated.workflow,trigger:'manual',startedBy:'program-owner'});
 expect(run.status).toBe('running');expect(run.log[0]).toMatchObject({type:'code',status:'pending'});
 const jobId=run.log[0].jobId;
 expect(JSON.parse((await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(jobId).first()).payload).code).toBe(code);
 await updateWorkflow(env.DB,'program-org',created.workflow.id,{steps:[{...definition.steps[0],code:'console.log("new revision")'}]});
 await continueRun(env,{orgId:'program-org',runId:run.id});
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_gateway_jobs').first()).n).toBe(1);
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
 const result={stdout:'HTTP result',stderr:'',exitCode:0};
 if(interrupted)await env.DB.prepare("UPDATE hx_gateway_jobs SET status='succeeded',result=?2,finished_at=?3 WHERE id=?1").bind(jobId,JSON.stringify(result),Date.now()).run();
 const complete=()=>api(`/jobs/${jobId}/finish`,{lease:job.lease,status:'succeeded',...result});
 expect((await complete()).status).toBe(interrupted?409:200);
 expect((await complete()).status).toBe(409);
 const run=await env.DB.prepare("SELECT status,log FROM hx_workflow_runs WHERE id='program-run'").first();
 expect(run.status).toBe('done');expect(JSON.parse(run.log)[0].output).toBe('HTTP result');
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

import {env} from 'cloudflare:test';
import {test,expect} from 'vitest';
import {recordWorkflowUsage,workflowRunUsage,estimateWorkflowUsageMicros} from '../src/harness/workflowUsage.js';
const orgId='personal:usage',workflowId='workflow-usage',runId='run-usage';
async function setup(){await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES(?1,?2,?3,'manual','running','[]',?4)").bind(runId,orgId,workflowId,new Date().toISOString()).run();}
const record=(data,over={})=>recordWorkflowUsage(env.DB,{orgId,workflowId,runId,stepNumber:1,data,provider:{provider:'Test',model:'test',byok:true},...over});
test('records rounds by step and retains unknown usage rather than claiming zero',async()=>{
 await setup();
 await record({usage:{prompt_tokens:10,completion_tokens:3}});
 await record({usage:{input_tokens:20,output_tokens:5}});
 await record({}, {stepNumber:2});
 await record({usage:{prompt_tokens:-1,completion_tokens:'7'}},{stepNumber:2});
 expect(await workflowRunUsage(env.DB,orgId,runId)).toMatchObject({calls:4,inputTokens:30,outputTokens:8,unknownCalls:2,steps:[{stepNumber:1,calls:2,unknownCalls:0},{stepNumber:2,calls:2,unknownCalls:2}]});
 expect((await workflowRunUsage(env.DB,'personal:other',runId)).calls).toBe(0);
 expect(await env.DB.prepare('SELECT byok FROM hx_workflow_usage WHERE org_id=?').bind(orgId).first()).toEqual({byok:1});
});
test('cannot attach another workspace or workflow to an existing run',async()=>{
 await setup();
 await expect(record({}, {orgId:'personal:other'})).rejects.toThrow('could not be recorded');
 await expect(record({}, {workflowId:'other'})).rejects.toThrow('could not be recorded');
 expect((await workflowRunUsage(env.DB,orgId,runId)).calls).toBe(0);
});
test('estimates only catalogued model token prices and keeps missing or unknown pricing unpriced',async()=>{
 expect(estimateWorkflowUsageMicros('gpt-4o-mini',1_000_000,1_000_000)).toBe(750_000);
 expect(estimateWorkflowUsageMicros('vendor/new-model',1_000,1_000)).toBeNull();
 expect(estimateWorkflowUsageMicros('gpt-4o-mini',null,1_000)).toBeNull();
 await setup();
 await record({model:'gpt-4o-mini',usage:{prompt_tokens:1_000_000,completion_tokens:1_000_000}});
 const stored=await env.DB.prepare('SELECT estimated_micros FROM hx_workflow_usage WHERE org_id=?1 AND run_id=?2').bind(orgId,runId).first();
 expect(stored.estimated_micros).toBe(750_000);
});

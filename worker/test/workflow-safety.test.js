import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schemaSql from '../schema.sql?raw';
import {ensureWorkflowSafety,readWorkflowSafety,resumeWorkflowSafety,workflowSettlementStatements,saveWorkflowBudget,workflowBudgetStatus,workflowBudgetWindows,recoverWorkflowBudgetPause,workflowBudgetReason} from '../src/harness/workflowSafety.js';
import {recordWorkflowUsage,reserveWorkflowBudgetCall} from '../src/harness/workflowUsage.js';
const org='safety',wf='wf';
beforeEach(async()=>{
 await env.DB.exec(schemaSql.replace(/\n/g,' '));
 await env.DB.prepare("INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES(?1,?2,'Safety',1,'{}','[]','owner','now','now')").bind(wf,org).run();
});
async function run(id,status,generation,startedAt='now'){
 await env.DB.batch([
  env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at) VALUES(?1,?2,?3,'manual',?4,'[]',?5)").bind(id,org,wf,status,startedAt),
  env.DB.prepare("INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES(?1,?2,?3,'now')").bind(id,org,JSON.stringify({safetyGeneration:generation})),
 ]);
}
const settle=id=>env.DB.batch(workflowSettlementStatements(env.DB,org,id));
test('three failures pause once and duplicate settlement does not increment twice',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 for(let n=1;n<=3;n++){
  await run('r'+n,'failed',generation);
  await Promise.all([settle('r'+n),settle('r'+n)]);
  expect((await readWorkflowSafety(env.DB,org,wf)).failure_streak).toBe(n);
 }
 expect(await readWorkflowSafety(env.DB,org,wf)).toMatchObject({pause_reason:'consecutive_failures'});
 const notices=await env.DB.prepare('SELECT recipient_id,run_id FROM hx_workflow_safety_notices WHERE org_id=?1').bind(org).all();
 expect(notices.results).toEqual([{recipient_id:'owner',run_id:'r3'}]);
});
test('success and decline reset failures; waiting does not count; foreign workspace does not settle',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 for(const [id,status] of [['f','failed'],['w','waiting'],['d','done'],['f2','failed'],['no','declined']]){await run(id,status,generation);await settle(id);}
 expect((await readWorkflowSafety(env.DB,org,wf)).failure_streak).toBe(0);
 await run('foreign','failed',generation);
 await env.DB.batch(workflowSettlementStatements(env.DB,'elsewhere','foreign'));
 expect((await readWorkflowSafety(env.DB,org,wf)).failure_streak).toBe(0);
});
test('resume changes generation so late old results cannot pause the resumed workflow',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await run('late','failed',generation);
 expect(await resumeWorkflowSafety(env.DB,org,wf,generation)).toBe(true);
 expect(await resumeWorkflowSafety(env.DB,org,wf,generation)).toBe(false);
 await settle('late');
 const current=await readWorkflowSafety(env.DB,org,wf);
 expect(current.generation).not.toBe(generation);
 expect(current.failure_streak).toBe(0);
 expect(await ensureWorkflowSafety(env.DB,'elsewhere',wf)).toBeNull();
});
test('settlement rolls back with the terminal-state transaction',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);await run('atomic','running',generation);
 await expect(env.DB.batch([
  env.DB.prepare("UPDATE hx_workflow_runs SET status='failed' WHERE org_id=?1 AND id='atomic'").bind(org),
  ...workflowSettlementStatements(env.DB,org,'atomic'),
  env.DB.prepare('INSERT INTO table_that_does_not_exist VALUES(1)'),
 ])).rejects.toThrow();
 expect((await readWorkflowSafety(env.DB,org,wf)).failure_streak).toBe(0);
 expect((await env.DB.prepare("SELECT status FROM hx_workflow_runs WHERE org_id=?1 AND id='atomic'").bind(org).first()).status).toBe('running');
});
test('UTC budget windows reset daily at midnight, weekly on Monday, and monthly on day one',()=>{
 const w=workflowBudgetWindows(Date.parse('2026-10-26T12:00:00.000Z'));
 expect(w).toMatchObject({dailyStart:'2026-10-26T00:00:00.000Z',dailyReset:'2026-10-27T00:00:00.000Z',weeklyStart:'2026-10-26T00:00:00.000Z',weeklyReset:'2026-11-02T00:00:00.000Z',monthlyStart:'2026-10-01T00:00:00.000Z',monthlyReset:'2026-11-01T00:00:00.000Z'});
});
test('run budgets use compare-and-swap settings, pause at the cap, and recover after the window resets',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 const saved=await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:1,weeklyLimit:2,monthlyLimit:3});
 expect(saved).toMatchObject({budget:{revision:1,daily:{limit:1,used:0,exhausted:false},weekly:{limit:2,used:0},monthly:{limit:3,used:0}}});
 expect(await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:4,weeklyLimit:0,monthlyLimit:0})).toMatchObject({status:409});
 await run('budget-run','done',generation,new Date(Date.now()-1000).toISOString());
 await settle('budget-run');
 expect((await readWorkflowSafety(env.DB,org,wf)).pause_reason).toBe('budget_daily');
 expect((await workflowBudgetStatus(env.DB,org,wf)).daily).toMatchObject({limit:1,used:1,exhausted:true});
 const safety=await readWorkflowSafety(env.DB,org,wf);
 const held=await recoverWorkflowBudgetPause(env.DB,org,wf,safety);
 expect(held.paused_at).not.toBeNull();
 await env.DB.prepare("UPDATE hx_workflow_runs SET started_at='2000-01-01T00:00:00.000Z' WHERE org_id=?1 AND id='budget-run'").bind(org).run();
 const recovered=await recoverWorkflowBudgetPause(env.DB,org,wf,await readWorkflowSafety(env.DB,org,wf));
 expect(recovered).toMatchObject({paused_at:null,pause_reason:null,failure_streak:0});
 expect(recovered.generation).not.toBe(generation);
});
test('USD budget accepts cent fractions despite floating point representation and rejects more than six decimals',async()=>{
 await ensureWorkflowSafety(env.DB,org,wf);
 const saved=await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:1.005,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'warn'});
 expect(saved.budget.ai['24h'].limitUsd).toBe(1.005);
 expect(await saveWorkflowBudget(env.DB,org,wf,{revision:1,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:0.0000001,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'warn'})).toMatchObject({status:400});
});
test('rolling AI spend budgets use catalogued token estimates, CAS settings, pause, and recover',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await run('ai-budget-run','done',generation,new Date().toISOString());
 await env.DB.prepare("INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros) VALUES('ai-usage',?1,?2,'ai-budget-run',1,'OpenAI','gpt-4o-mini',1000000,0,1,?3,150000)").bind(org,wf,new Date().toISOString()).run();
 const saved=await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 expect(saved).toMatchObject({budget:{revision:1,ai:{action:'pause','24h':{limitUsd:.1,usedUsd:.15,exhausted:true}}},safety:{paused_at:expect.any(String),pause_reason:'budget_ai_24h'}});
 expect(await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'})).toMatchObject({status:409});
 const safety=await readWorkflowSafety(env.DB,org,wf);
 const held=await recoverWorkflowBudgetPause(env.DB,org,wf,safety);
 expect(held.pause_reason).toBe('budget_ai_24h');
 await env.DB.prepare("UPDATE hx_workflow_usage SET created_at='2000-01-01T00:00:00.000Z' WHERE org_id=?1 AND id='ai-usage'").bind(org).run();
 const recovered=await recoverWorkflowBudgetPause(env.DB,org,wf,await readWorkflowSafety(env.DB,org,wf));
 expect(recovered).toMatchObject({paused_at:null,pause_reason:null});
 expect(recovered.generation).not.toBe(generation);
});
test('unknown AI cost pauses only when a workflow opted into pause mode',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await run('unknown-ai-run','done',generation,new Date().toISOString());
 await env.DB.prepare("INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros) VALUES('unknown-usage',?1,?2,'unknown-ai-run',1,'Unknown','new-model',NULL,NULL,0,?3,NULL)").bind(org,wf,new Date().toISOString()).run();
 const saved=await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 expect(saved).toMatchObject({safety:{paused_at:expect.any(String),pause_reason:'budget_ai_unpriced'},budget:{ai:{'24h':{unpricedCalls:1,exhausted:false}}}});
});
test('run settlement atomically pauses after its recorded token estimate exceeds a pause-mode cap',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 const now=new Date().toISOString();
 await run('settled-ai-cap','done',generation,now);
 await env.DB.prepare("INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros) VALUES('settled-ai-usage',?1,?2,'settled-ai-cap',1,'OpenAI','gpt-4o-mini',1000000,0,0,?3,150000)").bind(org,wf,now).run();
 await settle('settled-ai-cap');
 expect(await readWorkflowSafety(env.DB,org,wf)).toMatchObject({paused_at:expect.any(String),pause_reason:'budget_ai_24h'});
 expect(await env.DB.prepare('SELECT run_id,recipient_id FROM hx_workflow_safety_notices WHERE org_id=?1 AND workflow_id=?2').bind(org,wf).first()).toMatchObject({run_id:'settled-ai-cap',recipient_id:'owner'});
});
test('warn mode creates a durable notice without pausing the workflow after its rolling cap',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'warn'});
 await run('ai-warn-run','done',generation,new Date().toISOString());
 await env.DB.prepare("INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros) VALUES('warn-usage',?1,?2,'ai-warn-run',1,'OpenAI','gpt-4o-mini',1000000,0,0,?3,150000)").bind(org,wf,new Date().toISOString()).run();
 await settle('ai-warn-run');
 expect(await readWorkflowSafety(env.DB,org,wf)).toMatchObject({paused_at:null,pause_reason:null});
 expect(await env.DB.prepare("SELECT period,estimated_micros,limit_micros FROM hx_workflow_ai_budget_notices WHERE org_id=?1 AND workflow_id=?2").bind(org,wf).all()).toMatchObject({results:[{period:'24h',estimated_micros:150000,limit_micros:100000}]});
});
test('pause-mode workflow AI reserves before dispatch and atomically replaces the hold with actual usage',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.01,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 await run('reserve-run','running',generation);
 const reservation=await reserveWorkflowBudgetCall(env.DB,{orgId:org,workflowId:wf,runId:'reserve-run',stepNumber:1,model:'gpt-4o-mini',inputTokens:10000,outputTokens:10000,provider:'OpenAI'});
 expect(reservation).toMatchObject({allowed:true,reservationId:expect.any(String),reservedMicros:7500});
 expect((await workflowBudgetStatus(env.DB,org,wf)).ai['24h']).toMatchObject({usedMicros:0,reservedMicros:7500,projectedMicros:7500,exhausted:false});
 await recordWorkflowUsage(env.DB,{orgId:org,workflowId:wf,runId:'reserve-run',stepNumber:1,data:{model:'gpt-4o-mini',usage:{prompt_tokens:1000,completion_tokens:200}},provider:{provider:'OpenAI',model:'gpt-4o-mini',byok:false},reservationId:reservation.reservationId});
 const status=await workflowBudgetStatus(env.DB,org,wf);
 expect(status.ai['24h'].reservedMicros).toBe(0);
 expect(status.ai['24h'].usedMicros).toBeGreaterThan(0);
 expect(await env.DB.prepare('SELECT status FROM hx_workflow_ai_budget_reservations WHERE id=?1').bind(reservation.reservationId).first()).toMatchObject({status:'settled'});
});
test('concurrent model requests cannot reserve the same remaining workflow budget twice',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.01,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 await run('concurrent-budget-run','running',generation);
 const input={orgId:org,workflowId:wf,runId:'concurrent-budget-run',stepNumber:1,model:'gpt-4o-mini',inputTokens:10000,outputTokens:10000,provider:'OpenAI'};
 const results=await Promise.all([reserveWorkflowBudgetCall(env.DB,input),reserveWorkflowBudgetCall(env.DB,input)]);
 expect(results.filter(result=>result.allowed)).toHaveLength(1);
 expect(results.filter(result=>!result.allowed)).toMatchObject([{reason:'budget_ai_24h'}]);
 expect(await readWorkflowSafety(env.DB,org,wf)).toMatchObject({pause_reason:'budget_ai_24h',paused_at:expect.any(String)});
 expect((await workflowBudgetStatus(env.DB,org,wf)).ai['24h'].projectedMicros).toBeGreaterThan(10000);
});
test('an over-budget request is blocked before dispatch and a higher CAS limit recovers the workflow',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.000001,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 await run('blocked-budget-run','running',generation);
 const blocked=await reserveWorkflowBudgetCall(env.DB,{orgId:org,workflowId:wf,runId:'blocked-budget-run',stepNumber:1,model:'gpt-4o-mini',inputTokens:1000,outputTokens:500,provider:'OpenAI'});
 expect(blocked).toMatchObject({allowed:false,reason:'budget_ai_24h'});
 expect(await readWorkflowSafety(env.DB,org,wf)).toMatchObject({pause_reason:'budget_ai_24h',paused_at:expect.any(String)});
 expect(await env.DB.prepare("SELECT status FROM hx_workflow_ai_budget_reservations WHERE org_id=?1 AND workflow_id=?2").bind(org,wf).first()).toMatchObject({status:'blocked'});
 const recovered=await saveWorkflowBudget(env.DB,org,wf,{revision:1,dailyLimit:1,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 expect(recovered.safety.paused_at).not.toBeNull(); // The current run must finish before a budget change resumes its workflow.
 expect(workflowBudgetReason(recovered.budget)).toBeNull();
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='failed',finished_at=?1 WHERE org_id=?2 AND id='blocked-budget-run'").bind(new Date().toISOString(),org).run();
 const resumed=await recoverWorkflowBudgetPause(env.DB,org,wf,await readWorkflowSafety(env.DB,org,wf));
 expect(resumed).toMatchObject({paused_at:null,pause_reason:null});
});
test('BYOK skips workflow budget reservation and expired in-flight holds settle as unknown usage',async()=>{
 const {generation}=await ensureWorkflowSafety(env.DB,org,wf);
 await saveWorkflowBudget(env.DB,org,wf,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.01,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'pause'});
 await run('unknown-budget-run','running',generation);
 expect(await reserveWorkflowBudgetCall(env.DB,{orgId:org,workflowId:wf,runId:'unknown-budget-run',stepNumber:1,model:'gpt-4o-mini',inputTokens:10000,outputTokens:10000,byok:true})).toEqual({allowed:true,reservationId:null});
 const expiredAt=Date.now()-400_000;
 const held=await reserveWorkflowBudgetCall(env.DB,{orgId:org,workflowId:wf,runId:'unknown-budget-run',stepNumber:1,model:'gpt-4o-mini',inputTokens:1000,outputTokens:500,now:expiredAt});
 expect(held.allowed).toBe(true);
 const next=await reserveWorkflowBudgetCall(env.DB,{orgId:org,workflowId:wf,runId:'unknown-budget-run',stepNumber:1,model:'gpt-4o-mini',inputTokens:1000,outputTokens:500});
 expect(next).toMatchObject({allowed:false,reason:'budget_ai_unpriced'});
 expect(await env.DB.prepare('SELECT input_tokens,output_tokens,estimated_micros FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2').bind(org,wf).first()).toMatchObject({input_tokens:null,output_tokens:null,estimated_micros:null});
});

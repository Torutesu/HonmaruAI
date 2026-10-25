import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import schemaSql from '../schema.sql?raw';
import {ensureWorkflowSafety,readWorkflowSafety,resumeWorkflowSafety,workflowSettlementStatements,saveWorkflowBudget,workflowBudgetStatus,workflowBudgetWindows,recoverWorkflowBudgetPause} from '../src/harness/workflowSafety.js';
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

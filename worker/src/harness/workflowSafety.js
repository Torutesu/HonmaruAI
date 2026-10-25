// Operational safety is independent of the published workflow definition.
// These helpers are internal: routes must authorize workflow access first.
import {estimateWorkflowUsageMicros} from './workflowUsage.js';
export async function ensureWorkflowSafety(db, orgId, workflowId) {
  await db.prepare(`INSERT OR IGNORE INTO hx_workflow_safety(org_id,workflow_id,generation)
    SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?1 AND id=?2)`)
    .bind(orgId,workflowId,crypto.randomUUID()).run();
  return readWorkflowSafety(db,orgId,workflowId);
}
export async function readWorkflowSafety(db,orgId,workflowId) {
  return db.prepare('SELECT generation,failure_streak,paused_at,pause_reason,daily_run_limit,weekly_run_limit,monthly_run_limit,budget_revision,daily_ai_budget_micros,weekly_ai_budget_micros,monthly_ai_budget_micros,ai_budget_action FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
}
const DAY=86_400_000;
const AI_WINDOWS=[['24h','daily_ai_budget_micros',DAY],['7d','weekly_ai_budget_micros',7*DAY],['30d','monthly_ai_budget_micros',30*DAY]];
const usdFromMicros=value=>Math.round((Number(value)||0))/1_000_000;
export function workflowBudgetWindows(now=Date.now()) {
  const date=new Date(now), day=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
  const week=day-((date.getUTCDay()+6)%7)*DAY;
  const month=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1);
  return {dailyStart:new Date(day).toISOString(),dailyReset:new Date(day+DAY).toISOString(),weeklyStart:new Date(week).toISOString(),weeklyReset:new Date(week+7*DAY).toISOString(),monthlyStart:new Date(month).toISOString(),monthlyReset:new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)).toISOString()};
}
export function workflowAiBudgetWindows(now=Date.now()) {
  return Object.fromEntries(AI_WINDOWS.map(([key,,duration])=>[key,{start:new Date(now-duration).toISOString(),resetAt:null,duration}]));
}
export async function workflowBudgetStatus(db,orgId,workflowId,now=Date.now()) {
  const safety=await db.prepare('SELECT daily_run_limit,weekly_run_limit,monthly_run_limit,budget_revision,daily_ai_budget_micros,weekly_ai_budget_micros,monthly_ai_budget_micros,ai_budget_action FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
  if(!safety)return null;
  const windows=workflowBudgetWindows(now);
  const used=await db.prepare(`SELECT
    SUM(CASE WHEN started_at>=?3 THEN 1 ELSE 0 END) AS daily,
    SUM(CASE WHEN started_at>=?4 THEN 1 ELSE 0 END) AS weekly,
    SUM(CASE WHEN started_at>=?5 THEN 1 ELSE 0 END) AS monthly
    FROM hx_workflow_runs WHERE org_id=?1 AND workflow_id=?2 AND started_at<=?6`).bind(orgId,workflowId,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,new Date(now).toISOString()).first();
  const period=(limit,count,resetAt)=>({limit:Number(limit)||0,used:Number(count)||0,resetAt,exhausted:Number(limit)>0&&Number(count)>=Number(limit)});
  const aiWindows=workflowAiBudgetWindows(now),floor=aiWindows['30d'].start;
  const usage=await db.prepare('SELECT id,model,input_tokens,output_tokens,estimated_micros,created_at FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?3 AND created_at<=?4 ORDER BY created_at,id').bind(orgId,workflowId,floor,new Date(now).toISOString()).all();
  const updates=[];
  for(const row of usage.results||[]){
    if(row.estimated_micros!==null&&row.estimated_micros!==undefined)continue;
    const estimate=estimateWorkflowUsageMicros(row.model,row.input_tokens,row.output_tokens);
    if(estimate!==null){row.estimated_micros=estimate;updates.push(db.prepare('UPDATE hx_workflow_usage SET estimated_micros=?1 WHERE id=?2 AND org_id=?3 AND estimated_micros IS NULL').bind(estimate,row.id,orgId));}
  }
  for(let i=0;i<updates.length;i+=50)await db.batch(updates.slice(i,i+50));
  const ai=Object.fromEntries(AI_WINDOWS.map(([key,column,duration])=>{
    const start=aiWindows[key].start,rows=(usage.results||[]).filter(row=>row.created_at>=start);
    const usedMicros=rows.reduce((sum,row)=>sum+(Number(row.estimated_micros)||0),0);
    const unpricedCalls=rows.filter(row=>row.estimated_micros===null||row.estimated_micros===undefined).length;
    const limitMicros=Math.max(0,Number(safety[column])||0);
    let resetAt=null;
    if(limitMicros>0&&(usedMicros>=limitMicros||unpricedCalls)){
      let remaining=usedMicros,knownReset=null;
      for(const row of rows){remaining-=Number(row.estimated_micros)||0;if(remaining<limitMicros){knownReset=new Date(Date.parse(row.created_at)+duration).toISOString();break;}}
      const unknownReset=rows.filter(row=>row.estimated_micros===null||row.estimated_micros===undefined).map(row=>Date.parse(row.created_at)+duration).sort((a,b)=>b-a)[0];
      resetAt=new Date(Math.max(knownReset?Date.parse(knownReset):0,unknownReset||0)||now+duration).toISOString();
    }
    const exhausted=limitMicros>0&&usedMicros>=limitMicros;
    return [key,{limitMicros,limitUsd:usdFromMicros(limitMicros),usedMicros,usedUsd:usdFromMicros(usedMicros),unpricedCalls,resetAt,exhausted}];
  }));
  return {revision:Number(safety.budget_revision)||0,daily:period(safety.daily_run_limit,used?.daily,windows.dailyReset),weekly:period(safety.weekly_run_limit,used?.weekly,windows.weeklyReset),monthly:period(safety.monthly_run_limit,used?.monthly,windows.monthlyReset),ai:{revision:Number(safety.budget_revision)||0,action:safety.ai_budget_action==='pause'?'pause':'warn',...ai}};
}
export function workflowBudgetReason(budget) {
  if(!budget)return null;
  for(const key of ['daily','weekly','monthly'])if(budget[key]?.exhausted)return `budget_${key}`;
  if(budget.ai?.action==='pause'){
    const active=AI_WINDOWS.map(([key,column])=>[key,budget.ai[key],column]).filter(([,period])=>period?.limitMicros>0);
    if(active.some(([,period])=>period.unpricedCalls>0))return 'budget_ai_unpriced';
    for(const [key,period] of active)if(period.exhausted)return `budget_ai_${key}`;
  }
  return null;
}
export async function saveWorkflowBudget(db,orgId,workflowId,input={}) {
  const current=await ensureWorkflowSafety(db,orgId,workflowId);
  if(!current)return {error:'No such workflow.',status:404};
  const names=['dailyLimit','weeklyLimit','monthlyLimit'];
  const limits=names.map(name=>input[name]);
  if(limits.some(value=>!Number.isSafeInteger(value)||value<0||value>1_000_000))return {error:'Run limits must be whole numbers from 0 to 1,000,000. Use 0 for unlimited.',status:400};
  if(!Number.isSafeInteger(input.revision)||input.revision<0)return {error:'Reload the workflow before changing its run budget.',status:400};
  const aiFields=['dailyAiLimitUsd','weeklyAiLimitUsd','monthlyAiLimitUsd'];
  const aiLimits=aiFields.map((name,index)=>{
    const old=[current.daily_ai_budget_micros,current.weekly_ai_budget_micros,current.monthly_ai_budget_micros][index];
    const value=input[name]===undefined?Number(old||0)/1_000_000:Number(input[name]);
    const micros=value*1_000_000;
    if(!Number.isFinite(value)||value<0||value>1_000_000||Math.abs(micros-Math.round(micros))>=0.001)return null;
    return Math.round(micros);
  });
  if(aiLimits.some(value=>value===null))return {error:'AI budget limits must be USD amounts from 0 to 1,000,000 with up to six decimal places. Use 0 for unlimited.',status:400};
  const action=input.aiBudgetAction===undefined?(current.ai_budget_action==='pause'?'pause':'warn'):input.aiBudgetAction;
  if(!['warn','pause'].includes(action))return {error:'Choose whether to warn or pause when the estimated AI budget is reached.',status:400};
  const result=await db.prepare(`UPDATE hx_workflow_safety SET daily_run_limit=?1,weekly_run_limit=?2,monthly_run_limit=?3,daily_ai_budget_micros=?4,weekly_ai_budget_micros=?5,monthly_ai_budget_micros=?6,ai_budget_action=?7,budget_revision=budget_revision+1
    WHERE org_id=?8 AND workflow_id=?9 AND budget_revision=?10 AND EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?8 AND id=?9)`)
    .bind(...limits,...aiLimits,action,orgId,workflowId,input.revision).run();
  if(!result.meta?.changes){
    const exists=await db.prepare('SELECT 1 FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
    return exists?{error:'The workflow state changed. Reload before saving its budget.',status:409}:{error:'No such workflow.',status:404};
  }
  const budgetAt=Date.now(),budget=await workflowBudgetStatus(db,orgId,workflowId,budgetAt);
  const reason=workflowBudgetReason(budget);
  const at=new Date(budgetAt).toISOString(),fresh=await readWorkflowSafety(db,orgId,workflowId);
  if(reason)await pauseWorkflowForBudget(db,orgId,workflowId,fresh,reason,at);
  else await recoverWorkflowBudgetPause(db,orgId,workflowId,fresh);
  return {budget,safety:await readWorkflowSafety(db,orgId,workflowId)};
}
export async function recoverWorkflowBudgetPause(db,orgId,workflowId,safety) {
  if(!safety?.pause_reason?.startsWith('budget_'))return safety;
  const budget=await workflowBudgetStatus(db,orgId,workflowId);
  if(workflowBudgetReason(budget))return safety;
  await db.prepare(`UPDATE hx_workflow_safety SET generation=?1,paused_at=NULL,pause_reason=NULL
    WHERE org_id=?2 AND workflow_id=?3 AND generation=?4 AND budget_revision=?5 AND pause_reason LIKE 'budget_%'
    AND NOT EXISTS(SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.status IN ('running','waiting'))
    AND (daily_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?6 AND r.started_at<=?9)<daily_run_limit)
    AND (weekly_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?7 AND r.started_at<=?9)<weekly_run_limit)
    AND (monthly_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?8 AND r.started_at<=?9)<monthly_run_limit)
    AND (ai_budget_action!='pause' OR
      ((daily_ai_budget_micros=0 OR (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?10 AND u.created_at<=?9)<daily_ai_budget_micros AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?10 AND u.created_at<=?9 AND u.estimated_micros IS NULL))
      AND (weekly_ai_budget_micros=0 OR (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?11 AND u.created_at<=?9)<weekly_ai_budget_micros AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?11 AND u.created_at<=?9 AND u.estimated_micros IS NULL))
      AND (monthly_ai_budget_micros=0 OR (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?12 AND u.created_at<=?9)<monthly_ai_budget_micros AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?12 AND u.created_at<=?9 AND u.estimated_micros IS NULL))))`)
    .bind(crypto.randomUUID(),orgId,workflowId,safety.generation,budget.revision,workflowBudgetWindows().dailyStart,workflowBudgetWindows().weeklyStart,workflowBudgetWindows().monthlyStart,new Date().toISOString(),new Date(Date.now()-DAY).toISOString(),new Date(Date.now()-7*DAY).toISOString(),new Date(Date.now()-30*DAY).toISOString()).run();
  return readWorkflowSafety(db,orgId,workflowId);
}
export async function pauseWorkflowForBudget(db,orgId,workflowId,safety,reason,now=new Date().toISOString()) {
  if(!['budget_daily','budget_weekly','budget_monthly','budget_ai_24h','budget_ai_7d','budget_ai_30d','budget_ai_unpriced'].includes(reason))return false;
  const budget=await workflowBudgetStatus(db,orgId,workflowId,Date.parse(now));
  if(workflowBudgetReason(budget)!==reason)return false;
  const windows=workflowBudgetWindows(Date.parse(now));
  const aiWindows=workflowAiBudgetWindows(Date.parse(now));
  const costCondition=reason==='budget_ai_24h'?`daily_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?3 AND u.workflow_id=?4 AND u.created_at>=?11 AND u.created_at<=?10)>=daily_ai_budget_micros`
    :reason==='budget_ai_7d'?`weekly_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?3 AND u.workflow_id=?4 AND u.created_at>=?12 AND u.created_at<=?10)>=weekly_ai_budget_micros`
    :reason==='budget_ai_30d'?`monthly_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?3 AND u.workflow_id=?4 AND u.created_at>=?13 AND u.created_at<=?10)>=monthly_ai_budget_micros`
    :reason==='budget_ai_unpriced'?`((daily_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?3 AND u.workflow_id=?4 AND u.created_at>=?11 AND u.created_at<=?10 AND u.estimated_micros IS NULL)) OR (weekly_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?3 AND u.workflow_id=?4 AND u.created_at>=?12 AND u.created_at<=?10 AND u.estimated_micros IS NULL)) OR (monthly_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?3 AND u.workflow_id=?4 AND u.created_at>=?13 AND u.created_at<=?10 AND u.estimated_micros IS NULL)))`
    :`0`;
  const costReason=reason.startsWith('budget_ai_');
  const result=await db.prepare(`UPDATE hx_workflow_safety SET paused_at=?1,pause_reason=?2
    WHERE org_id=?3 AND workflow_id=?4 AND generation=?5 AND budget_revision=?6 AND paused_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.status IN ('running','waiting'))
    AND ((?2='budget_daily' AND daily_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?7 AND r.started_at<=?10)>=daily_run_limit)
      OR (?2='budget_weekly' AND weekly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?8 AND r.started_at<=?10)>=weekly_run_limit)
      OR (?2='budget_monthly' AND monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?9 AND r.started_at<=?10)>=monthly_run_limit)
      OR (?14=1 AND ai_budget_action='pause' AND (${costCondition})))`)
    .bind(now,reason,orgId,workflowId,safety.generation,budget.revision,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,now,aiWindows['24h'].start,aiWindows['7d'].start,aiWindows['30d'].start,costReason?1:0).run();
  return !!result.meta?.changes;
}
export async function resumeWorkflowSafety(db,orgId,workflowId,generation) {
  const result=await db.prepare(`UPDATE hx_workflow_safety SET generation=?1,failure_streak=0,paused_at=NULL,pause_reason=NULL
    WHERE org_id=?2 AND workflow_id=?3 AND generation=?4 AND EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?2 AND id=?3)`)
    .bind(crypto.randomUUID(),orgId,workflowId,generation).run();
  return !!result.meta?.changes;
}
// Append to the transaction which marks a run terminal. The persisted
// definition freezes generation at admission; callers cannot supply outcomes.
export function workflowSettlementStatements(db,orgId,runId) {
  const claim=crypto.randomUUID(),at=new Date().toISOString();
  const windows=workflowBudgetWindows(Date.parse(at));
  const aiWindows=workflowAiBudgetWindows(Date.parse(at));
  return [
    db.prepare(`INSERT OR IGNORE INTO hx_workflow_outcomes(org_id,run_id,workflow_id,generation,status,claim_id)
      SELECT r.org_id,r.id,r.workflow_id,s.generation,r.status,?3 FROM hx_workflow_runs r
      JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
      JOIN hx_workflow_safety s ON s.org_id=r.org_id AND s.workflow_id=r.workflow_id
      WHERE r.org_id=?1 AND r.id=?2 AND r.status IN ('done','failed','declined','cancelled')
      AND s.generation=json_extract(d.definition,'$.safetyGeneration') AND s.paused_at IS NULL`)
      .bind(orgId,runId,claim),
    db.prepare(`UPDATE hx_workflow_safety SET
      failure_streak=CASE WHEN (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN failure_streak+1 ELSE 0 END,
      paused_at=CASE
        WHEN failure_streak>=2 AND (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN ?4
        WHEN daily_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?5 AND r.started_at<=?8)>=daily_run_limit THEN ?4
        WHEN weekly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?6 AND r.started_at<=?8)>=weekly_run_limit THEN ?4
        WHEN monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?7 AND r.started_at<=?8)>=monthly_run_limit THEN ?4
        WHEN ai_budget_action='pause' AND ((daily_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?9 AND u.created_at<=?4 AND u.estimated_micros IS NULL)) OR (weekly_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?10 AND u.created_at<=?4 AND u.estimated_micros IS NULL)) OR (monthly_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?11 AND u.created_at<=?4 AND u.estimated_micros IS NULL))) THEN ?4
        WHEN ai_budget_action='pause' AND daily_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?9 AND u.created_at<=?4)>=daily_ai_budget_micros THEN ?4
        WHEN ai_budget_action='pause' AND weekly_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?10 AND u.created_at<=?4)>=weekly_ai_budget_micros THEN ?4
        WHEN ai_budget_action='pause' AND monthly_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?11 AND u.created_at<=?4)>=monthly_ai_budget_micros THEN ?4 ELSE NULL END,
      pause_reason=CASE
        WHEN failure_streak>=2 AND (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN 'consecutive_failures'
        WHEN daily_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?5 AND r.started_at<=?8)>=daily_run_limit THEN 'budget_daily'
        WHEN weekly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?6 AND r.started_at<=?8)>=weekly_run_limit THEN 'budget_weekly'
        WHEN monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?7 AND r.started_at<=?8)>=monthly_run_limit THEN 'budget_monthly'
        WHEN ai_budget_action='pause' AND ((daily_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?9 AND u.created_at<=?4 AND u.estimated_micros IS NULL)) OR (weekly_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?10 AND u.created_at<=?4 AND u.estimated_micros IS NULL)) OR (monthly_ai_budget_micros>0 AND EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?11 AND u.created_at<=?4 AND u.estimated_micros IS NULL))) THEN 'budget_ai_unpriced'
        WHEN ai_budget_action='pause' AND daily_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?9 AND u.created_at<=?4)>=daily_ai_budget_micros THEN 'budget_ai_24h'
        WHEN ai_budget_action='pause' AND weekly_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?10 AND u.created_at<=?4)>=weekly_ai_budget_micros THEN 'budget_ai_7d'
        WHEN ai_budget_action='pause' AND monthly_ai_budget_micros>0 AND (SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?1 AND u.workflow_id=hx_workflow_safety.workflow_id AND u.created_at>=?11 AND u.created_at<=?4)>=monthly_ai_budget_micros THEN 'budget_ai_30d' ELSE NULL END
      WHERE org_id=?1 AND EXISTS(SELECT 1 FROM hx_workflow_outcomes o WHERE o.org_id=?1 AND o.run_id=?2 AND o.claim_id=?3 AND o.workflow_id=hx_workflow_safety.workflow_id AND o.generation=hx_workflow_safety.generation)`)
      .bind(orgId,runId,claim,at,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,at,aiWindows['24h'].start,aiWindows['7d'].start,aiWindows['30d'].start),
    db.prepare(`INSERT OR IGNORE INTO hx_workflow_safety_notices(org_id,workflow_id,generation,run_id,recipient_id,created_at)
      SELECT s.org_id,s.workflow_id,s.generation,?2,w.created_by,?4 FROM hx_workflow_safety s
      JOIN hx_workflows w ON w.org_id=s.org_id AND w.id=s.workflow_id
      JOIN hx_workflow_outcomes o ON o.org_id=s.org_id AND o.workflow_id=s.workflow_id AND o.generation=s.generation
      WHERE s.org_id=?1 AND o.run_id=?2 AND o.claim_id=?3 AND s.paused_at IS NOT NULL`)
      .bind(orgId,runId,claim,at),
    ...AI_WINDOWS.map(([period,,duration])=>{
      const end=Date.parse(at),bucketStart=new Date(Math.floor(end/duration)*duration).toISOString(),start=new Date(end-duration).toISOString();
      const column={ '24h':'daily_ai_budget_micros','7d':'weekly_ai_budget_micros','30d':'monthly_ai_budget_micros' }[period];
      return db.prepare(`INSERT OR IGNORE INTO hx_workflow_ai_budget_notices(id,org_id,workflow_id,period,budget_revision,bucket_start,run_id,recipient_id,estimated_micros,limit_micros,unpriced_calls,created_at)
        SELECT ?1,s.org_id,s.workflow_id,?4,s.budget_revision,?5,?2,w.created_by,
          COALESCE((SELECT SUM(u.estimated_micros) FROM hx_workflow_usage u WHERE u.org_id=s.org_id AND u.workflow_id=s.workflow_id AND u.created_at>=?6 AND u.created_at<=?3),0),s.${column},
          (SELECT COUNT(*) FROM hx_workflow_usage u WHERE u.org_id=s.org_id AND u.workflow_id=s.workflow_id AND u.created_at>=?6 AND u.created_at<=?3 AND u.estimated_micros IS NULL),?3
        FROM hx_workflow_safety s JOIN hx_workflows w ON w.org_id=s.org_id AND w.id=s.workflow_id
        JOIN hx_workflow_outcomes o ON o.org_id=s.org_id AND o.workflow_id=s.workflow_id AND o.generation=s.generation
        WHERE s.org_id=?7 AND o.run_id=?2 AND o.claim_id=?8 AND s.paused_at IS NULL AND s.ai_budget_action='warn' AND s.${column}>0
        AND (COALESCE((SELECT SUM(u.estimated_micros) FROM hx_workflow_usage u WHERE u.org_id=s.org_id AND u.workflow_id=s.workflow_id AND u.created_at>=?6 AND u.created_at<=?3),0)>=s.${column}
          OR EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=s.org_id AND u.workflow_id=s.workflow_id AND u.created_at>=?6 AND u.created_at<=?3 AND u.estimated_micros IS NULL))`)
        .bind(crypto.randomUUID(),runId,at,period,bucketStart,start,orgId,claim);
    }),
  ];
}

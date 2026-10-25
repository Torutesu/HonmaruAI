// Operational safety is independent of the published workflow definition.
// These helpers are internal: routes must authorize workflow access first.
export async function ensureWorkflowSafety(db, orgId, workflowId) {
  await db.prepare(`INSERT OR IGNORE INTO hx_workflow_safety(org_id,workflow_id,generation)
    SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?1 AND id=?2)`)
    .bind(orgId,workflowId,crypto.randomUUID()).run();
  return readWorkflowSafety(db,orgId,workflowId);
}
export async function readWorkflowSafety(db,orgId,workflowId) {
  return db.prepare('SELECT generation,failure_streak,paused_at,pause_reason,daily_run_limit,weekly_run_limit,monthly_run_limit,budget_revision FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
}
const DAY=86_400_000;
export function workflowBudgetWindows(now=Date.now()) {
  const date=new Date(now), day=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
  const week=day-((date.getUTCDay()+6)%7)*DAY;
  const month=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1);
  return {dailyStart:new Date(day).toISOString(),dailyReset:new Date(day+DAY).toISOString(),weeklyStart:new Date(week).toISOString(),weeklyReset:new Date(week+7*DAY).toISOString(),monthlyStart:new Date(month).toISOString(),monthlyReset:new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)).toISOString()};
}
export async function workflowBudgetStatus(db,orgId,workflowId,now=Date.now()) {
  const safety=await db.prepare('SELECT daily_run_limit,weekly_run_limit,monthly_run_limit,budget_revision FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
  if(!safety)return null;
  const windows=workflowBudgetWindows(now);
  const used=await db.prepare(`SELECT
    SUM(CASE WHEN started_at>=?3 THEN 1 ELSE 0 END) AS daily,
    SUM(CASE WHEN started_at>=?4 THEN 1 ELSE 0 END) AS weekly,
    SUM(CASE WHEN started_at>=?5 THEN 1 ELSE 0 END) AS monthly
    FROM hx_workflow_runs WHERE org_id=?1 AND workflow_id=?2 AND started_at<=?6`).bind(orgId,workflowId,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,new Date(now).toISOString()).first();
  const period=(limit,count,resetAt)=>({limit:Number(limit)||0,used:Number(count)||0,resetAt,exhausted:Number(limit)>0&&Number(count)>=Number(limit)});
  return {revision:Number(safety.budget_revision)||0,daily:period(safety.daily_run_limit,used?.daily,windows.dailyReset),weekly:period(safety.weekly_run_limit,used?.weekly,windows.weeklyReset),monthly:period(safety.monthly_run_limit,used?.monthly,windows.monthlyReset)};
}
export function workflowBudgetReason(budget) {
  if(!budget)return null;
  for(const key of ['daily','weekly','monthly'])if(budget[key]?.exhausted)return `budget_${key}`;
  return null;
}
export async function saveWorkflowBudget(db,orgId,workflowId,input={}) {
  if(!await ensureWorkflowSafety(db,orgId,workflowId))return {error:'No such workflow.',status:404};
  const names=['dailyLimit','weeklyLimit','monthlyLimit'];
  const limits=names.map(name=>input[name]);
  if(limits.some(value=>!Number.isSafeInteger(value)||value<0||value>1_000_000))return {error:'Run limits must be whole numbers from 0 to 1,000,000. Use 0 for unlimited.',status:400};
  if(!Number.isSafeInteger(input.revision)||input.revision<0)return {error:'Reload the workflow before changing its run budget.',status:400};
  const result=await db.prepare(`UPDATE hx_workflow_safety SET daily_run_limit=?1,weekly_run_limit=?2,monthly_run_limit=?3,budget_revision=budget_revision+1
    WHERE org_id=?4 AND workflow_id=?5 AND budget_revision=?6 AND EXISTS(SELECT 1 FROM hx_workflows WHERE org_id=?4 AND id=?5)`)
    .bind(...limits,orgId,workflowId,input.revision).run();
  if(!result.meta?.changes){
    const exists=await db.prepare('SELECT 1 FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
    return exists?{error:'The workflow state changed. Reload before saving its budget.',status:409}:{error:'No such workflow.',status:404};
  }
  const budgetAt=Date.now(),budget=await workflowBudgetStatus(db,orgId,workflowId,budgetAt);
  const reason=workflowBudgetReason(budget);
  const windows=workflowBudgetWindows(budgetAt),at=new Date(budgetAt).toISOString();
  if(reason)await db.prepare(`UPDATE hx_workflow_safety SET paused_at=COALESCE(paused_at,?1),pause_reason=?2
    WHERE org_id=?3 AND workflow_id=?4 AND budget_revision=?5 AND (paused_at IS NULL OR pause_reason IN ('budget_daily','budget_weekly','budget_monthly'))
    AND NOT EXISTS(SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.status IN ('running','waiting'))
    AND ((?2='budget_daily' AND daily_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?6 AND r.started_at<=?9)>=daily_run_limit)
      OR (?2='budget_weekly' AND weekly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?7 AND r.started_at<=?9)>=weekly_run_limit)
      OR (?2='budget_monthly' AND monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?8 AND r.started_at<=?9)>=monthly_run_limit))`)
    .bind(at,reason,orgId,workflowId,budget.revision,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,at).run();
  else await db.prepare(`UPDATE hx_workflow_safety SET generation=?1,paused_at=NULL,pause_reason=NULL
    WHERE org_id=?2 AND workflow_id=?3 AND budget_revision=?4 AND pause_reason IN ('budget_daily','budget_weekly','budget_monthly')
    AND NOT EXISTS(SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.status IN ('running','waiting'))
    AND (daily_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?5 AND r.started_at<=?8)<daily_run_limit)
    AND (weekly_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?6 AND r.started_at<=?8)<weekly_run_limit)
    AND (monthly_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?7 AND r.started_at<=?8)<monthly_run_limit)`)
    .bind(crypto.randomUUID(),orgId,workflowId,budget.revision,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,at).run();
  return {budget,safety:await readWorkflowSafety(db,orgId,workflowId)};
}
export async function recoverWorkflowBudgetPause(db,orgId,workflowId,safety) {
  if(!safety?.pause_reason?.startsWith('budget_'))return safety;
  const budget=await workflowBudgetStatus(db,orgId,workflowId);
  if(workflowBudgetReason(budget))return safety;
  const windows=workflowBudgetWindows();
  await db.prepare(`UPDATE hx_workflow_safety SET generation=?1,paused_at=NULL,pause_reason=NULL
    WHERE org_id=?2 AND workflow_id=?3 AND generation=?4 AND budget_revision=?5 AND pause_reason IN ('budget_daily','budget_weekly','budget_monthly')
    AND NOT EXISTS(SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.status IN ('running','waiting'))
    AND (daily_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?6 AND r.started_at<=?9)<daily_run_limit)
    AND (weekly_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?7 AND r.started_at<=?9)<weekly_run_limit)
    AND (monthly_run_limit=0 OR (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.started_at>=?8 AND r.started_at<=?9)<monthly_run_limit)`)
    .bind(crypto.randomUUID(),orgId,workflowId,safety.generation,budget.revision,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,new Date().toISOString()).run();
  return readWorkflowSafety(db,orgId,workflowId);
}
export async function pauseWorkflowForBudget(db,orgId,workflowId,safety,reason,now=new Date().toISOString()) {
  if(!['budget_daily','budget_weekly','budget_monthly'].includes(reason))return false;
  const budget=await workflowBudgetStatus(db,orgId,workflowId,Date.parse(now));
  if(workflowBudgetReason(budget)!==reason)return false;
  const windows=workflowBudgetWindows(Date.parse(now));
  const result=await db.prepare(`UPDATE hx_workflow_safety SET paused_at=?1,pause_reason=?2
    WHERE org_id=?3 AND workflow_id=?4 AND generation=?5 AND budget_revision=?6 AND paused_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.status IN ('running','waiting'))
    AND ((?2='budget_daily' AND daily_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?7 AND r.started_at<=?10)>=daily_run_limit)
      OR (?2='budget_weekly' AND weekly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?8 AND r.started_at<=?10)>=weekly_run_limit)
      OR (?2='budget_monthly' AND monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?3 AND r.workflow_id=?4 AND r.started_at>=?9 AND r.started_at<=?10)>=monthly_run_limit))`)
    .bind(now,reason,orgId,workflowId,safety.generation,budget.revision,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,now).run();
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
        WHEN monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?7 AND r.started_at<=?8)>=monthly_run_limit THEN ?4 ELSE NULL END,
      pause_reason=CASE
        WHEN failure_streak>=2 AND (SELECT status FROM hx_workflow_outcomes WHERE org_id=?1 AND run_id=?2 AND claim_id=?3)='failed' THEN 'consecutive_failures'
        WHEN daily_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?5 AND r.started_at<=?8)>=daily_run_limit THEN 'budget_daily'
        WHEN weekly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?6 AND r.started_at<=?8)>=weekly_run_limit THEN 'budget_weekly'
        WHEN monthly_run_limit>0 AND (SELECT COUNT(*) FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.workflow_id=hx_workflow_safety.workflow_id AND r.started_at>=?7 AND r.started_at<=?8)>=monthly_run_limit THEN 'budget_monthly' ELSE NULL END
      WHERE org_id=?1 AND EXISTS(SELECT 1 FROM hx_workflow_outcomes o WHERE o.org_id=?1 AND o.run_id=?2 AND o.claim_id=?3 AND o.workflow_id=hx_workflow_safety.workflow_id AND o.generation=hx_workflow_safety.generation)`)
      .bind(orgId,runId,claim,at,windows.dailyStart,windows.weeklyStart,windows.monthlyStart,at),
    db.prepare(`INSERT OR IGNORE INTO hx_workflow_safety_notices(org_id,workflow_id,generation,run_id,recipient_id,created_at)
      SELECT s.org_id,s.workflow_id,s.generation,?2,w.created_by,?4 FROM hx_workflow_safety s
      JOIN hx_workflows w ON w.org_id=s.org_id AND w.id=s.workflow_id
      JOIN hx_workflow_outcomes o ON o.org_id=s.org_id AND o.workflow_id=s.workflow_id AND o.generation=s.generation
      WHERE s.org_id=?1 AND o.run_id=?2 AND o.claim_id=?3 AND s.paused_at IS NOT NULL`)
      .bind(orgId,runId,claim,at),
  ];
}

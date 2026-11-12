// Provider-reported token usage, not an invoice or a Kylon credit conversion.
// Missing/invalid counters stay null: unknown usage must never become free usage.
import {PRICES,costOf} from '../ledger.js';
const tokens=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
export function estimateWorkflowUsageMicros(model,input,output){
 if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)return null;
 const key=String(model||'').toLowerCase();
 if(!Object.keys(PRICES).some(price=>key===price||key.startsWith(price)))return null;
 const usd=costOf(key,{input,output});
 return Number.isFinite(usd)&&usd>=0?Math.ceil(usd*1_000_000):null;
}
const rollingWindowStarts=now=>({
 '24h':new Date(now-86_400_000).toISOString(),
 '7d':new Date(now-7*86_400_000).toISOString(),
 '30d':new Date(now-30*86_400_000).toISOString(),
});
export async function reserveWorkflowBudgetCall(db,{orgId,workflowId,runId,stepNumber,model,inputTokens,outputTokens,provider='OpenAI',byok=false,now=Date.now()}){
 if(byok)return {allowed:true,reservationId:null};
 const estimate=estimateWorkflowUsageMicros(model,inputTokens,outputTokens);
 const at=new Date(now).toISOString(),id=crypto.randomUUID();
 const safety=await db.prepare('SELECT generation,budget_revision,daily_ai_budget_micros,weekly_ai_budget_micros,monthly_ai_budget_micros,ai_budget_action,paused_at FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
 if(!safety)return {allowed:false,reason:'workflow_missing'};
 if(safety.ai_budget_action!=='pause'||![safety.daily_ai_budget_micros,safety.weekly_ai_budget_micros,safety.monthly_ai_budget_micros].some(value=>Number(value)>0))return {allowed:true,reservationId:null};
 if(safety.paused_at)return {allowed:false,reason:safety.pause_reason||'workflow_paused'};
 await expireWorkflowBudgetReservations(db,orgId,workflowId,now);
 const windows=rollingWindowStarts(now);
 const canFit=estimate!==null&&Number(safety.daily_ai_budget_micros||0)>0||estimate!==null&&Number(safety.weekly_ai_budget_micros||0)>0||estimate!==null&&Number(safety.monthly_ai_budget_micros||0)>0;
 const insert=canFit?await db.prepare(`INSERT INTO hx_workflow_ai_budget_reservations(id,org_id,workflow_id,run_id,step_number,provider,model,reserved_micros,budget_revision,status,created_at,expires_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?8,s.budget_revision,'held',?9,?10 FROM hx_workflow_safety s
   WHERE s.org_id=?2 AND s.workflow_id=?3 AND s.budget_revision=?11 AND s.ai_budget_action='pause' AND s.paused_at IS NULL
   AND (s.daily_ai_budget_micros=0 OR ((SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?12 AND u.created_at<=?9)+(SELECT COALESCE(SUM(r.reserved_micros),0) FROM hx_workflow_ai_budget_reservations r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.created_at>=?12 AND r.created_at<=?9 AND (r.status='blocked' OR (r.status='held' AND r.expires_at>?9)))+?8<=s.daily_ai_budget_micros AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?12 AND u.created_at<=?9 AND u.estimated_micros IS NULL)))
   AND (s.weekly_ai_budget_micros=0 OR ((SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?13 AND u.created_at<=?9)+(SELECT COALESCE(SUM(r.reserved_micros),0) FROM hx_workflow_ai_budget_reservations r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.created_at>=?13 AND r.created_at<=?9 AND (r.status='blocked' OR (r.status='held' AND r.expires_at>?9)))+?8<=s.weekly_ai_budget_micros AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?13 AND u.created_at<=?9 AND u.estimated_micros IS NULL)))
   AND (s.monthly_ai_budget_micros=0 OR ((SELECT COALESCE(SUM(u.estimated_micros),0) FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?14 AND u.created_at<=?9)+(SELECT COALESCE(SUM(r.reserved_micros),0) FROM hx_workflow_ai_budget_reservations r WHERE r.org_id=?2 AND r.workflow_id=?3 AND r.created_at>=?14 AND r.created_at<=?9 AND (r.status='blocked' OR (r.status='held' AND r.expires_at>?9)))+?8<=s.monthly_ai_budget_micros AND NOT EXISTS(SELECT 1 FROM hx_workflow_usage u WHERE u.org_id=?2 AND u.workflow_id=?3 AND u.created_at>=?14 AND u.created_at<=?9 AND u.estimated_micros IS NULL)))`)
   .bind(id,orgId,workflowId,runId,stepNumber,String(provider),String(model),estimate,at,new Date(now+300_000).toISOString(),safety.budget_revision,windows['24h'],windows['7d'],windows['30d']).run():{meta:{changes:0}};
 if(insert.meta?.changes)return {allowed:true,reservationId:id,reservedMicros:estimate};
 const reason=estimate===null?'budget_ai_unpriced':await workflowReservationDenialReason(db,orgId,workflowId,estimate,now,safety.budget_revision);
 const blockedId=crypto.randomUUID();
 const statements=[db.prepare(`INSERT INTO hx_workflow_ai_budget_reservations(id,org_id,workflow_id,run_id,step_number,provider,model,reserved_micros,budget_revision,status,created_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'blocked',?10 WHERE EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?2 AND workflow_id=?3 AND id=?4)
   AND EXISTS(SELECT 1 FROM hx_workflow_safety WHERE org_id=?2 AND workflow_id=?3 AND budget_revision=?9 AND ai_budget_action='pause' AND paused_at IS NULL)`)
   .bind(blockedId,orgId,workflowId,runId,stepNumber,String(provider),String(model),estimate,safety.budget_revision,at),
   db.prepare(`UPDATE hx_workflow_safety SET paused_at=?1,pause_reason=?2
   WHERE org_id=?3 AND workflow_id=?4 AND budget_revision=?5 AND ai_budget_action='pause' AND paused_at IS NULL`)
   .bind(at,reason,orgId,workflowId,safety.budget_revision)];
 await db.batch(statements);
 return {allowed:false,reason};
}
async function workflowReservationDenialReason(db,orgId,workflowId,estimate,now,revision){
 const safety=await db.prepare('SELECT budget_revision,daily_ai_budget_micros,weekly_ai_budget_micros,monthly_ai_budget_micros FROM hx_workflow_safety WHERE org_id=?1 AND workflow_id=?2').bind(orgId,workflowId).first();
 if(!safety||Number(safety.budget_revision)!==Number(revision))return 'budget_revision_changed';
 const windows=rollingWindowStarts(now),at=new Date(now).toISOString();
 const usage=await db.prepare(`SELECT
  (SELECT COALESCE(SUM(estimated_micros),0) FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?3 AND created_at<=?6)+(SELECT COALESCE(SUM(reserved_micros),0) FROM hx_workflow_ai_budget_reservations WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?3 AND created_at<=?6 AND (status='blocked' OR (status='held' AND expires_at>?6))) AS d24,
  (SELECT COALESCE(SUM(estimated_micros),0) FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?4 AND created_at<=?6)+(SELECT COALESCE(SUM(reserved_micros),0) FROM hx_workflow_ai_budget_reservations WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?4 AND created_at<=?6 AND (status='blocked' OR (status='held' AND expires_at>?6))) AS d7,
  (SELECT COALESCE(SUM(estimated_micros),0) FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?5 AND created_at<=?6)+(SELECT COALESCE(SUM(reserved_micros),0) FROM hx_workflow_ai_budget_reservations WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?5 AND created_at<=?6 AND (status='blocked' OR (status='held' AND expires_at>?6))) AS d30,
  EXISTS(SELECT 1 FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?3 AND created_at<=?6 AND estimated_micros IS NULL) AS unknown24,
  EXISTS(SELECT 1 FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?4 AND created_at<=?6 AND estimated_micros IS NULL) AS unknown7,
  EXISTS(SELECT 1 FROM hx_workflow_usage WHERE org_id=?1 AND workflow_id=?2 AND created_at>=?5 AND created_at<=?6 AND estimated_micros IS NULL) AS unknown30`)
  .bind(orgId,workflowId,windows['24h'],windows['7d'],windows['30d'],at).first();
 if((Number(safety.daily_ai_budget_micros)>0&&usage?.unknown24)||(Number(safety.weekly_ai_budget_micros)>0&&usage?.unknown7)||(Number(safety.monthly_ai_budget_micros)>0&&usage?.unknown30))return 'budget_ai_unpriced';
 for(const [key,column] of [['24h','daily_ai_budget_micros'],['7d','weekly_ai_budget_micros'],['30d','monthly_ai_budget_micros']])if(Number(safety[column])>0&&Number(usage?.[{ '24h':'d24','7d':'d7','30d':'d30'}[key]]||0)+estimate>Number(safety[column]))return `budget_ai_${key}`;
 return 'budget_revision_changed';
}
async function expireWorkflowBudgetReservations(db,orgId,workflowId,now){
 const at=new Date(now).toISOString();
 const {results=[]}=await db.prepare(`SELECT id,run_id,step_number,provider,model FROM hx_workflow_ai_budget_reservations WHERE org_id=?1 AND workflow_id=?2 AND status='held' AND expires_at<=?3 ORDER BY expires_at LIMIT 50`).bind(orgId,workflowId,at).all();
 for(let i=0;i<results.length;i+=50){
  const expired=results.slice(i,i+50);
  await db.batch(expired.flatMap(row=>{
   const usageId=crypto.randomUUID();
   return [db.prepare(`INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros)
     SELECT ?1,?2,?3,?4,?5,?6,?7,NULL,NULL,0,?8,NULL WHERE EXISTS(SELECT 1 FROM hx_workflow_ai_budget_reservations WHERE id=?9 AND org_id=?2 AND status='held' AND expires_at<=?8)`)
     .bind(usageId,orgId,workflowId,row.run_id,row.step_number,row.provider,row.model,at,row.id),
    db.prepare(`UPDATE hx_workflow_ai_budget_reservations SET status='settled',settled_at=?1 WHERE id=?2 AND org_id=?3 AND status='held' AND expires_at<=?1`).bind(at,row.id,orgId)];
  }));
 }
}
export async function releaseWorkflowBudgetReservation(db,reservationId,now=Date.now()){
 if(!reservationId)return false;
 const result=await db.prepare(`UPDATE hx_workflow_ai_budget_reservations SET status='settled',settled_at=?1 WHERE id=?2 AND status='held'`).bind(new Date(now).toISOString(),reservationId).run();
 return !!result.meta?.changes;
}
export async function recordWorkflowUsage(db,{orgId,workflowId,runId,stepNumber,data,provider,reservationId=null}){
 const u=data?.usage||{};
 const model=String(data?.model||provider.model||'unknown');
 const input=tokens(u.prompt_tokens??u.input_tokens),output=tokens(u.completion_tokens??u.output_tokens);
 const estimatedMicros=input===null||output===null?null:estimateWorkflowUsageMicros(model,input,output);
 const usageId=crypto.randomUUID(),at=new Date().toISOString();
 const statements=[db.prepare(`INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12 WHERE EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?2 AND workflow_id=?3 AND id=?4)`)
 .bind(usageId,orgId,workflowId,runId,stepNumber,String(provider.provider),model,input,output,provider.byok?1:0,at,estimatedMicros),
 ...(reservationId?[db.prepare(`UPDATE hx_workflow_ai_budget_reservations SET status='settled',settled_at=?1 WHERE id=?2 AND status='held' AND EXISTS(SELECT 1 FROM hx_workflow_usage WHERE id=?3 AND org_id=?4)`)
 .bind(at,reservationId,usageId,orgId)]:[])];
 const result=await db.batch(statements);
 if(!result[0]?.meta?.changes)throw new Error('Workflow usage could not be recorded.');
}
export async function workflowRunUsage(db,orgId,runId){
 const {results}=await db.prepare(`SELECT step_number AS stepNumber,COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownCalls,COALESCE(SUM(estimated_micros),0) AS estimatedMicros,SUM(CASE WHEN estimated_micros IS NULL THEN 1 ELSE 0 END) AS unpricedCalls FROM hx_workflow_usage WHERE org_id=?1 AND run_id=?2 GROUP BY step_number ORDER BY step_number`).bind(orgId,runId).all();
 return {coverage:'priced-token-estimate',steps:results,calls:results.reduce((n,s)=>n+s.calls,0),inputTokens:results.reduce((n,s)=>n+s.inputTokens,0),outputTokens:results.reduce((n,s)=>n+s.outputTokens,0),unknownCalls:results.reduce((n,s)=>n+s.unknownCalls,0),unpricedCalls:results.reduce((n,s)=>n+s.unpricedCalls,0),estimatedMicros:results.reduce((n,s)=>n+s.estimatedMicros,0),estimatedUsd:Math.round(results.reduce((n,s)=>n+s.estimatedMicros,0))/1_000_000};
}

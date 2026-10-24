// Provider-reported token usage, not an invoice or a Kylon credit conversion.
// Missing/invalid counters stay null: unknown usage must never become free usage.
const tokens=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
export async function recordWorkflowUsage(db,{orgId,workflowId,runId,stepNumber,data,provider}){
 const u=data?.usage||{};
 const result=await db.prepare(`INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?2 AND workflow_id=?3 AND id=?4)`)
 .bind(crypto.randomUUID(),orgId,workflowId,runId,stepNumber,String(provider.provider),String(data?.model||provider.model||'unknown'),tokens(u.prompt_tokens??u.input_tokens),tokens(u.completion_tokens??u.output_tokens),provider.byok?1:0,new Date().toISOString()).run();
 if(!result.meta?.changes)throw new Error('Workflow usage could not be recorded.');
}
export async function workflowRunUsage(db,orgId,runId){
 const {results}=await db.prepare(`SELECT step_number AS stepNumber,COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownCalls FROM hx_workflow_usage WHERE org_id=?1 AND run_id=?2 GROUP BY step_number ORDER BY step_number`).bind(orgId,runId).all();
 return {coverage:'recorded-responses-only',steps:results,calls:results.reduce((n,s)=>n+s.calls,0),inputTokens:results.reduce((n,s)=>n+s.inputTokens,0),outputTokens:results.reduce((n,s)=>n+s.outputTokens,0),unknownCalls:results.reduce((n,s)=>n+s.unknownCalls,0)};
}

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
export async function recordWorkflowUsage(db,{orgId,workflowId,runId,stepNumber,data,provider}){
 const u=data?.usage||{};
 const model=String(data?.model||provider.model||'unknown');
 const input=tokens(u.prompt_tokens??u.input_tokens),output=tokens(u.completion_tokens??u.output_tokens);
 const estimatedMicros=input===null||output===null?null:estimateWorkflowUsageMicros(model,input,output);
 const result=await db.prepare(`INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12 WHERE EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?2 AND workflow_id=?3 AND id=?4)`)
 .bind(crypto.randomUUID(),orgId,workflowId,runId,stepNumber,String(provider.provider),model,input,output,provider.byok?1:0,new Date().toISOString(),estimatedMicros).run();
 if(!result.meta?.changes)throw new Error('Workflow usage could not be recorded.');
}
export async function workflowRunUsage(db,orgId,runId){
 const {results}=await db.prepare(`SELECT step_number AS stepNumber,COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownCalls,COALESCE(SUM(estimated_micros),0) AS estimatedMicros,SUM(CASE WHEN estimated_micros IS NULL THEN 1 ELSE 0 END) AS unpricedCalls FROM hx_workflow_usage WHERE org_id=?1 AND run_id=?2 GROUP BY step_number ORDER BY step_number`).bind(orgId,runId).all();
 return {coverage:'priced-token-estimate',steps:results,calls:results.reduce((n,s)=>n+s.calls,0),inputTokens:results.reduce((n,s)=>n+s.inputTokens,0),outputTokens:results.reduce((n,s)=>n+s.outputTokens,0),unknownCalls:results.reduce((n,s)=>n+s.unknownCalls,0),unpricedCalls:results.reduce((n,s)=>n+s.unpricedCalls,0),estimatedMicros:results.reduce((n,s)=>n+s.estimatedMicros,0),estimatedUsd:Math.round(results.reduce((n,s)=>n+s.estimatedMicros,0))/1_000_000};
}

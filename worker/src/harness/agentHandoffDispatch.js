import {assignmentExecutionGrant} from './agentAssignmentGrant.js';
import {endAssignment} from './agentAssignments.js';

// Only queue delivery is retried. An accepted operation has one runner receipt
// and one assignment generation; uncertain model/tool execution never replays.
export async function drainAgentHandoffs(env,{now=Date.now(),limit=20,orgId=null,operationId=null}={}) {
  if(!env.AGENT_RUNNER)return {accepted:0,cancelled:0,retried:0};
  const cap=Number.isSafeInteger(limit)?Math.max(1,Math.min(50,limit)):20;
  const {results}=await env.DB.prepare(`SELECT org_id,operation_id,attempts FROM hx_agent_handoff_dispatch
    WHERE status='pending' AND next_attempt<=?1 AND lease_until<=?1 AND (?3 IS NULL OR org_id=?3) AND (?4 IS NULL OR operation_id=?4)
    ORDER BY next_attempt,operation_id LIMIT ?2`).bind(now,cap,orgId,operationId).all();
  const counts={accepted:0,cancelled:0,retried:0};
  await Promise.all(results.map(async row=>{
    const lease=crypto.randomUUID();
    const claim=await env.DB.prepare(`UPDATE hx_agent_handoff_dispatch SET lease=?3,lease_until=?4,attempts=attempts+1
      WHERE org_id=?1 AND operation_id=?2 AND status='pending' AND next_attempt<=?5 AND lease_until<=?5`)
      .bind(row.org_id,row.operation_id,lease,now+60000,now).run();
    if(!claim.meta?.changes)return;
    let status='pending';
    try {
      const operation=await env.DB.prepare('SELECT * FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2').bind(row.org_id,row.operation_id).first();
      const assignment=operation && await env.DB.prepare('SELECT * FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(row.org_id,operation.assignment_id).first();
      const execution=operation?{orgId:row.org_id,assignmentId:operation.assignment_id,generation:operation.source_generation+1,agentId:operation.target_agent_id}:null;
      if(!assignment)status='cancelled';
      // A completed/advanced generation proves this delivery already ran, even
      // if its queue acknowledgement was lost. Never queue its execution again.
      else if(assignment.generation>execution.generation || (assignment.generation===execution.generation && ['running','finished','failed','interrupted'].includes(assignment.status)))status='accepted';
      else if(!await assignmentExecutionGrant(env,{...execution,allowPending:true})) {
        await endAssignment(env.DB,{...execution,status:'cancelled'});
        status='cancelled';
      } else {
        const stub=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(row.org_id));
        const response=await stub.fetch('https://agents/enqueue',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({kind:'handoff',orgId:row.org_id,rowId:row.operation_id}),signal:AbortSignal.timeout(10000)});
        if(response.status===202)status='accepted';
      }
    } catch { /* Preserve the pending delivery; do not persist external errors. */ }
    const next=now+Math.min(3600000,15000*2**Math.min(row.attempts,8));
    const done=await env.DB.prepare(`UPDATE hx_agent_handoff_dispatch SET status=?4,next_attempt=?5,lease=NULL,lease_until=0,updated_at=?6
      WHERE org_id=?1 AND operation_id=?2 AND lease=?3`).bind(row.org_id,row.operation_id,lease,status,next,new Date(now).toISOString()).run();
    if(done.meta?.changes)counts[status==='pending'?'retried':status]++;
  }));
  return counts;
}

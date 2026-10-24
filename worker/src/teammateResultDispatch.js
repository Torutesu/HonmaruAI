// Retry local reply delivery, never the completed remote execution. The
// publisher must deduplicate by the persisted delivery ID.
export async function drainTeammateResults(env,publish,{now=Date.now(),limit=20,runId=null}={}) {
  const cap=Number.isSafeInteger(limit)?Math.max(1,Math.min(50,limit)):20;
  const {results}=await env.DB.prepare(`SELECT id,org_id,run_id,agent_id,payload,attempts FROM ai_teammate_result_dispatch
    WHERE status='pending' AND next_attempt<=?1 AND lease_until<=?1 AND (?3 IS NULL OR run_id=?3)
    ORDER BY next_attempt,id LIMIT ?2`).bind(now,cap,runId).all();
  const counts={published:0,cancelled:0,retried:0};
  await Promise.all(results.map(async row=>{
    const lease=crypto.randomUUID();
    const claimed=await env.DB.prepare("UPDATE ai_teammate_result_dispatch SET lease=?2,lease_until=?3,attempts=attempts+1 WHERE id=?1 AND status='pending' AND next_attempt<=?4 AND lease_until<=?4")
      .bind(row.id,lease,now+60000,now).run();
    if(!claimed.meta?.changes)return;
    let status='pending';
    try {
      const payload=JSON.parse(row.payload);
      const result=await publish({...payload,agentId:row.agent_id,deliveryId:row.id});
      if(result?.published)status='published';else if(result?.cancelled)status='cancelled';
    } catch { /* Keep the completed result, not provider error strings. */ }
    const next=now+Math.min(3600000,15000*2**Math.min(row.attempts,8));
    const updated=await env.DB.prepare(`UPDATE ai_teammate_result_dispatch SET status=?3,next_attempt=?4,lease=NULL,lease_until=0,updated_at=?5,
      payload=CASE WHEN ?3='pending' THEN payload ELSE NULL END WHERE id=?1 AND lease=?2`)
      .bind(row.id,lease,status,next,new Date(now).toISOString()).run();
    if(updated.meta?.changes)counts[status==='pending'?'retried':status]++;
  }));
  return counts;
}

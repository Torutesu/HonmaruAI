import {agentExecutionGrant} from './agentExecutionGrant.js';
import {sourceFingerprint} from './harness/agentAssignments.js';

// Added to the same D1 batch as the source message and attachment claims.
// Only the server's hashed session key and selected responder IDs are retained.
export async function agentRequestStatement(db,{orgId,row,sessionKey,agentIds,locale='en'}) {
  if(typeof sessionKey!=='string'||!sessionKey.startsWith('h1:')||!Array.isArray(agentIds)||!agentIds.length||agentIds.length>20
    ||agentIds.some(id=>typeof id!=='string'||!id||id.length>100)||new Set(agentIds).size!==agentIds.length||row.kind!=='message')throw new Error('Invalid durable agent request');
  const fingerprint=await sourceFingerprint(row);
  return db.prepare(`INSERT INTO hx_agent_request_dispatch(org_id,message_id,session_key,agent_ids,source_hash,locale,updated_at)
    SELECT org_id,id,?3,?4,?5,?6,created_at FROM channel_messages WHERE org_id=?1 AND id=?2 AND kind='message' AND deleted_at IS NULL`)
    .bind(orgId,row.id,sessionKey,JSON.stringify(agentIds),fingerprint,String(locale).slice(0,20));
}

export async function drainAgentRequests(env,{now=Date.now(),limit=20,orgId=null,messageId=null}={}) {
  if(!env.AGENT_RUNNER)return {accepted:0,cancelled:0,retried:0};
  const cap=Number.isSafeInteger(limit)?Math.max(1,Math.min(50,limit)):20;
  const {results}=await env.DB.prepare(`SELECT org_id,message_id,session_key,locale,attempts FROM hx_agent_request_dispatch
    WHERE status='pending' AND next_attempt<=?1 AND lease_until<=?1 AND (?3 IS NULL OR org_id=?3) AND (?4 IS NULL OR message_id=?4)
    ORDER BY next_attempt,message_id LIMIT ?2`).bind(now,cap,orgId,messageId).all();
  const counts={accepted:0,cancelled:0,retried:0};
  await Promise.all(results.map(async row=>{
    const lease=crypto.randomUUID();
    const claim=await env.DB.prepare(`UPDATE hx_agent_request_dispatch SET lease=?3,lease_until=?4,attempts=attempts+1
      WHERE org_id=?1 AND message_id=?2 AND status='pending' AND next_attempt<=?5 AND lease_until<=?5`)
      .bind(row.org_id,row.message_id,lease,now+60000,now).run();
    if(!claim.meta?.changes)return;
    let status='pending';
    try {
      const grant=await agentExecutionGrant(env,{orgId:row.org_id,token:row.session_key,rowId:row.message_id});
      if(!grant?.agents.length)status='cancelled';
      else {
        const stub=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(row.org_id));
        const response=await stub.fetch('https://agents/enqueue',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({orgId:row.org_id,rowId:row.message_id,token:row.session_key,locale:row.locale}),signal:AbortSignal.timeout(10000)});
        if(response.status===202)status='accepted';
      }
    } catch { /* Retry delivery, never run a second inline model call. */ }
    const next=now+Math.min(3600000,15000*2**Math.min(row.attempts,8));
    const done=await env.DB.prepare(`UPDATE hx_agent_request_dispatch SET status=?4,next_attempt=?5,lease=NULL,lease_until=0,updated_at=?6
      WHERE org_id=?1 AND message_id=?2 AND lease=?3`).bind(row.org_id,row.message_id,lease,status,next,new Date(now).toISOString()).run();
    if(done.meta?.changes)counts[status==='pending'?'retried':status]++;
  }));
  return counts;
}

export async function decorateAgentRequestStatuses(db,orgId,results) {
  if(!results.length)return results;
  const marks=results.map((_,index)=>`?${index+2}`).join(',');
  const {results:rows}=await db.prepare(`SELECT message_id,status FROM hx_agent_request_dispatch WHERE org_id=?1 AND message_id IN (${marks})`)
    .bind(orgId,...results.map(result=>result.rowId)).all();
  const dispatch=new Map(rows.map(row=>[row.message_id,row.status]));
  return results.map(result=>result.status!=='unknown'?result:dispatch.get(result.rowId)==='pending'?{...result,status:'pending_delivery'}:dispatch.get(result.rowId)==='cancelled'?{...result,status:'cancelled'}:result);
}

import { roomHookExecutionGrant } from './roomHookExecutionGrant.js';
function externalState(event) {
  if (event.status === 'cancelled' || event.status === 'interrupted') return event;
  if (Number(event.externalRunning)>0) return {...event,status:'external_running'};
  if (Number(event.externalFailed)>0) return {...event,status:'external_failed'};
  if (Number(event.externalRuns)>0) return {...event,status:'external_finished'};
  return event;
}
// Called only after the route has authorized membership of the exact room.
export async function roomHookStatuses(env,orgId,events,actorId=null) {
  const decorate = async rows => Promise.all(rows.map(async row=>{
    const event=externalState(row);
    const eligible=actorId!=null&&Number.isSafeInteger(event.version)&&['failed','interrupted','no_agents'].includes(event.status);
    const grant=eligible?await roomHookExecutionGrant(env.DB,orgId,event.messageId):null;
    return {...event,canRetry:Boolean(grant&&grant.creatorId===String(actorId))};
  }));
  const mapped = events.map(event=>({...event,status:event.dispatchStatus==='cancelled'?'cancelled':event.dispatchStatus==='accepted'?'unknown':'pending'}));
  if (!mapped.length || !env.AGENT_RUNNER) return decorate(mapped);
  try {
    const stub=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(orgId));
    const response=await stub.fetch('https://agents/room-hook-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orgId,rowIds:mapped.map(e=>e.messageId)}),signal:AbortSignal.timeout(5000)});
    if(!response.ok)return decorate(mapped);
    const {results}=await response.json();
    if(!Array.isArray(results))return decorate(mapped);
    const byId=new Map(results.map(r=>[r.rowId,r]));
    return decorate(mapped.map(event=>{
      const result=byId.get(event.messageId);
      if(!result||!['queued','running','finished','failed','interrupted','cancelled','no_agents'].includes(result.status))return externalState(event);
      return externalState({...event,version:result.version,status:result.status==='finished'?(result.answered>0?'answered':'finished'):result.status});
    }));
  } catch { return decorate(mapped); }
}

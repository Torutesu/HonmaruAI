import { roomHookExecutionGrant } from './roomHookExecutionGrant.js';
export async function retryRoomHook(env,orgId,channel,actorId,input) {
 if(typeof input.messageId!=='string'||!Number.isSafeInteger(input.version))return {error:'Reload the event before retrying.',status:400};
 const grant=await roomHookExecutionGrant(env.DB,orgId,input.messageId);
 if(!grant||grant.channel!==channel||grant.creatorId!==String(actorId))return {error:'Only the active webhook creator can retry this event.',status:403};
 if(!env.AGENT_RUNNER)return {error:'The agent runner is unavailable.',status:503};
 try {
  const stub=env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(orgId));
  const response=await stub.fetch('https://agents/room-hook-retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orgId,rowId:input.messageId,actorId:String(actorId),expectedAt:input.version,confirmInterrupted:input.confirmInterrupted===true}),signal:AbortSignal.timeout(5000)});
  if(response.status===202)return {queued:true,messageId:input.messageId};
  return {error:'Execution state changed. Reload before retrying.',status:response.status===503?503:409};
 } catch {return {error:'The retry result is uncertain. Reload the list to check.',status:503};}
}

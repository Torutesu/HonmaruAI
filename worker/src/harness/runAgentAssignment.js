import {externalAssignmentPending} from './externalAssignment.js';
import {beginAuthorizedAssignment,assignmentExecutionGrant,acceptAgentHandoff,assignmentTargets,hasStaticAgentPeerGrant} from './agentAssignmentGrant.js';
import {assignmentOwns,endAssignment} from './agentAssignments.js';
import {markControlTool,handoffControl} from '../agentToolControl.js';
import {drainAgentHandoffs} from './agentHandoffDispatch.js';
import {serverText} from '../serverCopy.js';
import {waitForAgentCancellation} from '../agentCancellation.js';

export async function runAgentAssignment(env,{orgId,session,row,agent,authorize=null,existing=null,locale='en',publish,registerCancellation=null},execute) {
  let assignment=existing;
  if(!assignment && session?.token) {
    const begun=await beginAuthorizedAssignment(env,{orgId,token:session.token,rowId:row.id},agent.id);
    if(begun?.error || (begun && !begun.started))return;
    assignment=begun?.assignment || null;
  }
  if(!assignment)return execute({authorize,tools:{}});
  const identity={orgId,assignmentId:assignment.id,generation:assignment.generation,agentId:agent.id};
  const controller=new AbortController();
  const permitted=async()=>Boolean(!controller.signal.aborted && (!authorize || await authorize(agent.id)) && await assignmentExecutionGrant(env,identity));
  const tools={};
  const grant=await assignmentExecutionGrant(env,identity);
  let visited=[];
  try { visited=JSON.parse(assignment.visited); } catch { visited=null; }
  const targets=grant&&Array.isArray(visited)?(await assignmentTargets(env,grant)).filter(target=>target.id!==agent.id && !visited.includes(target.id)):[];
  if(targets.length && assignment.generation<assignment.hop_limit && env.AGENT_RUNNER) {
    const operationId=crypto.randomUUID();
    tools.handoff_to_agent=markControlTool({
      description:'Transfer this task to one eligible room agent and end your turn. Call this alone, not alongside writes. Do not claim the target has finished. Eligible agents: '+targets.map(target=>`${target.id}: ${target.name} (@${target.handle})`).join('; '),
      parameters:{type:'object',properties:{targetAgentId:{type:'string',enum:targets.map(target=>target.id)},brief:{type:'string',minLength:1,maxLength:16000}},required:['targetAgentId','brief'],additionalProperties:false},
      run:async args=>{
        if(!await permitted())return {error:'Execution access changed.'};
        const target=targets.find(target=>target.id===args.targetAgentId);
        if(!target || typeof args.brief!=='string')return {error:'Choose an eligible room agent and a handoff brief.'};
        const result=await acceptAgentHandoff(env,{...identity,generation:assignment.generation,sourceAgentId:agent.id,targetAgentId:target.id,operationId,brief:args.brief,
          messageBody:serverText(locale,'agent.handoff',{name:target.name,handle:target.handle,brief:args.brief})});
        if(result.error)return {error:result.error};
        if(result.approvalRequired)return handoffControl(operationId);
        if(publish)await publish(result.operation.message_id).catch(()=>{});
        await drainAgentHandoffs(env,{orgId,operationId}).catch(()=>{});
        return handoffControl(operationId);
      },
    });
  }
  const unregister=registerCancellation?.(identity,controller);
  try {
    if(!await permitted()) {await endAssignment(env.DB,{...identity,status:'cancelled'});return {cancelled:true};}
    const result=await execute({authorize:permitted,signal:controller.signal,tools,replyFence:{assignmentId:assignment.id,generation:assignment.generation,sourceId:row.id,sourceBody:row.body,sourceAuthor:row.author_login,sourceParent:row.parent_id}});
    const cancellationDrained=await waitForAgentCancellation(controller.signal);
    if(cancellationDrained && result?.failed===true && result.outcome==='not_started' && !controller.signal.aborted
      && assignment.generation<assignment.hop_limit && await assignmentOwns(env.DB,identity)
      && await permitted() && !await externalAssignmentPending(env.DB,identity)) {
      const currentGrant=await assignmentExecutionGrant(env,identity);
      let currentVisited;
      try { currentVisited=JSON.parse(assignment.visited); } catch { currentVisited=null; }
      if(currentGrant && Array.isArray(currentVisited)) {
        const candidates=(await assignmentTargets(env,currentGrant))
          .filter(candidate=>candidate.id!==agent.id && !candidate.provider && !currentVisited.includes(candidate.id))
          .sort((left,right)=>String(left.handle||'').localeCompare(String(right.handle||''))||left.id.localeCompare(right.id));
        for(const candidate of candidates) {
          if(!await hasStaticAgentPeerGrant(env.DB,{orgId,sourceAgentId:agent.id,targetAgentId:candidate.id}))continue;
          if(controller.signal.aborted || !await assignmentOwns(env.DB,identity) || !await permitted()
            || await externalAssignmentPending(env.DB,identity))break;
          const operationId=`auto-handoff-${assignment.id}-${assignment.generation}`;
          const brief='The previous Agent could not start a model call. Continue the original user request from this thread; do not repeat external work unless needed.';
          const handoff=await acceptAgentHandoff(env,{...identity,generation:assignment.generation,sourceAgentId:agent.id,targetAgentId:candidate.id,
            operationId,brief,requireExistingPeerGrant:true,
            messageBody:serverText(locale,'agent.handoff',{name:candidate.name,handle:candidate.handle,brief})});
          if(handoff.error) {
            if(handoff.status===403 && await assignmentOwns(env.DB,identity) && await permitted()
              && !await externalAssignmentPending(env.DB,identity))continue;
            break;
          }
          if(handoff.approvalRequired)break;
          if(publish)await publish(handoff.operation.message_id).catch(()=>{});
          await drainAgentHandoffs(env,{orgId,operationId}).catch(()=>{});
          return {...result,automaticHandoff:{operationId,targetAgentId:candidate.id}};
        }
      }
    }
    if(await assignmentOwns(env.DB,identity)) {
      if(controller.signal.aborted || !await permitted())await endAssignment(env.DB,{...identity,status:'cancelled'});
      else if(!await externalAssignmentPending(env.DB,identity))await endAssignment(env.DB,{...identity,status:result?.failed?'failed':result?.interrupted?'interrupted':'finished'});
    }
    return result;
  } catch(error) {
    await waitForAgentCancellation(controller.signal);
    if(controller.signal.aborted) {
      if(!await externalAssignmentPending(env.DB,identity))await endAssignment(env.DB,{...identity,status:'cancelled'});
      return {cancelled:true};
    }
    if(!await externalAssignmentPending(env.DB,identity))await endAssignment(env.DB,{...identity,status:'failed'});
    throw error;
  } finally {
    unregister?.();
  }
}

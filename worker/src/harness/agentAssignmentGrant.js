import {teammateForAgent,canSignIn} from '../teammates.js';
import {agentRequestGrant, agentExecutionGrant} from '../agentExecutionGrant.js';
import {channelAgents} from '../customAgents.js';
import {filterResponders} from './agents.js';
import {getMode} from './mode.js';
import {beginAssignment, commitHandoff, sourceFingerprint} from './agentAssignments.js';
import {activeAgentWakeGrant,requestAgentWakeApproval} from './agentWakeApprovals.js';

// A delegation is not a forged human message. It retains the original human
// session and source, with an explicitly assigned target checked separately.
async function originGrant(env, assignment) {
  if (!assignment || await getMode(env.DB,assignment.org_id) !== 'harness') return null;
  const grant = await agentRequestGrant(env,{orgId:assignment.org_id,token:assignment.session_key,rowId:assignment.source_message_id});
  if (!grant || grant.resolved.kind !== 'business' || String(grant.session.github_id) !== assignment.actor_id
    || grant.row.channel !== assignment.channel || (grant.row.parent_id || grant.row.id) !== assignment.thread_id
    || await sourceFingerprint(grant.row) !== assignment.source_hash) return null;
  return {...grant,assignment};
}

export async function assignmentTargets(env, grant) {
  const placed = await channelAgents(env.DB,grant.orgId,grant.resolved.key);
  const eligible=await filterResponders(env.DB,grant.orgId,grant.user.login,placed,{named:new Set(placed.map(agent=>agent.id)),channel:grant.resolved.key});
  const available=await Promise.all(eligible.map(async agent=>{
    if(!agent.provider)return agent;
    const teammate=await teammateForAgent(env.DB,grant.orgId,agent);
    return canSignIn(teammate) && (!teammate.channels || teammate.channels.includes(grant.resolved.key))?agent:null;
  }));
  return available.filter(Boolean);
}

export async function beginAuthorizedAssignment(env, request, agentId) {
  if (await getMode(env.DB,request.orgId) !== 'harness') return null;
  const grant = await agentExecutionGrant(env,request);
  if (!grant || grant.resolved.kind !== 'business' || !grant.agents.some(agent=>agent.id===agentId)) return null;
  if (!(await assignmentTargets(env,grant)).some(agent=>agent.id===agentId)) return null;
  return beginAssignment(env.DB,{orgId:grant.orgId,row:grant.row,agentId,actorId:grant.session.github_id,sessionKey:grant.session.token});
}

export async function assignmentExecutionGrant(env,{orgId,assignmentId,generation,agentId,allowPending=false}) {
  const assignment = await env.DB.prepare('SELECT * FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(orgId,assignmentId).first();
  if (!assignment || assignment.generation !== generation || assignment.current_agent_id !== agentId
    || !(assignment.status === 'running' || (allowPending && assignment.status === 'pending'))) return null;
  const grant = await originGrant(env,assignment);
  if (!grant) return null;
  const agent = (await assignmentTargets(env,grant)).find(agent=>agent.id===agentId);
  return agent ? {...grant,agents:[agent]} : null;
}

export async function acceptAgentHandoff(env,input) {
  const assignment = await env.DB.prepare('SELECT * FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(input.orgId,input.assignmentId).first();
  const grant = await originGrant(env,assignment);
  if (!grant) return {error:'Execution access changed.',status:403};
  const eligible = await assignmentTargets(env,grant);
  if (![input.sourceAgentId,input.targetAgentId].every(id=>eligible.some(agent=>agent.id===id))) return {error:'The handoff agents are not available in this room.',status:403};
  const prior=await env.DB.prepare(`SELECT * FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2`).bind(input.orgId,input.operationId).first();
  if(prior) {
    if(prior.assignment_id!==input.assignmentId||prior.source_generation!==input.generation||prior.source_agent_id!==input.sourceAgentId
      ||prior.target_agent_id!==input.targetAgentId||prior.brief!==input.brief||prior.message_body!==input.messageBody)
      return {error:'This operation ID belongs to a different handoff.',status:409};
    return {operation:prior,replayed:true};
  }
  const target=eligible.find(agent=>agent.id===input.targetAgentId);
  const targetExists=Boolean(target);
  const staticPermit=!targetExists || Boolean(await env.DB.prepare(`SELECT 1 FROM hx_agent_agent_members WHERE org_id=?1 AND agent_id=?2 AND member_agent_id=?3`).bind(input.orgId,input.targetAgentId,input.sourceAgentId).first());
  if(targetExists&&!staticPermit) {
    const wakeGrantId=await activeAgentWakeGrant(env.DB,{orgId:input.orgId,assignmentId:input.assignmentId,sourceAgentId:input.sourceAgentId,targetAgentId:input.targetAgentId,operationId:input.operationId});
    if(!wakeGrantId) {
      const request=await requestAgentWakeApproval(env,assignment,{requesterLogin:grant.user.login,targetName:target.name,...input});
      return request.error?request:{approvalRequired:true,...request};
    }
    input={...input,wakeGrantId};
  }
  // commitHandoff checks immutable replay identity before consuming ownership.
  // A valid retry can inspect its original result after the generation changed.
  return commitHandoff(env.DB,input);
}

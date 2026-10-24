import {agentRequestGrant, agentExecutionGrant} from '../agentExecutionGrant.js';
import {channelAgents} from '../customAgents.js';
import {filterResponders} from './agents.js';
import {getMode} from './mode.js';
import {beginAssignment, commitHandoff, sourceFingerprint} from './agentAssignments.js';

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

async function eligibleTargets(env, grant) {
  const placed = await channelAgents(env.DB,grant.orgId,grant.resolved.key);
  return filterResponders(env.DB,grant.orgId,grant.user.login,placed,{named:new Set(placed.map(agent=>agent.id)),channel:grant.resolved.key});
}

export async function beginAuthorizedAssignment(env, request, agentId) {
  if (await getMode(env.DB,request.orgId) !== 'harness') return null;
  const grant = await agentExecutionGrant(env,request);
  if (!grant || grant.resolved.kind !== 'business' || !grant.agents.some(agent=>agent.id===agentId)) return null;
  if (!(await eligibleTargets(env,grant)).some(agent=>agent.id===agentId)) return null;
  return beginAssignment(env.DB,{orgId:grant.orgId,row:grant.row,agentId,actorId:grant.session.github_id,sessionKey:grant.session.token});
}

export async function assignmentExecutionGrant(env,{orgId,assignmentId,generation,agentId,allowPending=false}) {
  const assignment = await env.DB.prepare('SELECT * FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(orgId,assignmentId).first();
  if (!assignment || assignment.generation !== generation || assignment.current_agent_id !== agentId
    || !(assignment.status === 'running' || (allowPending && assignment.status === 'pending'))) return null;
  const grant = await originGrant(env,assignment);
  if (!grant) return null;
  const agent = (await eligibleTargets(env,grant)).find(agent=>agent.id===agentId);
  return agent ? {...grant,agents:[agent]} : null;
}

export async function acceptAgentHandoff(env,input) {
  const assignment = await env.DB.prepare('SELECT * FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(input.orgId,input.assignmentId).first();
  const grant = await originGrant(env,assignment);
  if (!grant) return {error:'Execution access changed.',status:403};
  const eligible = await eligibleTargets(env,grant);
  if (![input.sourceAgentId,input.targetAgentId].every(id=>eligible.some(agent=>agent.id===id))) return {error:'The handoff agents are not available in this room.',status:403};
  // commitHandoff checks immutable replay identity before consuming ownership.
  // A valid retry can inspect its original result after the generation changed.
  return commitHandoff(env.DB,input);
}

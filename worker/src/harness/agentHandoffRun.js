import {assignmentExecutionGrant} from './agentAssignmentGrant.js';
import {claimHandoff,endAssignment} from './agentAssignments.js';
import {runAgents} from '../channelRoutes.js';

export async function handoffExecution(db,orgId,operationId) {
  const operation=await db.prepare('SELECT * FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2').bind(orgId,operationId).first();
  return operation?{operation,identity:{orgId,assignmentId:operation.assignment_id,generation:operation.source_generation+1,agentId:operation.target_agent_id}}:null;
}

export async function settleHandoff(env,job,result) {
  const execution=await handoffExecution(env.DB,job.orgId,job.rowId);
  if(!execution)return;
  const status=['finished','failed','cancelled','interrupted'].includes(result.status)?result.status:'interrupted';
  await endAssignment(env.DB,{...execution.identity,status});
}

export async function runQueuedHandoff(env,{orgId,rowId}) {
  const execution=await handoffExecution(env.DB,orgId,rowId);
  if(!execution)return {status:'cancelled',answered:0};
  const {operation,identity}=execution;
  const grant=await assignmentExecutionGrant(env,{...identity,allowPending:true});
  if(!grant) {await endAssignment(env.DB,{...identity,status:'cancelled'});return {status:'cancelled',answered:0};}
  if(!await claimHandoff(env.DB,{orgId,operationId:rowId})) {
    // Another attempt has already claimed this generation. Its outcome is
    // uncertain, so never repeat the model or its tools.
    await endAssignment(env.DB,{...identity,status:'interrupted'});
    return {status:'interrupted',answered:0};
  }
  const assignment={...grant.assignment,status:'running'};
  const authorize=async()=>Boolean(await assignmentExecutionGrant(env,identity));
  const answered=await runAgents(env,{...grant,assignment,durableExecution:true,requestOverride:operation.brief,locale:grant.user.locale || 'en',authorize});
  const current=await env.DB.prepare('SELECT generation,status FROM hx_agent_assignments WHERE org_id=?1 AND id=?2').bind(orgId,identity.assignmentId).first();
  return {status:current?.generation>identity.generation?'handed_off':current?.status || 'interrupted',answered};
}

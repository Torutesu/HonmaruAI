import {assignmentExecutionGrant} from './agentAssignmentGrant.js';
import {endAssignment} from './agentAssignments.js';

export function externalIdentity(run) {
  return run.assignment_id?{orgId:run.org_id,assignmentId:run.assignment_id,generation:run.assignment_generation,agentId:run.assignment_agent_id}:null;
}
export async function externalAssignmentPending(db,{orgId,assignmentId,generation,agentId}) {
  return Boolean(await db.prepare(`SELECT 1 FROM ai_teammate_runs WHERE org_id=?1 AND assignment_id=?2 AND assignment_generation=?3 AND assignment_agent_id=?4 AND status='running'
    UNION ALL SELECT 1 FROM ai_teammate_result_dispatch WHERE org_id=?1 AND assignment_id=?2 AND assignment_generation=?3 AND assignment_agent_id=?4 AND status='pending' LIMIT 1`)
    .bind(orgId,assignmentId,generation,agentId).first());
}
export async function externalReplyGrant(env,run,agentId) {
  const identity=externalIdentity(run);
  if(!identity)return null;
  const grant=identity.agentId===agentId && await assignmentExecutionGrant(env,identity);
  if(!grant || grant.row.channel!==run.channel || grant.assignment.thread_id!==run.thread_id) {
    await endAssignment(env.DB,{...identity,status:'cancelled'});return null;
  }
  return {identity,replyFence:{assignmentId:identity.assignmentId,generation:identity.generation,sourceId:grant.row.id,sourceBody:grant.row.body,sourceAuthor:grant.row.author_login,sourceParent:grant.row.parent_id}};
}

import {isMember} from '../db.js';
import {getWorkflow} from './workflows.js';

// Read-time permission checks apply to durable notices as well as workflows.
// Returning a notice does not mark it read, so refresh/retry is harmless.
export async function workflowNotices(db,orgId,userId,input={},markRead=false){
 if(!await isMember(db,orgId,userId))return {error:'Workspace access required.',status:403};
 const {results}=await db.prepare(`SELECT workflow_id AS workflowId,generation,run_id AS runId,created_at AS createdAt,read_at AS readAt
   FROM hx_workflow_safety_notices WHERE org_id=?1 AND recipient_id=?2 ORDER BY created_at DESC LIMIT 100`)
   .bind(orgId,String(userId)).all();
 const items=[];
 for(const notice of results){
  const workflow=await getWorkflow(db,orgId,notice.workflowId,{viewerId:userId});
  if(!workflow)continue;
  items.push({...notice,name:workflow.name,paused:!!workflow.safety?.paused_at&&workflow.safety.generation===notice.generation});
 }
 if(markRead){
  const notice=items.find(n=>n.workflowId===input.workflowId&&n.generation===input.generation);
  if(!notice)return {error:'No such notification.',status:404};
  await db.prepare('UPDATE hx_workflow_safety_notices SET read_at=COALESCE(read_at,?1) WHERE org_id=?2 AND recipient_id=?3 AND workflow_id=?4 AND generation=?5')
   .bind(new Date().toISOString(),orgId,String(userId),notice.workflowId,notice.generation).run();
  return {ok:true};
 }
 return {items};
}

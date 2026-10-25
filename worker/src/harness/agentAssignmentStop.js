// The route must verify current membership, sign-in policy and source-room
// readability first. A stale button cannot stop a newer assignment generation.
export async function stopAssignment(db,{orgId,sourceMessageId,channel,assignmentId,generation,actorId,canManage=false}) {
  if(typeof assignmentId!=='string'||!assignmentId||assignmentId.length>100||!Number.isSafeInteger(generation)||generation<0||generation>8)return {status:400,message:'Invalid execution.'};
  const assignment=await db.prepare('SELECT actor_id,generation,status,remote_stop_status,remote_stop_updated_at FROM hx_agent_assignments WHERE org_id=?1 AND id=?2 AND source_message_id=?3 AND channel=?4')
    .bind(orgId,assignmentId,sourceMessageId,channel).first();
  if(!assignment)return {status:404,message:'No such execution.'};
  if(!canManage && assignment.actor_id!==String(actorId))return {status:403,message:'You cannot stop this execution.'};
  if(assignment.generation!==generation)return {status:409,message:'The execution changed. Refresh before stopping it.'};
  if(assignment.status==='cancelled') {
    const waiting=assignment.remote_stop_status==='requesting' && Date.now()-Date.parse(assignment.remote_stop_updated_at||'')<30000;
    return {status:200,stopped:true,retryRemote:!waiting&&!['requested','already_finished','unsupported','no_remote_run'].includes(assignment.remote_stop_status),remoteStop:assignment.remote_stop_status || null};
  }
  const updated=await db.prepare(`UPDATE hx_agent_assignments SET status='cancelled',updated_at=?5,remote_stop_status='pending',remote_stop_updated_at=?5
    WHERE org_id=?1 AND id=?2 AND generation=?3 AND source_message_id=?4 AND status IN ('running','pending')`)
    .bind(orgId,assignmentId,generation,sourceMessageId,new Date().toISOString()).run();
  return updated.meta?.changes?{status:200,stopped:true,retryRemote:true,remoteStop:'pending'}:{status:409,message:'The execution changed. Refresh before stopping it.'};
}

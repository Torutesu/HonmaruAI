// Called before a durable normal job is marked terminal. Only generation zero
// belongs to that job: a delegated target has its own durable execution.
export async function settleInitialAssignments(env,job,result) {
  const status=['finished','failed','cancelled','interrupted'].includes(result.status)?result.status:result.status==='no_agents'?'cancelled':'interrupted';
  await env.DB.prepare(`UPDATE hx_agent_assignments SET status=?3,updated_at=?4
    WHERE org_id=?1 AND source_message_id=?2 AND generation=0 AND status='running'
      AND NOT EXISTS(SELECT 1 FROM ai_teammate_runs r WHERE r.org_id=hx_agent_assignments.org_id AND r.assignment_id=hx_agent_assignments.id AND r.assignment_generation=0 AND r.status='running')
      AND NOT EXISTS(SELECT 1 FROM ai_teammate_result_dispatch d WHERE d.org_id=hx_agent_assignments.org_id AND d.assignment_id=hx_agent_assignments.id AND d.assignment_generation=0 AND d.status='pending')`)
    .bind(job.orgId,job.rowId,status,new Date().toISOString()).run();
}

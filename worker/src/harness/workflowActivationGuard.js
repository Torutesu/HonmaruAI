// Used within the state statement: both the workflow checkpoint lease and the
// assigned gateway job lease must still be live at the moment D1 reads/writes.
export function workflowActivationFence(job,gateway,lease,at) {
 return `EXISTS(SELECT 1 FROM hx_workflow_activations a
 JOIN hx_gateway_jobs j ON j.org_id=a.org_id AND j.id=a.job_id
 JOIN hx_gateways g ON g.org_id=j.org_id AND g.id=j.gateway_id
 WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.node_id=c.node_id AND a.node_owner=c.owner AND a.node_attempt=c.attempt
 AND j.id=${job} AND g.id=${gateway} AND g.revoked_at IS NULL
 AND EXISTS(SELECT 1 FROM memberships gm WHERE gm.org_id=g.org_id AND gm.user_github_id=g.created_by AND lower(gm.role) IN ('owner','admin'))
 AND j.created_by=json_extract(d.definition,'$.createdBy')
 AND (json_extract(j.payload,'$.context.roomId') IS NULL OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=r.workflow_id AND source.channel=json_extract(j.payload,'$.context.roomId')))
 AND j.status='running' AND j.lease_hash=${lease} AND j.lease_until>${at} AND j.deadline>${at})`;
}
export function activationScope(value) {
 if(value===undefined)return [null,null,null];
 if(!value||!['jobId','gatewayId','leaseHash'].every(key=>typeof value[key]==='string'&&value[key].length>0&&value[key].length<=200))throw Error('Invalid workflow activation.');
 return [value.jobId,value.gatewayId,value.leaseHash];
}

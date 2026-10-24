// Internal checkpoint store. Callers must authorize the node's effects before
// execution; possession of a lease is not permission to access a resource.
const MAX_RESULT = 128000;
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
function scope(orgId,runId,nodeId) { if (![orgId,runId,nodeId].every(valid)) throw Error('Invalid checkpoint identity.'); }
function clock(at,ttl=30000) { if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(ttl)||ttl<1000||ttl>300000||!Number.isSafeInteger(at+ttl))throw Error('Invalid checkpoint lease.'); }
export async function claimWorkflowNode(db,{orgId,runId,nodeId,fingerprint,effect=false,at=Date.now(),ttl=30000}) {
 scope(orgId,runId,nodeId);clock(at,ttl);if(!valid(fingerprint)||typeof effect!=='boolean')throw Error('Invalid checkpoint definition.');
 const owner=crypto.randomUUID();
 await db.batch([
  db.prepare(`INSERT OR IGNORE INTO hx_workflow_node_checkpoints(org_id,run_id,node_id,fingerprint,effect,status,owner,attempt,lease_until)
   SELECT ?1,?2,?3,?4,?5,'running',?6,1,?7 WHERE EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?1 AND id=?2 AND status='running')`)
   .bind(orgId,runId,nodeId,fingerprint,effect?1:0,owner,at+ttl),
  db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='unknown' WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND status='running' AND effect=1 AND lease_until<=?4 AND fingerprint=?5 AND ?6=1`)
   .bind(orgId,runId,nodeId,at,fingerprint,effect?1:0),
  db.prepare(`UPDATE hx_workflow_node_checkpoints SET owner=?4,attempt=attempt+1,lease_until=?5 WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND status='running' AND effect=0 AND lease_until<=?6 AND fingerprint=?7 AND ?8=0
   AND EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?1 AND id=?2 AND status='running')`)
   .bind(orgId,runId,nodeId,owner,at+ttl,at,fingerprint,effect?1:0),
 ]);
 const row=await db.prepare('SELECT * FROM hx_workflow_node_checkpoints WHERE org_id=?1 AND run_id=?2 AND node_id=?3').bind(orgId,runId,nodeId).first();
 if(!row)return {status:'unavailable'};
 if(row.fingerprint!==fingerprint||row.effect!==(effect?1:0))return {status:'conflict'};
 if(row.status==='done')return {status:'done',result:JSON.parse(row.result)};
 if(row.status==='unknown')return {status:'unknown'};
 if(row.owner!==owner)return {status:'busy'};
 return {status:'acquired',owner,attempt:row.attempt,leaseUntil:row.lease_until};
}
export async function finishWorkflowNode(db,{orgId,runId,nodeId,owner,attempt,result,at=Date.now()}) {
 scope(orgId,runId,nodeId);clock(at);if(!valid(owner)||!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid checkpoint claim.');
 const serialized=JSON.stringify(result);if(typeof serialized!=='string'||new TextEncoder().encode(serialized).length>MAX_RESULT)throw Error('Checkpoint result exceeds the limit or is not JSON.');
 const saved=await db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='done',result=?6,lease_until=0 WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND owner=?4 AND attempt=?5 AND status='running' AND lease_until>?7
  AND EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?1 AND id=?2 AND status='running')`)
  .bind(orgId,runId,nodeId,owner,attempt,serialized,at).run();
 return !!saved.meta?.changes;
}
export async function renewWorkflowNode(db,{orgId,runId,nodeId,owner,attempt,at=Date.now(),ttl=30000}) {
 scope(orgId,runId,nodeId);clock(at,ttl);if(!valid(owner)||!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid checkpoint claim.');
 const saved=await db.prepare(`UPDATE hx_workflow_node_checkpoints SET lease_until=MAX(lease_until,?6) WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND owner=?4 AND attempt=?5 AND status='running' AND lease_until>?7
  AND EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?1 AND id=?2 AND status='running')`)
  .bind(orgId,runId,nodeId,owner,attempt,at+ttl,at).run();
 return !!saved.meta?.changes;
}

// Internal D1 effects only. Authorization must be represented in the supplied
// statements; this lease fence is not a substitute for current resource ACLs.
// Never pass statements that mutate workflow orchestration/checkpoint tables.
export async function commitWorkflowNodeEffects(db,{orgId,runId,nodeId,owner,attempt,result,statements,at=Date.now()}) {
 scope(orgId,runId,nodeId);clock(at);
 if(!valid(owner)||!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid checkpoint claim.');
 if(!Array.isArray(statements)||!statements.length||statements.length>32)throw Error('Expected 1–32 local effect statements.');
 const serialized=JSON.stringify(result);
 if(typeof serialized!=='string'||new TextEncoder().encode(serialized).length>MAX_RESULT)throw Error('Checkpoint result exceeds the limit or is not JSON.');
 // A failed fence deliberately violates the checkpoint status CHECK constraint.
 // Unlike an UPDATE affecting zero rows, this aborts the entire D1 batch before
 // any effect can commit. No sentinel row is inserted for a valid lease.
 const fence=db.prepare(`INSERT INTO hx_workflow_node_checkpoints(org_id,run_id,node_id,fingerprint,effect,status,owner,attempt,lease_until)
  SELECT ?1,?2,?3,'fence',1,'invalid-lease',?4,?5,0 WHERE NOT EXISTS(
   SELECT 1 FROM hx_workflow_node_checkpoints c JOIN hx_workflow_runs r ON r.id=c.run_id AND r.org_id=c.org_id
   WHERE c.org_id=?1 AND c.run_id=?2 AND c.node_id=?3 AND c.owner=?4 AND c.attempt=?5 AND c.effect=1 AND c.status='running' AND c.lease_until>?6 AND r.status='running')`)
  .bind(orgId,runId,nodeId,owner,attempt,at);
 const complete=db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='done',result=?6,lease_until=0
  WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND owner=?4 AND attempt=?5`)
  .bind(orgId,runId,nodeId,owner,attempt,serialized);
 // All effects and completion roll back together if any statement fails.
 await db.batch([fence,complete,...statements]);
 return {status:'done',result};
}

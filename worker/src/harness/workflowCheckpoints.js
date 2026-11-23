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
export async function finishWorkflowNode(db,{orgId,runId,nodeId,owner,attempt,result,at=Date.now(),sourceGrantFence=null,remoteMcpFence=null,workflowRemoteMcpFence=null}) {
 scope(orgId,runId,nodeId);clock(at);if(!valid(owner)||!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid checkpoint claim.');
 if(sourceGrantFence&&(!valid(sourceGrantFence.orgId)||!valid(sourceGrantFence.agentId)||!valid(sourceGrantFence.ownerId)||!['notion','github'].includes(sourceGrantFence.source)))throw Error('Invalid checkpoint authorization fence.');
 if(remoteMcpFence&&(sourceGrantFence||![remoteMcpFence.orgId,remoteMcpFence.agentId,remoteMcpFence.actorId,remoteMcpFence.serverId,remoteMcpFence.toolName,remoteMcpFence.workflowOwnerId,remoteMcpFence.actorMembershipSince].every(valid)
  ||remoteMcpFence.legacyGeneration==null&&remoteMcpFence.toolGeneration==null&&remoteMcpFence.shareAudienceType!=='agent'))throw Error('Invalid Remote MCP checkpoint authorization fence.');
 if(workflowRemoteMcpFence&&(sourceGrantFence||remoteMcpFence||![workflowRemoteMcpFence.orgId,workflowRemoteMcpFence.workflowId,workflowRemoteMcpFence.actorId,workflowRemoteMcpFence.workflowOwnerId,workflowRemoteMcpFence.actorMembershipSince,workflowRemoteMcpFence.ownerMembershipSince,workflowRemoteMcpFence.serverId,workflowRemoteMcpFence.toolName,workflowRemoteMcpFence.grantGeneration,workflowRemoteMcpFence.grantCreatedAt,workflowRemoteMcpFence.workflowUpdatedAt,workflowRemoteMcpFence.modeUpdatedAt,workflowRemoteMcpFence.serverUpdatedAt].every(valid)))throw Error('Invalid Workflow Remote MCP checkpoint authorization fence.');
 const serialized=JSON.stringify(result);if(typeof serialized!=='string'||new TextEncoder().encode(serialized).length>MAX_RESULT)throw Error('Checkpoint result exceeds the limit or is not JSON.');
 const grantFence=sourceGrantFence?` AND EXISTS(SELECT 1 FROM hx_agent_source_grants g
  JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id AND m.created_at=g.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
  JOIN custom_agents a ON a.org_id=g.org_id AND a.id=g.agent_id AND a.deleted_at IS NULL
  WHERE g.org_id=?8 AND g.agent_id=?9 AND g.user_github_id=?10 AND g.source=?11)`:'';
 const remoteFence=remoteMcpFence?` AND EXISTS(
  SELECT 1 FROM hx_remote_mcp_servers s
  JOIN custom_agents a ON a.org_id=s.org_id AND a.id=?9
  JOIN memberships actor ON actor.org_id=s.org_id AND actor.user_github_id=?10 AND actor.created_at=?14 AND LOWER(TRIM(COALESCE(actor.role,'guest')))!='guest'
  JOIN memberships maker ON maker.org_id=s.org_id AND maker.user_github_id=?13 AND maker.created_at=?44 AND LOWER(TRIM(COALESCE(maker.role,'guest')))!='guest'
  JOIN org_settings os ON os.org_id=s.org_id AND os.mode='harness' AND os.updated_at IS ?16
  LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
  LEFT JOIN hx_agent_access x ON x.org_id=a.org_id AND x.agent_id=a.id
  WHERE s.org_id=?8 AND s.id=?11 AND a.deleted_at IS NULL
   AND a.created_at IS ?17 AND a.updated_at IS ?18 AND a.deleted_at IS ?19 AND a.scope IS ?20 AND a.owner_login IS ?21
   AND p.access IS ?22 AND p.people IS ?23 AND p.updated_at IS ?24
   AND COALESCE(x.version,0) IS ?25 AND x.mutation_id IS ?26
   AND (SELECT json_group_array(json_object('user',r.user_id,'since',r.member_since,'role',r.role,'updatedAt',r.updated_at)) FROM hx_agent_members r WHERE r.org_id=a.org_id AND r.agent_id=a.id) IS ?27
   AND s.auth_mode IS ?28 AND s.updated_at IS ?29 AND s.allowed_tools IS ?30 AND s.tools_json IS ?31
   AND ((?32 IS NOT NULL AND EXISTS(SELECT 1 FROM hx_agent_remote_mcp_grants g WHERE g.org_id=?8 AND g.agent_id=?9 AND g.user_github_id=?10 AND g.server_id=?11 AND g.generation=?32 AND g.membership_since IS ?33 AND g.created_at IS ?34))
     OR (?35 IS NOT NULL AND EXISTS(SELECT 1 FROM hx_agent_remote_mcp_tool_grants tg WHERE tg.org_id=?8 AND tg.agent_id=?9 AND tg.user_github_id=?10 AND tg.server_id=?11 AND tg.tool_name=?12 AND tg.generation=?35 AND tg.membership_since IS ?36 AND tg.created_at IS ?37))
     OR (?45='agent' AND EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_shares sh WHERE sh.org_id=?8 AND sh.server_id=?11 AND sh.owner_github_id=?15 AND sh.audience_type=?45 AND sh.audience_id=?46 AND sh.audience_membership_since IS ?47 AND sh.created_at IS ?48)))
   AND ((?38 IS NULL AND NOT EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_credentials c WHERE c.org_id=?8 AND c.server_id=?11 AND c.user_github_id=?15))
     OR EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_credentials c WHERE c.org_id=?8 AND c.server_id=?11 AND c.user_github_id=?15 AND c.rowid=?38 AND c.membership_since IS ?39 AND c.created_at IS ?40))
   AND ((?41 IS NULL AND NOT EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_share_sets sh WHERE sh.org_id=?8 AND sh.server_id=?11 AND sh.owner_github_id=?15))
     OR EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_share_sets sh WHERE sh.org_id=?8 AND sh.server_id=?11 AND sh.owner_github_id=?15 AND sh.version=?41 AND sh.owner_membership_since IS ?42 AND sh.mutation_id IS ?43))
 )`:'';
 const workflowMcpFence=workflowRemoteMcpFence?` AND EXISTS(
  SELECT 1 FROM hx_workflow_runs r
  JOIN hx_workflows w ON w.org_id=r.org_id AND w.id=r.workflow_id
  JOIN hx_workflow_remote_mcp_tool_grants g ON g.org_id=w.org_id AND g.workflow_id=w.id
    AND g.server_id=?11 AND g.tool_name=?12 AND g.generation=?13 AND g.created_at=?14 AND g.granted_by=?24
  JOIN hx_remote_mcp_servers s ON s.org_id=g.org_id AND s.id=g.server_id
  JOIN memberships actor ON actor.org_id=w.org_id AND actor.user_github_id=?10 AND actor.created_at=?16 AND LOWER(TRIM(COALESCE(actor.role,'guest')))!='guest'
  JOIN memberships maker ON maker.org_id=w.org_id AND maker.user_github_id=?17 AND maker.created_at=?18 AND LOWER(TRIM(COALESCE(maker.role,'guest')))!='guest'
  JOIN org_settings os ON os.org_id=w.org_id AND os.mode='harness' AND os.updated_at=?19
  WHERE r.org_id=?8 AND r.id=?2 AND r.workflow_id=?9 AND r.status='running'
    AND w.created_by=?17 AND w.updated_at=?15 AND s.auth_mode='headers' AND s.updated_at=?20
    AND s.allowed_tools=?21 AND s.write_tools=?22 AND s.tools_json=?23
    AND EXISTS(SELECT 1 FROM json_each(s.allowed_tools) allowed WHERE allowed.value=?12)
 )`:'';
 const query=db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='done',result=?6,lease_until=0 WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND owner=?4 AND attempt=?5 AND status='running' AND lease_until>?7
  AND EXISTS(SELECT 1 FROM hx_workflow_runs WHERE org_id=?1 AND id=?2 AND status='running')${grantFence}${remoteFence}${workflowMcpFence}`);
 let params=[orgId,runId,nodeId,owner,attempt,serialized,at];
 if(sourceGrantFence)params.push(sourceGrantFence.orgId,sourceGrantFence.agentId,sourceGrantFence.ownerId,sourceGrantFence.source);
 if(remoteMcpFence)params.push(remoteMcpFence.orgId,remoteMcpFence.agentId,remoteMcpFence.actorId,remoteMcpFence.serverId,remoteMcpFence.toolName,
  remoteMcpFence.workflowOwnerId,remoteMcpFence.actorMembershipSince,remoteMcpFence.connectionOwnerId,
  remoteMcpFence.modeUpdatedAt,remoteMcpFence.agentCreatedAt,remoteMcpFence.agentUpdatedAt,remoteMcpFence.agentDeletedAt,remoteMcpFence.agentScope,remoteMcpFence.agentOwnerLogin,
  remoteMcpFence.agentProfileAccess,remoteMcpFence.agentProfilePeople,remoteMcpFence.agentProfileUpdatedAt,remoteMcpFence.agentAccessVersion,remoteMcpFence.agentAccessMutation,
  remoteMcpFence.agentMembers,
  remoteMcpFence.serverAuthMode,remoteMcpFence.serverUpdatedAt,remoteMcpFence.serverAllowedTools,remoteMcpFence.serverToolsJson,
  remoteMcpFence.legacyGeneration,remoteMcpFence.legacyMembershipSince,remoteMcpFence.legacyCreatedAt,remoteMcpFence.toolGeneration,remoteMcpFence.toolMembershipSince,remoteMcpFence.toolCreatedAt,
  remoteMcpFence.credentialGeneration,remoteMcpFence.credentialMembershipSince,remoteMcpFence.credentialCreatedAt,remoteMcpFence.shareVersion,remoteMcpFence.shareOwnerMembershipSince,remoteMcpFence.shareMutationId,
  remoteMcpFence.workflowOwnerMembershipSince,
  remoteMcpFence.shareAudienceType,remoteMcpFence.shareAudienceId,remoteMcpFence.shareAudienceMembershipSince,remoteMcpFence.shareCreatedAt);
 if(workflowRemoteMcpFence)params.push(workflowRemoteMcpFence.orgId,workflowRemoteMcpFence.workflowId,workflowRemoteMcpFence.actorId,
  workflowRemoteMcpFence.serverId,workflowRemoteMcpFence.toolName,workflowRemoteMcpFence.grantGeneration,workflowRemoteMcpFence.grantCreatedAt,
  workflowRemoteMcpFence.workflowUpdatedAt,workflowRemoteMcpFence.actorMembershipSince,workflowRemoteMcpFence.workflowOwnerId,
  workflowRemoteMcpFence.ownerMembershipSince,workflowRemoteMcpFence.modeUpdatedAt,workflowRemoteMcpFence.serverUpdatedAt,
  workflowRemoteMcpFence.allowedTools,workflowRemoteMcpFence.writeTools,workflowRemoteMcpFence.toolsJson,workflowRemoteMcpFence.grantedBy);
 const saved=await query.bind(...params).run();
 return !!saved.meta?.changes;
}
export async function markWorkflowNodeUnknown(db,{orgId,runId,nodeId,owner,attempt,at=Date.now()}) {
 scope(orgId,runId,nodeId);clock(at);if(!valid(owner)||!Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid checkpoint claim.');
 const saved=await db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='unknown',lease_until=0
  WHERE org_id=?1 AND run_id=?2 AND node_id=?3 AND owner=?4 AND attempt=?5 AND effect=1 AND status='running'`)
  .bind(orgId,runId,nodeId,owner,attempt).run();
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
 const guardedStatements=statements.flatMap(statement=>[
  statement,
  // A guarded UPDATE/INSERT that affects no row is a conflict, not a saved
  // success. Make D1 roll the transaction back, including checkpoint `done`.
  db.prepare(`INSERT INTO hx_workflow_node_checkpoints(org_id,run_id,node_id,fingerprint,effect,status,owner,attempt,lease_until)
   SELECT ?1,?2,?3,'effect-fence',1,'invalid-effect',?4,?5,0 WHERE changes()=0`)
   .bind(orgId,runId,nodeId,owner,attempt),
 ]);
 // All effects and completion roll back together if a write errors or its
 // guarded statement affects no row.
 await db.batch([fence,complete,...guardedStatements]);
 return {status:'done',result};
}

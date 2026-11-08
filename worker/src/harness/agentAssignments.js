// Persistence only: callers must resolve current origin/room/agent authority.
// There is deliberately no public HTTP entry point into this state machine.
export const MAX_HANDOFF_HOPS = 8;
const conflict = () => ({error: 'The assignment changed or is no longer running.', status: 409});
const idOk = value => typeof value === 'string' && value.length > 0 && value.length <= 100;
const actorMayUseAgent = agentId => `EXISTS(SELECT 1 FROM custom_agents access_agent
  JOIN users access_user ON access_user.github_id=hx_agent_assignments.actor_id
  LEFT JOIN hx_agent_profiles access_profile ON access_profile.org_id=access_agent.org_id AND access_profile.agent_id=access_agent.id
  WHERE access_agent.org_id=?1 AND access_agent.id=${agentId} AND access_agent.deleted_at IS NULL
    AND (access_agent.scope='team' OR access_agent.owner_login=access_user.login)
    AND (access_agent.scope!='team' OR access_agent.owner_login=access_user.login
      OR (access_profile.agent_id IS NULL OR access_profile.access='everyone'
        OR (access_profile.access='people' AND EXISTS(SELECT 1 FROM json_each(access_profile.people) p WHERE p.value=access_user.login))
        OR EXISTS(SELECT 1 FROM hx_agent_members role
          WHERE role.org_id=access_agent.org_id AND role.agent_id=access_agent.id AND role.user_id=hx_agent_assignments.actor_id
            AND role.member_since=hx_agent_assignments.actor_membership AND role.role IN ('admin','member')))))`;

export async function sourceFingerprint(row) {
  const bytes = new TextEncoder().encode(JSON.stringify([row.id, row.channel, row.author_login, row.parent_id || null, row.body]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// One assignment per independently requested initial agent. An existing
// running record is not a permit to repeat an uncertain external execution.
export async function beginAssignment(db, {orgId, row, agentId, actorId, sessionKey, hopLimit = MAX_HANDOFF_HOPS}) {
  if (!idOk(agentId) || !idOk(row?.id) || !String(sessionKey || '').startsWith('h1:') || !actorId || !row.channel || row.kind !== 'message'
    || !Number.isSafeInteger(hopLimit) || hopLimit < 1 || hopLimit > MAX_HANDOFF_HOPS) return {error: 'Invalid execution origin.', status: 400};
  const sourceHash = await sourceFingerprint(row), now = new Date().toISOString(), id = crypto.randomUUID();
  const inserted = await db.prepare(`INSERT INTO hx_agent_assignments
    (id,org_id,source_message_id,initial_agent_id,current_agent_id,channel,thread_id,actor_id,actor_membership,session_key,source_hash,status,visited,hop_limit,created_at,updated_at)
    SELECT ?1,?2,?3,?4,?4,?5,?6,?7,m.created_at,?8,?9,'running',?10,?11,?12,?12 FROM channel_messages cm
      LEFT JOIN memberships m ON m.org_id=cm.org_id AND m.user_github_id=?7 AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE cm.org_id=?2 AND cm.id=?3 AND cm.channel=?5 AND cm.body=?13 AND cm.author_login=?14 AND COALESCE(cm.parent_id,'')=?15 AND cm.kind='message' AND cm.deleted_at IS NULL
    ON CONFLICT(org_id,source_message_id,initial_agent_id) DO NOTHING`)
    .bind(id,orgId,row.id,agentId,row.channel,row.parent_id || row.id,String(actorId),sessionKey,sourceHash,JSON.stringify([agentId]),hopLimit,now,row.body,row.author_login,row.parent_id || '').run();
  const assignment = await db.prepare('SELECT * FROM hx_agent_assignments WHERE org_id=?1 AND source_message_id=?2 AND initial_agent_id=?3').bind(orgId,row.id,agentId).first();
  if (!assignment || assignment.source_hash !== sourceHash || assignment.actor_id !== String(actorId) || assignment.session_key !== sessionKey) return conflict();
  return {assignment, started: Boolean(inserted.meta?.changes)};
}

export async function assignmentOwns(db, {orgId, assignmentId, generation, agentId}) {
  return Boolean(await db.prepare("SELECT 1 FROM hx_agent_assignments WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status='running'")
    .bind(orgId,assignmentId,generation,agentId).first());
}

// Exactly one operation can consume an assignment generation. The visible
// event and delivery outbox exist iff the owner transition commits.
export async function commitHandoff(db, {orgId, assignmentId, generation, sourceAgentId, targetAgentId, operationId, brief, messageBody, wakeGrantId=null}) {
  if (![assignmentId,sourceAgentId,targetAgentId,operationId].every(idOk) || !Number.isSafeInteger(generation) || generation < 0
    || typeof brief !== 'string' || !brief.trim() || brief.length > 16000 || typeof messageBody !== 'string' || !messageBody.trim() || messageBody.length > 20000)
    return {error: 'Invalid handoff.', status: 400};
  const previous = async () => {
    const operation = await db.prepare('SELECT * FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2').bind(orgId,operationId).first();
    if (!operation) return null;
    if (operation.assignment_id !== assignmentId || operation.source_generation !== generation || operation.source_agent_id !== sourceAgentId || operation.target_agent_id !== targetAgentId || operation.brief !== brief || operation.message_body !== messageBody)
      return {error: 'This operation ID belongs to a different handoff.', status: 409};
    return {operation, replayed: true};
  };
  const replay = await previous();
  if (replay) return replay;
  if (sourceAgentId === targetAgentId) return {error: 'An agent cannot hand work to itself.', status: 409};
  const targetIsManaged=await db.prepare(`SELECT 1 FROM custom_agents a
    WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL`)
    .bind(orgId,targetAgentId).first();
  if(targetIsManaged&&!await db.prepare(`SELECT 1 FROM hx_agent_agent_members peer
    JOIN custom_agents source ON source.org_id=peer.org_id AND source.id=peer.member_agent_id
      AND source.scope='team' AND source.provider IS NULL AND source.deleted_at IS NULL
    JOIN hx_agent_profiles source_profile ON source_profile.org_id=source.org_id AND source_profile.agent_id=source.id
    WHERE peer.org_id=?1 AND peer.agent_id=?2 AND peer.member_agent_id=?3`).bind(orgId,targetAgentId,sourceAgentId).first()
    && !await db.prepare(`SELECT 1 FROM hx_agent_wake_grants g JOIN hx_agent_assignments a ON a.org_id=g.org_id AND a.id=?6
      WHERE g.org_id=?1 AND g.id=?2 AND g.source_agent_id=?3 AND g.target_agent_id=?4 AND g.requester_id=a.actor_id
        AND g.room_channel=a.channel AND (g.scope!='thread' OR g.thread_id=a.thread_id)
        AND (g.scope!='once' OR EXISTS(SELECT 1 FROM hx_agent_wake_approvals r WHERE r.org_id=g.org_id AND r.id=g.approval_id AND r.assignment_id=a.id AND r.source_generation=a.generation AND r.operation_id=?7))
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?5) AND (g.use_limit IS NULL OR g.use_count<g.use_limit)`)
      .bind(orgId,wakeGrantId||'',sourceAgentId,targetAgentId,new Date().toISOString(),assignmentId,operationId).first())
    return {error:'This Agent is not assigned to the target Agent.',status:403};
  const now = new Date().toISOString(), messageId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`UPDATE hx_agent_assignments SET current_agent_id=?5,generation=generation+1,status='pending',
      visited=json_insert(visited,'$[#]',?5),mutation_id=?6,updated_at=?7
      WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status='running'
        AND generation<hop_limit AND NOT EXISTS(SELECT 1 FROM json_each(visited) WHERE value=?5)
        AND (hx_agent_assignments.actor_membership IS NULL OR EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=hx_agent_assignments.actor_id
          AND m.created_at=hx_agent_assignments.actor_membership AND LOWER(COALESCE(m.role,'guest'))!='guest'))
        AND (NOT EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=?1 AND b.slug=substr(hx_agent_assignments.channel,3) AND b.private=1)
          OR EXISTS(SELECT 1 FROM users u JOIN conversation_members cm ON cm.org_id=?1 AND cm.channel=hx_agent_assignments.channel AND cm.login=u.login
            WHERE u.github_id=hx_agent_assignments.actor_id))
        AND EXISTS(SELECT 1 FROM channel_agents ca JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
          WHERE ca.org_id=?1 AND ca.channel=hx_agent_assignments.channel AND ca.agent_id=?4)
        AND EXISTS(SELECT 1 FROM channel_agents ca JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
          WHERE ca.org_id=?1 AND ca.channel=hx_agent_assignments.channel AND ca.agent_id=?5)
        AND ${actorMayUseAgent('?4')}
        AND ${actorMayUseAgent('?5')}
        AND (NOT EXISTS(SELECT 1 FROM custom_agents target
          WHERE target.org_id=?1 AND target.id=?5 AND target.deleted_at IS NULL)
          OR EXISTS(SELECT 1 FROM hx_agent_agent_members peer JOIN custom_agents target
            ON target.org_id=peer.org_id AND target.id=peer.agent_id AND target.scope='team' AND target.deleted_at IS NULL
            JOIN hx_agent_profiles p ON p.org_id=target.org_id AND p.agent_id=target.id
            JOIN custom_agents source ON source.org_id=peer.org_id AND source.id=peer.member_agent_id
              AND source.scope='team' AND source.provider IS NULL AND source.deleted_at IS NULL
            JOIN hx_agent_profiles source_profile ON source_profile.org_id=source.org_id AND source_profile.agent_id=source.id
            WHERE peer.org_id=?1 AND peer.agent_id=?5 AND peer.member_agent_id=?4)
          OR EXISTS(SELECT 1 FROM hx_agent_wake_grants g WHERE g.org_id=?1 AND g.id=?8 AND g.source_agent_id=?4 AND g.target_agent_id=?5
            AND g.requester_id=(SELECT actor_id FROM hx_agent_assignments WHERE org_id=?1 AND id=?2)
            AND g.requester_membership=(SELECT m.created_at FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=g.requester_id AND LOWER(COALESCE(m.role,'guest'))!='guest' LIMIT 1)
            AND g.room_channel=(SELECT channel FROM hx_agent_assignments WHERE org_id=?1 AND id=?2)
            AND (g.scope!='thread' OR g.thread_id=(SELECT thread_id FROM hx_agent_assignments WHERE org_id=?1 AND id=?2))
            AND g.requester_membership=(SELECT m.created_at FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=g.requester_id AND LOWER(COALESCE(m.role,'guest'))!='guest' LIMIT 1)
            AND (g.scope!='once' OR EXISTS(SELECT 1 FROM hx_agent_wake_approvals r WHERE r.org_id=g.org_id AND r.id=g.approval_id AND r.assignment_id=?2 AND r.source_generation=?3 AND r.operation_id=?6))
            AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?7) AND (g.use_limit IS NULL OR g.use_count<g.use_limit)))
        AND NOT EXISTS(SELECT 1 FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?6)`)
      .bind(orgId,assignmentId,generation,sourceAgentId,targetAgentId,operationId,now,wakeGrantId||''),
    db.prepare(`INSERT INTO hx_agent_handoffs(org_id,operation_id,assignment_id,source_generation,source_agent_id,target_agent_id,brief,message_body,message_id,wake_grant_id,created_at)
      SELECT org_id,?3,id,?4,?5,current_agent_id,?6,?10,?7,?11,?8 FROM hx_agent_assignments
      WHERE org_id=?1 AND id=?2 AND mutation_id=?3 AND generation=?4+1 AND status='pending' AND current_agent_id=?9
        AND NOT EXISTS(SELECT 1 FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?3)`)
      .bind(orgId,assignmentId,operationId,generation,sourceAgentId,brief,messageId,now,targetAgentId,messageBody,wakeGrantId||null),
    db.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at,parent_id)
      SELECT h.message_id,h.org_id,a.channel,'agent:'||h.source_agent_id,'agent',?4,h.created_at,a.thread_id
      FROM hx_agent_handoffs h JOIN hx_agent_assignments a ON a.id=h.assignment_id AND a.org_id=h.org_id
      WHERE h.org_id=?1 AND h.operation_id=?2 AND h.message_id=?3`)
      .bind(orgId,operationId,messageId,messageBody),
    db.prepare(`INSERT INTO hx_agent_handoff_dispatch(org_id,operation_id,updated_at)
      SELECT org_id,operation_id,created_at FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2 AND message_id=?3`)
      .bind(orgId,operationId,messageId),
    db.prepare(`UPDATE hx_agent_wake_grants SET use_count=use_count+1,updated_at=?4 WHERE org_id=?1 AND id=?2 AND ?3!=''
      AND EXISTS(SELECT 1 FROM hx_agent_handoffs h WHERE h.org_id=?1 AND h.operation_id=?5 AND h.assignment_id=?6 AND h.source_generation=?7)`)
      .bind(orgId,wakeGrantId||'',wakeGrantId||'',now,operationId,assignmentId,generation),
  ]);
  if (!results[0].meta?.changes) return await previous() || conflict();
  return {operation: (await previous()).operation, replayed: false};
}

export async function claimHandoff(db, {orgId, operationId}) {
  const operation = await db.prepare('SELECT * FROM hx_agent_handoffs WHERE org_id=?1 AND operation_id=?2').bind(orgId,operationId).first();
  if (!operation) return null;
  const result = await db.prepare(`UPDATE hx_agent_assignments SET status='running',updated_at=?6
    WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND mutation_id=?5 AND status='pending'`)
    .bind(orgId,operation.assignment_id,operation.source_generation+1,operation.target_agent_id,operationId,new Date().toISOString()).run();
  return result.meta?.changes ? operation : null;
}

export async function endAssignment(db, {orgId, assignmentId, generation, agentId, status}) {
  if (!['finished','failed','cancelled','interrupted'].includes(status)) throw new Error('Invalid terminal assignment state');
  const result = await db.prepare(`UPDATE hx_agent_assignments SET status=?5,updated_at=?6
    WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status IN ('running','pending')`)
    .bind(orgId,assignmentId,generation,agentId,status,new Date().toISOString()).run();
  return Boolean(result.meta?.changes);
}

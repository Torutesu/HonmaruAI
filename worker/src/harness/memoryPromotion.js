const safe = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

export async function proposeMemoryPromotion(db, orgId, agentId, { memoryId, expectedVersion, requestKey, requesterId, requesterLogin }) {
  if (!safe(memoryId, 160) || !safe(requestKey, 160) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    return { error: 'A memory, current version, and request key are required.', status: 400 };
  const existing = await db.prepare(`SELECT r.*,d.decision,d.decided_by,d.decided_at,d.shared_memory_id
    FROM hx_memory_promotion_requests r LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id
    WHERE r.org_id=?1 AND r.agent_id=?2 AND r.requester_id=?3 AND r.request_key=?4`).bind(orgId,agentId,String(requesterId),requestKey).first();
  if (existing) return { request: formatRequest(existing), replayed: true };
  const priorSource = await db.prepare(`SELECT r.*,d.decision,d.decided_by,d.decided_at,d.shared_memory_id FROM hx_memory_promotion_requests r
    LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id
    WHERE r.org_id=?1 AND r.agent_id=?2 AND r.source_memory_id=?3 AND r.source_version=?4 AND r.requester_id=?5`)
    .bind(orgId,agentId,memoryId,expectedVersion,String(requesterId)).first();
  if(priorSource)return {request:formatRequest(priorSource),replayed:true};
  const id = `mp_${crypto.randomUUID()}`, createdAt = new Date().toISOString();
  let result;
  try { result = await db.prepare(`INSERT INTO hx_memory_promotion_requests
    (id,org_id,agent_id,source_memory_id,source_version,source_scope,source_owner_id,source_channel,requester_id,requester_login,request_key,created_at)
    SELECT ?1,?2,?3,m.id,COALESCE(d.version,0),'person',s.user_github_id,'',?4,?5,?6,?7
    FROM hx_agent_memories m JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id
    LEFT JOIN hx_memory_entries d ON d.org_id=m.org_id AND d.memory_id=m.id
    JOIN custom_agents a ON a.org_id=m.org_id AND a.id=m.agent_id AND a.deleted_at IS NULL
    JOIN memberships requester_membership ON requester_membership.org_id=m.org_id AND requester_membership.user_github_id=?4 AND LOWER(COALESCE(requester_membership.role,'guest'))!='guest'
    WHERE m.org_id=?2 AND m.agent_id=?3 AND m.id=?8 AND s.channel='' AND s.user_github_id=?4
      AND COALESCE(d.version,0)=?9`).bind(id,orgId,agentId,String(requesterId),String(requesterLogin),requestKey,createdAt,memoryId,expectedVersion).run(); }
  catch (error) {
    const duplicate=await db.prepare(`SELECT r.*,d.decision,d.decided_by,d.decided_at,d.shared_memory_id FROM hx_memory_promotion_requests r
      LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.source_memory_id=?3 AND r.source_version=?4 AND r.requester_id=?5`)
      .bind(orgId,agentId,memoryId,expectedVersion,String(requesterId)).first();
    if(duplicate)return {request:formatRequest(duplicate),replayed:true};
    throw error;
  }
  if (!result.meta?.changes) {
    const raced = await db.prepare(`SELECT r.*,d.decision,d.decided_by,d.decided_at,d.shared_memory_id FROM hx_memory_promotion_requests r
      LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id WHERE r.org_id=?1 AND r.agent_id=?2 AND r.requester_id=?3 AND r.request_key=?4`).bind(orgId,agentId,String(requesterId),requestKey).first();
    if (raced) return { request: formatRequest(raced), replayed: true };
    const concurrent = await db.prepare(`SELECT r.*,d.decision,d.decided_by,d.decided_at,d.shared_memory_id FROM hx_memory_promotion_requests r
      LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.source_memory_id=?3 AND r.source_version=?4 AND r.requester_id=?5`)
      .bind(orgId,agentId,memoryId,expectedVersion,String(requesterId)).first();
    if(concurrent)return {request:formatRequest(concurrent),replayed:true};
    return { error: 'No such owned personal memory at that version.', status: 409 };
  }
  return { request: { id, agentId, memoryId, sourceVersion: expectedVersion, scope: 'person', requesterId: String(requesterId), requesterLogin, status: 'pending', createdAt }, created: true };
}

function formatRequest(row) {
  const sourceCurrent=!!row.current_source_id;
  return { id:row.id,agentId:row.agent_id,memoryId:row.source_memory_id,sourceVersion:row.source_version,scope:row.source_scope,
    requesterId:row.requester_id,requesterLogin:row.requester_login,status:row.decision||'pending',decidedBy:row.decided_by||null,
    decidedAt:row.decided_at||null,sharedMemoryId:row.shared_memory_id||null,createdAt:row.created_at,sourceCurrent,
    source:sourceCurrent?{title:row.current_title||row.current_text||'',description:row.current_description||'',body:row.current_body||row.current_text||'',version:row.current_version??0}:null };
}

export async function canDecideMemoryPromotion(db,orgId,agentId,actorLogin) {
  const agent=await db.prepare(`SELECT owner_login FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL`).bind(orgId,agentId).first();
  if(!agent)return false;
  if(String(agent.owner_login)===String(actorLogin))return true;
  return !!await db.prepare(`SELECT 1 FROM hx_agent_members r JOIN users u ON u.github_id=r.user_id
    JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.user_id AND m.created_at=r.member_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE r.org_id=?1 AND r.agent_id=?2 AND u.login=?3 AND r.role='admin'`).bind(orgId,agentId,String(actorLogin)).first();
}

export async function listMemoryPromotions(db, orgId, agentId, actorId, actorLogin) {
  const canDecide=await canDecideMemoryPromotion(db,orgId,agentId,actorLogin);
  const {results=[]}=await db.prepare(`SELECT r.*,d.decision,d.decided_by,d.decided_at,d.shared_memory_id,
    CASE WHEN s.user_github_id=r.source_owner_id AND s.channel='' AND COALESCE(e.version,0)=r.source_version THEN m.id END AS current_source_id,
    e.title AS current_title,e.description AS current_description,e.body AS current_body,e.version AS current_version,m.text AS current_text
    FROM hx_memory_promotion_requests r LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id
    LEFT JOIN hx_agent_memories m ON m.org_id=r.org_id AND m.agent_id=r.agent_id AND m.id=r.source_memory_id
    LEFT JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id
    LEFT JOIN hx_memory_entries e ON e.org_id=m.org_id AND e.memory_id=m.id
    WHERE r.org_id=?1 AND r.agent_id=?2 AND (?4=1 OR r.requester_id=?3)
    ORDER BY CASE WHEN d.decision IS NULL THEN 0 ELSE 1 END,r.created_at DESC LIMIT 200`).bind(orgId,agentId,String(actorId),canDecide?1:0).all();
  const agent=await db.prepare(`SELECT id,owner_login,scope FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL`).bind(orgId,agentId).first();
  const {mayAccessAgent}=await import('./agents.js');
  const requests=[];
  for(const row of results){
    const member=await db.prepare(`SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'`).bind(orgId,row.requester_id).first();
    const sourceAccess=!!member&&!!agent&&await mayAccessAgent(db,orgId,{...agent,ownerLogin:agent.owner_login},row.requester_login);
    const item=formatRequest(row);
    if(!sourceAccess){item.sourceCurrent=false;item.source=null;item.sourceAccess=false;}
    else item.sourceAccess=true;
    requests.push(item);
  }
  return { requests,canDecide };
}

export async function decideMemoryPromotion(db, orgId, agentId, requestId, { decision, actorId, actorLogin }) {
  if (!['approve','reject'].includes(decision)) return { error:'Decision must be approve or reject.',status:400 };
  const request=await db.prepare(`SELECT r.*,d.decision AS prior_decision,d.decided_by,d.decided_at,d.shared_memory_id
    FROM hx_memory_promotion_requests r LEFT JOIN hx_memory_promotion_decisions d ON d.request_id=r.id AND d.org_id=r.org_id
    WHERE r.org_id=?1 AND r.agent_id=?2 AND r.id=?3`).bind(orgId,agentId,requestId).first();
  if(!request)return {error:'No such promotion request.',status:404};
  if(request.prior_decision)return {request:formatRequest({...request,decision:request.prior_decision}),replayed:true};
  const liveAgent=await db.prepare(`SELECT id,owner_login,scope FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL`).bind(orgId,agentId).first();
  if(!liveAgent)return {error:'No such Agent.',status:404};
  const {mayAccessAgent}=await import('./agents.js');
  if(!await mayAccessAgent(db,orgId,{...liveAgent,ownerLogin:liveAgent.owner_login},request.requester_login))return {error:'Requester no longer has access to this Agent.',status:409};
  const admin=String(liveAgent.owner_login)===String(actorLogin)||!!await db.prepare(`SELECT 1 FROM hx_agent_members r
    JOIN users u ON u.github_id=r.user_id JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.user_id
      AND m.created_at=r.member_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE r.org_id=?1 AND r.agent_id=?2 AND u.login=?3 AND r.role='admin'`).bind(orgId,agentId,String(actorLogin)).first();
  if(!admin)return {error:'Only the current Agent owner or an active Agent admin can decide.',status:403};
  const stamp=new Date().toISOString();
  const requesterPredicate=`(a.owner_login=r.requester_login OR (a.scope='team' AND (
    NOT EXISTS(SELECT 1 FROM hx_agent_profiles p WHERE p.org_id=r.org_id AND p.agent_id=r.agent_id)
    OR EXISTS(SELECT 1 FROM hx_agent_profiles p WHERE p.org_id=r.org_id AND p.agent_id=r.agent_id AND p.access='everyone')
    OR EXISTS(SELECT 1 FROM hx_agent_profiles p JOIN json_each(COALESCE(p.people,'[]')) person
      WHERE p.org_id=r.org_id AND p.agent_id=r.agent_id AND p.access='people' AND person.value=r.requester_login)
    OR EXISTS(SELECT 1 FROM hx_agent_members rr JOIN memberships rm ON rm.org_id=rr.org_id AND rm.user_github_id=rr.user_id
      AND rm.created_at=rr.member_since AND LOWER(COALESCE(rm.role,'guest'))!='guest'
      WHERE rr.org_id=r.org_id AND rr.agent_id=r.agent_id AND rr.user_id=r.requester_id AND rr.role IN ('member','admin')))))`;
  if(decision==='reject'){
    const out=await db.prepare(`INSERT INTO hx_memory_promotion_decisions(request_id,org_id,decision,decided_by,decided_at)
      SELECT r.id,r.org_id,'rejected',?4,?5 FROM hx_memory_promotion_requests r
      JOIN custom_agents a ON a.org_id=r.org_id AND a.id=r.agent_id AND a.deleted_at IS NULL
      JOIN memberships reviewer ON reviewer.org_id=r.org_id AND reviewer.user_github_id=?4 AND LOWER(COALESCE(reviewer.role,'guest'))!='guest'
      JOIN memberships requester ON requester.org_id=r.org_id AND requester.user_github_id=r.requester_id AND LOWER(COALESCE(requester.role,'guest'))!='guest'
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.id=?3 AND NOT EXISTS(SELECT 1 FROM hx_memory_promotion_decisions x WHERE x.request_id=r.id)
        AND ${requesterPredicate} AND (a.owner_login=?6 OR EXISTS(SELECT 1 FROM hx_agent_members ar JOIN users au ON au.github_id=ar.user_id
          JOIN memberships am ON am.org_id=ar.org_id AND am.user_github_id=ar.user_id AND am.created_at=ar.member_since
            AND LOWER(COALESCE(am.role,'guest'))!='guest' WHERE ar.org_id=r.org_id AND ar.agent_id=r.agent_id AND au.login=?6 AND ar.role='admin'))`)
      .bind(orgId,agentId,requestId,String(actorId),stamp,String(actorLogin)).run();
    if(!out.meta?.changes)return {error:'Request or active workspace access changed. Reload before deciding.',status:409};
    return {request:{...formatRequest(request),status:'rejected',decidedBy:String(actorId),decidedAt:stamp}};
  }
  const sharedId=`amem_${crypto.randomUUID()}`;
  const reviewerPredicate=`(a.owner_login=?7 OR EXISTS(SELECT 1 FROM hx_agent_members ar JOIN users au ON au.github_id=ar.user_id
    JOIN memberships am ON am.org_id=ar.org_id AND am.user_github_id=ar.user_id AND am.created_at=ar.member_since
      AND LOWER(COALESCE(am.role,'guest'))!='guest' WHERE ar.org_id=r.org_id AND ar.agent_id=r.agent_id AND au.login=?7 AND ar.role='admin'))`;
  const results=await db.batch([
    db.prepare(`INSERT INTO hx_agent_memories(id,org_id,agent_id,text,source,created_by,created_at)
      SELECT ?6,m.org_id,m.agent_id,m.text,m.source,?4,?5 FROM hx_memory_promotion_requests r
      JOIN hx_agent_memories m ON m.org_id=r.org_id AND m.agent_id=r.agent_id AND m.id=r.source_memory_id
      JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id AND s.channel='' AND s.user_github_id=r.source_owner_id
      LEFT JOIN hx_memory_entries d ON d.org_id=m.org_id AND d.memory_id=m.id
      JOIN custom_agents a ON a.org_id=r.org_id AND a.id=r.agent_id AND a.deleted_at IS NULL
      JOIN memberships reviewer ON reviewer.org_id=r.org_id AND reviewer.user_github_id=?4 AND LOWER(COALESCE(reviewer.role,'guest'))!='guest'
      JOIN memberships requester ON requester.org_id=r.org_id AND requester.user_github_id=r.requester_id AND LOWER(COALESCE(requester.role,'guest'))!='guest'
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.id=?3 AND r.source_scope='person' AND r.source_channel=''
        AND COALESCE(d.version,0)=r.source_version AND NOT EXISTS(SELECT 1 FROM hx_memory_promotion_decisions x WHERE x.request_id=r.id)
        AND ${requesterPredicate} AND ${reviewerPredicate}`)
      .bind(orgId,agentId,requestId,String(actorId),stamp,sharedId,String(actorLogin)),
    db.prepare(`INSERT INTO hx_memory_scopes(memory_id,org_id,channel,kind,user_github_id,source_channel,source_message_id,source_thread_id)
      SELECT ?6,m.org_id,'',s.kind,NULL,NULL,NULL,NULL FROM hx_memory_promotion_requests r
      JOIN hx_agent_memories m ON m.org_id=r.org_id AND m.id=r.source_memory_id AND m.agent_id=r.agent_id
      JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id AND s.channel='' AND s.user_github_id=r.source_owner_id
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.id=?3 AND EXISTS(SELECT 1 FROM hx_agent_memories n WHERE n.org_id=?1 AND n.id=?6)`)
      .bind(orgId,agentId,requestId,String(actorId),stamp,sharedId),
    db.prepare(`INSERT INTO hx_memory_entries(memory_id,org_id,title,description,body,version,updated_by,updated_at)
      SELECT ?6,m.org_id,COALESCE(d.title,substr(m.text,1,120)),COALESCE(d.description,''),COALESCE(d.body,m.text),1,?4,?5
      FROM hx_memory_promotion_requests r JOIN hx_agent_memories m ON m.org_id=r.org_id AND m.id=r.source_memory_id AND m.agent_id=r.agent_id
      LEFT JOIN hx_memory_entries d ON d.org_id=m.org_id AND d.memory_id=m.id
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.id=?3 AND EXISTS(SELECT 1 FROM hx_agent_memories n WHERE n.org_id=?1 AND n.id=?6)`)
      .bind(orgId,agentId,requestId,String(actorId),stamp,sharedId),
    db.prepare(`INSERT INTO hx_memory_promotion_decisions(request_id,org_id,decision,decided_by,decided_at,shared_memory_id)
      SELECT r.id,r.org_id,'approved',?4,?5,?6 FROM hx_memory_promotion_requests r
      JOIN hx_agent_memories m ON m.org_id=r.org_id AND m.agent_id=r.agent_id AND m.id=r.source_memory_id
      JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id AND s.channel='' AND s.user_github_id=r.source_owner_id
      LEFT JOIN hx_memory_entries d ON d.org_id=m.org_id AND d.memory_id=m.id
      JOIN custom_agents a ON a.org_id=r.org_id AND a.id=r.agent_id AND a.deleted_at IS NULL
      JOIN memberships reviewer ON reviewer.org_id=r.org_id AND reviewer.user_github_id=?4 AND LOWER(COALESCE(reviewer.role,'guest'))!='guest'
      JOIN memberships requester ON requester.org_id=r.org_id AND requester.user_github_id=r.requester_id AND LOWER(COALESCE(requester.role,'guest'))!='guest'
      WHERE r.org_id=?1 AND r.agent_id=?2 AND r.id=?3 AND r.source_scope='person' AND r.source_channel=''
        AND COALESCE(d.version,0)=r.source_version AND EXISTS(SELECT 1 FROM hx_agent_memories n WHERE n.org_id=?1 AND n.id=?6)
        AND NOT EXISTS(SELECT 1 FROM hx_memory_promotion_decisions x WHERE x.request_id=r.id)
        AND ${requesterPredicate} AND ${reviewerPredicate}`)
      .bind(orgId,agentId,requestId,String(actorId),stamp,sharedId,String(actorLogin)),
  ]);
  if(!results[0]?.meta?.changes||!results[3]?.meta?.changes)return {error:'Source memory changed or access was revoked. Reload before approving.',status:409};
  return {request:{...formatRequest(request),status:'approved',decidedBy:String(actorId),decidedAt:stamp,sharedMemoryId:sharedId}};
}

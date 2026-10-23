import { sha256Hex } from '../auth.js';

// Only managed agents have independent roles. Legacy Simple agents retain
// their existing lifecycle until their ownership policy is explicitly migrated.
const responsibilities = `SELECT a.id,a.name,a.owner_login,a.scope,COALESCE(v.version,0) AS version
  FROM custom_agents a JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
  LEFT JOIN hx_agent_access v ON v.org_id=a.org_id AND v.agent_id=a.id
  WHERE a.org_id=?1 AND a.deleted_at IS NULL AND a.provider IS NULL
    AND (a.owner_login=?3 OR (a.scope='team' AND EXISTS (
      SELECT 1 FROM hx_agent_members r JOIN memberships m
        ON m.org_id=r.org_id AND m.user_github_id=r.user_id
        AND m.created_at=r.member_since AND m.role!='guest'
      WHERE r.org_id=a.org_id AND r.agent_id=a.id AND r.user_id=?2 AND r.role='admin')))
  ORDER BY a.id`;
const snapshotQuery = `SELECT json_group_array(json_array(id,owner_login,scope,version)) FROM (${responsibilities})`;

const skillResponsibilities = `SELECT s.id,s.name,COALESCE(s.owner_id,s.created_by) AS owner_id,
  COALESCE(p.visibility,'workspace') AS visibility,COALESCE(p.version,0) AS version
  FROM hx_skills s LEFT JOIN hx_skill_access p ON p.org_id=s.org_id AND p.skill_id=s.id
  WHERE s.org_id=?1 AND COALESCE(s.owner_id,s.created_by)=?2 ORDER BY s.id`;
const skillSnapshotQuery = `SELECT json_group_array(json_array(id,owner_id,visibility,version)) FROM (${skillResponsibilities})`;
const roomResponsibilities = `SELECT p.channel,b.name,p.version FROM hx_room_access p
 JOIN businesses b ON b.org_id=p.org_id AND 'b:'||b.slug=p.channel
 JOIN hx_room_roles r ON r.org_id=p.org_id AND r.channel=p.channel AND r.subject_kind='person' AND r.subject_id=?2 AND r.role='admin'
 JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.subject_id AND m.role!='guest'
 JOIN users u ON u.github_id=m.user_github_id
 JOIN conversation_members c ON c.org_id=r.org_id AND c.channel=r.channel AND c.login=u.login
 WHERE p.org_id=?1 AND p.deleted_at IS NULL AND r.member_since=m.created_at||'/'||c.added_at ORDER BY p.channel`;
const roomSnapshotQuery = `SELECT json_group_array(json_array(channel,version)) FROM (${roomResponsibilities})`;
const completeSnapshotQuery = `SELECT json_object('agents',json((${snapshotQuery})),'skills',json((${skillSnapshotQuery})),'rooms',json((${roomSnapshotQuery})))`;

export async function departureResponsibilities(db, orgId, target) {
  const {results}=await db.prepare(responsibilities).bind(orgId,target.userId,target.login).all();
  const {results:skills}=await db.prepare(skillResponsibilities).bind(orgId,target.userId).all();
  const {results:rooms}=await db.prepare(roomResponsibilities).bind(orgId,target.userId).all();
  const snapshot=JSON.stringify({agents:results.map(a=>[a.id,a.owner_login,a.scope,a.version]),skills:skills.map(s=>[s.id,s.owner_id,s.visibility,s.version]),rooms:rooms.map(r=>[r.channel,r.version])});
  const version=await sha256Hex(JSON.stringify([orgId,target.userId,target.joinedAt,snapshot]));
  return {agents:results,skills,rooms,snapshot,version};
}

// A receipt is claimed only while the entire preview and all memberships are
// still current. Every write in the same D1 transaction is gated by its nonce.
// A losing race changes neither agents nor membership.
export async function removeWithResourceHandoff(db, orgId, context, {transferTo,previewVersion}) {
  const {actor,target,members}=context;
  const plan=await departureResponsibilities(db,orgId,target);
  // Older clients omit a preview for an empty departure. New clients must
  // still reject a stale preview when the person has left and rejoined.
  if(previewVersion!==undefined && previewVersion!==plan.version)
    return {error:'Workspace responsibilities changed. Reload before removing this member.',code:'departure-conflict',status:409};
  const recipient=members.find(m=>m.ref===transferTo&&m.userId!==target.userId&&m.role!=='guest');
  const hasResponsibilities=plan.agents.length+plan.skills.length+plan.rooms.length>0;
  if(hasResponsibilities && (!recipient || previewVersion!==plan.version))
    return {error:'Review the responsibilities and choose a successor before leaving.',code:'agent-handoff-required',status:409};
  const roomIds=JSON.stringify(plan.rooms.map(r=>r.channel));
  let recipientRoomSnapshot='[]';
  if(plan.rooms.length&&recipient) {
    const {results:joined}=await db.prepare(`SELECT channel,added_at FROM conversation_members WHERE org_id=?1 AND login=?2 AND channel IN(SELECT value FROM json_each(?3)) ORDER BY channel`).bind(orgId,recipient.login,roomIds).all();
    if(joined.length!==plan.rooms.length)return {error:'Choose a successor who already belongs to every listed room.',code:'room-handoff-membership',status:409};
    recipientRoomSnapshot=JSON.stringify(joined.map(r=>[r.channel,r.added_at]));
  }
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const ids=JSON.stringify(plan.agents.map(a=>a.id));
  const gate='EXISTS (SELECT 1 FROM hx_member_departures WHERE org_id=?1 AND user_id=?2 AND nonce=?3)';
  const batch=[db.prepare(`INSERT INTO hx_member_departures(org_id,user_id,nonce,created_at)
    SELECT ?1,?2,?4,?5 WHERE
      EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND role=?6 AND created_at=?7)
      AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?8 AND role=?9 AND created_at=?10)
      AND (?6!='owner' OR EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND role='owner' AND user_github_id!=?2))
      AND (?11 IS NULL OR EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?11 AND role!='guest' AND created_at=?12))
      AND (${completeSnapshotQuery})=?13
      AND NOT EXISTS(SELECT 1 FROM (${roomResponsibilities}) room WHERE NOT EXISTS(
        SELECT 1 FROM conversation_members c JOIN users u ON u.login=c.login
        WHERE c.org_id=?1 AND c.channel=room.channel AND u.github_id=?11))
      AND (SELECT json_group_array(json_array(channel,added_at)) FROM (
        SELECT c.channel,c.added_at FROM conversation_members c JOIN users u ON u.login=c.login
        WHERE c.org_id=?1 AND u.github_id=?11 AND c.channel IN(SELECT value FROM json_each(?14)) ORDER BY c.channel))=?15
    ON CONFLICT(org_id,user_id) DO UPDATE SET nonce=excluded.nonce,created_at=excluded.created_at`)
    .bind(orgId,target.userId,target.login,nonce,at,target.role,target.joinedAt,actor.userId,actor.role,actor.joinedAt,
      hasResponsibilities?recipient.userId:null,hasResponsibilities?recipient.joinedAt:null,plan.snapshot,roomIds,recipientRoomSnapshot)];
  if(plan.agents.length) {
    batch.push(
      db.prepare(`INSERT INTO hx_agent_access(org_id,agent_id,version,mutation_id)
        SELECT ?1,value,1,?3 FROM json_each(?4) WHERE ${gate}
        ON CONFLICT(org_id,agent_id) DO UPDATE SET version=version+1,mutation_id=excluded.mutation_id`).bind(orgId,target.userId,nonce,ids),
      db.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
        SELECT ?1,value,?5,'admin',?6,?7,?8 FROM json_each(?4) WHERE ${gate}
        ON CONFLICT(org_id,agent_id,user_id) DO UPDATE SET role='admin',updated_by=excluded.updated_by,updated_at=excluded.updated_at,member_since=excluded.member_since`)
        .bind(orgId,target.userId,nonce,ids,recipient.userId,actor.userId,at,recipient.joinedAt),
      db.prepare(`UPDATE custom_agents SET created_by_login=COALESCE(created_by_login,owner_login),owner_login=?5,updated_by=?6,updated_at=?7
        WHERE org_id=?1 AND id IN (SELECT value FROM json_each(?4)) AND owner_login=?8 AND ${gate}`)
        .bind(orgId,target.userId,nonce,ids,recipient.login,actor.login,at,target.login));
  }
  if(plan.skills.length) {
    const skillIds=JSON.stringify(plan.skills.map(s=>s.id));
    batch.push(
      db.prepare(`INSERT INTO hx_skill_access(org_id,skill_id,visibility,version)
        SELECT ?1,s.id,COALESCE(p.visibility,'workspace'),COALESCE(p.version,0)+1
        FROM hx_skills s LEFT JOIN hx_skill_access p ON p.org_id=s.org_id AND p.skill_id=s.id
        WHERE s.org_id=?1 AND s.id IN(SELECT value FROM json_each(?4)) AND ${gate}
        ON CONFLICT(org_id,skill_id) DO UPDATE SET version=excluded.version`)
        .bind(orgId,target.userId,nonce,skillIds),
      db.prepare(`UPDATE hx_skills SET owner_id=?5,updated_at=?6
        WHERE org_id=?1 AND id IN(SELECT value FROM json_each(?4)) AND ${gate}`)
        .bind(orgId,target.userId,nonce,skillIds,recipient.userId,at));
  }
  if(plan.rooms.length) {
    const roomIds=JSON.stringify(plan.rooms.map(r=>r.channel));
    batch.push(
      db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?3 WHERE org_id=?1 AND channel IN(SELECT value FROM json_each(?4)) AND ${gate}`).bind(orgId,target.userId,nonce,roomIds),
      db.prepare(`INSERT INTO hx_room_roles(org_id,channel,subject_kind,subject_id,role,member_since,updated_by,updated_at)
        SELECT ?1,c.channel,'person',?5,'admin',m.created_at||'/'||c.added_at,?6,?7
        FROM conversation_members c JOIN users u ON u.login=c.login
        JOIN memberships m ON m.org_id=c.org_id AND m.user_github_id=u.github_id
        WHERE c.org_id=?1 AND u.github_id=?5 AND c.channel IN(SELECT value FROM json_each(?4)) AND ${gate}
        ON CONFLICT(org_id,channel,subject_kind,subject_id) DO UPDATE SET role='admin',member_since=excluded.member_since,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .bind(orgId,target.userId,nonce,roomIds,recipient.userId,actor.userId,at),
    );
  }
  batch.push(db.prepare(`DELETE FROM hx_room_roles WHERE org_id=?1 AND subject_kind='person' AND subject_id=?2 AND ${gate}`).bind(orgId,target.userId,nonce));
  batch.push(
    db.prepare(`UPDATE hx_gateways SET revoked_at=?4 WHERE org_id=?1 AND created_by=?2 AND revoked_at IS NULL AND ${gate}`)
      .bind(orgId,target.userId,nonce,Date.parse(at)),
    db.prepare(`UPDATE hx_gateway_jobs SET status='cancelled',lease_hash=NULL,finished_at=?4
      WHERE org_id=?1 AND status IN('queued','running')
      AND (created_by=?2 OR gateway_id IN(SELECT id FROM hx_gateways WHERE org_id=?1 AND created_by=?2)) AND ${gate}`)
      .bind(orgId,target.userId,nonce,Date.parse(at)),
    db.prepare(`DELETE FROM hx_agent_members WHERE org_id=?1 AND user_id=?2 AND ${gate}`).bind(orgId,target.userId,nonce),
    db.prepare(`DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND ${gate}`).bind(orgId,target.userId,nonce));
  const results=await db.batch(batch);
  if(!results[0]?.meta?.changes) {
    if(target.role==='owner') {
      const last=await db.prepare(`SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=?2 AND m.role='owner'
        AND NOT EXISTS(SELECT 1 FROM memberships o WHERE o.org_id=m.org_id AND o.role='owner' AND o.user_github_id!=m.user_github_id)`)
        .bind(orgId,target.userId).first();
      if(last)return {error:"You are this workspace's only owner. Make someone else an owner first.",code:'last-owner',status:409};
    }
    return {error:'Workspace responsibilities changed. Reload before removing this member.',code:'departure-conflict',status:409};
  }
  return {handoff:hasResponsibilities?{agents:plan.agents.length,skills:plan.skills.length,...(plan.rooms.length?{rooms:plan.rooms.length}:{}),to:recipient.ref}:null};
}

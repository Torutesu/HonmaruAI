// Room roles are independent of workspace and agent roles. A grant belongs
// to the current membership/assignment, so leaving and returning never revives it.
const subjects = `SELECT 'person' AS kind,u.github_id AS id,u.name,u.login,
    m.created_at||'/'||CASE WHEN b.private=1 THEN COALESCE(c.added_at,'') ELSE '' END AS membership,CASE WHEN m.role='guest' THEN 0 ELSE 1 END AS eligible,
    CASE WHEN m.role='guest' THEN 'member' ELSE COALESCE(r.role,'member') END AS role
  FROM businesses b JOIN memberships m ON m.org_id=b.org_id
  JOIN users u ON u.github_id=m.user_github_id
  LEFT JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2 AND c.login=u.login
  LEFT JOIN hx_room_roles r ON r.org_id=b.org_id AND r.channel=?2 AND r.subject_kind='person'
    AND r.subject_id=u.github_id AND r.member_since=m.created_at||'/'||CASE WHEN b.private=1 THEN COALESCE(c.added_at,'') ELSE '' END
  WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL
    AND ((b.private=0 AND m.role!='guest') OR c.login IS NOT NULL)
  UNION ALL
  SELECT 'agent',a.id,a.name,NULL,ca.added_at||'/'||a.created_at,1,COALESCE(r.role,'member')
  FROM businesses b JOIN channel_agents ca ON ca.org_id=b.org_id AND ca.channel=?2
  JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
  LEFT JOIN hx_room_roles r ON r.org_id=b.org_id AND r.channel=?2 AND r.subject_kind='agent'
    AND r.subject_id=a.id AND r.member_since=ca.added_at||'/'||a.created_at
  WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`;

export async function roomRoleState(db, orgId, channel) {
  if(typeof channel!=='string'||!channel.startsWith('b:'))return null;
  const room=await db.prepare(`SELECT b.created_by,COALESCE(p.version,0) AS version,
    CASE WHEN p.channel IS NULL THEN 0 ELSE 1 END AS managed
    FROM businesses b LEFT JOIN hx_room_access p ON p.org_id=b.org_id AND p.channel=?2
    WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`).bind(orgId,channel).first();
  if(!room)return null;
  const {results}=await db.prepare(subjects).bind(orgId,channel).all();
  return {managed:!!room.managed,version:room.version,createdBy:room.created_by,members:results};
}

// Existing Simple rooms remain unchanged unless their current creator opts in.
// New managed-room creation can use this same atomic initialization.
export async function initializeRoomRoles(db, orgId, channel, actorId) {
  actorId=String(actorId||'');
  const state=await roomRoleState(db,orgId,channel);
  if(!state)return {error:'No such room.',status:404};
  const actor=state.members.find(m=>m.kind==='person'&&m.id===actorId&&m.eligible);
  if(!actor||String(state.createdBy)!==actorId)return {error:'Only the room creator can initialize its roles.',status:403};
  if(state.managed)return {version:state.version};
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_room_access(org_id,channel,version,mutation_id)
      SELECT ?1,?2,1,?4 WHERE EXISTS(SELECT 1 FROM businesses WHERE org_id=?1 AND 'b:'||slug=?2 AND created_by=?3 AND archived_at IS NULL)
      AND EXISTS(SELECT 1 FROM (${subjects}) WHERE kind='person' AND id=?3 AND eligible=1)`)
      .bind(orgId,channel,actorId,nonce),
    db.prepare(`INSERT INTO hx_room_roles(org_id,channel,subject_kind,subject_id,role,member_since,updated_by,updated_at)
      SELECT ?1,?2,'person',id,'admin',membership,?3,?5 FROM (${subjects})
      WHERE kind='person' AND id=?3 AND eligible=1
      AND EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?4)
      ON CONFLICT(org_id,channel,subject_kind,subject_id) DO UPDATE SET role='admin',member_since=excluded.member_since,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,channel,actorId,nonce,at),
  ]);
  return result[0].meta?.changes?{version:1}:{error:'Room roles changed. Reload before saving.',status:409};
}

export async function setRoomRole(db, orgId, channel, {actorId,kind,id,role,version}) {
  actorId=String(actorId||'');id=String(id||'');
  if(!['person','agent'].includes(kind)||!['admin','member'].includes(role)||!Number.isSafeInteger(version)||version<1)
    return {error:'A valid room role and current version are required.',status:400};
  const state=await roomRoleState(db,orgId,channel);
  if(!state)return {error:'No such room.',status:404};
  if(!state.managed)return {error:'Initialize room roles before changing them.',status:409};
  const actor=state.members.find(m=>m.kind==='person'&&m.id===actorId);
  if(actor?.role!=='admin'||!actor.eligible)return {error:'Only a room admin can change roles.',status:403};
  const target=state.members.find(m=>m.kind===kind&&m.id===id);
  if(!target)return {error:'That member is no longer in the room.',status:404};
  if(role==='admin'&&!target.eligible)return {error:'A guest cannot become a room admin.',status:403};
  if(state.version!==version)return {error:'Room roles changed. Reload before saving.',status:409};
  if(kind==='person'&&role!=='admin'&&!state.members.some(m=>m.kind==='person'&&m.id!==id&&m.role==='admin'&&m.eligible))
    return {error:'Keep at least one active human room admin.',status:409};
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const result=await db.batch([
    db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?8 WHERE org_id=?1 AND channel=?2 AND version=?7
      AND EXISTS(SELECT 1 FROM (${subjects}) WHERE kind='person' AND id=?3 AND role='admin' AND eligible=1)
      AND EXISTS(SELECT 1 FROM (${subjects}) WHERE kind=?4 AND id=?5 AND membership=?9 AND (?6!='admin' OR eligible=1))
      AND (?4!='person' OR ?6='admin' OR EXISTS(SELECT 1 FROM (${subjects}) WHERE kind='person' AND id!=?5 AND role='admin' AND eligible=1))`)
      .bind(orgId,channel,actorId,kind,id,role,version,nonce,target.membership),
    db.prepare(`INSERT INTO hx_room_roles(org_id,channel,subject_kind,subject_id,role,member_since,updated_by,updated_at)
      SELECT ?1,?2,?4,?5,?6,?7,?3,?9 WHERE EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?8)
      ON CONFLICT(org_id,channel,subject_kind,subject_id) DO UPDATE SET role=excluded.role,member_since=excluded.member_since,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,channel,actorId,kind,id,role,target.membership,nonce,at),
  ]);
  return result[0].meta?.changes?{version:version+1}:{error:'Room roles changed. Reload before saving.',status:409};
}

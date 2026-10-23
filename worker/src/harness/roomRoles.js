// Room roles are independent of workspace and agent roles. A grant belongs
// to the current membership/assignment, so leaving and returning never revives it.
const subjects = `SELECT 'person' AS kind,u.github_id AS id,u.name,u.login,
    m.created_at||'/'||c.added_at AS membership,CASE WHEN m.role='guest' THEN 0 ELSE 1 END AS eligible,
    CASE WHEN m.role='guest' THEN 'member' ELSE COALESCE(r.role,'member') END AS role
  FROM businesses b JOIN memberships m ON m.org_id=b.org_id
  JOIN users u ON u.github_id=m.user_github_id
  LEFT JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2 AND c.login=u.login
  LEFT JOIN hx_room_roles r ON r.org_id=b.org_id AND r.channel=?2 AND r.subject_kind='person'
    AND r.subject_id=u.github_id AND r.member_since=m.created_at||'/'||c.added_at
  WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL
    AND c.login IS NOT NULL
  UNION ALL
  SELECT 'agent',a.id,a.name,NULL,ca.added_at||'/'||a.created_at,1,COALESCE(r.role,'member')
  FROM businesses b JOIN channel_agents ca ON ca.org_id=b.org_id AND ca.channel=?2
  JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
  LEFT JOIN hx_room_roles r ON r.org_id=b.org_id AND r.channel=?2 AND r.subject_kind='agent'
    AND r.subject_id=a.id AND r.member_since=ca.added_at||'/'||a.created_at
  WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`;

export async function roomRoleState(db, orgId, channel, {includeArchived=false}={}) {
  if(typeof channel!=='string'||!channel.startsWith('b:'))return null;
  const room=await db.prepare(`SELECT b.created_by,b.private,COALESCE(p.version,0) AS version,
    CASE WHEN p.channel IS NULL THEN 0 ELSE 1 END AS managed
    FROM businesses b LEFT JOIN hx_room_access p ON p.org_id=b.org_id AND p.channel=?2
    WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND p.deleted_at IS NULL ${includeArchived?'':'AND b.archived_at IS NULL'}`).bind(orgId,channel).first();
  if(!room)return null;
  const {results}=await db.prepare(includeArchived?subjects.replaceAll(' AND b.archived_at IS NULL',''):subjects).bind(orgId,channel).all();
  return {managed:!!room.managed,private:!!room.private,version:room.version,createdBy:room.created_by,members:results};
}

// Existing Simple rooms remain unchanged unless their current creator opts in.
// New managed-room creation can use this same atomic initialization.
export async function initializeRoomRoles(db, orgId, channel, actorId) {
  actorId=String(actorId||'');
  const state=await roomRoleState(db,orgId,channel);
  if(!state)return {error:'No such room.',status:404};
  const actor=await db.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND role!='guest'").bind(orgId,actorId).first();
  if(!actor||(state.private&&!state.members.some(m=>m.kind==='person'&&m.id===actorId))||String(state.createdBy)!==actorId)return {error:'Only the room creator can initialize its roles.',status:403};
  if(state.managed)return {version:state.version};
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_room_access(org_id,channel,version,mutation_id)
      SELECT ?1,?2,1,?4 WHERE EXISTS(SELECT 1 FROM businesses WHERE org_id=?1 AND 'b:'||slug=?2 AND created_by=?3 AND archived_at IS NULL)
      AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?3 AND role!='guest' AND created_at=?5)
      AND EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND (b.private=0 OR EXISTS(
        SELECT 1 FROM conversation_members c JOIN users u ON u.login=c.login WHERE c.org_id=?1 AND c.channel=?2 AND u.github_id=?3)))`)
      .bind(orgId,channel,actorId,nonce,actor.created_at),
    db.prepare(`INSERT OR IGNORE INTO conversation_members(org_id,channel,login,added_by,added_at)
      SELECT ?1,?2,login,login,?5 FROM users WHERE github_id=?3
      AND EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?4)`)
      .bind(orgId,channel,actorId,nonce,at),
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

// Remove the membership/assignment and its role under the same version claim.
// A check followed by the old unconditional DELETE would allow a racing role
// promotion or rejoin to remove a different membership than the one reviewed.
export async function removeRoomSubject(db, orgId, channel, {actorId,kind,id,version}) {
  if(!channel.startsWith('b:'))return {managed:false};
  actorId=String(actorId||'');id=String(id||'');
  const state=await roomRoleState(db,orgId,channel);
  if(!state)return {error:'No such room.',status:404};
  if(!state.managed)return {managed:false};
  if(!['person','agent'].includes(kind))return {error:'Invalid room member.',status:400};
  const actor=state.members.find(m=>m.kind==='person'&&m.id===actorId);
  const target=state.members.find(m=>m.kind===kind&&m.id===id);
  if(!actor?.eligible)return {error:'Only a room member can remove members.',status:403};
  if(!target)return {error:'That member is no longer in the room.',status:404};
  const self=kind==='person'&&actorId===id;
  if(target.role==='admin'&&actor.role!=='admin'&&!self)return {error:'Only a room admin can remove an admin.',status:403};
  if(kind==='person'&&target.role==='admin'&&!state.members.some(m=>m.kind==='person'&&m.id!==id&&m.role==='admin'&&m.eligible))
    return {error:'Keep at least one active human room admin.',status:409};
  if(version!==undefined&&version!==state.version)return {error:'Room roles changed. Reload before saving.',status:409};
  const nonce=crypto.randomUUID();
  const gate='EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?3)';
  const result=await db.batch([
    db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?8 WHERE org_id=?1 AND channel=?2 AND version=?7
      AND EXISTS(SELECT 1 FROM (${subjects}) actor JOIN (${subjects}) target
        ON target.kind=?4 AND target.id=?5 AND target.membership=?6
        WHERE actor.kind='person' AND actor.id=?3 AND actor.eligible=1
        AND (target.role!='admin' OR actor.role='admin' OR (?4='person' AND ?3=?5))
        AND (?4!='person' OR target.role!='admin' OR EXISTS(SELECT 1 FROM (${subjects}) other WHERE other.kind='person' AND other.id!=?5 AND other.role='admin' AND other.eligible=1)))`)
      .bind(orgId,channel,actorId,kind,id,target.membership,state.version,nonce),
    kind==='person'
      ? db.prepare(`DELETE FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login=?4 AND ${gate}`).bind(orgId,channel,nonce,target.login)
      : db.prepare(`DELETE FROM channel_agents WHERE org_id=?1 AND channel=?2 AND agent_id=?4 AND ${gate}`).bind(orgId,channel,nonce,id),
    db.prepare(`DELETE FROM hx_room_roles WHERE org_id=?1 AND channel=?2 AND subject_kind=?4 AND subject_id=?5 AND ${gate}`).bind(orgId,channel,nonce,kind,id),
  ]);
  return result[0].meta?.changes?{managed:true,removed:true,version:state.version+1}:{error:'Room roles changed. Reload before saving.',status:409};
}

// Deletion is a room-admin action; workspace admins have a separate lifecycle
// permission that does not grant them access to the room's messages. Retain
// a private, archived tombstone: removing the slug would make historical
// messages public through legacy access queries and same-name recreation.
export async function deleteManagedRoom(db,orgId,channel,{actorId,version}) {
  actorId=String(actorId||'');
  const state=await roomRoleState(db,orgId,channel,{includeArchived:true});
  if(!state?.managed) {
    // A concurrently deleted managed room must never fall back to the legacy
    // physical DELETE, which would erase its private historical boundary.
    const policy=await db.prepare('SELECT deleted_at FROM hx_room_access WHERE org_id=?1 AND channel=?2').bind(orgId,channel).first();
    if(policy)return {error:'Room roles changed. Reload before deleting.',status:409};
    return {managed:false};
  }
  const membership=await db.prepare("SELECT role,created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId,actorId).first();
  if(!membership)return {error:'Your workspace membership changed. Reload before deleting.',status:409};
  const actor=state.members.find(m=>m.kind==='person'&&m.id===actorId);
  const workspaceAdmin=['admin','owner'].includes(membership?.role);
  if(!workspaceAdmin&&!(actor?.role==='admin'&&actor.eligible))return {error:'Only a room or workspace admin can delete this room.',status:403};
  if(version!==undefined&&version!==state.version)return {error:'Room roles changed. Reload before deleting.',status:409};
  const nonce=crypto.randomUUID();
  const allSubjects=subjects.replaceAll(' AND b.archived_at IS NULL','');
  const gate='EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?3)';
  const result=await db.batch([
    db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?4 WHERE org_id=?1 AND channel=?2 AND version=?5
      AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?3 AND created_at=?6 AND role!='guest')
      AND (EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?3 AND role IN('admin','owner'))
        OR EXISTS(SELECT 1 FROM (${allSubjects}) WHERE kind='person' AND id=?3 AND role='admin' AND eligible=1 AND membership=?7))`)
      .bind(orgId,channel,actorId,nonce,state.version,membership.created_at,actor?.membership||''),
    db.prepare(`UPDATE businesses SET private=1,archived_at=?4 WHERE org_id=?1 AND 'b:'||slug=?2 AND ${gate}`).bind(orgId,channel,nonce,new Date().toISOString()),
    ...['conversation_members','channel_agents','hx_room_roles','hx_room_guidelines','hx_room_responses'].map(table=>
      db.prepare(`DELETE FROM ${table} WHERE org_id=?1 AND channel=?2 AND ${gate}`).bind(orgId,channel,nonce)),
    db.prepare('UPDATE hx_room_access SET deleted_at=?4 WHERE org_id=?1 AND channel=?2 AND mutation_id=?3').bind(orgId,channel,nonce,new Date().toISOString()),
  ]);
  return result[0].meta?.changes?{managed:true,deleted:true}:{error:'Room roles changed. Reload before deleting.',status:409};
}

// Admin API member edits must be all-or-nothing, including additions: an
// invalid removal must not leave an unrelated invitation applied first.
export async function changeManagedRoomMembers(db,orgId,channel,{actorId,adding=[],removing=[]}) {
  actorId=String(actorId||'');
  const state=await roomRoleState(db,orgId,channel);
  if(!state?.managed) {
    const policy=await db.prepare('SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2').bind(orgId,channel).first();
    if(policy)return {error:'Room membership changed. Reload before saving.',status:409};
    return {managed:false};
  }
  const actor=state.members.find(m=>m.kind==='person'&&m.id===actorId&&m.eligible);
  if(!actor)return {error:'Only a room member can change its members.',status:403};
  const removeIds=[...new Set(removing.map(m=>String(m.userId)))];
  const addIds=[...new Set(adding.map(m=>String(m.userId)))];
  if(addIds.some(id=>removeIds.includes(id)))return {error:'A member cannot be added and removed together.',status:400};
  const removed=state.members.filter(m=>m.kind==='person'&&removeIds.includes(m.id));
  if(removed.length!==removeIds.length)return {error:'Room membership changed. Reload before saving.',status:409};
  if(removed.some(m=>m.role==='admin')&&actor.role!=='admin')return {error:'Only a room admin can remove an admin.',status:403};
  if(!state.members.some(m=>m.kind==='person'&&m.eligible&&m.role==='admin'&&!removeIds.includes(m.id)))return {error:'Keep at least one active human room admin.',status:409};
  const {results:people}=await db.prepare('SELECT m.user_github_id AS id,m.created_at,u.login FROM memberships m JOIN users u ON u.github_id=m.user_github_id WHERE m.org_id=?1 AND m.user_github_id IN(SELECT value FROM json_each(?2)) ORDER BY m.user_github_id').bind(orgId,JSON.stringify(addIds)).all();
  if(people.length!==addIds.length)return {error:'Workspace membership changed. Reload before saving.',status:409};
  const snapshot=JSON.stringify(state.members.map(m=>[m.kind,m.id,m.membership,m.role,m.eligible]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  // Use SQL's own deterministic ordering for the transaction comparison.
  const snapshotSql=`SELECT json_group_array(json_array(kind,id,membership,role,eligible)) FROM (SELECT * FROM (${subjects}) ORDER BY kind,id)`;
  const liveSnapshot=await db.prepare(snapshotSql).bind(orgId,channel).first();
  const expected=Object.values(liveSnapshot)[0];
  // Compare the exact snapshot we will bind, not a separate later read:
  // an intervening membership change must not supply a different expected
  // state than the one used for authorization and last-admin checks.
  if(JSON.stringify(JSON.parse(expected).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))!==snapshot)
    return {error:'Room membership changed. Reload before saving.',status:409};
  const nonce=crypto.randomUUID(),at=new Date().toISOString(),addSnapshot=JSON.stringify(people.map(m=>[m.id,m.created_at,m.login]));
  const gate='EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?3)';
  const result=await db.batch([
    db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?3 WHERE org_id=?1 AND channel=?2 AND version=?4 AND deleted_at IS NULL
      AND (${snapshotSql})=?5
      AND (SELECT json_group_array(json_array(id,created_at,login)) FROM (SELECT m.user_github_id AS id,m.created_at,u.login FROM memberships m JOIN users u ON u.github_id=m.user_github_id WHERE m.org_id=?1 AND m.user_github_id IN(SELECT value FROM json_each(?6)) ORDER BY m.user_github_id))=?7`)
      .bind(orgId,channel,nonce,state.version,expected,JSON.stringify(addIds),addSnapshot),
    ...people.map(p=>db.prepare(`INSERT OR IGNORE INTO conversation_members(org_id,channel,login,added_by,added_at) SELECT ?1,?2,?4,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,p.login,actor.login,at)),
    ...removed.map(p=>db.prepare(`DELETE FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login=?4 AND ${gate}`).bind(orgId,channel,nonce,p.login)),
    db.prepare(`DELETE FROM hx_room_roles WHERE org_id=?1 AND channel=?2 AND subject_kind='person' AND subject_id IN(SELECT value FROM json_each(?4)) AND ${gate}`).bind(orgId,channel,nonce,JSON.stringify(removeIds)),
  ]);
  return result[0].meta?.changes?{managed:true}:{error:'Room membership changed. Reload before saving.',status:409};
}

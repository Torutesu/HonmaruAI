// Stable user IDs hold explicit roles; active human membership is checked on
// every read and again in the mutation transaction. The maker remains admin.
export async function explicitAgentRoles(db, orgId, agentIds, login) {
  if (!login || !agentIds.length) return new Map();
  const { results } = await db.prepare(`SELECT r.agent_id,r.role FROM hx_agent_members r
    JOIN custom_agents a ON a.org_id=r.org_id AND a.id=r.agent_id AND a.scope='team' AND a.deleted_at IS NULL AND a.provider IS NULL
    JOIN hx_agent_profiles p ON p.org_id=r.org_id AND p.agent_id=r.agent_id
    JOIN users u ON u.github_id=r.user_id
    JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.user_id AND m.role!='guest' AND m.created_at=r.member_since
    WHERE r.org_id=?1 AND u.login=?2 AND r.agent_id IN (${agentIds.map((_,i)=>`?${i+3}`).join(',')})`)
    .bind(orgId,login,...agentIds).all();
  return new Map(results.map(row=>[row.agent_id,row.role]));
}

export async function agentRoleState(db, orgId, agentId) {
  const agent = await db.prepare(`SELECT a.owner_login,a.scope,COALESCE(s.version,0) AS version
    FROM custom_agents a LEFT JOIN hx_agent_access s ON s.org_id=a.org_id AND s.agent_id=a.id
    WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL AND a.provider IS NULL`).bind(orgId,agentId).first();
  if (!agent) return null;
  const {results} = await db.prepare(`SELECT u.github_id AS userId,u.login,u.name,
    CASE WHEN u.login=?3 THEN 'admin' ELSE r.role END AS role,
    CASE WHEN u.login=?3 THEN 1 ELSE 0 END AS owner
    FROM users u JOIN memberships m ON m.user_github_id=u.github_id AND m.org_id=?1 AND m.role!='guest'
    LEFT JOIN hx_agent_members r ON r.org_id=m.org_id AND r.agent_id=?2 AND r.user_id=u.github_id AND r.member_since=m.created_at
    WHERE u.login=?3 OR r.user_id IS NOT NULL ORDER BY owner DESC,u.name,u.github_id`)
    .bind(orgId,agentId,agent.owner_login).all();
  return {version:agent.version,scope:agent.scope,members:results};
}

export async function setAgentRole(db, orgId, agentId, { actorId, targetId, role, expectedVersion }) {
  if (!['admin','member','none'].includes(role) || !Number.isSafeInteger(expectedVersion) || expectedVersion<0)
    return {error:'A valid role and current access version are required.',status:400};
  actorId=String(actorId||'');targetId=String(targetId||'');
  const state=await agentRoleState(db,orgId,agentId);
  if (!state) return {error:'No such agent.',status:404};
  const actor=state.members.find(m=>m.userId===actorId);
  const targetRole=state.members.find(m=>m.userId===targetId);
  const ordinaryChange=actor?.role==='member' && ((role==='member'&&!targetRole)||(role==='none'&&targetRole?.role==='member'&&!targetRole.owner));
  if (actor?.role!=='admin'&&!ordinaryChange) return {error:'Only an agent admin can change roles or remove an admin.',status:403};
  // Assigning a person is an explicit restricted share, never workspace-wide.
  if (state.scope==='personal' && role==='none') return {error:'Assign a role to share this personal agent.',status:409};
  const profile=await db.prepare('SELECT 1 FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(orgId,agentId).first();
  if (!profile) return {error:'Set up the agent profile before assigning members.',status:409};
  const target=await db.prepare(`SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND role!='guest'`).bind(orgId,targetId).first();
  if (!target) return {error:'That person is not an active workspace member.',status:404};
  if (state.members.some(m=>m.userId===targetId&&m.owner)) return {error:'Transfer ownership before changing the maker’s role.',status:409};
  if (state.version!==expectedVersion) return {error:'Agent access changed. Reload before saving.',status:409};
  if (role!=='admin' && !state.members.some(m=>m.userId!==targetId&&m.role==='admin'))
    return {error:'Keep at least one active human agent admin.',status:409};
  const mutation=crypto.randomUUID(),at=new Date().toISOString();
  const result=await db.batch([
    db.prepare('INSERT OR IGNORE INTO hx_agent_access(org_id,agent_id,version) VALUES (?1,?2,0)').bind(orgId,agentId),
    db.prepare(`UPDATE hx_agent_access SET version=version+1,mutation_id=?5
      WHERE org_id=?1 AND agent_id=?2 AND version=?6
      AND EXISTS (SELECT 1 FROM custom_agents a JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
        JOIN users u ON u.github_id=?3 JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=u.github_id AND m.role!='guest'
        WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL AND a.provider IS NULL AND (a.scope='team' OR (a.scope='personal' AND a.owner_login=u.login AND ?7!='none'))
        AND (a.owner_login=u.login OR EXISTS(SELECT 1 FROM hx_agent_members r WHERE r.org_id=?1 AND r.agent_id=?2 AND r.user_id=?3 AND r.member_since=m.created_at
          AND (r.role='admin' OR (r.role='member' AND (
            (?7='member' AND NOT EXISTS(SELECT 1 FROM hx_agent_members t WHERE t.org_id=?1 AND t.agent_id=?2 AND t.user_id=?4 AND t.member_since=?8))
            OR (?7='none' AND EXISTS(SELECT 1 FROM hx_agent_members t WHERE t.org_id=?1 AND t.agent_id=?2 AND t.user_id=?4 AND t.member_since=?8 AND t.role='member'))
          ))))))
      AND EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.user_github_id=u.github_id AND m.org_id=?1 AND m.role!='guest'
        JOIN custom_agents a ON a.org_id=?1 AND a.id=?2 WHERE u.github_id=?4 AND u.login!=a.owner_login AND m.created_at=?8)
      AND (?7='admin' OR EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.user_github_id=u.github_id AND m.org_id=?1 AND m.role!='guest'
        JOIN custom_agents a ON a.org_id=?1 AND a.id=?2 WHERE u.github_id!=?4 AND (u.login=a.owner_login OR EXISTS
        (SELECT 1 FROM hx_agent_members r WHERE r.org_id=?1 AND r.agent_id=?2 AND r.user_id=u.github_id AND r.role='admin' AND r.member_since=m.created_at))))
      RETURNING version`).bind(orgId,agentId,actorId,targetId,mutation,expectedVersion,role,target.created_at),
    db.prepare(`UPDATE hx_agent_profiles SET access='private',people='[]',updated_by=?3,updated_at=?4
      WHERE org_id=?1 AND agent_id=?2 AND EXISTS(SELECT 1 FROM custom_agents a JOIN hx_agent_access s ON s.org_id=a.org_id AND s.agent_id=a.id
        WHERE a.org_id=?1 AND a.id=?2 AND a.scope='personal' AND s.mutation_id=?5)`).bind(orgId,agentId,actorId,at,mutation),
    db.prepare(`UPDATE custom_agents SET scope='team',updated_by=?3,updated_at=?4 WHERE org_id=?1 AND id=?2 AND scope='personal'
      AND EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2 AND mutation_id=?5)`).bind(orgId,agentId,actor.login,at,mutation),
    role==='none'
      ? db.prepare(`DELETE FROM hx_agent_members WHERE org_id=?1 AND agent_id=?2 AND user_id=?3 AND EXISTS
          (SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2 AND mutation_id=?4)`).bind(orgId,agentId,targetId,mutation)
      : db.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
          SELECT ?1,?2,?3,?4,?5,?6,?8 WHERE EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2 AND mutation_id=?7)
          ON CONFLICT(org_id,agent_id,user_id) DO UPDATE SET role=excluded.role,updated_by=excluded.updated_by,updated_at=excluded.updated_at,member_since=excluded.member_since`)
          .bind(orgId,agentId,targetId,role,actorId,at,mutation,target.created_at),
  ]);
  return result[1].results?.length ? {version:result[1].results[0].version} : {error:'Agent access changed. Reload before saving.',status:409};
}

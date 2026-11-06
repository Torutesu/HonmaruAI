import {agentRoleState} from './agentRoles.js';

export async function agentPeerRoleState(db,orgId,agentId) {
  const owner=await db.prepare(`SELECT owner_login,scope,COALESCE(v.version,0) AS version
    FROM custom_agents a LEFT JOIN hx_agent_access v ON v.org_id=a.org_id AND v.agent_id=a.id
    WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL AND a.provider IS NULL`)
    .bind(orgId,agentId).first();
  if(!owner)return null;
  const {results}=await db.prepare(`SELECT r.member_agent_id AS agentId,a.name,r.role
    FROM hx_agent_agent_members r JOIN custom_agents a
      ON a.org_id=r.org_id AND a.id=r.member_agent_id AND a.deleted_at IS NULL
    WHERE r.org_id=?1 AND r.agent_id=?2 ORDER BY a.name,a.id`).bind(orgId,agentId).all();
  return {version:owner.version,scope:owner.scope,members:results};
}

// Only human Agent Admins may assign another Agent. The recipient is scoped to
// an explicitly managed team Agent; a CAS version fences concurrent edits.
export async function setAgentPeerRole(db,orgId,agentId,{actorId,memberAgentId,role,expectedVersion}) {
  if(!['admin','member','none'].includes(role)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0
    ||typeof memberAgentId!=='string'||!memberAgentId||memberAgentId===agentId)
    return {error:'A valid Agent role and current access version are required.',status:400};
  const actorState=await agentRoleState(db,orgId,agentId);
  if(!actorState)return {error:'No such agent.',status:404};
  if(!actorState.members.some(m=>m.userId===String(actorId)&&m.role==='admin'))
    return {error:'Only an agent admin can assign another Agent.',status:403};
  if(actorState.scope!=='team')return {error:'Only shared team agents can have Agent members.',status:409};
  const target=await db.prepare(`SELECT 1 FROM custom_agents a JOIN hx_agent_profiles p
      ON p.org_id=a.org_id AND p.agent_id=a.id
    WHERE a.org_id=?1 AND a.id=?2 AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL`)
    .bind(orgId,memberAgentId).first();
  if(!target)return {error:'Choose an active managed team Agent.',status:404};
  const state=await agentPeerRoleState(db,orgId,agentId);
  if(state.version!==expectedVersion)return {error:'Agent access changed. Reload before saving.',status:409};
  const mutation=crypto.randomUUID(),at=new Date().toISOString();
  const results=await db.batch([
    db.prepare('INSERT OR IGNORE INTO hx_agent_access(org_id,agent_id,version) VALUES (?1,?2,0)').bind(orgId,agentId),
    db.prepare(`UPDATE hx_agent_access SET version=version+1,mutation_id=?3
      WHERE org_id=?1 AND agent_id=?2 AND version=?4
        AND EXISTS(SELECT 1 FROM custom_agents a JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
          WHERE a.org_id=?1 AND a.id=?2 AND a.scope='team' AND a.deleted_at IS NULL AND a.provider IS NULL)
        AND EXISTS(SELECT 1 FROM custom_agents a JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
          WHERE a.org_id=?1 AND a.id=?5 AND a.scope='team' AND a.deleted_at IS NULL AND a.provider IS NULL)
        AND EXISTS(SELECT 1 FROM custom_agents a JOIN users u ON u.login=a.owner_login
          JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=u.github_id AND m.role!='guest'
          WHERE a.org_id=?1 AND a.id=?2 AND (a.owner_login=(SELECT login FROM users WHERE github_id=?6)
            OR EXISTS(SELECT 1 FROM hx_agent_members r WHERE r.org_id=?1 AND r.agent_id=?2 AND r.user_id=?6
              AND r.member_since=m.created_at AND r.role='admin')))
      RETURNING version`).bind(orgId,agentId,mutation,expectedVersion,memberAgentId,String(actorId)),
    role==='none'
      ? db.prepare(`DELETE FROM hx_agent_agent_members WHERE org_id=?1 AND agent_id=?2 AND member_agent_id=?3
          AND EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2 AND mutation_id=?4)`)
          .bind(orgId,agentId,memberAgentId,mutation)
      : db.prepare(`INSERT INTO hx_agent_agent_members(org_id,agent_id,member_agent_id,role,updated_by,updated_at)
          SELECT ?1,?2,?3,?5,?6,?7 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?2 AND mutation_id=?4
          ON CONFLICT(org_id,agent_id,member_agent_id) DO UPDATE SET role=excluded.role,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .bind(orgId,agentId,memberAgentId,mutation,role,String(actorId),at),
  ]);
  if(!results[1]?.meta?.changes)return {error:'Agent access changed. Reload before saving.',status:409};
  return {version:results[1].results?.[0]?.version ?? expectedVersion+1};
}

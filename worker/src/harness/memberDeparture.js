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

export async function departureAgents(db, orgId, target) {
  const {results}=await db.prepare(responsibilities).bind(orgId,target.userId,target.login).all();
  const snapshot=JSON.stringify(results.map(a=>[a.id,a.owner_login,a.scope,a.version]));
  const version=await sha256Hex(JSON.stringify([orgId,target.userId,target.joinedAt,snapshot]));
  return {agents:results,snapshot,version};
}

// A receipt is claimed only while the entire preview and all memberships are
// still current. Every write in the same D1 transaction is gated by its nonce.
// A losing race changes neither agents nor membership.
export async function removeWithAgentHandoff(db, orgId, context, {transferTo,previewVersion}) {
  const {actor,target,members}=context;
  const plan=await departureAgents(db,orgId,target);
  const recipient=members.find(m=>m.ref===transferTo&&m.userId!==target.userId&&m.role!=='guest');
  if(plan.agents.length && (!recipient || previewVersion!==plan.version))
    return {error:'Review the agent responsibilities and choose a successor before leaving.',code:'agent-handoff-required',status:409};
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const ids=JSON.stringify(plan.agents.map(a=>a.id));
  const gate='EXISTS (SELECT 1 FROM hx_member_departures WHERE org_id=?1 AND user_id=?2 AND nonce=?3)';
  const batch=[db.prepare(`INSERT INTO hx_member_departures(org_id,user_id,nonce,created_at)
    SELECT ?1,?2,?4,?5 WHERE
      EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND role=?6 AND created_at=?7)
      AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?8 AND role=?9 AND created_at=?10)
      AND (?6!='owner' OR EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND role='owner' AND user_github_id!=?2))
      AND (?11 IS NULL OR EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?11 AND role!='guest' AND created_at=?12))
      AND (${snapshotQuery})=?13
    ON CONFLICT(org_id,user_id) DO UPDATE SET nonce=excluded.nonce,created_at=excluded.created_at`)
    .bind(orgId,target.userId,target.login,nonce,at,target.role,target.joinedAt,actor.userId,actor.role,actor.joinedAt,
      plan.agents.length?recipient.userId:null,plan.agents.length?recipient.joinedAt:null,plan.snapshot)];
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
  batch.push(
    db.prepare(`DELETE FROM hx_agent_members WHERE org_id=?1 AND user_id=?2 AND ${gate}`).bind(orgId,target.userId,nonce),
    db.prepare(`DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND ${gate}`).bind(orgId,target.userId,nonce));
  const results=await db.batch(batch);
  if(!results[0]?.meta?.changes) return {error:'Workspace responsibilities changed. Reload before removing this member.',code:'departure-conflict',status:409};
  return {handoff:plan.agents.length?{agents:plan.agents.length,to:recipient.ref}:null};
}

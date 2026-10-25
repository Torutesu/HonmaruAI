import {listMembers} from '../team.js';
import {sha256Hex} from '../auth.js';

import {ROOM_COLOR_KEYS as colors} from './roomColors.js';
import {roomAgentAccessPlan} from './agentAccessRequests.js';
const failure=(error,status=409)=>({error,status});
export async function createManagedRoom(db,orgId,actorId,input) {
  if(!input||typeof input!=='object'||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(input.requestId)
    ||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120
    ||typeof input.private!=='boolean'||typeof input.guidelines!=='string'||input.guidelines.length>4096||!colors.has(input.color)
    ||!Array.isArray(input.memberRefs)||!Array.isArray(input.agentIds)
    ||(input.grantAccessAgentIds!==undefined&&!Array.isArray(input.grantAccessAgentIds))
    ||input.memberRefs.length>200||input.agentIds.length>100||(input.grantAccessAgentIds||[]).length>100
    ||[...input.memberRefs,...input.agentIds,...(input.grantAccessAgentIds||[])].some(id=>typeof id!=='string'||!id||id.length>200))
    return failure('A room name, visibility, color, guidelines and valid member selections are required.',400);
  actorId=String(actorId);
  const refs=[...new Set(input.memberRefs)].sort(),agentIds=[...new Set(input.agentIds)].sort(),grantAccessAgentIds=[...new Set(input.grantAccessAgentIds||[])].sort();
  if(grantAccessAgentIds.some(id=>!agentIds.includes(id)))return failure('Only agents selected for this room can receive access grants.',400);
  const payload={name:input.name.trim(),private:input.private,color:input.color,guidelines:input.guidelines.trim(),memberRefs:refs,agentIds};
  const fingerprint=await sha256Hex(JSON.stringify(grantAccessAgentIds.length?{...payload,grantAccessAgentIds}:payload));
  const members=await listMembers(db,orgId,actorId),actor=members.find(m=>m.userId===actorId);
  if(!actor||actor.role==='guest')return failure('Only a workspace member can create rooms.',403);
  const existing=await db.prepare('SELECT channel,fingerprint,member_since FROM hx_room_creations WHERE org_id=?1 AND user_id=?2 AND request_id=?3').bind(orgId,actorId,input.requestId).first();
  const replay=async row=>{
    if(row.fingerprint!==fingerprint||row.member_since!==actor.joinedAt)return failure('This creation request belongs to a different draft or membership. Start a new room.');
    const live=await db.prepare(`SELECT b.slug,b.name,p.version,COALESCE((SELECT a.color FROM hx_room_appearance a WHERE a.org_id=b.org_id AND a.channel=?2),r.color) AS color FROM businesses b
      JOIN hx_room_access p ON p.org_id=b.org_id AND p.channel=?2 AND p.deleted_at IS NULL
      JOIN hx_room_creations r ON r.org_id=b.org_id AND r.channel=p.channel
      JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=p.channel AND c.login=?3
      JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=?4 AND m.created_at=?5 AND LOWER(COALESCE(m.role,'guest'))!='guest'
      WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`).bind(orgId,row.channel,actor.login,actorId,actor.joinedAt).first();
    return live?{room:{...live,channel:row.channel},created:false}:failure('The room created by this request is no longer available.');
  };
  if(existing)return replay(existing);
  const chosen=members.filter(m=>refs.includes(m.ref));
  if(chosen.length!==refs.length)return failure('Workspace membership changed. Reload before creating the room.');
  const people=[actor,...chosen.filter(m=>m.userId!==actorId)].sort((a,b)=>a.userId<b.userId?-1:a.userId>b.userId?1:0);
  const grantPeople=people.filter(m=>String(m.role||'guest').toLowerCase()!=='guest').map(m=>({kind:'person',id:String(m.userId),eligible:true,membership:m.joinedAt}));
  const grantPairs=[];
  for(const agentId of grantAccessAgentIds) {
    const plan=await roomAgentAccessPlan(db,orgId,agentId,grantPeople,actorId);
    if(plan.missing.length&&!plan.canGrantAccess)return failure('Only an agent owner or member can grant access to room members.',403);
    for(const missing of plan.missing)grantPairs.push([agentId,missing.id,missing.membership]);
  }
  grantPairs.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
  const grantGroups=[...new Set(grantPairs.map(pair=>pair[0]))].map(agentId=>({agentId,userIds:grantPairs.filter(pair=>pair[0]===agentId).map(pair=>pair[1])}));
  const peopleIds=JSON.stringify(people.map(m=>m.userId));
  const peopleSnapshot=JSON.stringify(people.map(m=>[m.userId,m.joinedAt,m.login,m.role]));
  const agents=JSON.stringify(agentIds),slug=`room-${crypto.randomUUID()}`,channel=`b:${slug}`,nonce=crypto.randomUUID(),at=new Date().toISOString();
  const gate='EXISTS(SELECT 1 FROM hx_room_creations WHERE org_id=?1 AND channel=?2 AND nonce=?3)';
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_room_creations(org_id,user_id,request_id,channel,fingerprint,member_since,nonce,color,created_at)
      SELECT ?1,?4,?5,?2,?6,?7,?3,?8,?9
      WHERE EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id WHERE m.org_id=?1 AND m.user_github_id=?4 AND m.created_at=?7 AND LOWER(COALESCE(m.role,'guest'))!='guest')
      AND (SELECT json_group_array(json_array(id,stamp,login,role)) FROM (
        SELECT CAST(m.user_github_id AS TEXT) AS id,m.created_at AS stamp,u.login,LOWER(COALESCE(m.role,'member')) AS role FROM memberships m JOIN users u ON u.github_id=m.user_github_id
        WHERE m.org_id=?1 AND m.user_github_id IN(SELECT value FROM json_each(?10)) ORDER BY m.user_github_id))=?11
      AND (SELECT COUNT(*) FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
        JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?4 AND LOWER(COALESCE(m.role,'guest'))!='guest' JOIN users u ON u.github_id=m.user_github_id
        WHERE a.org_id=?1 AND a.id IN(SELECT value FROM json_each(?12)) AND a.deleted_at IS NULL AND (a.scope='team' OR a.owner_login=u.login)
        AND (p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
          OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=u.login))
          OR (a.scope='team' AND a.provider IS NULL AND EXISTS(SELECT 1 FROM hx_agent_members r WHERE r.org_id=a.org_id AND r.agent_id=a.id AND r.user_id=?4 AND r.member_since=m.created_at))))=json_array_length(?12)
      AND (SELECT COUNT(DISTINCT handle) FROM custom_agents WHERE org_id=?1 AND id IN(SELECT value FROM json_each(?12)))=json_array_length(?12)
      AND (json_array_length(?13)=0 OR (SELECT json_group_array(json_array(agent_id,user_id,member_since)) FROM (
        SELECT a.id AS agent_id,CAST(m.user_github_id AS TEXT) AS user_id,m.created_at AS member_since
        FROM json_each(?13) g
        JOIN custom_agents a ON a.org_id=?1 AND a.id=json_extract(g.value,'$[0]') AND a.deleted_at IS NULL AND a.provider IS NULL
        JOIN memberships m ON m.org_id=?1 AND m.user_github_id=json_extract(g.value,'$[1]')
          AND m.created_at=json_extract(g.value,'$[2]') AND LOWER(COALESCE(m.role,'guest'))!='guest'
        JOIN users u ON u.github_id=m.user_github_id
        JOIN users au ON au.github_id=?4
        JOIN memberships am ON am.org_id=?1 AND am.user_github_id=au.github_id AND LOWER(COALESCE(am.role,'guest'))!='guest'
        LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
        WHERE (a.owner_login=au.login OR (a.scope='team' AND EXISTS(SELECT 1 FROM hx_agent_members ar
          JOIN memberships arm ON arm.org_id=ar.org_id AND arm.user_github_id=au.github_id
            AND arm.created_at=ar.member_since AND LOWER(COALESCE(arm.role,'guest'))!='guest'
          WHERE ar.org_id=a.org_id AND ar.agent_id=a.id AND ar.user_id=au.github_id AND ar.role IN('admin','member'))))
          AND NOT ((a.scope!='personal' OR a.owner_login=u.login) AND (
            p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
            OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=u.login))
            OR (a.scope='team' AND EXISTS(SELECT 1 FROM hx_agent_members tr
              WHERE tr.org_id=a.org_id AND tr.agent_id=a.id AND tr.user_id=u.github_id
                AND tr.member_since=m.created_at AND LOWER(COALESCE(m.role,'guest'))!='guest'))
          )) ORDER BY a.id,m.user_github_id))=?14)`)
      .bind(orgId,channel,nonce,actorId,input.requestId,fingerprint,actor.joinedAt,input.color,at,peopleIds,peopleSnapshot,agents,JSON.stringify(grantPairs),JSON.stringify(grantPairs)),
    db.prepare(`INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) SELECT ?1,?4,?5,?6,?7,?8 WHERE ${gate}`).bind(orgId,channel,nonce,slug,payload.name,actorId,at,input.private?1:0),
    db.prepare(`INSERT INTO hx_room_access(org_id,channel,version,mutation_id) SELECT ?1,?2,1,?3 WHERE ${gate}`).bind(orgId,channel,nonce),
    ...people.map(p=>db.prepare(`INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) SELECT ?1,?2,?4,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,p.login,actor.login,at)),
    db.prepare(`INSERT INTO hx_room_roles(org_id,channel,subject_kind,subject_id,role,member_since,updated_by,updated_at)
      SELECT ?1,?2,'person',?4,'admin',?5,?4,?6 WHERE ${gate}`).bind(orgId,channel,nonce,actorId,`${actor.joinedAt}/${at}`,at),
    ...grantGroups.flatMap(({agentId,userIds})=>{
      const accessNonce=crypto.randomUUID(),targets=JSON.stringify(userIds);
      return [
        db.prepare(`INSERT OR IGNORE INTO hx_agent_access(org_id,agent_id,version)
          SELECT ?1,?4,0 WHERE ${gate} AND json_array_length(?5)>0`).bind(orgId,channel,nonce,agentId,targets),
        db.prepare(`UPDATE hx_agent_access SET version=version+1,mutation_id=?4
          WHERE org_id=?1 AND agent_id=?5 AND ${gate} AND json_array_length(?6)>0`)
          .bind(orgId,channel,nonce,accessNonce,agentId,targets),
        db.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,specialty,tier,mention_only,access,people,updated_by,updated_at)
          SELECT ?1,?5,'','standard',0,'private','[]',?6,?7
          WHERE EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?5 AND mutation_id=?4)
          ON CONFLICT(org_id,agent_id) DO UPDATE SET
            access=CASE WHEN EXISTS(SELECT 1 FROM custom_agents WHERE org_id=?1 AND id=?5 AND scope='personal' AND owner_login=?6)
              THEN 'private' ELSE hx_agent_profiles.access END,
            people=CASE WHEN EXISTS(SELECT 1 FROM custom_agents WHERE org_id=?1 AND id=?5 AND scope='personal' AND owner_login=?6)
              THEN '[]' ELSE hx_agent_profiles.people END,
            updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .bind(orgId,channel,nonce,accessNonce,agentId,actor.login,at),
        db.prepare(`UPDATE custom_agents SET scope='team',updated_by=?6,updated_at=?7
          WHERE org_id=?1 AND id=?5 AND scope='personal' AND owner_login=?6
            AND EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?5 AND mutation_id=?4)`)
          .bind(orgId,channel,nonce,accessNonce,agentId,actor.login,at),
        db.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
          SELECT ?1,?5,m.user_github_id,'member',?6,?7,m.created_at FROM memberships m
          WHERE m.org_id=?1 AND m.user_github_id IN(SELECT value FROM json_each(?8))
            AND LOWER(COALESCE(m.role,'guest'))!='guest'
            AND EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?5 AND mutation_id=?4)
            AND ${gate}
          ON CONFLICT(org_id,agent_id,user_id) DO UPDATE SET
            role=CASE WHEN hx_agent_members.member_since!=excluded.member_since THEN 'member' ELSE hx_agent_members.role END,
            member_since=excluded.member_since,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .bind(orgId,channel,nonce,accessNonce,agentId,actor.login,at,targets),
      ];
    }),
    ...agentIds.map(id=>db.prepare(`INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) SELECT ?1,?2,?4,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,id,actor.login,at)),
    db.prepare(`INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) SELECT ?1,?2,?4,1,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,payload.guidelines,actorId,at),
  ]);
  if(result[0].meta?.changes)return {room:{slug,channel,name:payload.name,color:payload.color,version:1},created:true};
  const concurrent=await db.prepare('SELECT channel,fingerprint,member_since FROM hx_room_creations WHERE org_id=?1 AND user_id=?2 AND request_id=?3').bind(orgId,actorId,input.requestId).first();
  return concurrent?replay(concurrent):failure('Workspace membership or agent access changed. Reload before creating the room.');
}

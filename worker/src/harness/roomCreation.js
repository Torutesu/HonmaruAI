import {listMembers} from '../team.js';
import {sha256Hex} from '../auth.js';

const colors=new Set(['teal','olive','blue','purple','pink','orange','red','gray','rose','yellow','green','lake','indigo']);
const failure=(error,status=409)=>({error,status});
export async function createManagedRoom(db,orgId,actorId,input) {
  if(!input||typeof input!=='object'||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(input.requestId)
    ||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120
    ||typeof input.private!=='boolean'||typeof input.guidelines!=='string'||input.guidelines.length>4096||!colors.has(input.color)
    ||!Array.isArray(input.memberRefs)||!Array.isArray(input.agentIds)
    ||input.memberRefs.length>200||input.agentIds.length>100
    ||[...input.memberRefs,...input.agentIds].some(id=>typeof id!=='string'||!id||id.length>200))
    return failure('A room name, visibility, color, guidelines and valid member selections are required.',400);
  actorId=String(actorId);
  const refs=[...new Set(input.memberRefs)].sort(),agentIds=[...new Set(input.agentIds)].sort();
  const payload={name:input.name.trim(),private:input.private,color:input.color,guidelines:input.guidelines.trim(),memberRefs:refs,agentIds};
  const fingerprint=await sha256Hex(JSON.stringify(payload));
  const members=await listMembers(db,orgId,actorId),actor=members.find(m=>m.userId===actorId);
  if(!actor||actor.role==='guest')return failure('Only a workspace member can create rooms.',403);
  const existing=await db.prepare('SELECT channel,fingerprint,member_since FROM hx_room_creations WHERE org_id=?1 AND user_id=?2 AND request_id=?3').bind(orgId,actorId,input.requestId).first();
  const replay=async row=>{
    if(row.fingerprint!==fingerprint||row.member_since!==actor.joinedAt)return failure('This creation request belongs to a different draft or membership. Start a new room.');
    const live=await db.prepare(`SELECT b.slug,b.name,p.version,r.color FROM businesses b
      JOIN hx_room_access p ON p.org_id=b.org_id AND p.channel=?2 AND p.deleted_at IS NULL
      JOIN hx_room_creations r ON r.org_id=b.org_id AND r.channel=p.channel
      JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=p.channel AND c.login=?3
      JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=?4 AND m.created_at=?5 AND m.role!='guest'
      WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`).bind(orgId,row.channel,actor.login,actorId,actor.joinedAt).first();
    return live?{room:{...live,channel:row.channel},created:false}:failure('The room created by this request is no longer available.');
  };
  if(existing)return replay(existing);
  const chosen=members.filter(m=>refs.includes(m.ref));
  if(chosen.length!==refs.length)return failure('Workspace membership changed. Reload before creating the room.');
  const people=[actor,...chosen.filter(m=>m.userId!==actorId)].sort((a,b)=>a.userId<b.userId?-1:a.userId>b.userId?1:0);
  const peopleIds=JSON.stringify(people.map(m=>m.userId));
  const peopleSnapshot=JSON.stringify(people.map(m=>[m.userId,m.joinedAt,m.login,m.role]));
  const agents=JSON.stringify(agentIds),slug=`room-${crypto.randomUUID()}`,channel=`b:${slug}`,nonce=crypto.randomUUID(),at=new Date().toISOString();
  const gate='EXISTS(SELECT 1 FROM hx_room_creations WHERE org_id=?1 AND channel=?2 AND nonce=?3)';
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_room_creations(org_id,user_id,request_id,channel,fingerprint,member_since,nonce,color,created_at)
      SELECT ?1,?4,?5,?2,?6,?7,?3,?8,?9
      WHERE EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id WHERE m.org_id=?1 AND m.user_github_id=?4 AND m.created_at=?7 AND m.role!='guest')
      AND (SELECT json_group_array(json_array(id,stamp,login,role)) FROM (
        SELECT m.user_github_id AS id,m.created_at AS stamp,u.login,m.role FROM memberships m JOIN users u ON u.github_id=m.user_github_id
        WHERE m.org_id=?1 AND m.user_github_id IN(SELECT value FROM json_each(?10)) ORDER BY m.user_github_id))=?11
      AND (SELECT COUNT(*) FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
        JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=?4 AND m.role!='guest' JOIN users u ON u.github_id=m.user_github_id
        WHERE a.org_id=?1 AND a.id IN(SELECT value FROM json_each(?12)) AND a.deleted_at IS NULL AND (a.scope='team' OR a.owner_login=u.login)
        AND (p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
          OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=u.login))
          OR (a.scope='team' AND a.provider IS NULL AND EXISTS(SELECT 1 FROM hx_agent_members r WHERE r.org_id=a.org_id AND r.agent_id=a.id AND r.user_id=?4 AND r.member_since=m.created_at))))=json_array_length(?12)
      AND (SELECT COUNT(DISTINCT handle) FROM custom_agents WHERE org_id=?1 AND id IN(SELECT value FROM json_each(?12)))=json_array_length(?12)`)
      .bind(orgId,channel,nonce,actorId,input.requestId,fingerprint,actor.joinedAt,input.color,at,peopleIds,peopleSnapshot,agents),
    db.prepare(`INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) SELECT ?1,?4,?5,?6,?7,?8 WHERE ${gate}`).bind(orgId,channel,nonce,slug,payload.name,actorId,at,input.private?1:0),
    db.prepare(`INSERT INTO hx_room_access(org_id,channel,version,mutation_id) SELECT ?1,?2,1,?3 WHERE ${gate}`).bind(orgId,channel,nonce),
    ...people.map(p=>db.prepare(`INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) SELECT ?1,?2,?4,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,p.login,actor.login,at)),
    db.prepare(`INSERT INTO hx_room_roles(org_id,channel,subject_kind,subject_id,role,member_since,updated_by,updated_at)
      SELECT ?1,?2,'person',?4,'admin',?5,?4,?6 WHERE ${gate}`).bind(orgId,channel,nonce,actorId,`${actor.joinedAt}/${at}`,at),
    ...agentIds.map(id=>db.prepare(`INSERT INTO channel_agents(org_id,channel,agent_id,added_by,added_at) SELECT ?1,?2,?4,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,id,actor.login,at)),
    db.prepare(`INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) SELECT ?1,?2,?4,1,?5,?6 WHERE ${gate}`).bind(orgId,channel,nonce,payload.guidelines,actorId,at),
  ]);
  if(result[0].meta?.changes)return {room:{slug,channel,name:payload.name,color:payload.color,version:1},created:true};
  const concurrent=await db.prepare('SELECT channel,fingerprint,member_since FROM hx_room_creations WHERE org_id=?1 AND user_id=?2 AND request_id=?3').bind(orgId,actorId,input.requestId).first();
  return concurrent?replay(concurrent):failure('Workspace membership or agent access changed. Reload before creating the room.');
}

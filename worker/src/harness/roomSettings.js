import {roomRoleState} from './roomRoles.js';
import {ROOM_COLOR_KEYS} from './roomColors.js';
import {filterResponders,profilesFor} from './agents.js';

const fail=(error,status=409)=>({error,status});
export async function managedRoomSettings(db,orgId,channel,actorId) {
  const state=await roomRoleState(db,orgId,channel);
  if(!state?.managed)return fail('No such active managed room.',404);
  const row=await db.prepare(`SELECT b.name,b.is_default,b.fixed_membership,b.private,COALESCE(a.color,c.color,'teal') AS color,
    COALESCE(r.mentioned_only,0) AS mentioned_only,r.default_agent_id,COALESCE(r.version,0) AS response_version
    FROM businesses b LEFT JOIN hx_room_appearance a ON a.org_id=b.org_id AND a.channel=?2
    LEFT JOIN hx_room_creations c ON c.org_id=b.org_id AND c.channel=?2
    LEFT JOIN hx_room_responses r ON r.org_id=b.org_id AND r.channel=?2
    WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`).bind(orgId,channel).first();
  if(!row)return fail('No such active managed room.',404);
  const actor=state.members.find(m=>m.kind==='person'&&m.id===String(actorId)&&m.eligible);
  let availableAgents=[];
  if(actor){
    const user=await db.prepare('SELECT login FROM users WHERE github_id=?1').bind(String(actorId)).first();
    if(user?.login){
      const {results=[]}=await db.prepare(`SELECT a.id,a.name,a.emoji,a.description FROM channel_agents ca
        JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
        WHERE ca.org_id=?1 AND ca.channel=?2 ORDER BY a.created_at,a.id`).bind(orgId,channel).all();
      const eligible=await filterResponders(db,orgId,user.login,results,{named:new Set(),channel});
      const profiles=await profilesFor(db,orgId,eligible.map(agent=>agent.id));
      availableAgents=eligible.map(agent=>({id:agent.id,name:agent.name,emoji:agent.emoji||null,specialty:profiles.get(agent.id)?.specialty||''}));
    }
  }
  const workspaceRole=actorId?await db.prepare("SELECT LOWER(TRIM(COALESCE(role,'guest'))) AS role FROM memberships WHERE org_id=?1 AND user_github_id=?2").bind(orgId,String(actorId)).first('role'):null;
  return {settings:{name:row.name,color:row.color,mentionedOnly:!!row.mentioned_only,defaultAgentId:row.default_agent_id||null,isDefault:state.isDefault,fixedMembership:!!row.fixed_membership,version:state.version,responseVersion:row.response_version},canEdit:!!actor,canChangeRoomPolicies:!!actor&&actor.role==='admin',canChangeDefault:!!actor&&['owner','admin'].includes(workspaceRole),isPrivate:!!row.private,actor,availableAgents};
}

// One version claim gates all three edits. Creation receipts remain immutable:
// a changed appearance never changes the payload/fingerprint of an old retry.
export async function saveManagedRoomSettings(db,orgId,channel,actorId,input,{canChangeResponses=true}={}) {
  if(typeof input?.name!=='string'||!input.name.trim()||input.name.trim().length>120||!ROOM_COLOR_KEYS.has(input.color)
    ||typeof input.mentionedOnly!=='boolean'||!Number.isSafeInteger(input.version)||input.version<1
    ||!Number.isSafeInteger(input.responseVersion)||input.responseVersion<0
    ||(input.defaultAgentId!==undefined&&input.defaultAgentId!==null&&(typeof input.defaultAgentId!=='string'||input.defaultAgentId.length>128))
    ||(input.isDefault!==undefined&&typeof input.isDefault!=='boolean')
    ||(input.fixedMembership!==undefined&&typeof input.fixedMembership!=='boolean'))
    return fail('A room name, color, response setting and current versions are required.',400);
  actorId=String(actorId);
  const current=await managedRoomSettings(db,orgId,channel,actorId);
  if(current.error)return current;
  if(!current.canEdit)return fail('Only a room member can change its settings.',403);
  const defaultAgentId=input.defaultAgentId===undefined?current.settings.defaultAgentId:input.defaultAgentId;
  const isDefault=input.isDefault===undefined?current.settings.isDefault:input.isDefault;
  const fixedMembership=input.fixedMembership===undefined?current.settings.fixedMembership:input.fixedMembership;
  if(isDefault!==current.settings.isDefault&&!current.canChangeDefault)return fail('Only a workspace admin can change which rooms new members join.',403);
  if(fixedMembership!==current.settings.fixedMembership&&!current.canChangeRoomPolicies)return fail('Only a room admin can change fixed membership.',403);
  if(channel==='b:general'&&!isDefault)return fail('General is always a default Room.',403);
  if(isDefault&&current.isPrivate)return fail('A private Room cannot be a default Room.',409);
  if(!canChangeResponses&&(input.mentionedOnly!==current.settings.mentionedOnly||defaultAgentId!==current.settings.defaultAgentId))return fail('You cannot change how agents respond in this workspace.',403);
  if(defaultAgentId!==null&&!current.availableAgents.some(agent=>agent.id===defaultAgentId))return fail('Choose an agent available in this room, or use automatic routing.',400);
  if(input.version!==current.settings.version||input.responseVersion!==current.settings.responseVersion)return fail('Room settings changed. Reload before saving.');
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const gate='EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?3 AND deleted_at IS NULL)';
  const result=await db.batch([
    db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?3
      WHERE org_id=?1 AND channel=?2 AND version=?4 AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM businesses b JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2
        JOIN users u ON u.login=c.login JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=u.github_id
        WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL AND u.github_id=?5
        AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest' AND m.created_at||'/'||c.added_at=?6)
      AND COALESCE((SELECT version FROM hx_room_responses WHERE org_id=?1 AND channel=?2),0)=?7
      AND (?8 IS NULL OR EXISTS(SELECT 1 FROM channel_agents ca JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL WHERE ca.org_id=?1 AND ca.channel=?2 AND ca.agent_id=?8))`)
      .bind(orgId,channel,nonce,input.version,actorId,current.actor.membership,input.responseVersion,defaultAgentId),
    db.prepare(`UPDATE businesses SET name=?4,is_default=?5,fixed_membership=?6 WHERE org_id=?1 AND 'b:'||slug=?2 AND ${gate}
      AND (?5=0 OR private=0)`).bind(orgId,channel,nonce,input.name.trim(),isDefault?1:0,fixedMembership?1:0),
    db.prepare(`INSERT INTO hx_room_appearance(org_id,channel,color,updated_by,updated_at)
      SELECT ?1,?2,?4,?5,?6 WHERE ${gate}
      ON CONFLICT(org_id,channel) DO UPDATE SET color=excluded.color,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,channel,nonce,input.color,actorId,at),
    db.prepare(`INSERT INTO hx_room_responses(org_id,channel,mentioned_only,default_agent_id,version,updated_by,updated_at)
      SELECT ?1,?2,?4,?8,?5+1,?6,?7 WHERE ${gate}
      ON CONFLICT(org_id,channel) DO UPDATE SET mentioned_only=excluded.mentioned_only,default_agent_id=excluded.default_agent_id,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,channel,nonce,input.mentionedOnly?1:0,input.responseVersion,actorId,at,defaultAgentId),
  ]);
  return result[0].meta?.changes&&result[1].meta?.changes?{settings:{name:input.name.trim(),color:input.color,mentionedOnly:input.mentionedOnly,defaultAgentId,isDefault,fixedMembership,version:input.version+1,responseVersion:input.responseVersion+1}}:fail('Room settings or membership changed. Reload before saving.');
}

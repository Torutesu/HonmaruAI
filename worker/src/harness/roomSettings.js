import {roomRoleState} from './roomRoles.js';
import {ROOM_COLOR_KEYS} from './roomColors.js';

const fail=(error,status=409)=>({error,status});
export async function managedRoomSettings(db,orgId,channel,actorId) {
  const state=await roomRoleState(db,orgId,channel);
  if(!state?.managed)return fail('No such active managed room.',404);
  const row=await db.prepare(`SELECT b.name,COALESCE(a.color,c.color,'teal') AS color,
    COALESCE(r.mentioned_only,0) AS mentioned_only,COALESCE(r.version,0) AS response_version
    FROM businesses b LEFT JOIN hx_room_appearance a ON a.org_id=b.org_id AND a.channel=?2
    LEFT JOIN hx_room_creations c ON c.org_id=b.org_id AND c.channel=?2
    LEFT JOIN hx_room_responses r ON r.org_id=b.org_id AND r.channel=?2
    WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL`).bind(orgId,channel).first();
  if(!row)return fail('No such active managed room.',404);
  const actor=state.members.find(m=>m.kind==='person'&&m.id===String(actorId)&&m.eligible);
  return {settings:{name:row.name,color:row.color,mentionedOnly:!!row.mentioned_only,version:state.version,responseVersion:row.response_version},canEdit:!!actor,actor};
}

// One version claim gates all three edits. Creation receipts remain immutable:
// a changed appearance never changes the payload/fingerprint of an old retry.
export async function saveManagedRoomSettings(db,orgId,channel,actorId,input,{canChangeResponses=true}={}) {
  if(typeof input?.name!=='string'||!input.name.trim()||input.name.trim().length>120||!ROOM_COLOR_KEYS.has(input.color)
    ||typeof input.mentionedOnly!=='boolean'||!Number.isSafeInteger(input.version)||input.version<1
    ||!Number.isSafeInteger(input.responseVersion)||input.responseVersion<0)
    return fail('A room name, color, response setting and current versions are required.',400);
  actorId=String(actorId);
  const current=await managedRoomSettings(db,orgId,channel,actorId);
  if(current.error)return current;
  if(!current.canEdit)return fail('Only a room member can change its settings.',403);
  if(!canChangeResponses&&input.mentionedOnly!==current.settings.mentionedOnly)return fail('You cannot change how agents respond in this workspace.',403);
  if(input.version!==current.settings.version||input.responseVersion!==current.settings.responseVersion)return fail('Room settings changed. Reload before saving.');
  const nonce=crypto.randomUUID(),at=new Date().toISOString();
  const gate='EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?3 AND deleted_at IS NULL)';
  const result=await db.batch([
    db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?3
      WHERE org_id=?1 AND channel=?2 AND version=?4 AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM businesses b JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2
        JOIN users u ON u.login=c.login JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=u.github_id
        WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL AND u.github_id=?5
        AND m.role!='guest' AND m.created_at||'/'||c.added_at=?6)
      AND COALESCE((SELECT version FROM hx_room_responses WHERE org_id=?1 AND channel=?2),0)=?7`)
      .bind(orgId,channel,nonce,input.version,actorId,current.actor.membership,input.responseVersion),
    db.prepare(`UPDATE businesses SET name=?4 WHERE org_id=?1 AND 'b:'||slug=?2 AND ${gate}`).bind(orgId,channel,nonce,input.name.trim()),
    db.prepare(`INSERT INTO hx_room_appearance(org_id,channel,color,updated_by,updated_at)
      SELECT ?1,?2,?4,?5,?6 WHERE ${gate}
      ON CONFLICT(org_id,channel) DO UPDATE SET color=excluded.color,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,channel,nonce,input.color,actorId,at),
    db.prepare(`INSERT INTO hx_room_responses(org_id,channel,mentioned_only,version,updated_by,updated_at)
      SELECT ?1,?2,?4,?5+1,?6,?7 WHERE ${gate}
      ON CONFLICT(org_id,channel) DO UPDATE SET mentioned_only=excluded.mentioned_only,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,channel,nonce,input.mentionedOnly?1:0,input.responseVersion,actorId,at),
  ]);
  return result[0].meta?.changes?{settings:{name:input.name.trim(),color:input.color,mentionedOnly:input.mentionedOnly,version:input.version+1,responseVersion:input.responseVersion+1}}:fail('Room settings or membership changed. Reload before saving.');
}

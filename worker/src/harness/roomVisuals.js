import {roomRoleState} from './roomRoles.js';

const fail=(error,status)=>({error,status});
// The visual's object key is internal metadata, never a public image URL.
export async function roomVisualState(db,orgId,channel,actorId) {
 const state=await roomRoleState(db,orgId,channel);
 if(!state?.managed)return fail('No such active managed room.',404);
 const actor=state.members.find(m=>m.kind==='person'&&m.id===String(actorId)&&m.eligible);
 if(!actor)return fail('Join this room to manage its visual.',403);
 const visual=await db.prepare('SELECT object_key,content_type FROM hx_room_visuals WHERE org_id=?1 AND channel=?2').bind(orgId,channel).first();
 return {version:state.version,actor,visual:visual||null};
}

// The same access version used by membership/room settings guards the pointer.
// A departed/rejoined member cannot commit an upload begun under an old grant.
export async function setRoomVisual(db,orgId,channel,actorId,{version,objectKey=null,contentType=null}) {
 if(!Number.isSafeInteger(version)||version<1)return fail('A current room version is required.',400);
 if(objectKey!==null&&(!/^room-visual-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(objectKey)||!['image/png','image/jpeg','image/webp','image/gif'].includes(contentType)))return fail('A validated room image is required.',400);
 const current=await roomVisualState(db,orgId,channel,actorId);
 if(current.error)return current;
 if(current.version!==version)return fail('Room settings changed. Reload before saving.',409);
 const nonce=crypto.randomUUID(),at=new Date().toISOString();
 const gate='EXISTS(SELECT 1 FROM hx_room_access WHERE org_id=?1 AND channel=?2 AND mutation_id=?3 AND deleted_at IS NULL)';
 const result=await db.batch([
  db.prepare(`UPDATE hx_room_access SET version=version+1,mutation_id=?3
   WHERE org_id=?1 AND channel=?2 AND version=?4 AND deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM businesses b JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2
    JOIN users u ON u.login=c.login JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=u.github_id
    WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL AND u.github_id=?5
    AND m.role!='guest' AND m.created_at||'/'||c.added_at=?6)`)
   .bind(orgId,channel,nonce,version,String(actorId),current.actor.membership),
  objectKey===null
   ?db.prepare(`DELETE FROM hx_room_visuals WHERE org_id=?1 AND channel=?2 AND ${gate}`).bind(orgId,channel,nonce)
   :db.prepare(`INSERT INTO hx_room_visuals(org_id,channel,object_key,content_type,updated_by,updated_at)
     SELECT ?1,?2,?4,?5,?6,?7 WHERE ${gate}
     ON CONFLICT(org_id,channel) DO UPDATE SET object_key=excluded.object_key,content_type=excluded.content_type,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
     .bind(orgId,channel,nonce,objectKey,contentType,String(actorId),at),
 ]);
 return result[0].meta?.changes?{version:version+1,previous:current.visual?.object_key||null,objectKey}:fail('Room settings or membership changed. Reload before saving.',409);
}

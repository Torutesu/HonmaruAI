import { sourceFor } from './appConversationFeatures.js';
import { formatRoomGuidelinesRequest } from './guidelines.js';
import { conversationWriteAuthority } from './conversationWriteAuthority.js';

// Snapshot only data that was authorized in the same database statement.
// A room membership timestamp and room creation timestamp are generations,
// not globally unique IDs; same-timestamp replacement is still ambiguous.
async function snapshot(db, orgId, appId, userId, source) {
  const common=`a.org_id=?1 AND a.id=?2 AND m.user_github_id=?3
    AND LOWER(COALESCE(m.role,'guest'))!='guest'
    AND (a.created_by=?3 OR LOWER(m.role) IN ('admin','owner'))
    AND (COALESCE(p.visibility,'workspace')='workspace' OR a.created_by=?3)
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=a.org_id AND d.purge_started_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=a.org_id)`;
  const from=`FROM hx_apps a JOIN memberships m ON m.org_id=a.org_id JOIN users u ON u.github_id=m.user_github_id
    LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id`;
  const base=`m.created_at AS memberSince,u.login,a.created_by AS appOwner,a.created_at AS appCreatedAt`;
  if(!source) return db.prepare(`SELECT ${base} ${from} WHERE ${common}`).bind(orgId,appId,String(userId)).first();
  return db.prepare(`SELECT ${base}, b.created_at AS roomCreatedAt,b.private AS roomPrivate,
      CASE WHEN b.private=1 THEN c.added_at ELSE NULL END AS roomMemberSince,
      COALESCE(g.body,'') AS body,COALESCE(g.version,0) AS version
    ${from}
    JOIN hx_app_conversation_sources s ON s.org_id=a.org_id AND s.app_id=a.id
    JOIN businesses b ON b.org_id=s.org_id AND 'b:'||b.slug=s.channel
    JOIN channel_messages root ON root.org_id=s.org_id AND root.id=s.thread_id AND root.channel=s.channel AND root.parent_id IS NULL AND root.deleted_at IS NULL
    LEFT JOIN conversation_members c ON c.org_id=s.org_id AND c.channel=s.channel AND c.login=u.login
    LEFT JOIN hx_room_guidelines g ON g.org_id=s.org_id AND g.channel=s.channel
    LEFT JOIN hx_room_access access ON access.org_id=s.org_id AND access.channel=s.channel
    WHERE ${common} AND s.channel=?4 AND s.thread_id=?5 AND b.archived_at IS NULL AND access.deleted_at IS NULL
      AND ${conversationWriteAuthority('?1','?4','?3')}`)
    .bind(orgId,appId,String(userId),source.channel,source.threadId).first();
}

// Existing apps with an unavailable source keep generating without its rules.
// If a rule was captured, the model call is cancelled if source access,
// membership, app access, room generation, or the rule body/version changes.
export async function prepareAppGuidelines(db,orgId,user,appId,request) {
  const found=typeof request==='string'?await sourceFor(db,orgId,user,appId):null;
  const source=found?.channel?.startsWith('b:')?found:null;
  const original=await snapshot(db,orgId,appId,user.github_id,source);
  if(!original)return null;
  const authorize=async()=>{
    const current=await snapshot(db,orgId,appId,user.github_id,source);
    return Boolean(current && JSON.stringify(current)===JSON.stringify(original));
  };
  const wrap=complete=>{
    if(!complete)return null;
    const guarded=async(system,prompt,options={})=>{
      const other=options.authorize;
      return complete(system,prompt,{...options,authorize:async()=>await authorize() && (!other||await other()) && await authorize()});
    };
    guarded.dispose=()=>complete.dispose?.();
    return guarded;
  };
  return {request:source?formatRoomGuidelinesRequest(original,request):request,authorize,wrap};
}

import { grantExternalResource, revokeExternalResource } from './externalCollaborators.js';
import { allowed } from '../permissions.js';
import { getMode } from './mode.js';
import { sha256Hex } from '../auth.js';
import { deliverExternalInvite } from '../externalInviteMail.js';
import { sealCollaboratorRef, openCollaboratorRef, outsiderLabel, recipientFromParam } from './collaboratorRefs.js';

/// The account a grant response was about, for the audit record only: the
/// response itself names that person by handle (#956).
export const grantRecipients = new WeakMap();
import {
  cleanResourceAudienceInput, listResourceAudienceRooms, readResourceAudience,
  writeResourceAudience,
} from './externalResourceAudiences.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const fileRoute = url => {
  const match = url.pathname.match(/^\/hx\/files\/([^/]+)\/external-grants(?:\/([^/]+))?$/);
  if (!match) return null;
  try { return { fileId: decodeURIComponent(match[1]), recipientId: match[2] ? decodeURIComponent(match[2]) : null }; }
  catch { return { malformed: true }; }
};
const fileLinkRoute = url => {
  const match=url.pathname.match(/^\/hx\/files\/([^/]+)\/external-links(?:\/([^/]+))?$/);
  if(!match)return null;
  try{return {fileId:decodeURIComponent(match[1]),linkId:match[2]?decodeURIComponent(match[2]):null};}catch{return {malformed:true};}
};
const fileAudienceRoute = url => {
  const match = url.pathname.match(/^\/hx\/files\/([^/]+)\/external-audience$/);
  if (!match) return null;
  try { return { fileId: decodeURIComponent(match[1]) }; }
  catch { return { malformed: true }; }
};
const expiry = value => {
  if (value === 0 || value === null) return null;
  if (![1, 7, 30, 90].includes(value)) throw new TypeError('Choose no expiry, 1, 7, 30, or 90 days.');
  return new Date(Date.now() + value * 86400000).toISOString();
};
async function fileRecord(db, orgId, fileId) {
  return db.prepare("SELECT f.id,f.path,f.scope,f.created_by,f.current_version,v.kind FROM hx_workspace_files f LEFT JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version WHERE f.org_id=?1 AND f.id=?2 AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id) AND NOT EXISTS(SELECT 1 FROM hx_room_access r WHERE r.org_id=f.org_id AND r.channel=f.scope AND r.deleted_at IS NOT NULL) AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))")
    .bind(orgId,fileId).first();
}
async function canManage(db, orgId, userId, ownerId) {
  return String(userId) === String(ownerId) || await allowed(db,orgId,userId,'harness.delete_others');
}

const fileInviteRoute = url => {
  const match = url.pathname.match(/^\/hx\/files\/([^/]+)\/external-grant-invites(?:\/([^/]+))?$/);
  if (!match) return null;
  try { return { fileId: decodeURIComponent(match[1]), inviteId: match[2] ? decodeURIComponent(match[2]) : null }; }
  catch { return { malformed: true }; }
};
const randomInviteToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
async function manageFileLinks(request,env,url,{orgId,userId},route){
 const db=env.DB,file=await fileRecord(db,orgId,route.fileId);
 if(!file||file.kind!=='content'||await getMode(db,orgId)!=='harness')return json({message:'File not found.'},404);
 if(!await canManage(db,orgId,userId,file.created_by))return json({message:'Only the file owner or a workspace admin can manage external access.'},403);
 if(request.method==='GET'&&!route.linkId){
  const now=new Date().toISOString();
  const {results=[]}=await db.prepare("SELECT id,permission,created_at AS createdAt,expires_at AS expiresAt FROM hx_external_file_link_shares WHERE org_id=?1 AND resource_id=?2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?3) ORDER BY created_at DESC LIMIT 100").bind(orgId,route.fileId,now).all();
  return json({canManage:true,links:results});
 }
 if(request.method==='POST'&&!route.linkId){
  const input=await request.json().catch(()=>null),permission=['view','edit'].includes(input?.permission)?input.permission:null;
  if(!permission)return json({message:'Choose view or edit access.'},400);
  let expiresAt=input?.expiresAt==null?null:String(input.expiresAt).trim();
  if(expiresAt){const parsed=Date.parse(expiresAt);if(!Number.isFinite(parsed)||parsed<=Date.now())return json({message:'Expiry must be a future timestamp.'},400);expiresAt=new Date(parsed).toISOString();}
  const now=new Date().toISOString(),token=randomInviteToken(),id='xfl_'+crypto.randomUUID().replaceAll('-','');
  const inserted=await db.prepare(`INSERT INTO hx_external_file_link_shares(id,org_id,resource_id,permission,token_hash,created_by,created_at,expires_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=?2 AND f.id=?3 AND f.current_version>0 AND f.created_by=?6
    AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content')
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
    AND NOT EXISTS(SELECT 1 FROM hx_room_access r WHERE r.org_id=f.org_id AND r.channel=f.scope AND r.deleted_at IS NOT NULL)
    AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))
    AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness'))
    OR EXISTS(SELECT 1 FROM hx_workspace_files f JOIN memberships m ON m.org_id=f.org_id AND m.user_github_id=?6
      WHERE f.org_id=?2 AND f.id=?3 AND f.current_version>0 AND lower(m.role) IN ('owner','admin')
       AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content')
       AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
       AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
       AND NOT EXISTS(SELECT 1 FROM hx_room_access r WHERE r.org_id=f.org_id AND r.channel=f.scope AND r.deleted_at IS NOT NULL)
       AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))
       AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness'))`)
   .bind(id,orgId,route.fileId,permission,await sha256Hex(token),String(userId),now,expiresAt).run();
  if(Number(inserted.meta?.changes||0)!==1)return json({message:'File not found or sharing permission changed.'},404);
  const inviteUrl=new URL('/#/external-invite/'+token,env.APP_WEB_URL||url.origin).toString();
  return json({created:true,link:{id,permission,createdAt:now,expiresAt},token,inviteUrl},201);
 }
 if(request.method==='DELETE'&&route.linkId){
  const now=new Date().toISOString();
  const results=await db.batch([
   db.prepare("UPDATE hx_external_file_link_shares SET revoked_at=?1,revoked_by=?2 WHERE id=?3 AND org_id=?4 AND resource_id=?5 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=?4 AND f.id=?5 AND (f.created_by=?2 OR EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=f.org_id AND m.user_github_id=?2 AND lower(m.role) IN ('owner','admin'))) AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness') AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id))").bind(now,String(userId),route.linkId,orgId,route.fileId),
   db.prepare("UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2 WHERE id IN (SELECT grant_id FROM hx_external_file_link_redemptions WHERE link_id=?3) AND org_id=?4 AND resource_type='file' AND resource_id=?5 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM hx_external_file_link_shares l WHERE l.id=?3 AND l.org_id=?4 AND l.resource_id=?5 AND l.revoked_at=?1 AND l.revoked_by=?2)").bind(now,String(userId),route.linkId,orgId,route.fileId)
  ]);
  return json({revoked:Number(results?.[0]?.meta?.changes||0)>0});
 }
 return json({message:'Method not allowed.'},405);
}
const fileInviteId = () => 'xfi_' + crypto.randomUUID().replaceAll('-','');
async function handleFileInviteRoutes(request,env,url,{orgId,userId},route) {
 const db=env.DB;
 if(route.malformed||!route.fileId)return json({message:'File not found.'},404);
 if(await getMode(db,orgId)!=='harness')return json({message:'External File sharing is unavailable in Simple mode.'},404);
 const file=await fileRecord(db,orgId,route.fileId);
 if(!file||file.kind!=='content')return json({message:'File not found.'},404);
 const manage=await canManage(db,orgId,userId,file.created_by);
 if(request.method==='GET'&&!route.inviteId){
  if(!manage)return json({canManage:false,invites:[]});
  try{
   const {results=[]}=await db.prepare("SELECT id,invited_email AS invitedEmail,permission,access_expires_at AS accessExpiresAt,created_at AS createdAt,expires_at AS expiresAt,redeemed_at AS redeemedAt,revoked_at AS revokedAt FROM hx_external_file_invites_v2 WHERE org_id=?1 AND file_id=?2 ORDER BY created_at DESC LIMIT 100").bind(orgId,route.fileId).all();
   return json({canManage:true,invites:results});
  }catch{return json({message:'File invitations are not ready until the workspace migration completes.'},503)}
 }
 if(!manage)return json({message:'Only the file owner or a workspace admin can manage external access.'},403);
 if(request.method==='POST'&&!route.inviteId){
  const input=await request.json().catch(()=>null),email=typeof input?.email==='string'?input.email.trim().toLowerCase():'';
  const permission=input?.permission==='edit'?'edit':input?.permission==='view'?'view':null;
  if(!permission)return json({message:'Choose view or edit access.'},400);
  if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({message:'Enter a valid email address.'},400);
  // Email is globally unique for verified identities; scope is applied before any grant is written.
  const known=await db.prepare("SELECT u.github_id FROM users u WHERE lower(trim(coalesce(u.email,'')))=?1 AND u.email_verified_at IS NOT NULL").bind(email).first();
  if(known&&await db.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId,known.github_id).first())return json({message:'Workspace members should use their existing workspace access.'},409);
  let accessExpiresAt,inviteDays=Number(input?.inviteExpiresInDays??7);
  try{accessExpiresAt=expiry(input?.expiresInDays)}catch(error){return json({message:error.message},400)}
  if(![1,7,30].includes(inviteDays))return json({message:'Choose an invitation expiry of 1, 7, or 30 days.'},400);
  const createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+inviteDays*86400000).toISOString(),token=randomInviteToken(),id=fileInviteId();
  try{
   const inserted=await db.prepare("INSERT INTO hx_external_file_invites_v2(id,org_id,file_id,invited_email,permission,access_expires_at,token_hash,created_by,created_at,expires_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=?2 AND f.id=?3 AND f.current_version>0 AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content') AND f.created_by=?11) OR EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=?2 AND f.id=?3 AND f.current_version>0 AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content') AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?2 AND m.user_github_id=?11 AND lower(m.role) IN ('owner','admin')))").bind(id,orgId,route.fileId,email,permission,accessExpiresAt,await sha256Hex(token),String(userId),createdAt,expiresAt,String(userId)).run();
   if(inserted.meta?.changes!==1)return json({message:'File not found or sharing permission changed.'},404);
   const inviteUrl=new URL('/#/external-invite/'+token,env.APP_WEB_URL||url.origin).toString();
   const emailDelivery=await deliverExternalInvite(env,{id,to:email,resource:`the file “${file.path.split('/').at(-1)}”`,inviteUrl,expiresAt});
   return json({invite:{id,invitedEmail:email,permission,accessExpiresAt,createdAt,expiresAt,token,inviteUrl,emailDelivery,redeemedAt:null,revokedAt:null}},201);
  }catch(error){return json({message:error instanceof Error?error.message:'Could not create a File invitation.'},400)}
 }
 if(request.method==='PATCH'&&route.inviteId){
  const input=await request.json().catch(()=>null);
  const permission=input?.permission==='edit'?'edit':input?.permission==='view'?'view':null;
  if(!permission)return json({message:'Choose view or edit access.'},400);
  if(!input||!Object.hasOwn(input,'accessExpiresAt'))return json({message:'Choose an access expiry.'},400);
  let accessExpiresAt=null;
  if(input.accessExpiresAt!==null){
   const parsed=typeof input.accessExpiresAt==='string'?Date.parse(input.accessExpiresAt):NaN;
   if(!Number.isFinite(parsed)||parsed<=Date.now())return json({message:'Access expiry must be a future timestamp or no expiry.'},400);
   accessExpiresAt=new Date(parsed).toISOString();
  }
  const now=new Date().toISOString();
  const result=await db.prepare(`UPDATE hx_external_file_invites_v2
   SET permission=?1,access_expires_at=?2
   WHERE org_id=?3 AND file_id=?4 AND id=?5 AND redeemed_at IS NULL AND redemption_id IS NULL
     AND revoked_at IS NULL AND expires_at>?6
     AND NOT EXISTS(SELECT 1 FROM users recipient JOIN memberships recipientMember
       ON recipientMember.org_id=?3 AND recipientMember.user_github_id=recipient.github_id
       WHERE lower(trim(COALESCE(recipient.email,'')))=lower(trim(hx_external_file_invites_v2.invited_email)))
     AND EXISTS(SELECT 1 FROM hx_workspace_files f
       JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content'
       WHERE f.org_id=?3 AND f.id=?4 AND f.current_version>0
         AND (f.created_by=?7 OR EXISTS(SELECT 1 FROM memberships manager WHERE manager.org_id=f.org_id AND manager.user_github_id=?7 AND lower(manager.role) IN ('owner','admin')))
         AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
         AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
         AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
         AND NOT EXISTS(SELECT 1 FROM hx_room_access removed WHERE removed.org_id=f.org_id AND removed.channel=f.scope AND removed.deleted_at IS NOT NULL)
         AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))
         AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness'))`)
   .bind(permission,accessExpiresAt,orgId,route.fileId,route.inviteId,now,String(userId)).run();
  if(Number(result?.meta?.changes||0)!==1)return json({message:'An eligible unredeemed File invitation was not found.'},404);
  return json({updated:true,inviteId:route.inviteId,permission,accessExpiresAt});
 }
 if(request.method==='DELETE'&&route.inviteId){
  const at=new Date().toISOString();
  const results=await db.batch([
   db.prepare("UPDATE hx_external_file_invites_v2 SET revoked_at=?1,revoked_by=?2 WHERE org_id=?3 AND file_id=?4 AND id=?5 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=?3 AND f.id=?4 AND (f.created_by=?2 OR EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?3 AND m.user_github_id=?2 AND lower(m.role) IN ('owner','admin'))))").bind(at,String(userId),orgId,route.fileId,route.inviteId),
   db.prepare("UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2 WHERE org_id=?3 AND resource_type='file' AND resource_id=?4 AND id=(SELECT created_grant_id FROM hx_external_file_invites_v2 WHERE org_id=?3 AND file_id=?4 AND id=?5 AND revoked_at=?1)").bind(at,String(userId),orgId,route.fileId,route.inviteId),
  ]);
  return json({revoked:results[0]?.meta?.changes===1,inviteId:route.inviteId});
 }
 return json({message:'Method not allowed.'},405);
}

async function handleFileAudienceRoute(request,env,url,{orgId,userId},route) {
 const db=env.DB;
 if(route.malformed||!route.fileId)return json({message:'File not found.'},404);
 if(request.method!=='GET'&&request.method!=='PUT')return json({message:'Method not allowed.'},405);
 if(await getMode(db,orgId)!=='harness')return json({message:'External File sharing is unavailable in Simple mode.'},404);
 const file=await fileRecord(db,orgId,route.fileId);
 if(!file||file.kind!=='content')return json({message:'File not found.'},404);
 if(!await canManage(db,orgId,userId,file.created_by))return json({message:'Only the file owner or a workspace admin can manage external access.'},403);
 if(request.method==='GET')return json(await readResourceAudience(db,{orgId,resourceType:'file',resourceId:route.fileId,userId:String(userId)}));
 const input=await request.json().catch(()=>null);
 let audience;
 try{audience=cleanResourceAudienceInput(input)}catch(error){return json({message:error.message||'Invalid audience.'},400)}
 if(audience.type==='room'){
  const rooms=await listResourceAudienceRooms(db,orgId,String(userId));
  if(!rooms.some(room=>room.id===audience.roomId))return json({message:'Choose an accessible Room.'},400);
 }
 const updated=await writeResourceAudience(db,{
  orgId,resourceType:'file',resourceId:route.fileId,actorId:String(userId),audience,
  managerFence:first=>({
   sql:`EXISTS(SELECT 1 /* org_id scope */ FROM hx_workspace_files f
    WHERE f.org_id=?${first} AND f.id=?${first+1}
      AND (f.created_by=?${first+2} OR EXISTS(SELECT 1 /* org_id scope */ FROM memberships manager
        WHERE manager.org_id=f.org_id AND manager.user_github_id=?${first+2} AND lower(manager.role) IN ('owner','admin')))
      AND EXISTS(SELECT 1 /* org_id scope */ FROM hx_workspace_file_versions current
        WHERE current.org_id=f.org_id AND current.file_id=f.id AND current.version=f.current_version AND current.kind='content'
          AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM hx_workspace_file_purges purged
            WHERE purged.org_id=current.org_id AND purged.file_id=current.file_id AND purged.version=current.version))
      AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM workspace_deletions deletion WHERE deletion.org_id=f.org_id AND deletion.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM workspace_tombstones deleted WHERE deleted.org_id=f.org_id)
      AND COALESCE((SELECT mode FROM org_settings setting WHERE setting.org_id=f.org_id),'simple')='harness'
      AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM hx_room_access removed WHERE removed.org_id=f.org_id AND removed.channel=f.scope AND removed.deleted_at IS NOT NULL)
      AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 /* org_id scope */ FROM businesses business
        WHERE business.org_id=f.org_id AND 'b:'||business.slug=f.scope AND business.archived_at IS NULL))
      ${audience.type==='room'?`AND EXISTS(SELECT 1 /* org_id scope */ FROM businesses targetRoom
        JOIN users managerUser ON managerUser.github_id=?${first+2}
        WHERE targetRoom.org_id=f.org_id AND 'b:'||targetRoom.slug=?${first+3} AND targetRoom.archived_at IS NULL
          AND NOT EXISTS(SELECT 1 /* org_id scope */ FROM hx_room_access roomDeleted WHERE roomDeleted.org_id=targetRoom.org_id AND roomDeleted.channel=?${first+3} AND roomDeleted.deleted_at IS NOT NULL)
          AND (targetRoom.private=0 OR EXISTS(SELECT 1 /* org_id scope */ FROM conversation_members roomMember
            WHERE roomMember.org_id=targetRoom.org_id AND roomMember.channel=?${first+3} AND roomMember.login=managerUser.login)))`:''})`,
   bindings:[orgId,route.fileId,String(userId),...(audience.type==='room'?[audience.roomId]:[])],
  }),
 });
 if(!updated)return json({message:'Audience changed or access revoked. Reload and retry.'},409);
 return json(await readResourceAudience(db,{orgId,resourceType:'file',resourceId:route.fileId,userId:String(userId)}));
}
export async function redeemExternalFileInvite(env,{token,userId}) {
 const deny={error:'This File invitation is unavailable or expired.',status:404};
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/i.test(token))return deny;
 const tokenHash=await sha256Hex(token.toLowerCase());
 // User IDs are globally unique. Invitation lookup below uses the globally unique token hash.
 const user=await env.DB.prepare("SELECT email,email_verified_at FROM users WHERE github_id=?1").bind(String(userId)).first();
 if(!user?.email_verified_at)return {error:'Sign in with the verified email address that received this invitation.',status:403};
 const now=new Date().toISOString();
 // token_hash is globally unique and is the bearer capability; joining files remains org-scoped.
 const invite=await env.DB.prepare("SELECT i.*,f.created_by AS file_owner,f.current_version FROM hx_external_file_invites_v2 i JOIN hx_workspace_files f ON f.org_id=i.org_id AND f.id=i.file_id WHERE i.token_hash=?1 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?2 AND (i.access_expires_at IS NULL OR i.access_expires_at>?2) AND f.current_version>0 AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content') AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version) AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)").bind(tokenHash,now).first();
 if(!invite||String(user.email||'').trim().toLowerCase()!==String(invite.invited_email).trim().toLowerCase()||(await getMode(env.DB,invite.org_id))!=='harness')return deny;
 if(await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(invite.org_id,String(userId)).first())return {error:'Workspace members should use their existing workspace access.',status:409};
 const inviter=await canManage(env.DB,invite.org_id,invite.created_by,invite.file_owner);
 if(!inviter)return deny;
 const redemptionId=crypto.randomUUID(),grantId='xg_'+crypto.randomUUID().replaceAll('-','');
 const results=await env.DB.batch([
  env.DB.prepare("UPDATE hx_external_file_invites_v2 SET redemption_id=?1 WHERE id=?2 AND token_hash=?3 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?4 AND EXISTS(SELECT 1 FROM users u WHERE u.github_id=?5 AND u.email_verified_at IS NOT NULL AND lower(trim(coalesce(u.email,'')))=lower(trim(hx_external_file_invites_v2.invited_email)))").bind(redemptionId,invite.id,tokenHash,now,String(userId)),
  env.DB.prepare("INSERT INTO hx_external_resource_grants(id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at) SELECT ?1,i.org_id,'file',i.file_id,?2,i.permission,i.created_by,?3,i.access_expires_at FROM hx_external_file_invites_v2 i WHERE i.id=?4 AND i.redemption_id=?5 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=i.org_id AND m.user_github_id=?2)").bind(grantId,String(userId),now,invite.id,redemptionId),
  env.DB.prepare("UPDATE hx_external_file_invites_v2 SET redeemed_at=?1,redeemed_by=?2,created_grant_id=?3 WHERE id=?4 AND redemption_id=?5 AND redeemed_at IS NULL AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.id=?3 AND g.org_id=?6 AND g.resource_type='file' AND g.resource_id=?7 AND g.recipient_github_id=?2)").bind(now,String(userId),grantId,invite.id,redemptionId,invite.org_id,invite.file_id),
 ]);
 if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1||results[2]?.meta?.changes!==1){
  await env.DB.prepare("UPDATE hx_external_resource_grants SET revoked_at=?1,revoked_by=?2 WHERE id=?3 AND revoked_at IS NULL").bind(now,String(invite.created_by),grantId).run();
  await env.DB.prepare("UPDATE hx_external_file_invites_v2 SET redemption_id=NULL WHERE id=?1 AND redemption_id=?2 AND redeemed_at IS NULL").bind(invite.id,redemptionId).run();
  return deny;
 }
 return {redeemed:true,resourceType:'file',orgId:invite.org_id,fileId:invite.file_id,permission:invite.permission};
}

/** Redeem an authenticated reusable File link into an exact-resource grant. */
export async function redeemExternalFileLink(env,{token,userId}){
 const deny={error:'This share link is not valid, or has expired.',status:404};
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/i.test(token)||!userId)return deny;
 const tokenHash=await sha256Hex(token.toLowerCase()),now=new Date().toISOString();
 // The random token hash is globally unique and is the only lookup key available before its org is known.
 const link=await env.DB.prepare("SELECT l.* FROM hx_external_file_link_shares l WHERE l.token_hash=?1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?2)").bind(tokenHash,now).first();
 if(!link||(await getMode(env.DB,link.org_id))!=='harness')return deny;
 const file=await fileRecord(env.DB,link.org_id,link.resource_id);
 if(!file||file.kind!=='content')return deny;
 const creator=await canManage(env.DB,link.org_id,link.created_by,file.created_by);
 if(!creator)return deny;
 if(await env.DB.prepare('SELECT 1 FROM users WHERE github_id=?1').bind(String(userId)).first()===null)return deny;
 if(await env.DB.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(link.org_id,String(userId)).first())return deny;
 const previous=await env.DB.prepare("SELECT permission FROM hx_external_resource_grants WHERE org_id=?1 AND resource_type='file' AND resource_id=?2 AND recipient_github_id=?3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?4) ORDER BY granted_at DESC LIMIT 1").bind(link.org_id,link.resource_id,String(userId),now).first();
 if(previous)return {redeemed:true,orgId:link.org_id,resourceType:'file',resourceId:link.resource_id,fileId:link.resource_id,permission:previous.permission};
 const grantId='xg_'+crypto.randomUUID().replaceAll('-','');
 const writes=await env.DB.batch([
  env.DB.prepare(`INSERT OR IGNORE INTO hx_external_file_link_redemptions(link_id,recipient_github_id,redeemed_at)
   SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM hx_external_file_link_shares l WHERE l.id=?1 AND l.token_hash=?4 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?3))
    AND EXISTS(SELECT 1 FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content' WHERE f.org_id=?5 AND f.id=?6 AND f.current_version>0
     AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
     AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
     AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
     AND NOT EXISTS(SELECT 1 FROM hx_room_access r WHERE r.org_id=f.org_id AND r.channel=f.scope AND r.deleted_at IS NOT NULL)
     AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))
     AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness'))
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?5 AND m.user_github_id=?2)`)
   .bind(link.id,String(userId),now,tokenHash,link.org_id,link.resource_id),
  env.DB.prepare(`INSERT OR IGNORE INTO hx_external_resource_grants(id,org_id,resource_type,resource_id,recipient_github_id,permission,granted_by,granted_at,expires_at)
   SELECT ?1,l.org_id,'file',l.resource_id,?2,l.permission,l.created_by,?3,l.expires_at FROM hx_external_file_link_shares l
   JOIN hx_external_file_link_redemptions r ON r.link_id=l.id AND r.recipient_github_id=?2
   JOIN hx_workspace_files f ON f.org_id=l.org_id AND f.id=l.resource_id
   JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content'
   WHERE l.id=?4 AND r.grant_id IS NULL AND l.token_hash=?5 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?3)
    AND f.current_version>0 AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
    AND NOT EXISTS(SELECT 1 FROM hx_room_access x WHERE x.org_id=f.org_id AND x.channel=f.scope AND x.deleted_at IS NOT NULL)
    AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))
    AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness')
    AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=l.org_id AND m.user_github_id=?2)
    AND (l.created_by=f.created_by OR EXISTS(SELECT 1 FROM memberships manager WHERE manager.org_id=f.org_id AND manager.user_github_id=l.created_by AND lower(manager.role) IN ('owner','admin')))`)
   .bind(grantId,String(userId),now,link.id,tokenHash),
  env.DB.prepare("UPDATE hx_external_file_link_redemptions SET grant_id=?1 WHERE link_id=?2 AND recipient_github_id=?3 AND grant_id IS NULL AND EXISTS(SELECT 1 FROM hx_external_resource_grants g WHERE g.id=?1 AND g.org_id=?4 AND g.resource_type='file' AND g.resource_id=?5 AND g.recipient_github_id=?3)").bind(grantId,link.id,String(userId),link.org_id,link.resource_id)
 ]);
 if(Number(writes?.[1]?.meta?.changes||0)>0&&Number(writes?.[2]?.meta?.changes||0)>0)return {redeemed:true,orgId:link.org_id,resourceType:'file',resourceId:link.resource_id,fileId:link.resource_id,permission:link.permission};
 const concurrent=await env.DB.prepare("SELECT g.permission FROM hx_external_file_link_redemptions r JOIN hx_external_file_link_shares l ON l.id=r.link_id AND l.org_id=?4 AND l.resource_id=?5 JOIN hx_external_resource_grants g ON g.id=r.grant_id AND g.org_id=l.org_id AND g.resource_type='file' AND g.resource_id=l.resource_id WHERE r.link_id=?1 AND r.recipient_github_id=?2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?3)").bind(link.id,String(userId),now,link.org_id,link.resource_id).first();
 if(concurrent)return {redeemed:true,orgId:link.org_id,resourceType:'file',resourceId:link.resource_id,fileId:link.resource_id,permission:concurrent.permission};
 return deny;
}

/// A File grant as its managers see it: a handle, a name and, only when the
/// caller already knows it, an address.
async function publicGrant(db,scope,row,email){
  const label=outsiderLabel(row);
  return {id:row.id,recipientRef:await sealCollaboratorRef(db,scope,String(row.githubId)),recipientName:label.name,recipientLogin:label.login,recipientEmail:email||null,permission:row.permission,grantedAt:row.grantedAt,expiresAt:row.expiresAt??null,revokedAt:row.revokedAt??null,revokedBy:row.revokedBy??null};
}

export async function handleExternalFileGrantRoutes(request, env, url, { orgId, userId }) {
  const linkRoute=fileLinkRoute(url);
  if(linkRoute)return manageFileLinks(request,env,url,{orgId,userId},linkRoute);
  const audienceRoute=fileAudienceRoute(url);
  if(audienceRoute)return handleFileAudienceRoute(request,env,url,{orgId,userId},audienceRoute);
  const inviteRoute=fileInviteRoute(url);
  if(inviteRoute)return handleFileInviteRoutes(request,env,url,{orgId,userId},inviteRoute);
  const route=fileRoute(url);
  if(!route)return null;
  if(route.malformed||!route.fileId)return json({message:'File not found.'},404);
  const db=env.DB;
  if(await getMode(db,orgId)!=='harness')return json({message:'External File sharing is unavailable in Simple mode.'},404);
  const file=await fileRecord(db,orgId,route.fileId);
  if(!file||file.kind!=='content')return json({message:'File not found.'},404);
  const manage=await canManage(db,orgId,userId,file.created_by);
  const scope={orgId,resourceType:'file',resourceId:route.fileId};
  if(request.method==='GET'&&!route.recipientId){
    if(!manage)return json({canManage:false,grants:[]});
    // A grantee's account id and login can be their address, so the list
    // names them by handle, and shows an address only when they redeemed an
    // emailed invitation a manager typed it into (#956).
    const {results=[]}=await db.prepare("SELECT g.id,g.recipient_github_id AS githubId,u.login,u.name,(SELECT i.invited_email FROM hx_external_file_invites_v2 i WHERE i.org_id=g.org_id AND i.file_id=g.resource_id AND i.redeemed_by=g.recipient_github_id AND i.redeemed_at IS NOT NULL ORDER BY i.redeemed_at DESC LIMIT 1) AS invitedEmail,g.permission,g.granted_at AS grantedAt,g.expires_at AS expiresAt,g.revoked_at AS revokedAt,g.revoked_by AS revokedBy FROM hx_external_resource_grants g JOIN users u ON u.github_id=g.recipient_github_id WHERE g.org_id=?1 AND g.resource_type='file' AND g.resource_id=?2 ORDER BY g.granted_at DESC LIMIT 100")
      .bind(orgId,route.fileId).all();
    const grants=[];
    for(const row of results)grants.push(await publicGrant(db,scope,row,row.invitedEmail));
    return json({canManage:true,grants});
  }
  if(!manage)return json({message:'Only the file owner or a workspace admin can manage external access.'},403);
  if(request.method==='POST'&&!route.recipientId){
    const input=await request.json().catch(()=>null);
    const email=typeof input?.email==='string'?input.email.trim().toLowerCase():'';
    const permission=input?.permission==='edit'?'edit':input?.permission==='view'?'view':null;
    if(!permission)return json({message:'Choose view or edit access.'},400);
    let recipient;
    // Someone picked from the search arrives as the handle it gave out.
    const picked=typeof input?.recipientRef==='string';
    if(picked){
      const recipientId=await openCollaboratorRef(db,scope,input.recipientRef.trim());
      if(!recipientId||recipientId.length>200)return json({message:'No eligible signed-in Honmaru collaborator exists.'},404);
      try{recipient=await db.prepare('SELECT github_id AS githubId,login,name,email FROM users WHERE github_id=?1 AND email_verified_at IS NOT NULL LIMIT 1').bind(recipientId).first()}
      catch{return json({message:'Verified account sharing is not available until the workspace migration completes.'},503)}
    }else{
      if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({message:'Enter a valid email address.'},400);
      try{recipient=await db.prepare('SELECT github_id AS githubId,login,name,email FROM users WHERE lower(trim(email))=?1 AND email_verified_at IS NOT NULL LIMIT 1').bind(email).first()}
      catch{return json({message:'Verified email sharing is not available until the workspace migration completes.'},503)}
    }
    if(!recipient||String(recipient.githubId)===String(userId))return json({message:'No eligible signed-in Honmaru collaborator exists.'},404);
    const member=await db.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId,recipient.githubId).first();
    if(member)return json({message:'Workspace members should use their existing workspace access.'},409);
    let expiresAt;
    try{expiresAt=expiry(input?.expiresInDays)}catch(error){return json({message:error.message},400)}
    const at=new Date().toISOString();
    try{
      const grant=await grantExternalResource(db,{orgId,resourceType:'file',resourceId:route.fileId,recipientGithubId:String(recipient.githubId),grantedBy:String(userId),permission,expiresAt},at,{requireVerifiedExternalAccount:true});
      if(!grant)return json({message:'Workspace membership or account verification changed. Reload and retry.'},409);
      // The address goes back only to a caller who typed it.
      const response=json({grant:await publicGrant(db,scope,{id:grant.id,...recipient,permission,grantedAt:at,expiresAt,revokedAt:null,revokedBy:null},picked?null:email),redemptionPath:'/external/files/'+encodeURIComponent(orgId)+'/'+encodeURIComponent(route.fileId)},201);
      grantRecipients.set(response,String(recipient.githubId));
      return response;
    }catch(error){return json({message:error instanceof Error?error.message:'Could not grant file access.'},400)}
  }
  const recipientId=route.recipientId?await recipientFromParam(db,scope,route.recipientId):'';
  if(request.method==='PATCH'&&route.recipientId){
    const input=await request.json().catch(()=>null);
    const permission=input?.permission==='edit'?'edit':input?.permission==='view'?'view':null;
    if(!permission)return json({message:'Choose view or edit access.'},400);
    if(!input||!Object.hasOwn(input,'expiresAt'))return json({message:'Choose an access expiry.'},400);
    let expiresAt=null;
    if(input.expiresAt!==null){
      const parsed=typeof input.expiresAt==='string'?Date.parse(input.expiresAt):NaN;
      if(!Number.isFinite(parsed)||parsed<=Date.now())return json({message:'Access expiry must be a future timestamp or no expiry.'},400);
      expiresAt=new Date(parsed).toISOString();
    }
    const now=new Date().toISOString();
    const result=await db.prepare(`UPDATE hx_external_resource_grants
      SET permission=?1,expires_at=?2
      WHERE org_id=?3 AND resource_type='file' AND resource_id=?4 AND recipient_github_id=?5
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?6)
        AND EXISTS(SELECT 1 FROM users recipient WHERE recipient.github_id=?5 AND recipient.email_verified_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM memberships recipientMember WHERE recipientMember.org_id=?3 AND recipientMember.user_github_id=?5)
        AND EXISTS(SELECT 1 FROM hx_workspace_files f
          JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content'
          WHERE f.org_id=?3 AND f.id=?4 AND f.current_version>0
            AND (f.created_by=?7 OR EXISTS(SELECT 1 FROM memberships manager WHERE manager.org_id=f.org_id AND manager.user_github_id=?7 AND lower(manager.role) IN ('owner','admin')))
            AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=f.current_version)
            AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=f.org_id AND d.purge_started_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=f.org_id)
            AND NOT EXISTS(SELECT 1 FROM hx_room_access removed WHERE removed.org_id=f.org_id AND removed.channel=f.scope AND removed.deleted_at IS NOT NULL)
            AND (substr(f.scope,1,2)!='b:' OR EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=f.org_id AND 'b:'||b.slug=f.scope AND b.archived_at IS NULL))
            AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=f.org_id AND s.mode='harness'))`)
      .bind(permission,expiresAt,orgId,route.fileId,recipientId,now,String(userId)).run();
    if(Number(result?.meta?.changes||0)!==1)return json({message:'An active File collaborator was not found.'},404);
    const response=json({updated:true,recipientRef:route.recipientId,permission,expiresAt});
    grantRecipients.set(response,recipientId);
    return response;
  }
  if(request.method==='DELETE'&&route.recipientId){
    const changes=await revokeExternalResource(db,{orgId,resourceType:'file',resourceId:route.fileId,recipientGithubId:recipientId,revokedBy:String(userId)});
    return json({revoked:changes>0,recipientRef:route.recipientId});
  }
  return json({message:'Method not allowed.'},405);
}

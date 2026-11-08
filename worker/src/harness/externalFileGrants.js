import { grantExternalResource, revokeExternalResource } from './externalCollaborators.js';
import { allowed } from '../permissions.js';
import { getMode } from './mode.js';
import { sha256Hex } from '../auth.js';
import { deliverExternalInvite } from '../externalInviteMail.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const fileRoute = url => {
  const match = url.pathname.match(/^\/hx\/files\/([^/]+)\/external-grants(?:\/([^/]+))?$/);
  if (!match) return null;
  try { return { fileId: decodeURIComponent(match[1]), recipientId: match[2] ? decodeURIComponent(match[2]) : null }; }
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

export async function handleExternalFileGrantRoutes(request, env, url, { orgId, userId }) {
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
  if(request.method==='GET'&&!route.recipientId){
    if(!manage)return json({canManage:false,grants:[]});
    const {results=[]}=await db.prepare("SELECT g.id,g.recipient_github_id AS recipientGithubId,u.login AS recipientLogin,lower(u.email) AS recipientEmail,g.permission,g.granted_at AS grantedAt,g.expires_at AS expiresAt,g.revoked_at AS revokedAt,g.revoked_by AS revokedBy FROM hx_external_resource_grants g JOIN users u ON u.github_id=g.recipient_github_id WHERE g.org_id=?1 AND g.resource_type='file' AND g.resource_id=?2 ORDER BY g.granted_at DESC LIMIT 100")
      .bind(orgId,route.fileId).all();
    return json({canManage:true,grants:results});
  }
  if(!manage)return json({message:'Only the file owner or a workspace admin can manage external access.'},403);
  if(request.method==='POST'&&!route.recipientId){
    const input=await request.json().catch(()=>null);
    const email=typeof input?.email==='string'?input.email.trim().toLowerCase():'';
    const permission=input?.permission==='edit'?'edit':input?.permission==='view'?'view':null;
    if(!permission)return json({message:'Choose view or edit access.'},400);
    if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({message:'Enter a valid email address.'},400);
    let recipient;
    try{recipient=await db.prepare('SELECT github_id AS githubId,login,email FROM users WHERE lower(trim(email))=?1 AND email_verified_at IS NOT NULL LIMIT 1').bind(email).first()}
    catch{return json({message:'Verified email sharing is not available until the workspace migration completes.'},503)}
    if(!recipient)return json({message:'No signed-in Honmaru user with that verified email exists. No invitation was sent.'},404);
    const member=await db.prepare('SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(orgId,recipient.githubId).first();
    if(member)return json({message:'Workspace members should use their existing workspace access.'},409);
    let expiresAt;
    try{expiresAt=expiry(input?.expiresInDays)}catch(error){return json({message:error.message},400)}
    const at=new Date().toISOString();
    try{
      const grant=await grantExternalResource(db,{orgId,resourceType:'file',resourceId:route.fileId,recipientGithubId:String(recipient.githubId),grantedBy:String(userId),permission,expiresAt},at);
      return json({grant:{id:grant.id,recipientGithubId:String(recipient.githubId),recipientLogin:recipient.login,recipientEmail:recipient.email,permission,grantedAt:at,expiresAt,revokedAt:null},redemptionPath:'/external/files/'+encodeURIComponent(orgId)+'/'+encodeURIComponent(route.fileId)},201);
    }catch(error){return json({message:error instanceof Error?error.message:'Could not grant file access.'},400)}
  }
  if(request.method==='DELETE'&&route.recipientId){
    const changes=await revokeExternalResource(db,{orgId,resourceType:'file',resourceId:route.fileId,recipientGithubId:route.recipientId,revokedBy:String(userId)});
    return json({revoked:changes>0,recipientGithubId:route.recipientId});
  }
  return json({message:'Method not allowed.'},405);
}

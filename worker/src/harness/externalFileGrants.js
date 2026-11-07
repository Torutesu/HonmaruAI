import { grantExternalResource, revokeExternalResource } from './externalCollaborators.js';
import { allowed } from '../permissions.js';
import { getMode } from './mode.js';

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
export async function handleExternalFileGrantRoutes(request, env, url, { orgId, userId }) {
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
      const grant=await grantExternalResource(db,{orgId,resourceType:'file',resourceId:route.fileId,recipientGithubId:String(recipient.githubId),grantedBy:String(userId),permission:'view',expiresAt},at);
      return json({grant:{id:grant.id,recipientGithubId:String(recipient.githubId),recipientLogin:recipient.login,recipientEmail:recipient.email,permission:'view',grantedAt:at,expiresAt,revokedAt:null},redemptionPath:'/external/files/'+encodeURIComponent(orgId)+'/'+encodeURIComponent(route.fileId)},201);
    }catch(error){return json({message:error instanceof Error?error.message:'Could not grant file access.'},400)}
  }
  if(request.method==='DELETE'&&route.recipientId){
    const changes=await revokeExternalResource(db,{orgId,resourceType:'file',resourceId:route.fileId,recipientGithubId:route.recipientId,revokedBy:String(userId)});
    return json({revoked:changes>0,recipientGithubId:route.recipientId});
  }
  return json({message:'Method not allowed.'},405);
}
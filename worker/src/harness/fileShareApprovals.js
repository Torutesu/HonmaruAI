import {createHash,randomBytes} from 'node:crypto';
import {readFileVersionContent} from './fileVersionLedger.js';
import {fileDeleteAuthority} from './fileAuthority.js';

const id=prefix=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`;
const iso=()=>new Date().toISOString();
const token=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('hex');
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
export const FILE_SHARE_EXPIRY_CHOICES=[86400,604800,2592000];

export function normalizedShareExpiry(seconds,now=Date.now()){
 if(!FILE_SHARE_EXPIRY_CHOICES.includes(seconds))throw new TypeError('Choose an expiry of 1, 7, or 30 days.');
 return new Date(now+seconds*1000).toISOString();
}

// The request contains metadata for one immutable version. No bearer token is
// generated or stored while it is awaiting a human decision.
export async function proposePublicFileShare(env,{orgId,fileId,version,userId,login,requestKey,expiresIn=604800,allowDownload=false}){
 if(!validId(orgId)||!validId(fileId)||!validId(userId)||!validId(login)||!/^[-A-Za-z0-9_]{16,100}$/.test(requestKey||''))return {error:'Invalid public share request.',status:400};
 let expiresAt;try{expiresAt=normalizedShareExpiry(expiresIn)}catch(error){return {error:error.message,status:400}}
 const source=await readFileVersionContent(env.DB,{orgId,fileId,userId:String(userId),version});
 if(!source)return {error:'File version is unavailable.',status:404};
 const current=await env.DB.prepare(`SELECT f.scope,f.current_version,v.content_hash,v.content_type,v.size
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=?3
  WHERE f.org_id=?1 AND f.id=?2 AND v.kind='content'`).bind(orgId,fileId,version).first();
 if(!current||current.current_version!==version||current.content_hash!==source.contentHash)return {error:'Only the current unchanged file version can be proposed.',status:409};
 const requestId=id('fshare_req'),createdAt=iso();
 const result=await env.DB.prepare(`INSERT OR IGNORE INTO hx_file_share_requests
  (org_id,id,file_id,file_scope,file_version,content_hash,content_type,size,requester_id,requester_login,request_key,expires_at,allow_download,status,created_at)
  SELECT ?1,?2,f.id,f.scope,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=?4
  WHERE f.org_id=?1 AND f.id=?3 AND f.current_version=?4 AND v.kind='content' AND v.content_hash=?5
    AND ${/* trusted SQL fragment */'1=1'}
    AND EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.org_id=?1 AND m.user_github_id=u.github_id
      WHERE u.github_id=?8 AND u.login=?9 AND lower(coalesce(m.role,'guest'))!='guest')
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=?4)`)
  .bind(orgId,requestId,fileId,version,source.contentHash,source.contentType,source.size,String(userId),login,requestKey,expiresAt,allowDownload?1:0,createdAt).run();
 if(result.meta.changes!==1){
  const replay=await env.DB.prepare('SELECT id,status FROM hx_file_share_requests WHERE org_id=? AND requester_id=? AND request_key=?').bind(orgId,String(userId),requestKey).first();
  return replay?{requestId:replay.id,status:replay.status,created:false}:{error:'File changed or access was revoked. Reload before requesting approval.',status:409};
 }
 await env.DB.prepare(`INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at)
  VALUES(?1,?2,NULL,?3,'proposed',?4,?5)`).bind(orgId,requestId,String(userId),JSON.stringify({fileId,version,contentHash:source.contentHash,expiresAt,allowDownload:Boolean(allowDownload)}),createdAt).run();
 return {requestId,status:'pending',fileId,version,contentHash:source.contentHash,expiresAt,allowDownload:Boolean(allowDownload),created:true};
}

export async function listPublicFileShareRequests(db,{orgId,fileId,userId}){
 const {results=[]}=await db.prepare(`SELECT r.id,r.file_id AS fileId,r.file_version AS version,r.content_hash AS contentHash,
   r.expires_at AS expiresAt,r.allow_download AS allowDownload,r.status,r.created_at AS createdAt,
   r.requester_login AS requesterLogin,r.decision_at AS decisionAt,s.id AS shareId,s.revoked_at AS revokedAt
  FROM hx_file_share_requests r LEFT JOIN hx_public_file_shares s ON s.org_id=r.org_id AND s.request_id=r.id
  WHERE r.org_id=?1 AND (?2 IS NULL OR r.file_id=?2)
    AND EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=r.org_id AND f.id=r.file_id
      AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')})
  ORDER BY r.created_at DESC LIMIT 100`).bind(orgId,fileId||null,String(userId)).all();
 return results.map(row=>({...row,allowDownload:Boolean(row.allowDownload)}));
}

// Owner/room-admin/workspace-admin approval creates a one-time bearer token.
// Approval is fenced by the still-current version and exact content checksum.
export async function approvePublicFileShare(env,{orgId,requestId,userId,login}){
 if(!validId(orgId)||!validId(requestId)||!validId(userId)||!validId(login))return {error:'Invalid approval.',status:400};
 const request=await env.DB.prepare(`SELECT r.*,f.current_version,f.created_by,f.scope AS current_scope,v.content_hash AS current_hash
  FROM hx_file_share_requests r JOIN hx_workspace_files f ON f.org_id=r.org_id AND f.id=r.file_id
  JOIN hx_workspace_file_versions v ON v.org_id=r.org_id AND v.file_id=r.file_id AND v.version=r.file_version AND v.kind='content'
  WHERE r.org_id=?1 AND r.id=?2 AND r.status='pending' AND r.expires_at>?3`).bind(orgId,requestId,iso()).first();
 if(!request)return {error:'Pending share request is unavailable.',status:404};
 if(request.current_version!==request.file_version||request.content_hash!==request.current_hash||request.file_scope!==request.current_scope){
  await env.DB.prepare(`UPDATE hx_file_share_requests SET status='stale',decision_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(orgId,requestId,iso()).run();
  return {error:'File changed after the proposal. A fresh approval is required.',status:409};
 }
 const permitted=await env.DB.prepare(`SELECT 1 AS ok WHERE ${fileDeleteAuthority('?1','?2','?3','?4')}`)
  .bind(orgId,request.created_by,String(userId),request.current_scope).first();
 if(!permitted)return {error:'Only the file owner or a current room/workspace administrator can approve this share.',status:403};
 const raw=token(),shareId=id('fshare'),at=iso();
 const results=await env.DB.batch([
  env.DB.prepare(`INSERT INTO hx_public_file_shares(org_id,id,request_id,file_id,file_scope,file_version,content_hash,token_hash,expires_at,allow_download,created_by,created_login,created_at)
   SELECT ?1,?2,?3,r.file_id,r.file_scope,r.file_version,r.content_hash,?4,r.expires_at,r.allow_download,?5,?6,?7
   FROM hx_file_share_requests r JOIN hx_workspace_files f ON f.org_id=r.org_id AND f.id=r.file_id
   WHERE r.org_id=?1 AND r.id=?3 AND r.status='pending' AND r.expires_at>?7
    AND f.current_version=r.file_version AND f.scope=r.file_scope
    AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=r.org_id AND v.file_id=r.file_id
      AND v.version=r.file_version AND v.content_hash=r.content_hash AND v.kind='content')
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=r.org_id AND p.file_id=r.file_id AND p.version=r.file_version)
    AND ${fileDeleteAuthority('f.org_id','f.created_by','?5','f.scope')}`)
    .bind(orgId,shareId,requestId,digest(raw),String(userId),login,at),
  env.DB.prepare(`UPDATE hx_file_share_requests SET status='approved',approver_id=?3,approver_login=?4,decision_at=?5
   WHERE org_id=?1 AND id=?2 AND status='pending' AND EXISTS(SELECT 1 FROM hx_public_file_shares s WHERE s.org_id=?1 AND s.request_id=?2 AND s.id=?6)`)
    .bind(orgId,requestId,String(userId),login,at,shareId),
  env.DB.prepare(`INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at)
   SELECT ?1,?2,?3,?4,'approved',?5,?6 WHERE EXISTS(SELECT 1 FROM hx_file_share_requests WHERE org_id=?1 AND id=?2 AND status='approved')`)
    .bind(orgId,requestId,shareId,String(userId),JSON.stringify({version:request.file_version,contentHash:request.content_hash,expiresAt:request.expires_at,allowDownload:Boolean(request.allow_download)}),at),
 ]);
 if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1){
  // Batch rollback semantics prevent orphan links; if state changed concurrently, no token is returned.
  return {error:'Request or file changed during approval. Review the current version and try again.',status:409};
 }
 return {shareId,url:`/hx/public-file-shares/${raw}`,expiresAt:request.expires_at,allowDownload:Boolean(request.allow_download)};
}

export async function revokePublicFileShare(env,{orgId,shareId,userId,login}){
 const row=await env.DB.prepare(`SELECT s.*,f.created_by AS file_creator,f.scope AS current_scope
  FROM hx_public_file_shares s JOIN hx_workspace_files f ON f.org_id=s.org_id AND f.id=s.file_id
  WHERE s.org_id=?1 AND s.id=?2 AND s.revoked_at IS NULL`).bind(orgId,shareId).first();
 if(!row)return {error:'Share is unavailable.',status:404};
 const permission=await env.DB.prepare(`SELECT 1 AS ok WHERE ${fileDeleteAuthority('?1','?2','?3','?4')}`)
  .bind(orgId,row.file_creator,String(userId),row.current_scope).first();
 if(!permission)return {error:'You cannot revoke this share.',status:403};
 const at=iso();
 const result=await env.DB.prepare(`UPDATE hx_public_file_shares SET revoked_at=?4,revoked_by=?3
  WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM hx_workspace_files f
   WHERE f.org_id=hx_public_file_shares.org_id AND f.id=hx_public_file_shares.file_id
    AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')})`)
  .bind(orgId,shareId,String(userId),at).run();
 if(result.meta.changes!==1)return {error:'Share was already revoked or access changed.',status:409};
 await env.DB.prepare(`INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at)
  VALUES(?1,?2,?3,?4,'revoked','{}',?5)`).bind(orgId,row.request_id,shareId,String(userId),at).run();
 return {shareId,revokedAt:at};
}

export async function servePublicFileShare(request,env,tokenValue){
 const json=(status=404)=>new Response('Not found.',{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 if(request.method!=='GET'||typeof tokenValue!=='string'||!/^[A-Za-z0-9_-]{40,60}$/.test(tokenValue))return json();
 const hash=digest(tokenValue),now=iso();
 const row=await env.DB.prepare(`SELECT s.file_id,s.file_version,s.content_hash,s.allow_download,s.expires_at,v.object_key,v.content_type,v.size
  FROM hx_public_file_shares s JOIN hx_workspace_files f ON f.org_id=s.org_id AND f.id=s.file_id
  JOIN hx_workspace_file_versions v ON v.org_id=s.org_id AND v.file_id=s.file_id AND v.version=s.file_version
  WHERE s.token_hash=?1 AND s.revoked_at IS NULL AND s.expires_at>?2
   AND v.kind='content' AND v.content_hash=s.content_hash
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=s.org_id AND p.file_id=s.file_id AND p.version=s.file_version)
   AND f.current_version=s.file_version
  LIMIT 1`).bind(hash,now).first();
 if(!row)return json();
 const object=await env.MEDIA.get(row.object_key);if(!object)return json();
 if(object.size!==row.size||row.size>25*1024*1024){await object.body.cancel().catch(()=>{});return json();}
 const bytes=await object.arrayBuffer();
 if(bytes.byteLength!==row.size||digest(new Uint8Array(bytes))!==row.content_hash)return json(410);
 const disposition=row.allow_download?'attachment':'inline';
 return new Response(bytes,{headers:{'content-type':row.content_type,'content-length':String(row.size),
  'content-disposition':`${disposition}; filename="shared-file-v${row.file_version}"`,
  'cache-control':'no-store, no-cache, must-revalidate','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; sandbox",
  'x-robots-tag':'noindex, nofollow'}});
}

export async function handleFileShareRoutes(request,env,url,{orgId,userId,login}){
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
 const parts=url.pathname.split('/').filter(Boolean);
 try{
  if(request.method==='GET'&&parts.length===3&&parts[2]==='share-requests'){
   const requests=await listPublicFileShareRequests(env.DB,{orgId,fileId:url.searchParams.get('fileId'),userId});
   return json({requests});
  }
  if(request.method==='POST'&&parts.length===4&&parts[2]==='share-requests'&&parts[3]==='approve'){
   const body=await request.json().catch(()=>null);
   const result=await approvePublicFileShare(env,{orgId,requestId:body?.requestId,userId,login});
   return json(result,result.error?result.status||400:200);
  }
  if(request.method==='POST'&&parts.length===5&&parts[2]==='shares'&&parts[4]==='revoke'){
   const result=await revokePublicFileShare(env,{orgId,shareId:decodeURIComponent(parts[3]),userId,login});
   return json(result,result.error?result.status||400:200);
  }
  if(request.method==='POST'&&parts.length===4&&parts[1]==='files'&&parts[3]==='share-requests'){
   const fileId=decodeURIComponent(parts[3]),body=await request.json().catch(()=>null);
   const result=await proposePublicFileShare(env,{orgId,fileId,version:body?.version,userId,login,
    requestKey:body?.requestKey,expiresIn:body?.expiresIn,allowDownload:body?.allowDownload===true});
   return json(result,result.error?result.status||400:201);
  }
 }catch(error){if(error instanceof URIError)return json({error:'Invalid identifier.'},400);throw error;}
 return null;
}

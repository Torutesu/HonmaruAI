import {createHash,randomBytes} from 'node:crypto';
import {readFileVersionContent} from './fileVersionLedger.js';
import {fileDeleteAuthority,fileScopeAuthority} from './fileAuthority.js';
import {getMode} from './mode.js';

const id=prefix=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`;
const iso=()=>new Date().toISOString();
const token=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('hex');
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
import {roomRoleState} from './roomRoles.js';

async function agentProposalSource(db,{orgId,userId,sourceAgentId,sourceMessageId,sourceScope,sourceSessionToken=null,expectedSessionCreatedAt=null,expectedMembership=null,expectedTurnHash=null}){
 try{
  if(!validId(String(orgId))||!validId(String(userId))||!validId(String(sourceAgentId))||!validId(String(sourceMessageId))||!validId(String(sourceScope)))return null;
  const now=iso();
  const user=await db.prepare('SELECT login FROM users WHERE github_id=?1').bind(String(userId)).first();
  const membership=await db.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(COALESCE(role,'guest'))!='guest'").bind(orgId,String(userId)).first();
  if(!user?.login||!membership)return null;
  let session;
  if(sourceSessionToken){
   session=await db.prepare('SELECT created_at FROM sessions WHERE token=?1 AND github_id=?2 AND (expires_at IS NULL OR expires_at>?3)').bind(sourceSessionToken,String(userId),now).first();
  }else if(expectedSessionCreatedAt){
   session=await db.prepare('SELECT created_at FROM sessions WHERE github_id=?1 AND created_at=?2 AND (expires_at IS NULL OR expires_at>?3) LIMIT 1').bind(String(userId),expectedSessionCreatedAt,now).first();
  }
  if(!session?.created_at||(expectedSessionCreatedAt&&session.created_at!==expectedSessionCreatedAt))return null;
  const message=await db.prepare("SELECT id,channel,author_login,kind,body,created_at,content_version,deleted_at FROM channel_messages WHERE org_id=?1 AND id=?2").bind(orgId,String(sourceMessageId)).first();
  if(!message||message.deleted_at||message.kind!=='message'||message.channel!==sourceScope||message.author_login!==user.login)return null;
  const agent=await db.prepare('SELECT id,owner_login,scope,created_at FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL').bind(orgId,String(sourceAgentId)).first();
  if(!agent)return null;
  let roomMembershipAt='',assignmentAt='';
  if(sourceScope.startsWith('ag:')){
   if(sourceScope!==`ag:${agent.id}|${user.login}`||agent.owner_login!==user.login||agent.scope!=='personal')return null;
  }else if(sourceScope.startsWith('b:')||sourceScope.startsWith('g:')){
   const roomMember=await db.prepare('SELECT added_at FROM conversation_members WHERE org_id=?1 AND channel=?2 AND login=?3').bind(orgId,sourceScope,user.login).first();
   const assignment=await db.prepare('SELECT added_at FROM channel_agents WHERE org_id=?1 AND channel=?2 AND agent_id=?3').bind(orgId,sourceScope,agent.id).first();
   if(!roomMember||!assignment)return null;
   if(sourceScope.startsWith('b:')){
    const state=await roomRoleState(db,orgId,sourceScope);
    if(!state?.managed||!state.members.some(item=>item.kind==='person'&&String(item.id)===String(userId))||!state.members.some(item=>item.kind==='agent'&&String(item.id)===String(agent.id)))return null;
   }
   roomMembershipAt=roomMember.added_at;
   assignmentAt=assignment.added_at;
  }else return null;
  const requesterMembership=`${membership.created_at}/${roomMembershipAt}`;
  const binding={orgId:String(orgId),userId:String(userId),login:user.login,agentId:String(agent.id),agentCreatedAt:agent.created_at,
   messageId:String(message.id),scope:String(message.channel),authorLogin:String(message.author_login),kind:String(message.kind),
   body:String(message.body),messageCreatedAt:String(message.created_at),contentVersion:Number(message.content_version||0),
   sessionCreatedAt:String(session.created_at),workspaceMembershipAt:String(membership.created_at),
   roomMembershipAt:String(roomMembershipAt),assignmentAt:String(assignmentAt)};
  const sourceTurnHash=digest(JSON.stringify(binding));
  if(expectedMembership&&requesterMembership!==expectedMembership)return null;
  if(expectedTurnHash&&sourceTurnHash!==expectedTurnHash)return null;
  return {...binding,requesterMembership,sourceTurnHash,messageBody:String(message.body),roomMembershipAt,assignmentAt};
 }catch{return null;}
}

function safeDownloadFilename(path){
 const basename=String(path||'').split(/[\\/]/).filter(Boolean).at(-1)||'shared-file';
 const value=basename.normalize('NFC').replace(/[\u0000-\u001f\u007f"\\/]/g,'_').replace(/^\.+$/,'file').slice(0,180).trim()||'shared-file';
 const fallback=value.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_')||'shared-file';
 const encoded=encodeURIComponent(value).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
 return {fallback,encoded};
}

export const FILE_SHARE_EXPIRY_CHOICES=[86400,604800,2592000];

export function normalizedShareExpiry(seconds,now=Date.now()){
 if(!FILE_SHARE_EXPIRY_CHOICES.includes(seconds))throw new TypeError('Choose an expiry of 1, 7, or 30 days.');
 return new Date(now+seconds*1000).toISOString();
}

// The request contains metadata for one immutable version. No bearer token is
// generated or stored while it is awaiting a human decision.
export async function proposePublicFileShare(env,{orgId,fileId,version,userId,login,requestKey,expiresIn=604800,allowDownload=false,sourceAgentId=null,sourceMessageId=null,sourceScope=null,sourceSessionToken=null}){
 if(!validId(orgId)||!validId(fileId)||!validId(userId)||!validId(login)||!/^[-A-Za-z0-9_]{16,100}$/.test(requestKey||''))return {error:'Invalid public share request.',status:400};
 let expiresAt;try{expiresAt=normalizedShareExpiry(expiresIn)}catch(error){return {error:error.message,status:400}}
 const source=await readFileVersionContent(env.DB,{orgId,fileId,userId:String(userId),version});
 if(!source)return {error:'File version is unavailable.',status:404};
 const current=await env.DB.prepare(`SELECT f.scope,f.current_version,v.content_hash,v.content_type,v.size
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=?3
  WHERE f.org_id=?1 AND f.id=?2 AND v.kind='content'`).bind(orgId,fileId,version).first();
 if(!current||current.current_version!==version||current.content_hash!==source.contentHash)return {error:'Only the current unchanged file version can be proposed.',status:409};
 let sourceBinding=null;
 if(sourceAgentId){
  sourceBinding=await agentProposalSource(env.DB,{orgId,userId,sourceAgentId,sourceMessageId,sourceScope,sourceSessionToken});
  if(!sourceBinding)return {error:'The Agent source turn, session, membership, or assignment is no longer valid.',status:409};
 }
 const pending=await env.DB.prepare(`SELECT id,status,expires_at AS expiresAt,allow_download AS allowDownload FROM hx_file_share_requests
  WHERE org_id=?1 AND file_id=?2 AND file_version=?3 AND requester_id=?4 AND status='pending' AND content_hash=?5 AND file_scope=?6 AND (?7 IS NULL OR source_turn_hash=?7)
  ORDER BY created_at DESC LIMIT 1`).bind(orgId,fileId,version,String(userId),source.contentHash,current.scope,sourceBinding?.sourceTurnHash||null).first();
 if(pending)return {requestId:pending.id,status:pending.status,fileId,version,contentHash:source.contentHash,expiresAt:pending.expiresAt,allowDownload:Boolean(pending.allowDownload),created:false};
 const requestId=id('fshare_req'),createdAt=iso();
 const result=await env.DB.prepare(`INSERT OR IGNORE INTO hx_file_share_requests
  (org_id,id,file_id,file_scope,file_version,content_hash,content_type,size,requester_id,requester_login,request_key,expires_at,allow_download,status,created_at,requester_membership,source_agent_id,source_message_id,source_scope,source_turn_hash,source_session_created_at)
  SELECT ?1,?2,f.id,f.scope,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13,?14,?15,?16,?17,?18,?19
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=?4
  WHERE f.org_id=?1 AND f.id=?3 AND f.current_version=?4 AND v.kind='content' AND v.content_hash=?5
    AND ${fileScopeAuthority('f.org_id','f.scope','?8')}
    AND EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.org_id=?1 AND m.user_github_id=u.github_id
      WHERE u.github_id=?8 AND u.login=?9 AND lower(coalesce(m.role,'guest'))!='guest')
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=f.org_id AND p.file_id=f.id AND p.version=?4)`)
  .bind(orgId,requestId,fileId,version,source.contentHash,source.contentType,source.size,String(userId),login,requestKey,expiresAt,allowDownload?1:0,createdAt,sourceBinding?.requesterMembership||null,sourceBinding?.agentId||null,sourceBinding?.messageId||null,sourceBinding?.scope||null,sourceBinding?.sourceTurnHash||null,sourceBinding?.sessionCreatedAt||null).run();
 if(result.meta.changes!==1){
  const replay=await env.DB.prepare('SELECT id,status FROM hx_file_share_requests WHERE org_id=? AND requester_id=? AND request_key=?').bind(orgId,String(userId),requestKey).first();
  return replay?{requestId:replay.id,status:replay.status,created:false}:{error:'File changed or access was revoked. Reload before requesting approval.',status:409};
 }
 await env.DB.prepare(`INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at)
  VALUES(?1,?2,NULL,?3,'proposed',?4,?5)`).bind(orgId,requestId,String(userId),JSON.stringify({fileId,version,contentHash:source.contentHash,expiresAt,allowDownload:Boolean(allowDownload)}),createdAt).run();
 return {requestId,status:'pending',fileId,version,contentHash:source.contentHash,expiresAt,allowDownload:Boolean(allowDownload),created:true};
}

export async function listPublicFileShareRequests(db,{orgId,fileId,userId}){
 const {results=[]}=await db.prepare(`SELECT r.id,r.file_id AS fileId,f.path AS filePath,r.file_scope AS scope,
   r.file_version AS version,f.current_version AS currentVersion,r.content_hash AS contentHash,r.content_type AS contentType,r.size,
   r.expires_at AS expiresAt,r.allow_download AS allowDownload,r.status,r.created_at AS createdAt,
   r.requester_login AS requesterLogin,r.decision_at AS decisionAt,s.id AS shareId,s.revoked_at AS revokedAt,s.revoked_by AS revokedBy
  FROM hx_file_share_requests r JOIN hx_workspace_files f ON f.org_id=r.org_id AND f.id=r.file_id
  LEFT JOIN hx_public_file_shares s ON s.org_id=r.org_id AND s.request_id=r.id
  WHERE r.org_id=?1 AND (?2 IS NULL OR r.file_id=?2)
    AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')}
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
  const staleAt=iso();
  await env.DB.batch([
   env.DB.prepare(`UPDATE hx_file_share_requests SET status='stale',decision_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(orgId,requestId,staleAt),
   env.DB.prepare(`INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at)
    SELECT ?1,?2,NULL,?4,'stale',?5,?3 WHERE EXISTS(SELECT 1 FROM hx_file_share_requests WHERE org_id=?1 AND id=?2 AND status='stale' AND decision_at=?3)`)
    .bind(orgId,requestId,staleAt,String(userId),JSON.stringify({expectedVersion:request.file_version,currentVersion:request.current_version,expectedHash:request.content_hash,currentHash:request.current_hash}))
  ]);
  return {error:'File changed after the proposal. A fresh approval is required.',status:409};
 }
 const permitted=await env.DB.prepare(`SELECT 1 AS ok WHERE ${fileDeleteAuthority('?1','?2','?3','?4')}`)
  .bind(orgId,request.created_by,String(userId),request.current_scope).first();
 if(!permitted)return {error:'Only the file owner or a current room/workspace administrator can approve this share.',status:403};

 let boundSource=null;
 if(request.source_agent_id){
  boundSource=await agentProposalSource(env.DB,{orgId,userId:String(request.requester_id),sourceAgentId:String(request.source_agent_id),
   sourceMessageId:String(request.source_message_id),sourceScope:String(request.source_scope),
   expectedSessionCreatedAt:String(request.source_session_created_at),expectedMembership:String(request.requester_membership),
   expectedTurnHash:String(request.source_turn_hash)});
  if(!boundSource){
   const staleAt=iso();
   await env.DB.batch([
    env.DB.prepare("UPDATE hx_file_share_requests SET status='stale',decision_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending'").bind(orgId,requestId,staleAt),
    env.DB.prepare("INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at) SELECT ?1,?2,NULL,?4,'stale',?5,?3 WHERE EXISTS(SELECT 1 FROM hx_file_share_requests WHERE org_id=?1 AND id=?2 AND status='stale' AND decision_at=?3)")
     .bind(orgId,requestId,staleAt,String(userId),JSON.stringify({reason:'agent_source_changed'}))
   ]);
   return {error:'The Agent source turn, session, membership, or assignment changed after the proposal.',status:409};
  }
 }
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
    AND (?8 IS NULL OR (
      r.source_agent_id=?8 AND r.source_message_id=?9 AND r.source_scope=?10 AND r.source_turn_hash=?11
      AND r.source_session_created_at=?12 AND r.requester_membership=?13
      AND EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=r.org_id AND m.id=r.source_message_id
        AND m.channel=r.source_scope AND m.author_login=?17 AND m.kind='message' AND m.deleted_at IS NULL
        AND m.body=?14 AND m.created_at=?15 AND m.content_version=?16)
      AND EXISTS(SELECT 1 FROM sessions ss WHERE ss.github_id=r.requester_id AND ss.created_at=?12
        AND (ss.expires_at IS NULL OR ss.expires_at>?7))
      AND EXISTS(SELECT 1 FROM memberships wm WHERE wm.org_id=r.org_id AND wm.user_github_id=r.requester_id
        AND wm.created_at=?18 AND LOWER(COALESCE(wm.role,'guest'))!='guest')
      AND EXISTS(SELECT 1 FROM custom_agents a WHERE a.org_id=r.org_id AND a.id=r.source_agent_id
        AND a.created_at=?21 AND a.deleted_at IS NULL AND (
          (r.source_scope='ag:'||a.id||'|'||?17 AND a.owner_login=?17 AND a.scope='personal')
          OR EXISTS(SELECT 1 FROM channel_agents ca WHERE ca.org_id=r.org_id AND ca.channel=r.source_scope
            AND ca.agent_id=a.id AND ca.added_at=?20)))
      AND (?19='' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.org_id=r.org_id
        AND cm.channel=r.source_scope AND cm.login=?17 AND cm.added_at=?19))
      AND (substr(r.source_scope,1,2)!='b:' OR EXISTS(
        SELECT 1 FROM businesses b JOIN hx_room_access ra ON ra.org_id=b.org_id AND ra.channel=r.source_scope
        WHERE b.org_id=r.org_id AND 'b:'||b.slug=r.source_scope AND b.archived_at IS NULL AND ra.deleted_at IS NULL))
    ))
    AND ${fileDeleteAuthority('f.org_id','f.created_by','?5','f.scope')}`)
    .bind(orgId,shareId,requestId,digest(raw),String(userId),login,at,boundSource?.agentId||null,boundSource?.messageId||null,boundSource?.scope||null,boundSource?.sourceTurnHash||null,boundSource?.sessionCreatedAt||null,boundSource?.requesterMembership||null,boundSource?.messageBody||null,boundSource?.messageCreatedAt||null,boundSource?.contentVersion??null,boundSource?.login||null,boundSource?.workspaceMembershipAt||null,boundSource?.roomMembershipAt||'',boundSource?.assignmentAt||'',boundSource?.agentCreatedAt||null),
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

export async function declinePublicFileShare(env,{orgId,requestId,userId,login}){
 if(!validId(orgId)||!validId(requestId)||!validId(userId)||!validId(login))return {error:'Invalid decline.',status:400};
 const request=await env.DB.prepare(`SELECT r.id,f.created_by,f.scope
  FROM hx_file_share_requests r JOIN hx_workspace_files f ON f.org_id=r.org_id AND f.id=r.file_id
  WHERE r.org_id=?1 AND r.id=?2 AND r.status='pending'`).bind(orgId,requestId).first();
 if(!request)return {error:'Pending share request is unavailable.',status:404};
 const permission=await env.DB.prepare(`SELECT 1 AS ok WHERE ${fileDeleteAuthority('?1','?2','?3','?4')}`)
  .bind(orgId,request.created_by,String(userId),request.scope).first();
 if(!permission)return {error:'Only the file owner or a current room/workspace administrator can decline this share.',status:403};
 const at=iso();
 const results=await env.DB.batch([
  env.DB.prepare(`UPDATE hx_file_share_requests SET status='declined',approver_id=?3,approver_login=?4,decision_at=?5
   WHERE org_id=?1 AND id=?2 AND status='pending' AND EXISTS(
    SELECT 1 FROM hx_workspace_files f WHERE f.org_id=hx_file_share_requests.org_id
     AND f.id=hx_file_share_requests.file_id AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')})`)
    .bind(orgId,requestId,String(userId),login,at),
  env.DB.prepare(`INSERT INTO hx_file_share_audit(org_id,request_id,share_id,actor_id,action,details,created_at)
   SELECT ?1,?2,NULL,?3,'declined','{}',?4 WHERE EXISTS(
    SELECT 1 FROM hx_file_share_requests WHERE org_id=?1 AND id=?2 AND status='declined' AND decision_at=?4)`)
    .bind(orgId,requestId,String(userId),at),
 ]);
 if(results[0]?.meta?.changes!==1)return {error:'Request changed before the decline was recorded.',status:409};
 return {requestId,status:'declined',decisionAt:at};
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
 const row=await env.DB.prepare(`SELECT s.file_id,s.file_version,s.content_hash,s.allow_download,s.expires_at,v.object_key,v.content_type,v.size,f.path AS file_path
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
 const disposition=row.allow_download?'attachment':'inline',filename=safeDownloadFilename(row.file_path);
 return new Response(bytes,{headers:{'content-type':row.content_type,'content-length':String(row.size),
  'content-disposition':`${disposition}; filename="${filename.fallback}"; filename*=UTF-8''${filename.encoded}`,
  'cache-control':'no-store, no-cache, must-revalidate','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; sandbox",
  'x-robots-tag':'noindex, nofollow'}});
}

export async function handleFileShareRoutes(request,env,url,{orgId,userId,login}){
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
 const parts=url.pathname.split('/').filter(Boolean);
 const shareManagementRoute=
  (request.method==='GET'&&parts.length===3&&parts[2]==='share-requests')||
  (request.method==='POST'&&parts.length===4&&parts[2]==='share-requests'&&['approve','decline'].includes(parts[3]))||
  (request.method==='POST'&&parts.length===5&&parts[2]==='shares'&&parts[4]==='revoke')||
  (request.method==='POST'&&parts.length===4&&parts[1]==='files'&&parts[3]==='share-requests');
 if(shareManagementRoute&&await getMode(env.DB,orgId)!=='harness')return json({error:'Not found.'},404);
 try{
  if(request.method==='GET'&&parts.length===3&&parts[2]==='share-requests'){
   const requests=await listPublicFileShareRequests(env.DB,{orgId,fileId:url.searchParams.get('fileId'),userId});
   return json({requests});
  }
  if(request.method==='POST'&&parts.length===4&&parts[2]==='share-requests'&&parts[3]==='decline'){
   const body=await request.json().catch(()=>null);
   const result=await declinePublicFileShare(env,{orgId,requestId:body?.requestId,userId,login});
   return json(result,result.error?result.status||400:200);
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
   const fileId=decodeURIComponent(parts[2]),body=await request.json().catch(()=>null);
   const result=await proposePublicFileShare(env,{orgId,fileId,version:body?.version,userId,login,
    requestKey:body?.requestKey,expiresIn:body?.expiresIn,allowDownload:body?.allowDownload===true});
   return json(result,result.error?result.status||400:201);
  }
 }catch(error){if(error instanceof URIError)return json({error:'Invalid identifier.'},400);throw error;}
 return null;
}

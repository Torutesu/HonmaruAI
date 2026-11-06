import {createHash} from 'node:crypto';
import {fileScopeAuthority,fileDeleteAuthority} from './fileAuthority.js';
import {allowed} from '../permissions.js';

const MAX_ASSETS=10;
const SHARE_KEY_CACHE=new Map();
const failure=(error,status=409)=>({error,status});
const newId=prefix=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`;
const encoder=new TextEncoder();
const b64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64url=text=>Uint8Array.from(atob(String(text).replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((String(text).length+3)%4)),c=>c.charCodeAt(0));

function base64Bytes(value){
 if(typeof value!=='string')return null;
 try{const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return bytes.length===32?bytes:null;}catch{return null;}
}
async function shareKey(env){
 const secret=env?.DATA_KEY,bytes=base64Bytes(secret);
 if(!bytes)return null;
 let key=SHARE_KEY_CACHE.get(secret);
 if(!key){key=crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);SHARE_KEY_CACHE.set(secret,key);}
 return key;
}
async function macFor(env,orgId,id){
 const key=await shareKey(env);if(!key)return null;
 const signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(`honmaru:file-share:v1\n${orgId}\n${id}`)));
 return b64url(signature);
}
async function verifyMac(env,orgId,id,signature){
 const key=await shareKey(env);if(!key||typeof signature!=='string')return false;
 let bytes;try{bytes=unb64url(signature);}catch{return false;}
 if(bytes.length!==32||b64url(bytes)!==signature)return false;
 return crypto.subtle.verify('HMAC',key,bytes,encoder.encode(`honmaru:file-share:v1\n${orgId}\n${id}`));
}
function publicTokenParts(token){
 if(typeof token!=='string'||token.length>120)return null;
 const match=/^(shr_[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token);
 return match?{id:match[1],signature:match[2]}:null;
}
export async function fileShareToken(env,orgId,id){
 const signature=await macFor(env,orgId,id);
 return signature?`${id}.${signature}`:null;
}
export function fileShareId(){return `shr_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;}

function basename(path){return String(path||'').split('/').at(-1)||'file';}
function validId(value){return typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);}
function shareOptions({expiresIn='never',allowDownload=true,reusable=true}={}){
 if(!['24h','7d','30d','never'].includes(expiresIn)||typeof allowDownload!=='boolean'||typeof reusable!=='boolean')return null;
 const days={'24h':1,'7d':7,'30d':30};
 return {expiresAt:days[expiresIn]?new Date(Date.now()+days[expiresIn]*86400000).toISOString():null,allowDownload,reusable,expiresIn};
}
function expiryActive(expiresAt,now=Date.now()){return expiresAt===null||Date.parse(expiresAt)>now;}
function digest(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function sameSnapshot(left,right){return typeof left==='string'&&left===right;}

async function snapshotManifest(db,{orgId,userId,fileId,version,assets=[],scope=null,requireCurrent=true}){
 if(!validId(fileId)||!Number.isSafeInteger(version)||version<1||!Array.isArray(assets)||assets.length>MAX_ASSETS)return failure('A file version and up to 10 included assets are required.',400);
 const seen=new Set([fileId]),refs=[{fileId,version},...assets];
 for(const asset of assets){if(!asset||!validId(asset.fileId)||!Number.isSafeInteger(asset.version)||asset.version<1||seen.has(asset.fileId))return failure('Included assets must be unique file versions.',400);seen.add(asset.fileId);}
 const manifest=[];
 for(const ref of refs){
  const row=await db.prepare(`SELECT f.id AS file_id,f.scope,f.path,f.current_version,v.version,v.object_key,v.content_hash,v.content_type,v.size
   FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id
   WHERE f.org_id=?1 AND f.id=?2 AND v.version=?3 AND v.kind='content'
    AND (?5 IS NULL OR f.scope=?5) AND (?6 IS NULL OR f.scope=?6)
    AND ${fileScopeAuthority('f.org_id','f.scope','?4')}
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)`)
   .bind(orgId,ref.fileId,ref.version,userId,scope,manifest[0]?.scope||null).first();
  if(!row)return failure('A file or included asset is unavailable.',404);
  if(requireCurrent&&row.current_version!==row.version)return failure('A file changed. Refresh it before sharing.',409);
  manifest.push({fileId:row.file_id,version:row.version,scope:row.scope,name:basename(row.path),contentType:row.content_type,size:row.size,contentHash:row.content_hash,objectKey:row.object_key});
 }
 return {manifest,snapshotHash:digest(manifest),scope:manifest[0].scope};
}

function publicFiles(snapshot){return snapshot.map(({fileId,version,name,contentType,size})=>({fileId,version,name,contentType,size}));}
function safeSnapshot(raw){try{const parsed=JSON.parse(raw);return Array.isArray(parsed)&&parsed.length>0&&parsed.length<=MAX_ASSETS+1?parsed:null;}catch{return null;}}
function eventStatement(db,{orgId,shareId=null,requestId=null,event,actorId,actorLogin,details={}}){
 return db.prepare(`INSERT INTO hx_workspace_file_share_events(org_id,id,share_id,request_id,event,actor_id,actor_login,details_json,created_at)
  VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`).bind(orgId,newId('fse'),shareId,requestId,event,actorId==null?null:String(actorId),actorLogin||null,JSON.stringify(details),new Date().toISOString());
}
function exactItemInsert(db,{orgId,shareId,revision,position,item,userId}){
 return db.prepare(`INSERT OR IGNORE INTO hx_workspace_file_share_items(org_id,share_id,revision,position,file_id,version)
  SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM hx_workspace_file_share_revisions r WHERE r.org_id=?1 AND r.share_id=?2 AND r.revision=?3)
   AND EXISTS(SELECT 1 FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id
    WHERE f.org_id=?1 AND f.id=?5 AND f.scope=?7 AND f.current_version=?6 AND v.version=?6 AND v.kind='content'
     AND v.object_key=?8 AND v.content_hash=?9 AND v.size=?10 AND v.content_type=?11
     AND ${fileScopeAuthority('f.org_id','f.scope','?12')}
     AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version))`)
  .bind(orgId,shareId,revision,position,item.fileId,item.version,item.scope,item.objectKey,item.contentHash,item.size,item.contentType,userId);
}
async function createRevision(db,{orgId,shareId,revision,manifest,snapshotHash,expiresAt,allowDownload,userId,actorLogin,mutationId,expectedStatus,expectedRevision,at,requestId=null}){
 const insertRevision=db.prepare(`INSERT OR IGNORE INTO hx_workspace_file_share_revisions(org_id,share_id,revision,publication_id,snapshot_json,snapshot_hash,expires_at,allow_download,created_by,created_at)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM hx_workspace_file_shares s WHERE s.org_id=?1 AND s.id=?2 AND s.status=?11 AND s.current_revision=?12)`)
  .bind(orgId,shareId,revision,mutationId,JSON.stringify(manifest),snapshotHash,expiresAt,allowDownload?1:0,userId,at,expectedStatus,expectedRevision);
 const items=manifest.map((item,position)=>exactItemInsert(db,{orgId,shareId,revision,position,item,userId}));
 const countGuard=`(SELECT COUNT(*) FROM hx_workspace_file_share_items i WHERE i.org_id=?1 AND i.share_id=?2 AND i.revision=?3)=?10`;
 const invalidGuard=`NOT EXISTS(SELECT 1 FROM hx_workspace_file_share_items i JOIN hx_workspace_files f ON f.org_id=i.org_id AND f.id=i.file_id
  JOIN hx_workspace_file_versions v ON v.org_id=i.org_id AND v.file_id=i.file_id AND v.version=i.version
  WHERE i.org_id=?1 AND i.share_id=?2 AND i.revision=?3 AND (f.current_version!=i.version OR f.scope!=?5
   OR NOT ${fileScopeAuthority('f.org_id','f.scope','?6')}
   OR EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)))`;
 const requestFence=requestId?`AND EXISTS(SELECT 1 FROM hx_workspace_file_share_requests req WHERE req.org_id=?1 AND req.id=?11
  AND req.share_id=?2 AND req.status='pending' AND req.expected_revision=?9)`:'';
 const updateShare=db.prepare(`UPDATE hx_workspace_file_shares SET status='active',current_revision=?3,last_change_id=?4,updated_at=?7
  WHERE org_id=?1 AND id=?2 AND status=?8 AND current_revision=?9 AND ${countGuard} AND ${invalidGuard} ${requestFence}`)
  .bind(orgId,shareId,revision,mutationId,manifest[0].scope,userId,at,expectedStatus,expectedRevision,manifest.length,...(requestId?[requestId]:[]));
 const finishRequest=requestId?db.prepare(`UPDATE hx_workspace_file_share_requests SET status='approved',decided_by=?4,decided_at=?5
  WHERE org_id=?1 AND id=?2 AND status='pending' AND EXISTS(SELECT 1 FROM hx_workspace_file_shares s
   WHERE s.org_id=?1 AND s.id=?3 AND s.status='active' AND s.current_revision=?6 AND s.last_change_id=?2)`)
   .bind(orgId,requestId,shareId,actorLogin,at,revision):null;
 const results=await db.batch([insertRevision,...items,updateShare,...(finishRequest?[finishRequest]:[])]);
 const pointer=results[items.length+1];
 const requestDone=finishRequest?results[items.length+2]?.meta?.changes===1:true;
 const published=pointer?.meta?.changes===1&&requestDone;
 if(!published)await db.prepare(`DELETE FROM hx_workspace_file_share_revisions WHERE org_id=?1 AND share_id=?2 AND revision=?3 AND publication_id=?4
  AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_shares s WHERE s.org_id=?1 AND s.id=?2 AND s.current_revision=?3)`)
  .bind(orgId,shareId,revision,mutationId).run();
 if(published)await eventStatement(db,{orgId,shareId,requestId,event:requestId?'approved':'published',actorId:userId,actorLogin,details:{revision,expiresAt,allowDownload,files:publicFiles(manifest)}}).run();
 return {published,results,revision};
}

async function findShareForManager(db,{orgId,fileId,shareId,userId}){
 return db.prepare(`SELECT s.*,f.scope,f.path FROM hx_workspace_file_shares s JOIN hx_workspace_files f ON f.org_id=s.org_id AND f.id=s.file_id
  WHERE s.org_id=?1 AND s.file_id=?2 AND s.id=?3 AND ${fileScopeAuthority('f.org_id','f.scope','?4')}
   AND ${fileDeleteAuthority('f.org_id','f.created_by','?4','f.scope')}`)
  .bind(orgId,fileId,shareId,userId).first();
}
async function currentShareInfo(db,orgId,shareId){
 return db.prepare(`SELECT s.id,s.file_id,s.created_by,s.created_login,s.reusable,s.status,s.current_revision,s.created_at,s.updated_at,
   r.expires_at,r.allow_download,r.snapshot_json,r.snapshot_hash
  FROM hx_workspace_file_shares s LEFT JOIN hx_workspace_file_share_revisions r ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision
  WHERE s.org_id=?1 AND s.id=?2`).bind(orgId,shareId).first();
}
function shapeShare(row,now=Date.now()){
 const snapshot=safeSnapshot(row.snapshot_json||'[]');
 return {id:row.id,status:row.status==='active'&&!expiryActive(row.expires_at,now)?'expired':row.status,reusable:Boolean(row.reusable),currentRevision:row.current_revision,
  createdBy:row.created_login,createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at||null,allowDownload:Boolean(row.allow_download),files:snapshot?publicFiles(snapshot):[]};
}

export async function listFileShares(db,{orgId,fileId,userId}){
 const file=await db.prepare(`SELECT f.id FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2 AND ${fileScopeAuthority('f.org_id','f.scope','?3')}`).bind(orgId,fileId,userId).first();
 if(!file)return failure('File is unavailable.',404);
 const {results=[]}=await db.prepare(`SELECT s.id,s.file_id,s.created_by,s.created_login,s.reusable,s.status,s.current_revision,s.created_at,s.updated_at,
   r.expires_at,r.allow_download,r.snapshot_json FROM hx_workspace_file_shares s LEFT JOIN hx_workspace_file_share_revisions r
    ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision
  WHERE s.org_id=?1 AND s.file_id=?2 ORDER BY s.created_at DESC LIMIT 50`).bind(orgId,fileId).all();
 const canManage=Boolean(await db.prepare(`SELECT 1 AS ok FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2
  AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')}`).bind(orgId,fileId,userId).first());
 return {shares:results.map(row=>shapeShare(row)),canManage};
}

export async function createDirectFileShare(env,{orgId,fileId,userId,login,version,assets=[],expiresIn='never',allowDownload=true,reusable=true,requestKey}){
 if(!await shareKey(env))return failure('Workspace encryption is required before creating public links.',503);
 if(!await allowed(env.DB,orgId,userId,'harness.build'))return failure('Current file write access is required.',403);
 if(typeof requestKey!=='string'||!/^[-A-Za-z0-9_]{16,100}$/.test(requestKey))return failure('A valid share request key is required.',400);
 let options=shareOptions({expiresIn,allowDownload,reusable});if(!options)return failure('Invalid public share options.',400);
 const snapshot=await snapshotManifest(env.DB,{orgId,userId,fileId,version,assets,requireCurrent:true});if(snapshot.error)return snapshot;
 const requestHash=digest({snapshotHash:snapshot.snapshotHash,expiresIn,allowDownload,reusable});
 const existing=await env.DB.prepare(`SELECT s.id,s.status,s.reusable,s.request_hash,s.current_revision,s.created_login,s.created_at,s.updated_at,r.snapshot_hash,r.expires_at,r.allow_download,r.snapshot_json
  FROM hx_workspace_file_shares s JOIN hx_workspace_file_share_revisions r ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision
  WHERE s.org_id=?1 AND s.created_by=?2 AND s.request_key=?3`).bind(orgId,userId,requestKey).first();
 if(existing){
  if(existing.status!=='active'||existing.request_hash!==requestHash||existing.snapshot_hash!==snapshot.snapshotHash||!expiryActive(existing.expires_at))return failure('This share request key was already used with different settings or the share has expired.',409);
  const token=await fileShareToken(env,orgId,existing.id);return token?{share:shapeShare(existing),token,replayed:true}:failure('Workspace encryption is unavailable.',503);
 }
 const id=fileShareId(),now=new Date().toISOString();
 const reserve=await env.DB.prepare(`INSERT OR IGNORE INTO hx_workspace_file_shares
  (org_id,id,file_id,created_by,created_login,request_key,request_hash,reusable,status,current_revision,last_change_id,created_at,updated_at)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,'',?9,?9 WHERE EXISTS(SELECT 1 FROM hx_workspace_files f
   JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id
   WHERE f.org_id=?1 AND f.id=?3 AND f.current_version=?10 AND f.scope=?11 AND v.version=?10 AND v.kind='content'
    AND ${fileScopeAuthority('f.org_id','f.scope','?4')}
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version))`)
   .bind(orgId,id,fileId,userId,login,requestKey,requestHash,reusable?1:0,now,version,snapshot.scope).run();
 if(!reserve.meta?.changes){
  const winner=await env.DB.prepare(`SELECT s.id,s.status,s.reusable,s.request_hash,s.current_revision,s.created_login,s.created_at,s.updated_at,r.snapshot_hash,r.expires_at,r.allow_download,r.snapshot_json
   FROM hx_workspace_file_shares s JOIN hx_workspace_file_share_revisions r ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision
   WHERE s.org_id=?1 AND s.created_by=?2 AND s.request_key=?3`).bind(orgId,userId,requestKey).first();
  if(winner&&winner.status==='active'&&winner.request_hash===requestHash&&winner.snapshot_hash===snapshot.snapshotHash&&expiryActive(winner.expires_at)){
   const token=await fileShareToken(env,orgId,winner.id);return token?{share:shapeShare(winner),token,replayed:true}:failure('Workspace encryption is unavailable.',503);
  }
  return failure('The share request key was already used or the file changed.',409);
 }
 const result=await createRevision(env.DB,{orgId,shareId:id,revision:1,manifest:snapshot.manifest,snapshotHash:snapshot.snapshotHash,expiresAt:options.expiresAt,allowDownload,userId,actorLogin:login,mutationId:requestKey,expectedStatus:'pending',expectedRevision:0,at:now});
 if(!result.published){await env.DB.prepare("DELETE FROM hx_workspace_file_shares WHERE org_id=?1 AND id=?2 AND status='pending'").bind(orgId,id).run();return failure('The file changed or became unavailable. Refresh it before sharing.',409);}
 const winner=await env.DB.prepare(`SELECT s.id,s.status,s.reusable,s.current_revision,r.snapshot_hash,r.expires_at,r.allow_download,r.snapshot_json
  FROM hx_workspace_file_shares s JOIN hx_workspace_file_share_revisions r ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision
  WHERE s.org_id=?1 AND s.created_by=?2 AND s.request_key=?3`).bind(orgId,userId,requestKey).first();
 if(!winner||winner.id!==id)return failure('The share request changed. Refresh and try again.',409);
 const token=await fileShareToken(env,orgId,id);return token?{share:shapeShare(winner),token}:failure('Workspace encryption is unavailable.',503);
}

export async function copyFileShare(env,{orgId,fileId,shareId,userId,login}){
 if(!await shareKey(env))return failure('Workspace encryption is unavailable.',503);
 if(!await allowed(env.DB,orgId,userId,'harness.build'))return failure('Current file write access is required.',403);
 const row=await findShareForManager(env.DB,{orgId,fileId,shareId,userId});
 if(!row||row.status!=='active'||row.current_revision<1)return failure('This share is unavailable.',404);
 const info=await currentShareInfo(env.DB,orgId,shareId);if(!info||!expiryActive(info.expires_at))return failure('This share has expired or stopped.',409);
 await eventStatement(env.DB,{orgId,shareId,event:'copied',actorId:userId,actorLogin:login,details:{revision:row.current_revision}}).run();
 const token=await fileShareToken(env,orgId,shareId);return token?{token}:failure('Workspace encryption is unavailable.',503);
}

export async function updateFileShare(env,{orgId,fileId,shareId,userId,login,version,assets=[]}){
 if(!await allowed(env.DB,orgId,userId,'harness.build'))return failure('Current file write access is required.',403);
 const share=await findShareForManager(env.DB,{orgId,fileId,shareId,userId});
 if(!share||share.status!=='active'||!share.reusable)return failure('Only an active reusable share can be updated.',409);
 const current=await currentShareInfo(env.DB,orgId,shareId);if(!current||!expiryActive(current.expires_at))return failure('Expired shares cannot be updated.',409);
 const old=safeSnapshot(current.snapshot_json);if(!old)return failure('The stored share snapshot is unavailable.',409);
 const refs=assets.length?assets:old.slice(1).map(item=>({fileId:item.fileId,version:item.version}));
 const snapshot=await snapshotManifest(env.DB,{orgId,userId,fileId,version,assets:refs,scope:share.scope,requireCurrent:true});if(snapshot.error)return snapshot;
 const revision=current.current_revision+1,now=new Date().toISOString(),requestKey=newId('update');
 const result=await createRevision(env.DB,{orgId,shareId,revision,manifest:snapshot.manifest,snapshotHash:snapshot.snapshotHash,expiresAt:current.expires_at,allowDownload:Boolean(current.allow_download),userId,actorLogin:login,mutationId:requestKey,expectedStatus:'active',expectedRevision:current.current_revision,at:now});
 if(!result.published)return failure('The file changed or share revision was updated. Refresh before publishing.',409);
 const updated=await currentShareInfo(env.DB,orgId,shareId);return {share:shapeShare(updated),token:await fileShareToken(env,orgId,shareId)};
}

export async function revokeFileShare(db,{orgId,fileId,shareId,userId,login,action='revoke'}){
 if(!['revoke','stop'].includes(action))return failure('Invalid share action.',400);
 if(!await allowed(db,orgId,userId,'harness.build'))return failure('Current file write access is required.',403);
 const next=action==='stop'?'stopped':'revoked',now=new Date().toISOString();
 const result=await db.prepare(`UPDATE hx_workspace_file_shares SET status=?5,updated_at=?6
  WHERE org_id=?1 AND file_id=?2 AND id=?3 AND status='active' AND EXISTS(SELECT 1 FROM hx_workspace_files f
   WHERE f.org_id=?1 AND f.id=?2 AND ${fileScopeAuthority('f.org_id','f.scope','?4')}
    AND ${fileDeleteAuthority('f.org_id','f.created_by','?4','f.scope')})`)
  .bind(orgId,fileId,shareId,userId,next,now).run();
 if(!result.meta?.changes)return failure('This share is unavailable or already stopped.',409);
 await eventStatement(db,{orgId,shareId,event:next,actorId:userId,actorLogin:login,details:{at:now}}).run();
 return {revoked:true,status:next};
}

function cardForRequest({id,cardId,requesterLogin,agentName,fileName,version,assets,options,requestType}){
 const expires=options.expiresAt?new Date(options.expiresAt).toLocaleString('ja-JP',{timeZone:'UTC'}):'期限なし';
 const descriptions=[`${fileName} v${version}`,...assets.map(item=>`${item.name} v${item.version}`)];
 const card={id:cardId,recipientUserID:requesterLogin,senderUserID:requesterLogin,type:'approval',title:'公開ファイル共有の承認',
  summary:`${agentName||'Agent'}が「${fileName}」の${requestType==='update'?'共有リンク更新':'公開リンク作成'}を求めています。`,
  context:`公開対象: ${descriptions.join('、')}\n有効期限: ${expires}\nダウンロード: ${options.allowDownload?'許可':'表示のみ'}\n${options.reusable?'URLを再利用し、更新時に新しい版へ切り替えます。':'この共有リンクは一度限りです。'}\n承認後に誰でもリンクから閲覧できます。リンクはまだ発行されていません。ファイルが承認前に変わった場合は公開されません。`,
  priority:'medium',status:'pending',createdAt:new Date().toISOString(),sourceApp:'Honmaru Harness',sourceDetail:'Public file share approval',visibility:'personal',originalLanguage:'ja',
  fileShareApproval:{requestId:id}};
 return card;
}

export async function requestAgentFileShare(env,{orgId,userId,login,agentId,agentName,channel,turnId,fileId,version,assets=[],expiresIn='never',allowDownload=true,reusable=true,requestKey,shareId=null}){
 if(!await shareKey(env))return failure('Workspace encryption is required before requesting public links.',503);
 if(!await allowed(env.DB,orgId,userId,'harness.build'))return failure('Current file write access is required.',403);
 if(typeof requestKey!=='string'||!/^[-A-Za-z0-9_]{16,100}$/.test(requestKey)||!validId(agentId)||!validId(channel)||!validId(turnId))return failure('A valid file share request key and source turn are required.',400);
 let options=shareOptions({expiresIn,allowDownload,reusable});if(!options)return failure('Invalid public share options.',400);
 const owner=await env.DB.prepare(`SELECT u.login,u.name,m.created_at AS membership,a.name AS agent_name,a.scope,a.owner_login,a.deleted_at
  FROM users u JOIN memberships m ON m.org_id=?1 AND m.user_github_id=u.github_id
  JOIN custom_agents a ON a.org_id=?1 AND a.id=?3 AND a.owner_login=u.login
  WHERE u.github_id=?2 AND a.scope='personal' AND a.provider IS NULL AND a.deleted_at IS NULL
   AND ?4='ag:'||a.id||'|'||u.login AND ${fileScopeAuthority('?1','?4','?2')}`)
  .bind(orgId,String(userId),agentId,channel).first();
 if(!owner||owner.login!==login)return failure('This Agent conversation is no longer available.',403);
 const snapshot=await snapshotManifest(env.DB,{orgId,userId:String(userId),fileId,version,assets,scope:channel,requireCurrent:true});if(snapshot.error)return snapshot;
 const requestType=shareId?'update':'create';
 let share=null,expectedRevision=0;
 if(shareId){
  share=await env.DB.prepare(`SELECT * FROM hx_workspace_file_shares WHERE org_id=?1 AND id=?2 AND file_id=?3 AND created_by=?4 AND status='active' AND reusable=1`).bind(orgId,shareId,fileId,String(userId)).first();
  if(!share)return failure('This reusable share is unavailable.',404);
  expectedRevision=share.current_revision;
  const previousShare=await currentShareInfo(env.DB,orgId,shareId);
  if(!previousShare||!expiryActive(previousShare.expires_at))return failure('Expired shares cannot be updated.',409);
  options={expiresAt:previousShare.expires_at||null,allowDownload:Boolean(previousShare.allow_download),reusable:Boolean(share.reusable),expiresIn:'preserved'};
 }else shareId=fileShareId();
 const previous=await env.DB.prepare(`SELECT id,card_id AS cardId,status,snapshot_hash FROM hx_workspace_file_share_requests WHERE org_id=?1 AND requester_id=?2 AND request_key=?3`).bind(orgId,String(userId),requestKey).first();
 if(previous){if(previous.snapshot_hash!==snapshot.snapshotHash)return failure('This request key was already used for a different snapshot.',409);return {request:{id:previous.id,cardId:previous.cardId,status:previous.status},created:false};}
 const id=newId('fsr'),cardId=`file-share-${crypto.randomUUID()}`,nonce=crypto.randomUUID(),now=new Date().toISOString();
 const card=cardForRequest({id,cardId,requesterLogin:login,agentName:owner.agent_name,fileName:snapshot.manifest[0].name,version,assets:snapshot.manifest.slice(1),options,requestType});
 const pendingShare=requestType==='create'?env.DB.prepare(`INSERT OR IGNORE INTO hx_workspace_file_shares
  (org_id,id,file_id,created_by,created_login,reusable,status,current_revision,last_change_id,created_at,updated_at)
  SELECT ?1,?2,?3,?4,?5,?6,'pending',0,'',?7,?7 WHERE EXISTS(SELECT 1 FROM hx_workspace_files f JOIN hx_workspace_file_versions v
   ON v.org_id=f.org_id AND v.file_id=f.id WHERE f.org_id=?1 AND f.id=?3 AND f.scope=?8 AND f.current_version=?9
    AND v.version=?9 AND v.kind='content' AND v.object_key=?10 AND ${fileScopeAuthority('f.org_id','f.scope','?4')})`)
   .bind(orgId,shareId,fileId,String(userId),login,reusable?1:0,now,channel,version,snapshot.manifest[0].objectKey):null;
 const shareReady=requestType==='create'?`EXISTS(SELECT 1 FROM hx_workspace_file_shares s WHERE s.org_id=?1 AND s.id=?15 AND s.status='pending')`:`EXISTS(SELECT 1 FROM hx_workspace_file_shares s WHERE s.org_id=?1 AND s.id=?15 AND s.status='active' AND s.current_revision=?16 AND s.reusable=1 AND s.created_by=?2)`;
 const requestInsert=env.DB.prepare(`INSERT OR IGNORE INTO hx_workspace_file_share_requests(org_id,id,file_id,share_id,request_type,requester_id,requester_login,requester_membership,agent_id,channel,request_key,card_id,nonce,expected_revision,snapshot_json,snapshot_hash,expires_at,allow_download,status,created_at,turn_id)
  SELECT ?1,?14,?3,?15,?17,?2,?4,?5,?6,?7,?8,?9,?10,?16,?11,?12,?18,?19,'pending',?13,?21
  WHERE EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.org_id=?1 AND m.user_github_id=u.github_id
   JOIN custom_agents a ON a.org_id=?1 AND a.id=?6 AND a.owner_login=u.login
   WHERE u.github_id=?2 AND u.login=?4 AND m.created_at=?5 AND lower(m.role) IN ('owner','admin','member','designer','engineer','triager','maintainer')
    AND a.scope='personal' AND a.provider IS NULL AND a.deleted_at IS NULL AND ?7='ag:'||a.id||'|'||u.login)
   AND ${shareReady}
   AND EXISTS(SELECT 1 FROM channel_messages turn WHERE turn.org_id=?1 AND turn.id=?21 AND turn.channel=?7 AND turn.author_login=?4 AND turn.kind='message' AND turn.parent_id IS NULL AND turn.deleted_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id
     WHERE f.org_id=?1 AND f.id=?3 AND f.scope=?7 AND f.current_version!=?20 AND v.version=?20 AND v.kind='content')`)
  .bind(orgId,String(userId),fileId,login,owner.membership,agentId,channel,requestKey,cardId,nonce,JSON.stringify(snapshot.manifest),snapshot.snapshotHash,now,id,shareId,expectedRevision,requestType,options.expiresAt,options.allowDownload?1:0,version,turnId);
 const cardInsert=env.DB.prepare(`INSERT INTO cards(org_id,card_id,recipient_user_id,sender_user_id,created_at,data,status,priority,decided_at,updated_at)
  SELECT ?1,?2,?3,?3,?4,?5,'pending','medium',NULL,?4 WHERE EXISTS(SELECT 1 FROM hx_workspace_file_share_requests WHERE org_id=?1 AND id=?6 AND nonce=?7 AND status='pending')`)
  .bind(orgId,cardId,login,now,JSON.stringify(card),id,nonce);
 const cardEvent=env.DB.prepare(`INSERT INTO card_events(id,org_id,card_id,type,action,actor_user_id,note,snapshot,created_at)
  SELECT ?1,?2,?3,'created',NULL,?4,'file_share_request',?5,?6 WHERE EXISTS(SELECT 1 FROM hx_workspace_file_share_requests WHERE org_id=?2 AND id=?7 AND card_id=?3 AND status='pending')`)
  .bind(crypto.randomUUID(),orgId,cardId,login,JSON.stringify(card),now,id);
 const requestEvent=eventStatement(env.DB,{orgId,shareId,requestId:id,event:'requested',actorId:userId,actorLogin:login,details:{agentId,version,assets:assets.length,expiresAt:options.expiresAt,allowDownload:options.allowDownload,reusable:options.reusable}});
 await env.DB.batch([...(pendingShare?[pendingShare]:[]),requestInsert,cardInsert,cardEvent,requestEvent]);
 const result=await env.DB.prepare(`SELECT id,card_id AS cardId,status,snapshot_hash FROM hx_workspace_file_share_requests WHERE org_id=?1 AND requester_id=?2 AND request_key=?3`).bind(orgId,String(userId),requestKey).first();
 if(!result){if(requestType==='create')await env.DB.prepare("DELETE FROM hx_workspace_file_shares WHERE org_id=?1 AND id=?2 AND status='pending'").bind(orgId,shareId).run();return failure('The file, Agent or membership changed. Refresh and request approval again.',409);}
 if(result.id!==id){if(requestType==='create')await env.DB.prepare("DELETE FROM hx_workspace_file_shares WHERE org_id=?1 AND id=?2 AND status='pending'").bind(orgId,shareId).run();return result.snapshot_hash===snapshot.snapshotHash?{request:{id:result.id,cardId:result.cardId,status:result.status},created:false}:failure('This request key was already used for a different snapshot.',409);}
 return {request:{id,cardId,status:'pending'},card,created:true};
}

async function staleApproval(db,orgId,row,actorLogin,at){
 await db.batch([
  db.prepare(`UPDATE hx_workspace_file_share_requests SET status='stale',decided_by=?3,decided_at=?4 WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(orgId,row.id,actorLogin,at),
  db.prepare(`UPDATE hx_workspace_file_shares SET status='stopped',updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending' AND ?4='create'`).bind(orgId,row.share_id,at,row.request_type),
  eventStatement(db,{orgId,shareId:row.share_id,requestId:row.id,event:'stale',actorId:actorLogin,actorLogin,details:{reason:'snapshot_or_authority_changed'}}),
 ]);
 const snapshot=safeSnapshot(row.snapshot_json);
 return {settled:true,action:'stale',actorLogin,requestId:row.id,cardId:row.card_id,channel:row.channel,agentId:row.agent_id,fileName:snapshot?.[0]?.name||'ファイル'};
}

export async function settleFileShareApproval(env,orgId,card){
 const ref=card?.fileShareApproval,decision=card?.decision;
 if(!ref?.requestId||!decision?.action||!['approve','choose','decline'].includes(decision.action))return false;
 const row=await env.DB.prepare(`SELECT r.*,u.login AS current_login,m.created_at AS current_membership,a.owner_login AS current_agent_owner,a.scope AS agent_scope,a.provider AS agent_provider,a.deleted_at AS agent_deleted
  FROM hx_workspace_file_share_requests r JOIN users u ON u.github_id=r.requester_id
  JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.requester_id AND m.created_at=r.requester_membership
   AND lower(m.role) IN ('owner','admin','member','designer','engineer','triager','maintainer')
  JOIN custom_agents a ON a.org_id=r.org_id AND a.id=r.agent_id AND a.owner_login=r.requester_login
  WHERE r.org_id=?1 AND r.id=?2 AND r.card_id=?3 AND r.status='pending'`).bind(orgId,ref.requestId,String(card.id||'')).first();
 const actorLogin=String(decision.actorUserID||'');
 if(!row||row.current_login!==row.requester_login||row.requester_login!==card.recipientUserID||row.requester_login!==card.senderUserID
  ||actorLogin!==row.requester_login||row.agent_scope!=='personal'||row.agent_provider!==null||row.agent_deleted)return false;
 const at=decision.decidedAt||new Date().toISOString();
 if(decision.action==='decline'){
  const results=await env.DB.batch([
   env.DB.prepare(`UPDATE hx_workspace_file_share_requests SET status='declined',decided_by=?4,decided_at=?5 WHERE org_id=?1 AND id=?2 AND card_id=?3 AND status='pending' AND requester_login=?4 AND requester_membership=?6`)
    .bind(orgId,row.id,row.card_id,actorLogin,at,row.requester_membership),
   env.DB.prepare(`UPDATE hx_workspace_file_shares SET status='revoked',updated_at=?4 WHERE org_id=?1 AND id=?2 AND status='pending' AND ?3='create'
    AND EXISTS(SELECT 1 FROM hx_workspace_file_share_requests r WHERE r.org_id=?1 AND r.id=?5 AND r.status='declined')`)
    .bind(orgId,row.share_id,row.request_type,at,row.id),
   eventStatement(env.DB,{orgId,shareId:row.share_id,requestId:row.id,event:'declined',actorId:actorLogin,actorLogin,details:{}}),
  ]);
  return results[0]?.meta?.changes?{settled:true,action:'decline',actorLogin,requestId:row.id}:false;
 }
 const requestSnapshot=safeSnapshot(row.snapshot_json);
 if(!requestSnapshot||!expiryActive(row.expires_at))return staleApproval(env.DB,orgId,row,actorLogin,at);
 if(!await allowed(env.DB,orgId,String(row.requester_id),'harness.build'))return staleApproval(env.DB,orgId,row,actorLogin,at);
 const sourceTurn=await env.DB.prepare(`SELECT 1 AS ok FROM channel_messages WHERE org_id=?1 AND id=?2 AND channel=?3
  AND author_login=?4 AND kind='message' AND parent_id IS NULL AND deleted_at IS NULL`)
  .bind(orgId,row.turn_id,row.channel,row.requester_login).first();
 if(!sourceTurn)return staleApproval(env.DB,orgId,row,actorLogin,at);
 const live=await snapshotManifest(env.DB,{orgId,userId:String(row.requester_id),fileId:row.file_id,version:requestSnapshot[0].version,
  assets:requestSnapshot.slice(1).map(item=>({fileId:item.fileId,version:item.version})),scope:row.channel,requireCurrent:true});
 if(live.error||!sameSnapshot(row.snapshot_hash,live.snapshotHash)||JSON.stringify(requestSnapshot)!==JSON.stringify(live.manifest))return staleApproval(env.DB,orgId,row,actorLogin,at);
 if(row.request_type==='update'){
  const share=await env.DB.prepare(`SELECT status,current_revision,reusable,created_by FROM hx_workspace_file_shares WHERE org_id=?1 AND id=?2 AND file_id=?3`).bind(orgId,row.share_id,row.file_id).first();
  if(!share||share.status!=='active'||!share.reusable||share.created_by!==String(row.requester_id)||share.current_revision!==row.expected_revision)return staleApproval(env.DB,orgId,row,actorLogin,at);
  const old=await currentShareInfo(env.DB,orgId,row.share_id);if(!old||!expiryActive(old.expires_at))return staleApproval(env.DB,orgId,row,actorLogin,at);
 }
 const revision=row.request_type==='create'?1:row.expected_revision+1;
 const status=row.request_type==='create'?'pending':'active',expectedRevision=row.request_type==='create'?0:row.expected_revision;
 const result=await createRevision(env.DB,{orgId,shareId:row.share_id,revision,manifest:live.manifest,snapshotHash:live.snapshotHash,
  expiresAt:row.expires_at,allowDownload:Boolean(row.allow_download),userId:String(row.requester_id),actorLogin,mutationId:row.id,
  expectedStatus:status,expectedRevision,at,requestId:row.id});
 if(!result.published)return staleApproval(env.DB,orgId,row,actorLogin,at);
 const token=await fileShareToken(env,orgId,row.share_id);
 if(!token)return {settled:true,action:'approved_without_link',actorLogin,requestId:row.id};
 return {settled:true,action:'approve',actorLogin,requestId:row.id,shareId:row.share_id,token,channel:row.channel,agentId:row.agent_id,fileName:live.manifest[0].name,revision};
}

async function activePublicShare(env,token){
 const parts=publicTokenParts(token);if(!parts)return null;
 const row=await env.DB.prepare(`SELECT s.org_id,s.id,s.file_id,s.status,s.current_revision,r.snapshot_json,r.snapshot_hash,r.expires_at,r.allow_download,
  EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=s.org_id AND d.purge_started_at IS NOT NULL) AS deleting,
  EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=s.org_id) AS deleted
  FROM hx_workspace_file_shares s JOIN hx_workspace_file_share_revisions r ON r.org_id=s.org_id AND r.share_id=s.id AND r.revision=s.current_revision
  WHERE s.id=?1 AND s.status='active' AND s.current_revision>0 LIMIT 1`).bind(parts.id).first();
 if(!row||row.deleting||row.deleted||!expiryActive(row.expires_at))return null;
 if(!await verifyMac(env,row.org_id,row.id,parts.signature))return null;
 const manifest=safeSnapshot(row.snapshot_json);if(!manifest||digest(manifest)!==row.snapshot_hash)return null;
 return {...row,manifest,token,shareId:parts.id};
}

export async function readPublicFileShare(env,token){
 const row=await activePublicShare(env,token);if(!row)return null;
 return {share:{name:row.manifest[0].name,version:row.manifest[0].version,files:row.manifest.map(({name,version,contentType,size})=>({name,version,contentType,size})),allowDownload:Boolean(row.allow_download),expiresAt:row.expires_at||null}};
}

const INLINE_TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','audio/x-m4a','audio/aac','audio/flac','audio/x-wav','text/plain']);
export async function readPublicFileShareContent(env,token,index,{preview=false}={}){
 const row=await activePublicShare(env,token);
 if(!row||!Number.isInteger(index)||index<0||index>=row.manifest.length)return null;
 const item=row.manifest[index],mime=String(item.contentType||'application/octet-stream').split(';')[0].trim().toLowerCase();
 if(!row.allow_download&&!INLINE_TYPES.has(mime))return new Response('Unavailable',{status:403,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 if(preview&&mime!=='text/plain')return new Response('Unavailable',{status:403,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 if(!env.MEDIA)return null;
 const object=await env.MEDIA.get(item.objectKey);if(!object)return null;
 if(object.size!==item.size||item.size>25*1024*1024){await object.body.cancel().catch(()=>{});return null;}
 let bytes=null;
 if(preview){if(item.size>128*1024){await object.body.cancel().catch(()=>{});return new Response('Unavailable',{status:413,headers:{'cache-control':'no-store'}});}bytes=await object.arrayBuffer();}
 const current=await activePublicShare(env,token);
 if(!current||current.current_revision!==row.current_revision||current.snapshot_hash!==row.snapshot_hash){if(!preview)await object.body.cancel().catch(()=>{});return null;}
 if(preview&&bytes.byteLength>128*1024)return new Response('Unavailable',{status:413,headers:{'cache-control':'no-store'}});
 const inline=preview||(!row.allow_download&&INLINE_TYPES.has(mime));
 return new Response(bytes||object.body,{headers:{'content-type':preview?'text/plain; charset=utf-8':mime,'content-length':String(item.size),
  'content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
  'cache-control':'private, no-store','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow, noarchive',
  'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cross-origin-resource-policy':'cross-origin',
  'access-control-allow-origin':'*'}});
}

import { createHash } from 'node:crypto';
import { publicMediaType } from '../../../packages/core/src/publicMediaType.ts';
import { allowed } from '../permissions.js';
import { byteRange, UNSATISFIABLE } from '../files.js';
import { fileScopeAuthority, fileDeleteAuthority } from './fileAuthority.js';

const KEY_CACHE = new Map();
const encoder = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64url = value => Uint8Array.from(atob(String(value).replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((String(value).length+3)%4)),c=>c.charCodeAt(0));
const failure = (error,status=409) => ({error,status});
const validId = value => typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
const basename = path => String(path||'').split('/').at(-1)||'file';
const tokenPattern = /^fpu_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
export const publicUrlMediaType=publicMediaType;

function dataKeyBytes(env){
 if(typeof env?.DATA_KEY!=='string')return null;
 try{const bytes=Uint8Array.from(atob(env.DATA_KEY),c=>c.charCodeAt(0));return bytes.length===32?bytes:null;}catch{return null;}
}
async function signingKey(env){
 const secret=env?.DATA_KEY,bytes=dataKeyBytes(env);
 if(!bytes)return null;
 let key=KEY_CACHE.get(secret);
 if(!key){key=crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);KEY_CACHE.set(secret,key);}
 return key;
}
function newPublicId(){return `fpu_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;}
async function signatureFor(env,{orgId,fileId,version,id}){
 const key=await signingKey(env);if(!key)return null;
 const bytes=await crypto.subtle.sign('HMAC',key,encoder.encode(`honmaru:file-public-url:v1\n${orgId}\n${fileId}\n${version}\n${id}`));
 return b64url(new Uint8Array(bytes));
}
async function tokenFor(env,row){
 const signature=await signatureFor(env,{orgId:row.org_id,fileId:row.file_id,version:row.version,id:row.id});
 return signature?`${row.id}.${signature}`:null;
}
function hashToken(token){return createHash('sha256').update(token).digest('hex');}
function tokenParts(token){
 if(typeof token!=='string'||token.length>120||!tokenPattern.test(token))return null;
 const [id,signature]=token.split('.');
 try{const random=unb64url(id.slice(4)),mac=unb64url(signature);if(random.length!==32||mac.length!==32||b64url(random)!==id.slice(4)||b64url(mac)!==signature)return null;}catch{return null;}
 return {id,signature,signatureBytes:unb64url(signature)};
}
async function validToken(env,row,token,signatureBytes){
 const key=await signingKey(env);if(!key||signatureBytes?.length!==32)return false;
 const valid=await crypto.subtle.verify('HMAC',key,signatureBytes,encoder.encode(`honmaru:file-public-url:v1\n${row.org_id}\n${row.file_id}\n${row.version}\n${row.id}`));
 if(!valid)return false;
 return hashToken(token)===row.token_hash;
}
function publicPath(base,token){
 try{return new URL(`/workspace-file-public-urls/${encodeURIComponent(token)}`,base).href;}catch{return null;}
}
function safeFailure(message,status=404){return new Response(message,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow, noarchive'}});}
function safeFilename(name){
 return encodeURIComponent(basename(name)).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function currentVersion(db,{orgId,fileId,userId}){
 if(!validId(fileId))return null;
 return db.prepare(`SELECT f.id AS file_id,f.scope,f.path,f.created_by,f.current_version,v.version,v.kind,v.object_key,v.content_type,v.size
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
  WHERE f.org_id=?1 AND f.id=?2 AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=v.org_id AND gone.file_id=v.file_id AND gone.version=v.version)`)
  .bind(orgId,fileId,String(userId)).first();
}

export async function filePublicUrlState(env,{orgId,fileId,userId,baseUrl}){
 const file=await currentVersion(env.DB,{orgId,fileId,userId});
 if(!file)return failure('File is unavailable.',404);
 const canCreate=Boolean(await allowed(env.DB,orgId,String(userId),'harness.build'));
 const canRevoke=Boolean(await env.DB.prepare(`SELECT 1 AS ok FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2
  AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')}`).bind(orgId,fileId,String(userId)).first());
 const type=publicUrlMediaType(file.content_type);
 let url=null;
 if(type&&file.kind==='content'&&canRevoke){
  const live=await env.DB.prepare(`SELECT p.id,p.org_id,p.file_id,p.version,p.token_hash FROM hx_workspace_file_public_urls p
   WHERE p.org_id=?1 AND p.file_id=?2 AND p.version=?3
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=p.org_id AND gone.file_id=p.file_id AND gone.version=p.version)`)
   .bind(orgId,fileId,file.current_version).first();
  if(live){
   const token=await tokenFor(env,live);
   if(!token)return failure('Workspace encryption is unavailable.',503);
   if(hashToken(token)!==live.token_hash)return failure('Public URL signing key is unavailable for this link.',409);
   url=publicPath(baseUrl,token);
  }
 }
 return {url,version:file.current_version,contentType:type,canCreate,canRevoke};
}

export async function createFilePublicUrl(env,{orgId,fileId,userId,login,baseUrl}){
 if(!await signingKey(env))return failure('Workspace encryption is unavailable.',503);
 if(!await allowed(env.DB,orgId,String(userId),'harness.build'))return failure('Current file write access is required.',403);
 const file=await currentVersion(env.DB,{orgId,fileId,userId});
 if(!file)return failure('File is unavailable.',404);
 if(file.kind!=='content'||file.version!==file.current_version)return failure('A current content version is required.',409);
 const type=publicUrlMediaType(file.content_type);
 if(!type)return failure('Permanent public URLs are limited to image, video, audio, and font files.',415);
 if(file.size>25*1024*1024||file.size<0||!file.object_key)return failure('File content is unavailable.',404);
 const existing=await env.DB.prepare(`SELECT p.id,p.org_id,p.file_id,p.version,p.token_hash FROM hx_workspace_file_public_urls p
  WHERE p.org_id=?1 AND p.file_id=?2 AND p.version=?3
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=p.org_id AND gone.file_id=p.file_id AND gone.version=p.version)`)
  .bind(orgId,fileId,file.version).first();
 if(existing){
  const token=await tokenFor(env,existing);if(!token)return failure('Workspace encryption is unavailable.',503);
  if(hashToken(token)!==existing.token_hash)return failure('Public URL signing key is unavailable for this link.',409);
  return {url:publicPath(baseUrl,token),version:file.version,contentType:type,reused:true};
 }
 const id=newPublicId(),token=await tokenFor(env,{org_id:orgId,file_id:fileId,version:file.version,id});
 if(!token)return failure('Workspace encryption is unavailable.',503);
 const tokenHash=hashToken(token),now=new Date().toISOString();
 const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO hx_workspace_file_public_urls(org_id,file_id,version,id,token_hash,created_by,created_login,created_at)
  SELECT f.org_id,f.id,f.current_version,?4,?5,?6,?7,?8 FROM hx_workspace_files f
   JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
  WHERE f.org_id=?1 AND f.id=?2 AND f.current_version=?3 AND v.kind='content' AND v.content_type=?9 AND v.object_key=?10
   AND ${fileScopeAuthority('f.org_id','f.scope','?6')}
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=v.org_id AND gone.file_id=v.file_id AND gone.version=v.version)`)
  .bind(orgId,fileId,file.version,id,tokenHash,String(userId),String(login||''),now,file.content_type,file.object_key).run();
 const winner=await env.DB.prepare(`SELECT p.id,p.org_id,p.file_id,p.version,p.token_hash FROM hx_workspace_file_public_urls p
  JOIN hx_workspace_files f ON f.org_id=p.org_id AND f.id=p.file_id
  WHERE p.org_id=?1 AND p.file_id=?2 AND p.version=?3 AND f.current_version=?3
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=p.org_id AND gone.file_id=p.file_id AND gone.version=p.version)`)
  .bind(orgId,fileId,file.version).first();
 if(!winner)return failure('The file changed or became unavailable. Refresh it before publishing.',409);
 const winnerToken=await tokenFor(env,winner);if(!winnerToken)return failure('Workspace encryption is unavailable.',503);
 if(hashToken(winnerToken)!==winner.token_hash)return failure('Public URL signing key is unavailable for this link.',409);
 return {url:publicPath(baseUrl,winnerToken),version:winner.version,contentType:type,reused:inserted.meta?.changes!==1};
}

export async function revokeFilePublicUrls(db,{orgId,fileId,userId}){
 if(!await allowed(db,orgId,String(userId),'harness.build'))return failure('Current file write access is required.',403);
 const manager=await db.prepare(`SELECT 1 AS ok FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2
  AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
  AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')}`).bind(orgId,fileId,String(userId)).first();
 if(!manager)return failure('File is unavailable.',404);
 const result=await db.prepare(`DELETE FROM hx_workspace_file_public_urls WHERE org_id=?1 AND file_id=?2
  AND EXISTS(SELECT 1 FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2)`)
  .bind(orgId,fileId).run();
 return {revoked:true,count:result.meta?.changes||0};
}

async function activePublicUrl(env,token){
 const parts=tokenParts(token);if(!parts)return null;
 const tokenHash=hashToken(token);
 let row;
 try{
  row=await env.DB.prepare(`SELECT p.id,p.org_id,p.file_id,p.version,p.token_hash,v.object_key,v.content_type,v.size,f.path
   FROM hx_workspace_file_public_urls p
   JOIN hx_workspace_files f ON f.org_id=p.org_id AND f.id=p.file_id
   JOIN hx_workspace_file_versions v ON v.org_id=p.org_id AND v.file_id=p.file_id AND v.version=p.version
   JOIN hx_workspace_file_versions current ON current.org_id=f.org_id AND current.file_id=f.id AND current.version=f.current_version
   WHERE p.id=?1 AND p.token_hash=?2 AND v.kind='content' AND current.kind='content'
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=p.org_id AND gone.file_id=p.file_id AND gone.version=p.version)`)
   .bind(parts.id,tokenHash).first();
 }catch{return null;}
 if(!row||row.id!==parts.id||!await validToken(env,row,token,parts.signatureBytes))return null;
 const contentType=publicUrlMediaType(row.content_type);
 if(!contentType||row.size<0||row.size>25*1024*1024||!row.object_key)return null;
 return {...row,content_type:contentType};
}

function responseHeaders(row,{range=null,status=200}={}){
 const headers={
  'content-type':row.content_type,
  'content-disposition':`inline; filename*=UTF-8''${safeFilename(row.path)}`,
  'content-length':String(range?range.length:row.size),
  'cache-control':'public, max-age=86400, s-maxage=86400, immutable',
  'cdn-cache-control':'public, max-age=86400, immutable',
  'x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  'cross-origin-resource-policy':'cross-origin',
  'access-control-allow-origin':'*',
  'referrer-policy':'no-referrer',
  'x-robots-tag':'noindex, nofollow, noarchive',
  'accept-ranges':'bytes',
 };
 if(range){headers['content-range']=`bytes ${range.offset}-${range.offset+range.length-1}/${row.size}`;}
 return headers;
}

export async function servePublicFileUrl(request,env,token){
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405,headers:{'allow':'GET, HEAD','cache-control':'no-store'}});
 const row=await activePublicUrl(env,token);if(!row)return safeFailure('Not found');
 if(!env.MEDIA)return safeFailure('Not found');
 const range=request.headers.has('if-range')?null:byteRange(request.headers.get('range'),row.size);
 if(range===UNSATISFIABLE)return new Response(null,{status:416,headers:{'cache-control':'no-store','content-range':`bytes */${row.size}`,'x-content-type-options':'nosniff'}});
 const object=request.method==='HEAD'?await env.MEDIA.head(row.object_key):await env.MEDIA.get(row.object_key,range?{range}:undefined);
 if(!object||object.size!==row.size){await object?.body?.cancel?.().catch(()=>{});return safeFailure('Not found');}
 const stillActive=await activePublicUrl(env,token);
 if(!stillActive||stillActive.id!==row.id){await object?.body?.cancel?.().catch(()=>{});return safeFailure('Not found');}
 return new Response(request.method==='HEAD'?null:object.body,{status:range?206:200,headers:responseHeaders(row,{range})});
}

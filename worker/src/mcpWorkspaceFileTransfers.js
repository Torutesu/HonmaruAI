import { allowed } from './permissions.js';
import { getMode } from './harness/mode.js';
import { uploadFileVersion } from './harness/fileUpload.js';
import { downloadFileVersion } from './harness/fileDownload.js';
import { readFileVersionContent, FileVersionInputError } from './harness/fileVersionLedger.js';
import { announceFileChanged } from './harness/fileEvents.js';
import { audit, person } from './audit.js';

const MAX_BYTES=25*1024*1024;
const headers={'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*','x-content-type-options':'nosniff'};
const connection=actor=>actor.grantId?`oauth:${actor.grantId}`:`pat:${actor.tokenId}`;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});

async function collect(request,size){
 if(!request.body)throw new FileVersionInputError('Upload body is required.');
 const reader=request.body.getReader(),chunks=[];let total=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>size||total>MAX_BYTES)throw new FileVersionInputError('Upload length differs from the reservation.');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 if(total!==size)throw new FileVersionInputError('Upload length differs from the reservation.');
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

export async function handleMcpWorkspaceFileTransfer(request,env,url,actor){
 const uploadMatch=/^\/mcp\/workspace-uploads\/([a-f0-9-]{36})$/.exec(url.pathname);
 const downloadMatch=/^\/mcp\/workspace-files\/([^/]+)\/versions\/([1-9][0-9]*)\/content$/.exec(url.pathname);
 if(!uploadMatch&&!downloadMatch)return null;
 const method=uploadMatch?'PUT':'GET';
 if(request.method!==method)return new Response(null,{status:405,headers:{...headers,allow:method}});
 const required=uploadMatch?'write':'read';
 if(!actor.scopes?.includes(required))return json({message:`This connection requires the ${required} permission.`},403);
 if(await getMode(env.DB,actor.orgId)!=='harness')return json({message:'Workspace file transfers require Harness mode.'},403);
 if(uploadMatch&&!await allowed(env.DB,actor.orgId,actor.githubId,'harness.build'))return json({message:'File changes are not allowed.'},403);
 try{
  if(downloadMatch){
   let fileId;try{fileId=decodeURIComponent(downloadMatch[1]);}catch{throw new FileVersionInputError('Invalid file identifier.');}
   const version=Number(downloadMatch[2]);if(!Number.isSafeInteger(version)||version<1)throw new FileVersionInputError('Invalid file version.');
   const response=await downloadFileVersion(env,{orgId:actor.orgId,userId:String(actor.githubId),fileId,version});
   return response||json({message:'File content is unavailable.'},404);
  }
  const id=uploadMatch[1],upload=await env.DB.prepare(`SELECT * FROM hx_mcp_workspace_file_uploads
   WHERE org_id=?1 AND id=?2 AND actor_id=?3 AND connection_id=?4`).bind(actor.orgId,id,String(actor.githubId),connection(actor)).first();
  if(!upload||upload.expires_at<Date.now())return json({message:'This upload reservation is unavailable or expired.'},404);
  const length=Number(request.headers.get('content-length'));
  const contentType=request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(length!==upload.size||contentType!==upload.content_type)return json({message:'Upload headers must match the reservation.'},400);
  const bytes=await collect(request,upload.size);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(hash!==upload.content_hash)return json({message:'Upload bytes do not match the reserved SHA-256.'},400);
  if(upload.state==='complete'){
   const saved=await readFileVersionContent(env.DB,{orgId:actor.orgId,userId:String(actor.githubId),fileId:upload.file_id,version:1});
   if(!saved||saved.contentHash!==upload.content_hash)return json({message:'The completed file is no longer available.'},404);
   return json({fileId:upload.file_id,version:1,saved:true,replayed:true});
  }
  if(upload.state!=='pending')return json({message:'This upload is already in progress. Retry with the same request after it settles.'},409);
  const claimed=await env.DB.prepare("UPDATE hx_mcp_workspace_file_uploads SET state='uploading' WHERE org_id=?1 AND id=?2 AND actor_id=?3 AND connection_id=?4 AND state='pending' AND expires_at>?5")
   .bind(actor.orgId,id,String(actor.githubId),connection(actor),Date.now()).run();
  if(!claimed.meta?.changes)return json({message:'This upload was already started.'},409);
  try{
   const saved=await uploadFileVersion(env,{orgId:actor.orgId,fileId:upload.file_id,userId:String(actor.githubId),expectedVersion:0,size:upload.size,contentType:upload.content_type,stream:new Blob([bytes]).stream()});
   if(!saved.saved)return json({message:'File creation conflicted or access changed. Reserve a new upload before retrying.'},409);
   await env.DB.prepare("UPDATE hx_mcp_workspace_file_uploads SET state='complete',expires_at=?3 WHERE org_id=?1 AND id=?2 AND state='uploading'")
    .bind(actor.orgId,id,Date.now()+24*60*60*1000).run();
   await audit(env,request,{orgId:actor.orgId,action:'workspace.file_changed',actor:person({login:actor.login,name:actor.name}),entity:{type:'file',id:upload.file_id},details:{source:'mcp',tokenId:actor.tokenId||null,operation:'create_file_upload',version:saved.version}});
   await announceFileChanged(env,actor.orgId,upload.file_id);
   return json({fileId:upload.file_id,version:saved.version,saved:true});
  }catch(error){
   await env.DB.prepare("UPDATE hx_mcp_workspace_file_uploads SET state='pending' WHERE org_id=?1 AND id=?2 AND state='uploading'").bind(actor.orgId,id).run().catch(()=>{});
   throw error;
  }
 }catch(error){
  if(error instanceof FileVersionInputError)return json({message:error.message},400);
  console.error('MCP workspace file transfer failed',error?.message||error);
  return json({message:'The file transfer could not be completed.'},503);
 }
}

export async function pruneMcpWorkspaceFileUploads(db,{now=Date.now(),limit=100}={}){
 if(!Number.isSafeInteger(now)||!Number.isInteger(limit)||limit<1||limit>1000)throw new TypeError('Invalid workspace file transfer pruning bounds.');
 const result=await db.prepare(`DELETE FROM hx_mcp_workspace_file_uploads WHERE rowid IN
  (SELECT rowid FROM hx_mcp_workspace_file_uploads WHERE (expires_at<=?1 AND state IN ('pending','complete','failed'))
   OR (expires_at<=?2 AND state='uploading') ORDER BY expires_at,id LIMIT ?3)`).bind(now,now-60*60*1000,limit).run();
 return {deleted:result.meta?.changes||0};
}

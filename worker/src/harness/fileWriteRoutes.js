import {createFileLedger,appendFileVersion,FileVersionInputError} from './fileVersionLedger.js';
import {uploadFileVersion,restoreFileVersion} from './fileUpload.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {workspaceFilePath} from './fileVersionLedger.js';
import {purgeFileVersion,purgeDeletedFile} from './filePurge.js';

async function input(request) {
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||!request.body)throw new FileVersionInputError('JSON input is required.');
 const reader=request.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192)throw new FileVersionInputError('File command is too large.');chunks.push(value);}
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new FileVersionInputError('Invalid JSON command.');}
}
// Outer member() authentication supplies identity, build permission
// and principal type. None of those decisions come from command JSON.
export async function handleFileWrites(request,env,url,{orgId,userId,canWrite,principalType,headers={}}) {
 if(!/^\/hx\/files(?:\/|$)/.test(url.pathname))return null;
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'content-type':'application/json','cache-control':'private, no-store'}});
 if(canWrite!==true)return json({message:'File changes are not allowed.'},403);
 try{
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length===2&&request.method==='POST'){
   const command=await input(request);
   if(command.requestId!==undefined && (typeof command.requestId!=='string'||!/^file-[a-f0-9-]{36}$/.test(command.requestId)))throw new FileVersionInputError('Invalid file request identifier.');
   const fileId=command.requestId||crypto.randomUUID(),path=workspaceFilePath(command.path);
   const result=await createFileLedger(env.DB,{orgId,fileId,scope:command.scope,path,createdBy:userId});
   if(result.created)return json({id:fileId,version:0},201);
   // A lost create response may be replayed only by its original author,
   // for this exact path/scope, while it still has no content.
   if(command.requestId){
    const existing=await env.DB.prepare(`SELECT f.id FROM hx_workspace_files f WHERE f.org_id=?1 AND f.id=?2 AND f.scope=?3 AND f.path=?4 AND f.created_by=?5 AND f.current_version=0 AND ${fileScopeAuthority('f.org_id','f.scope','?5')}`).bind(orgId,fileId,command.scope,path,userId).first();
    if(existing)return json({id:existing.id,version:0});
   }
   return json({message:'File path is unavailable.'},409);
  }
  let fileId;try{fileId=decodeURIComponent(parts[2]);}catch{throw new FileVersionInputError('Invalid file identifier.');}
  const identity={orgId,fileId,userId};let result;
  if(parts.length===4&&parts[3]==='content'&&request.method==='PUT'){
   const number=name=>{const value=url.searchParams.get(name);if(!/^(0|[1-9]\d*)$/.test(value??'')||!Number.isSafeInteger(Number(value)))throw new FileVersionInputError(`Invalid ${name}.`);return Number(value);};
   result=await uploadFileVersion(env,{...identity,expectedVersion:number('expectedVersion'),size:number('size'),contentType:request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()||'application/octet-stream',stream:request.body});
  }else if(parts.length===4&&parts[3]==='restore'&&request.method==='POST'){
   const command=await input(request);result=await restoreFileVersion(env,{...identity,version:command.version,expectedVersion:command.expectedVersion});
  }else if(parts.length===3&&request.method==='DELETE'){
   const command=await input(request);result=await appendFileVersion(env.DB,{orgId,fileId,createdBy:userId,expectedVersion:command.expectedVersion,kind:'deleted'});
  }else if(parts.length===4&&parts[3]==='purge'&&request.method==='POST'){
   if(principalType!=='human')return json({message:'A human must perform permanent deletion.'},403);
   const command=await input(request);
   result=command.version===undefined?await purgeDeletedFile(env.DB,{...identity,expectedVersion:command.expectedVersion,reason:command.reason}):await purgeFileVersion(env.DB,{...identity,version:command.version,reason:command.reason});
   return json(result,result.purged||result.purgedCount>0?200:409);
  }else return json({message:'Method or file operation not found.'},405);
  return json(result,result.saved?200:409);
 }catch(error){if(error instanceof FileVersionInputError)return json({message:error.message},400);throw error;}
}

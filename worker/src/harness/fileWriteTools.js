import {announceFileChanged} from './fileEvents.js';
import {createHash} from 'node:crypto';
import {getMode} from './mode.js';
import {allowed} from '../permissions.js';
import {audit} from '../audit.js';
import {FileVersionInputError,readFileVersionContent,createFileLedger,workspaceFilePath,appendFileVersion} from './fileVersionLedger.js';
import {uploadFileVersion,restoreFileVersion} from './fileUpload.js';
import {proposePublicFileShare} from './fileShareApprovals.js';
import {fileScopeAuthority,roomAgentFileAuthority} from './fileAuthority.js';

const textTypes=['text/plain','text/markdown','text/csv','text/html','application/json','application/xml','application/yaml','application/javascript'];
export const FILE_WRITE_TOOLS=[{
 name:'create_file_text',
 description:'Create a new UTF-8 text file in an explicit accessible room scope when requested by the user. Requires write scope and workspace build permission. Up to 128 KiB. Pass a stable requestId of file- followed by a UUID; reuse it with identical scope, path, text and contentType for retries. Never overwrites an existing path. Records agent creation, stores immutable version 1, and does not execute the content. Use list_workspace_files to discover saved results.',
 inputSchema:{type:'object',properties:{scope:{type:'string'},path:{type:'string'},requestId:{type:'string'},text:{type:'string',maxLength:131072},contentType:{type:'string',enum:textTypes}},required:['scope','path','requestId','text','contentType'],additionalProperties:false},
},{
 name:'request_public_file_share',
 description:'Request approval to publish the exact current version of a file as a public snapshot. Requires Harness mode, write scope, workspace build permission, and current file access. This creates only a pending approval request; it never creates or reveals a public token. An owner or current workspace/Room administrator must approve it in the Workspace UI. Call only when the user explicitly asks to request a public share.',
 inputSchema:{type:'object',properties:{fileId:{type:'string',minLength:1,maxLength:200},version:{type:'integer',minimum:1},requestKey:{type:'string',pattern:'^[-A-Za-z0-9_]{16,100}$'},expiresIn:{type:'integer',enum:[86400,604800,2592000]},allowDownload:{type:'boolean'}},required:['fileId','version','requestKey','expiresIn','allowDownload'],additionalProperties:false},
},{
 name:'create_file_upload',
 description:'Reserve a binary workspace file upload. Requires write scope and workspace build permission. Supply a stable file-UUID requestId, explicit accessible scope and path, exact byte size, MIME type, and SHA-256. PUT the identical bytes and headers to the returned short-lived uploadUrl. The file remains versioned and scoped by the same live workspace authority as other files.',
 inputSchema:{type:'object',properties:{scope:{type:'string',minLength:1,maxLength:200},path:{type:'string',minLength:1,maxLength:1024},requestId:{type:'string',pattern:'^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'},contentType:{type:'string',minLength:1,maxLength:200},size:{type:'integer',minimum:0,maximum:25*1024*1024},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['scope','path','requestId','contentType','size','sha256'],additionalProperties:false},
},{
 name:'update_file_text',
 description:'Save edited UTF-8 text as a new immutable version of an existing accessible file, only when the user requested the edit. Requires write scope and workspace build permission. Read the file first and supply its exact current expectedVersion. Stale edits fail; never retry using a newer version without reading and reconciling it. Maximum 128 KiB. Retains the content type. Does not create files, execute content, or alter sharing.',
 inputSchema:{type:'object',properties:{fileId:{type:'string'},expectedVersion:{type:'integer',minimum:1},text:{type:'string',maxLength:131072}},required:['fileId','expectedVersion','text'],additionalProperties:false},
},{
 name:'delete_file',
 description:'Move an accessible file to the deleted state while retaining its version history. Requires write scope and workspace build permission, plus the existing file delete authority. Supply the exact current expectedVersion; deletion removes public links. This is reversible by restoring a prior content version. Permanent purge is human-only.',
 inputSchema:{type:'object',properties:{fileId:{type:'string'},expectedVersion:{type:'integer',minimum:1}},required:['fileId','expectedVersion'],additionalProperties:false},
},{
 name:'restore_file_version',
 description:'Restore a prior unpurged content version as a new immutable current version. Requires write scope and workspace build permission. Read file history first and supply the exact current expectedVersion and source version. Stale restores fail; purged content cannot be restored.',
 inputSchema:{type:'object',properties:{fileId:{type:'string'},expectedVersion:{type:'integer',minimum:1},version:{type:'integer',minimum:1}},required:['fileId','expectedVersion','version'],additionalProperties:false},
}];
const error=message=>({isError:true,content:[{type:'text',text:message}]});
export async function callFileWriteTool(env,agent,name,args={}) {
 if(!FILE_WRITE_TOOLS.some(tool=>tool.name===name))return null;
 if(await getMode(env.DB,agent.orgId)!=='harness')return error('File tools require harness mode.');
 const userId=String(agent.githubId),orgId=agent.orgId;
 if(!await allowed(env.DB,orgId,userId,'harness.build'))return error('File changes are not allowed.');
 if(!args||typeof args!=='object'||Array.isArray(args))return error('Invalid file arguments.');
 if(name==='request_public_file_share'){
  if(typeof args.fileId!=='string'||!args.fileId.trim()||!Number.isSafeInteger(args.version)||args.version<1||typeof args.requestKey!=='string'||!/^[-A-Za-z0-9_]{16,100}$/.test(args.requestKey)||![86400,604800,2592000].includes(args.expiresIn)||typeof args.allowDownload!=='boolean')return error('A file ID, current version, stable requestKey, supported expiry, and download permission are required.');
  const request=await proposePublicFileShare(env,{orgId,fileId:args.fileId,version:args.version,userId,login:agent.login,requestKey:args.requestKey,expiresIn:args.expiresIn,allowDownload:args.allowDownload});
  if(request.error)return error(request.error);
  return success(request);
 }
 if(name==='create_file_upload')return createBinaryUpload(env,agent,args);
 const ready=await env.DB.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges','hx_workspace_file_uploads','hx_file_account_erasures','hx_workspace_file_origins')").first();
 if(ready.count!==6)return error('Workspace files are not available yet.');
 let bytes=null;
 if(name==='create_file_text'||name==='update_file_text'){
  if(typeof args.text!=='string'||args.text.length>128*1024)return error('Text writes are limited to 128 KiB.');
  bytes=new TextEncoder().encode(args.text);
  if(bytes.length>128*1024)return error('Text writes are limited to 128 KiB.');
  // Reject unpaired UTF-16 surrogates rather than silently saving replacements.
  if(new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes)!==args.text)return error('Text must contain valid Unicode.');
 }
 try {
  if(name==='create_file_text')return await createText(env,agent,args,bytes);
  if(name==='delete_file'){
   if(!Number.isSafeInteger(args.expectedVersion)||args.expectedVersion<1)return error('A positive expectedVersion is required.');
   const current=await env.DB.prepare(`SELECT v.kind FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version WHERE f.org_id=?1 AND f.id=?2 AND f.current_version=?3`).bind(orgId,args.fileId,args.expectedVersion).first();
   if(!current||current.kind!=='content')return error('File is unavailable, already deleted, or changed. Read its current version before deleting.');
   const saved=await appendFileVersion(env.DB,{orgId,fileId:args.fileId,createdBy:userId,expectedVersion:args.expectedVersion,kind:'deleted'});
   if(!saved.saved)return error('The file changed or is unavailable. Read its current version before deleting again.');
   await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:args.fileId},details:{source:agent.source||'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'delete_file',version:saved.version}});
   await announceFileChanged(env,orgId,args.fileId);
   return success({fileId:args.fileId,version:saved.version,deleted:true});
  }
  if(name==='restore_file_version'){
   if(!Number.isSafeInteger(args.expectedVersion)||args.expectedVersion<1||!Number.isSafeInteger(args.version)||args.version<1||args.version>args.expectedVersion)return error('Valid expectedVersion and source version are required.');
   const restored=await restoreFileVersion(env,{orgId,fileId:args.fileId,userId,expectedVersion:args.expectedVersion,version:args.version});
   if(!restored.saved)return error('The source version is unavailable, purged, or the file changed. Read its current history before restoring.');
   await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:args.fileId},details:{source:agent.source||'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'restore_file_version',version:restored.version,restoredFrom:args.version}});
   await announceFileChanged(env,orgId,args.fileId);
   return success({fileId:args.fileId,version:restored.version,restoredFrom:args.version,saved:true});
  }
  const file={orgId,userId,fileId:args.fileId};
  const source=await readFileVersionContent(env.DB,{...file,version:args.expectedVersion});
  if(!source)return error('File content is unavailable.');
  const mime=source.contentType.split(';')[0].trim().toLowerCase();
  if(!mime.startsWith('text/')&&!['application/json','application/xml','application/yaml','application/javascript'].includes(mime))return error('This file is not text.');
  const saved=await uploadFileVersion(env,{...file,expectedVersion:args.expectedVersion,size:bytes.length,contentType:mime,stream:new Blob([bytes]).stream(),
   ...(agent.fileRoomWrite?{authoritySql:`${fileScopeAuthority('f.org_id','f.scope','?3')} AND ${roomAgentFileAuthority('?1','f.scope','?3',agent.fileRoomWrite.agentId,agent.fileRoomWrite.channel)}`,commitAuthoritySql:`${fileScopeAuthority('f.org_id','f.scope','?10')} AND ${roomAgentFileAuthority('?1','f.scope','?10',agent.fileRoomWrite.agentId,agent.fileRoomWrite.channel)}`}:{})});
  if(!saved.saved)return error('The file changed or is unavailable. Read its current version before editing again.');
  await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:args.fileId},details:{source:agent.source||'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'update_file_text',version:saved.version}});
  await announceFileChanged(env,orgId,args.fileId);
  const result={fileId:args.fileId,version:saved.version,saved:true};
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
 }catch(e){if(e instanceof FileVersionInputError)return error(e.message);throw e;}
}

async function createBinaryUpload(env,agent,args){
 if(typeof args.requestId!=='string'||!/^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.requestId))return error('A stable file UUID requestId is required.');
 if(typeof args.contentType!=='string'||!/^[\w.+-]+\/[\w.+-]+$/.test(args.contentType)||args.contentType.length>200)return error('Invalid content type.');
 if(!Number.isSafeInteger(args.size)||args.size<0||args.size>25*1024*1024||!/^[a-f0-9]{64}$/i.test(args.sha256||''))return error('Invalid binary file size or SHA-256.');
 let path;try{path=workspaceFilePath(args.path)}catch(e){if(e instanceof FileVersionInputError)return error(e.message);throw e;}
 const orgId=agent.orgId,userId=String(agent.githubId),fileId=args.requestId;
 const connectionId=agent.grantId?`oauth:${agent.grantId}`:`pat:${agent.tokenId}`;
 const payload=JSON.stringify({scope:args.scope,path,contentType:args.contentType.toLowerCase(),size:args.size,sha256:args.sha256.toLowerCase()});
 const digest=createHash('sha256').update(payload).digest('hex');
 const requestKey=[orgId,userId,connectionId,args.requestId];
 const prior=await env.DB.prepare('SELECT * FROM hx_mcp_workspace_file_uploads WHERE org_id=?1 AND actor_id=?2 AND connection_id=?3 AND request_id=?4').bind(...requestKey).first();
 if(prior){
  if(prior.payload_hash!==digest)return error('This requestId was already used with different input.');
  if(prior.state==='complete')return success({fileId:prior.file_id,version:1,saved:true,replayed:true});
  if(prior.state==='pending'&&prior.expires_at>Date.now())return success({fileId:prior.file_id,uploadId:prior.id,uploadUrl:`/mcp/workspace-uploads/${prior.id}`,method:'PUT',contentType:prior.content_type,size:prior.size,expiresAt:prior.expires_at});
  if(prior.state==='uploading')return error('This upload is still in progress.');
  await env.DB.prepare('DELETE FROM hx_mcp_workspace_file_uploads WHERE org_id=?1 AND id=?2 AND state IN (\'pending\',\'failed\') AND expires_at<=?3').bind(orgId,prior.id,Date.now()).run();
 }
 let fileCreated=false;
 try{
  const created=await createFileLedger(env.DB,{orgId,fileId,scope:args.scope,path,createdBy:userId,origin:'agent'});
  if(!created.created){
   const existing=await env.DB.prepare(`SELECT f.current_version,v.content_type,v.size,v.content_hash FROM hx_workspace_files f
    LEFT JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
    JOIN hx_workspace_file_origins o ON o.org_id=f.org_id AND o.file_id=f.id
    WHERE f.org_id=?1 AND f.id=?2 AND f.created_by=?3 AND f.scope=?4 AND f.path=?5 AND o.source='agent'`).bind(orgId,fileId,userId,args.scope,path).first();
   if(existing?.current_version===1&&existing.content_type===args.contentType.toLowerCase()&&existing.size===args.size&&existing.content_hash===args.sha256.toLowerCase())return success({fileId,version:1,saved:true,replayed:true});
   if(existing?.current_version!==0)throw new FileVersionInputError('File path or request identifier is unavailable.');
  }else fileCreated=true;
  const uploadId=crypto.randomUUID(),now=Date.now(),expiresAt=now+15*60*1000;
  // The reserved row is a single-use, short-lived capability. The transfer
  // endpoint rechecks the live file audience before storing any bytes.
  await env.DB.prepare(`INSERT INTO hx_mcp_workspace_file_uploads(org_id,id,actor_id,connection_id,request_id,file_id,scope,path,content_type,size,content_hash,payload_hash,created_at,expires_at,state)
   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'pending')`).bind(orgId,uploadId,userId,connectionId,args.requestId,fileId,args.scope,path,args.contentType.toLowerCase(),args.size,args.sha256.toLowerCase(),digest,now,expiresAt).run();
  const result={fileId,uploadId,uploadUrl:`/mcp/workspace-uploads/${uploadId}`,method:'PUT',contentType:args.contentType.toLowerCase(),size:args.size,expiresAt};
  return success(result);
 }catch(e){
  if(fileCreated)await env.DB.prepare('DELETE FROM hx_workspace_files WHERE org_id=?1 AND id=?2 AND created_by=?3 AND current_version=0').bind(orgId,fileId,userId).run().catch(()=>{});
  if(e instanceof FileVersionInputError)return error(e.message);throw e;
 }
}

async function createText(env,agent,args,bytes){
 if(typeof args.requestId!=='string'||!/^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.requestId))throw new FileVersionInputError('A stable file UUID requestId is required.');
 if(!textTypes.includes(args.contentType))throw new FileVersionInputError('Unsupported text content type.');
 const orgId=agent.orgId,userId=String(agent.githubId),fileId=args.requestId,path=workspaceFilePath(args.path);
 const created=await createFileLedger(env.DB,{orgId,fileId,scope:args.scope,path,createdBy:userId,origin:'agent',
  ...(agent.fileRoomWrite?{authoritySql:roomAgentFileAuthority('?1','?3','?5',agent.fileRoomWrite.agentId,agent.fileRoomWrite.channel)}:{})});
 if(!created.created){
  // A retry may resume only this author's exact agent reservation. A human
  // reservation, different path or scope cannot be adopted by an agent call.
  const row=await env.DB.prepare(`SELECT f.current_version FROM hx_workspace_files f JOIN hx_workspace_file_origins o ON o.org_id=f.org_id AND o.file_id=f.id
   WHERE f.org_id=? AND f.id=? AND f.created_by=? AND f.scope=? AND f.path=? AND o.source='agent'`).bind(orgId,fileId,userId,args.scope,path).first();
  if(!row)return error('File path or request identifier is unavailable.');
  if(row.current_version!==0){
   const source=await readFileVersionContent(env.DB,{orgId,fileId,userId,version:1});
   if(row.current_version!==1||!source||source.contentType!==args.contentType||source.size!==bytes.length||source.contentHash!==createHash('sha256').update(bytes).digest('hex'))return error('This request already has different content or the file changed. Read its history before continuing.');
   return success({fileId,version:1,saved:true,replayed:true});
  }
 }
 const saved=await uploadFileVersion(env,{orgId,fileId,userId,expectedVersion:0,size:bytes.length,contentType:args.contentType,stream:new Blob([bytes]).stream(),
  ...(agent.fileRoomWrite?{authoritySql:`${fileScopeAuthority('f.org_id','f.scope','?3')} AND ${roomAgentFileAuthority('?1','f.scope','?3',agent.fileRoomWrite.agentId,agent.fileRoomWrite.channel)}`,commitAuthoritySql:`${fileScopeAuthority('f.org_id','f.scope','?10')} AND ${roomAgentFileAuthority('?1','f.scope','?10',agent.fileRoomWrite.agentId,agent.fileRoomWrite.channel)}`}:{})});
 if(!saved.saved)return error('File creation conflicted or access changed. Retry the same request to check the saved result.');
 await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:fileId},details:{source:agent.source||'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'create_file_text',version:saved.version}});
 await announceFileChanged(env,orgId,fileId);
 return success({fileId,version:saved.version,saved:true,replayed:false});
}
const success=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});

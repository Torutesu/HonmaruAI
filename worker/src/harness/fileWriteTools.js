import {createHash} from 'node:crypto';
import {getMode} from './mode.js';
import {allowed} from '../permissions.js';
import {audit} from '../audit.js';
import {FileVersionInputError,readFileVersionContent,createFileLedger,workspaceFilePath} from './fileVersionLedger.js';
import {uploadFileVersion} from './fileUpload.js';

const textTypes=['text/plain','text/markdown','text/csv','text/html','application/json','application/xml','application/yaml','application/javascript'];
export const FILE_WRITE_TOOLS=[{
 name:'create_file_text',
 description:'Create a new UTF-8 text file in an explicit accessible room scope when requested by the user. Requires write scope and workspace build permission. Up to 128 KiB. Pass a stable requestId of file- followed by a UUID; reuse it with identical scope, path, text and contentType for retries. Never overwrites an existing path. Records agent creation, stores immutable version 1, and does not execute the content. Use list_workspace_files to discover saved results.',
 inputSchema:{type:'object',properties:{scope:{type:'string'},path:{type:'string'},requestId:{type:'string'},text:{type:'string',maxLength:131072},contentType:{type:'string',enum:textTypes}},required:['scope','path','requestId','text','contentType'],additionalProperties:false},
},{
 name:'update_file_text',
 description:'Save edited UTF-8 text as a new immutable version of an existing accessible file, only when the user requested the edit. Requires write scope and workspace build permission. Read the file first and supply its exact current expectedVersion. Stale edits fail; never retry using a newer version without reading and reconciling it. Maximum 128 KiB. Retains the content type. Does not create files, execute content, or alter sharing.',
 inputSchema:{type:'object',properties:{fileId:{type:'string'},expectedVersion:{type:'integer',minimum:1},text:{type:'string',maxLength:131072}},required:['fileId','expectedVersion','text'],additionalProperties:false},
}];
const error=message=>({isError:true,content:[{type:'text',text:message}]});
export async function callFileWriteTool(env,agent,name,args={}) {
 if(!FILE_WRITE_TOOLS.some(tool=>tool.name===name))return null;
 if(await getMode(env.DB,agent.orgId)!=='harness')return error('File tools require harness mode.');
 const userId=String(agent.githubId),orgId=agent.orgId;
 if(!await allowed(env.DB,orgId,userId,'harness.build'))return error('File changes are not allowed.');
 if(!args||typeof args!=='object'||Array.isArray(args)||typeof args.text!=='string'||args.text.length>128*1024)return error('Text writes are limited to 128 KiB.');
 const bytes=new TextEncoder().encode(args.text);
 if(bytes.length>128*1024)return error('Text writes are limited to 128 KiB.');
 // Reject unpaired UTF-16 surrogates rather than silently saving replacements.
 if(new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes)!==args.text)return error('Text must contain valid Unicode.');
 const ready=await env.DB.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges','hx_workspace_file_uploads','hx_file_account_erasures','hx_workspace_file_origins')").first();
 if(ready.count!==6)return error('Workspace files are not available yet.');
 try {
  if(name==='create_file_text')return await createText(env,agent,args,bytes);
  const file={orgId,userId,fileId:args.fileId};
  const source=await readFileVersionContent(env.DB,{...file,version:args.expectedVersion});
  if(!source)return error('File content is unavailable.');
  const mime=source.contentType.split(';')[0].trim().toLowerCase();
  if(!mime.startsWith('text/')&&!['application/json','application/xml','application/yaml','application/javascript'].includes(mime))return error('This file is not text.');
  const saved=await uploadFileVersion(env,{...file,expectedVersion:args.expectedVersion,size:bytes.length,contentType:mime,stream:new Blob([bytes]).stream()});
  if(!saved.saved)return error('The file changed or is unavailable. Read its current version before editing again.');
  await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:args.fileId},details:{source:agent.source||'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'update_file_text',version:saved.version}});
  const result={fileId:args.fileId,version:saved.version,saved:true};
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
 }catch(e){if(e instanceof FileVersionInputError)return error(e.message);throw e;}
}

async function createText(env,agent,args,bytes){
 if(typeof args.requestId!=='string'||!/^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.requestId))throw new FileVersionInputError('A stable file UUID requestId is required.');
 if(!textTypes.includes(args.contentType))throw new FileVersionInputError('Unsupported text content type.');
 const orgId=agent.orgId,userId=String(agent.githubId),fileId=args.requestId,path=workspaceFilePath(args.path);
 const created=await createFileLedger(env.DB,{orgId,fileId,scope:args.scope,path,createdBy:userId,origin:'agent'});
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
 const saved=await uploadFileVersion(env,{orgId,fileId,userId,expectedVersion:0,size:bytes.length,contentType:args.contentType,stream:new Blob([bytes]).stream()});
 if(!saved.saved)return error('File creation conflicted or access changed. Retry the same request to check the saved result.');
 await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:fileId},details:{source:agent.source||'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'create_file_text',version:saved.version}});
 return success({fileId,version:saved.version,saved:true,replayed:false});
}
const success=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});

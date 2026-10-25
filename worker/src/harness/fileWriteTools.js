import {getMode} from './mode.js';
import {allowed} from '../permissions.js';
import {audit} from '../audit.js';
import {FileVersionInputError,readFileVersionContent} from './fileVersionLedger.js';
import {uploadFileVersion} from './fileUpload.js';

export const FILE_WRITE_TOOLS=[{
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
 if(new TextDecoder().decode(bytes)!==args.text)return error('Text must contain valid Unicode.');
 const ready=await env.DB.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges','hx_workspace_file_uploads','hx_file_account_erasures')").first();
 if(ready.count!==5)return error('Workspace files are not available yet.');
 try {
  const file={orgId,userId,fileId:args.fileId};
  const source=await readFileVersionContent(env.DB,{...file,version:args.expectedVersion});
  if(!source)return error('File content is unavailable.');
  const mime=source.contentType.split(';')[0].trim().toLowerCase();
  if(!mime.startsWith('text/')&&!['application/json','application/xml','application/yaml','application/javascript'].includes(mime))return error('This file is not text.');
  const saved=await uploadFileVersion(env,{...file,expectedVersion:args.expectedVersion,size:bytes.length,contentType:mime,stream:new Blob([bytes]).stream()});
  if(!saved.saved)return error('The file changed or is unavailable. Read its current version before editing again.');
  await audit(env,null,{orgId,action:'workspace.file_changed',actor:{type:'user',id:agent.login,name:agent.name},entity:{type:'file',id:args.fileId},details:{source:'mcp',tokenId:agent.tokenId,agentName:agent.agentName,operation:'update_file_text',version:saved.version}});
  const result={fileId:args.fileId,version:saved.version,saved:true};
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
 }catch(e){if(e instanceof FileVersionInputError)return error(e.message);throw e;}
}

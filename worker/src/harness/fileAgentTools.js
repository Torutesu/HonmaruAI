import {getMode} from './mode.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {FILE_READ_TOOLS,callFileReadTool} from './fileTools.js';
import {FILE_WRITE_TOOLS,callFileWriteTool} from './fileWriteTools.js';

// Follow the existing own-agent write boundary. The canonical conversation
// scope comes from resolveChannel, never from model arguments.
export async function fileAgentTools(env,{orgId,session,personal,ownAgentsOnly,fileScope,taint}){
 if(!personal||!ownAgentsOnly||!session?.github_id||typeof fileScope!=='string'||!fileScope.startsWith('ag:'))return {};
 if(await getMode(env.DB,orgId)!=='harness')return {};
 const ready=await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_workspace_file_origins'").first();
 if(!ready)return {};
 const userId=String(session.github_id);
 const current=async()=>await env.DB.prepare(`SELECT a.name FROM custom_agents a JOIN users u ON u.github_id=?2
  WHERE a.org_id=?1 AND ?3='ag:'||a.id||'|'||u.login AND a.owner_login=u.login AND a.deleted_at IS NULL
  AND ${fileScopeAuthority('?1','?3','?2')}`).bind(orgId,userId,fileScope).first();
 const owner=await current();
 if(!owner)return {};
 const user=await env.DB.prepare('SELECT login,name FROM users WHERE github_id=?').bind(userId).first();
 const actor={orgId,githubId:userId,login:user.login,name:user.name,agentName:owner.name,source:'conversation'};
 return Object.fromEntries([...FILE_READ_TOOLS,...FILE_WRITE_TOOLS].map(tool=>{
  const {scope:unused,...properties}=tool.inputSchema.properties;
  return [tool.name,{
   description:tool.description+' This tool is restricted to files in this conversation; do not request other scopes. After saving, include the returned openUrl as a Markdown link so the user can open the file in this conversation.',
   parameters:{...tool.inputSchema,properties,required:tool.inputSchema.required.filter(key=>key!=='scope')},strict:false,
   run:async(args={})=>{
    if(!await current())return JSON.stringify({error:'This agent conversation is no longer available.'});
    if(!args||typeof args!=='object'||Array.isArray(args))return JSON.stringify({error:'Invalid file arguments.'});
    if(Object.hasOwn(args,'fileId')){
     const file=typeof args.fileId==='string'&&await env.DB.prepare('SELECT 1 FROM hx_workspace_files WHERE org_id=? AND id=? AND scope=?').bind(orgId,args.fileId,fileScope).first();
     if(!file)return JSON.stringify({error:'File is not in this conversation.'});
    }
    // Reading private file content must not be followed by a public URL read.
    if(taint)taint.value=true;
    const input={...args,scope:fileScope};
    const result=FILE_WRITE_TOOLS.some(t=>t.name===tool.name)?await callFileWriteTool(env,actor,tool.name,input):await callFileReadTool(env,actor,tool.name,input);
    if(result.structuredContent?.saved && result.structuredContent.fileId){
     const openUrl=conversationFileUrl(env.APP_WEB_URL,{orgId,fileScope,fileId:result.structuredContent.fileId});
     if(openUrl)result.structuredContent={...result.structuredContent,openUrl};
    }
    return JSON.stringify(result.structuredContent||{error:result.content?.[0]?.text||'File operation failed.'});
   },
  }];
 }));
}

// Keep links on the configured app deployment, without inherited URL secrets.
export function conversationFileUrl(webUrl,{orgId,fileScope,fileId}){
 try{
  const url=new URL(webUrl);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
  const channel=fileScope.slice(0,fileScope.lastIndexOf('|'));
  if(!channel.startsWith('ag:')||channel.length<=3)return null;
  url.search='';url.hash=`/c/${encodeURIComponent(channel)}?${new URLSearchParams({org:orgId,file:fileId})}`;
  return url.toString();
 }catch{return null;}
}

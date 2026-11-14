import {documentAgentTools} from './documentAgentTools.js';
import {mediaAgentTools} from './mediaGeneration.js';
import {getMode} from './mode.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {filterResponders} from './agents.js';
import {FILE_READ_TOOLS,callFileReadTool} from './fileTools.js';
import {FILE_WRITE_TOOLS,callFileWriteTool} from './fileWriteTools.js';
import {proposePublicFileShare} from './fileShareApprovals.js';

// Follow the existing own-agent write boundary. The canonical conversation
// scope comes from resolveChannel, never from model arguments.
export async function fileAgentTools(env,{orgId,session,personal,ownAgentsOnly,fileScope,taint,fileProposalAgentId=null,sourceMessageId=null,managedRoom=false}){
 const privateAgent=personal&&ownAgentsOnly&&typeof fileScope==='string'&&fileScope.startsWith('ag:');
 const sharedRoom=managedRoom&&typeof fileProposalAgentId==='string'&&typeof sourceMessageId==='string'&&['b:','g:'].some(prefix=>fileScope.startsWith(prefix));
 if((!privateAgent&&!sharedRoom)||!session?.github_id||typeof fileScope!=='string')return {};
 if(await getMode(env.DB,orgId)!=='harness')return {};
 const ready=await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_workspace_file_origins'").first();
 if(!ready)return {};
 const userId=String(session.github_id);
 if(sharedRoom){
  const user=await env.DB.prepare('SELECT login,name FROM users WHERE github_id=?').bind(userId).first();
  if(!user?.login)return {};
  const current=async()=>{
   const agentRow=await env.DB.prepare('SELECT id,scope,owner_login AS ownerLogin FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL').bind(orgId,fileProposalAgentId).first();
   if(!agentRow)return null;
   const rows=await filterResponders(env.DB,orgId,user.login,[agentRow],{named:new Set([agentRow.id]),channel:fileScope});
   if(!rows.length)return null;
   return await env.DB.prepare(`SELECT a.id,a.name,a.scope,a.owner_login AS ownerLogin FROM custom_agents a WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM channel_agents placed WHERE placed.org_id=a.org_id AND placed.channel=?3 AND placed.agent_id=a.id)
    AND ${fileScopeAuthority('?1','?3','?4')}`).bind(orgId,agentRow.id,fileScope,userId).first();
  };
  const currentAgent=await current();if(!currentAgent)return {};
  const actor={orgId,githubId:userId,login:user.login,name:user.name,agentName:currentAgent.name,source:'conversation',fileRoomWrite:{agentId:currentAgent.id,channel:fileScope}};
  const tools=Object.fromEntries([...FILE_READ_TOOLS,...FILE_WRITE_TOOLS.filter(t=>['create_file_text','update_file_text'].includes(t.name))].map(tool=>{
   const {scope:unused,...properties}=tool.inputSchema.properties;
   return [tool.name,{description:tool.description+' This tool is bound to the current Room; never provide or request another scope.',parameters:{...tool.inputSchema,properties,required:tool.inputSchema.required.filter(key=>key!=='scope')},strict:false,
    run:async(args={})=>{
     if(!await current())return JSON.stringify({error:'This Room Agent is no longer available.'});
     if(!args||typeof args!=='object'||Array.isArray(args))return JSON.stringify({error:'Invalid file arguments.'});
     if(Object.hasOwn(args,'fileId')){
      const file=typeof args.fileId==='string'&&await env.DB.prepare('SELECT 1 FROM hx_workspace_files WHERE org_id=? AND id=? AND scope=?').bind(orgId,args.fileId,fileScope).first();
      if(!file)return JSON.stringify({error:'File is not in this Room.'});
     }
     if(taint)taint.value=true;
     const input={...args,scope:fileScope};
     const result=FILE_WRITE_TOOLS.some(t=>t.name===tool.name)?await callFileWriteTool(env,actor,tool.name,input):await callFileReadTool(env,actor,tool.name,input);
     return JSON.stringify(result.structuredContent||{error:result.content?.[0]?.text||'File operation failed.'});
    }}];
  }));
  return {...tools,request_public_file_share:publicFileShareTool({env,orgId,userId,login:user.login,fileScope,sourceAgentId:currentAgent.id,sourceMessageId,sessionToken:session.token,taint,current})};
 }
 const current=async()=>await env.DB.prepare(`SELECT a.id,a.name FROM custom_agents a JOIN users u ON u.github_id=?2
  WHERE a.org_id=?1 AND ?3='ag:'||a.id||'|'||u.login AND a.owner_login=u.login AND a.deleted_at IS NULL
  AND ${fileScopeAuthority('?1','?3','?2')}`).bind(orgId,userId,fileScope).first();
 const owner=await current();
 if(!owner)return {};
 const user=await env.DB.prepare('SELECT login,name FROM users WHERE github_id=?').bind(userId).first();
 const actor={orgId,githubId:userId,login:user.login,name:user.name,agentName:owner.name,source:'conversation'};
 const fileTools=Object.fromEntries([...FILE_READ_TOOLS,...FILE_WRITE_TOOLS].map(tool=>{
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
 const publicShareTool=publicFileShareTool({env,orgId,userId,login:user.login,fileScope,sourceAgentId:owner.id,sourceMessageId,sessionToken:session.token,taint,current});
 const fileUrl=fileId=>conversationFileUrl(env.APP_WEB_URL,{orgId,fileScope,fileId});
 return {...fileTools,request_public_file_share:publicShareTool,...await documentAgentTools(env,{actor,fileScope,current,taint,fileUrl}),...await mediaAgentTools(env,{actor,fileScope,current,taint,fileUrl})};
}


function publicFileShareTool({env,orgId,userId,login,fileScope,sourceAgentId,sourceMessageId,sessionToken,taint,current=null}){
 return {
  description:'Request human approval to publish the current immutable version of a file in this conversation as a public snapshot. No public URL exists until an authorized person approves. Never use this after reading private file content in this turn.',
  parameters:{type:'object',properties:{fileId:{type:'string'},version:{type:'integer'},expiresIn:{type:'integer',enum:[86400,604800,2592000]},allowDownload:{type:'boolean'}},required:['fileId','version','expiresIn','allowDownload']},strict:false,
  run:async(args={})=>{
   if(current&&!await current())return JSON.stringify({error:'This agent conversation is no longer available.'});
   if(taint?.value)return JSON.stringify({error:'Public sharing is unavailable after private file content has been read in this turn.'});
   if(!args||typeof args.fileId!=='string'||!Number.isSafeInteger(args.version))return JSON.stringify({error:'A file ID and version are required.'});
   const file=await env.DB.prepare('SELECT 1 FROM hx_workspace_files WHERE org_id=? AND id=? AND scope=?').bind(orgId,args.fileId,fileScope).first();
   if(!file)return JSON.stringify({error:'File is not in this conversation.'});
   const result=await proposePublicFileShare(env,{orgId,fileId:args.fileId,version:args.version,userId,login,
    requestKey:crypto.randomUUID().replaceAll('-',''),expiresIn:args.expiresIn,allowDownload:args.allowDownload===true,
    sourceAgentId,sourceMessageId,sourceScope:fileScope,sourceSessionToken:sessionToken});
   return JSON.stringify(result);
  },
 };
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

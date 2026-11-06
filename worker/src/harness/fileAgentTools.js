import {documentAgentTools} from './documentAgentTools.js';
import {getMode} from './mode.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {FILE_READ_TOOLS,callFileReadTool} from './fileTools.js';
import {FILE_WRITE_TOOLS,callFileWriteTool} from './fileWriteTools.js';
import {requestAgentFileShare} from './fileShares.js';
import {announceCards} from '../announce.js';

// Follow the existing own-agent write boundary. The canonical conversation
// scope comes from resolveChannel, never from model arguments.
export async function fileAgentTools(env,{orgId,session,personal,ownAgentsOnly,fileScope,fileTurnId,agentId,taint}){
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
 const actor={orgId,githubId:userId,login:user.login,name:user.name,agentId,agentName:owner.name,source:'conversation'};
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
 const publicShareTool={
  request_file_public_share:{
   description:'Request approval to publish an exact immutable snapshot of a file in this private Agent conversation. No public URL exists until the owner approves. For a new share, give fileId, version, requestKey, and any expiry/download settings. For an existing reusable share, also give shareId to request an update; its current expiry and download setting are preserved. Never claim the link is ready before approval.',
   parameters:{type:'object',properties:{
    fileId:{type:'string',description:'File in this Agent conversation.'},version:{type:'integer',description:'Current immutable file version to publish.'},
    assets:{type:'array',items:{type:'object',properties:{fileId:{type:'string'},version:{type:'integer'}},required:['fileId','version'],additionalProperties:false},description:'Optional exact asset file versions in the same conversation.'},
    expiresIn:{type:'string',enum:['24h','7d','30d','never'],description:'Requested expiry for a new share; omitted update requests preserve the existing expiry.'},
    allowDownload:{type:'boolean',description:'Whether viewers may download the published content; omitted update requests preserve the existing setting.'},
    reusable:{type:'boolean',description:'Whether the same URL can be updated to later approved snapshots.'},
    requestKey:{type:'string',description:'Unique idempotency key for this approval request.'},shareId:{type:'string',description:'Existing active reusable share ID when requesting an update.'},
   },required:['fileId','version','requestKey'],additionalProperties:false},strict:false,
   run:async(args={})=>{
    if(!await current())return JSON.stringify({error:'This agent conversation is no longer available.'});
    if(!args||typeof args!=='object'||Array.isArray(args)||!Array.isArray(args.assets||[]))return JSON.stringify({error:'Invalid public share request.'});
    const refs=[args.fileId,...(args.assets||[]).map(item=>item?.fileId)];
    for(const id of refs){const found=typeof id==='string'&&await env.DB.prepare('SELECT 1 FROM hx_workspace_files WHERE org_id=?1 AND id=?2 AND scope=?3').bind(orgId,id,fileScope).first();if(!found)return JSON.stringify({error:'A file or asset is not in this conversation.'});}
    const result=await requestAgentFileShare(env,{orgId,userId:userId,login:user.login,agentId:actor.agentId,agentName:actor.agentName,
     channel:fileScope,turnId:fileTurnId,fileId:args.fileId,version:args.version,assets:args.assets||[],expiresIn:args.expiresIn,
     allowDownload:args.allowDownload,reusable:args.reusable,requestKey:args.requestKey,shareId:args.shareId||null});
    if(result.error)return JSON.stringify({error:result.error});
    if(result.created&&result.card)await announceCards(env,orgId,[result.card]);
    return JSON.stringify({request:result.request,approvalPending:result.request?.status==='pending',message:'Approval requested. A public URL is created only after approval.'});
   },
  },
 };
 return {...fileTools,...publicShareTool,...await documentAgentTools(env,{actor,fileScope,current,taint,fileUrl:fileId=>conversationFileUrl(env.APP_WEB_URL,{orgId,fileScope,fileId})})};
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

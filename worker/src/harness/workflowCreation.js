import {mirrorIds} from '../store/mirror.js';
import {workflowFromPrompt} from './workflowGeneration.js';
import {createWorkflow,getWorkflow,mayViewWorkflow} from './workflows.js';
import {workflowSource} from './workflowSource.js';
import {mayUseConversation} from './conversationAccess.js';
import {mayUseTable,visibleResources} from './resourceAccess.js';
import {listTables} from './tables.js';
import {listAgents} from '../customAgents.js';
import {mayAccessAgent} from './agents.js';
import {resolveChannel,postMessage,getMessage} from '../channels.js';
import {broadcastStored} from '../channelRoutes.js';
import {checkOutgoing} from '../dlp.js';
import {completer} from './model.js';

const conflict=()=>({error:'This automation is still being created. Try again shortly.',status:409});
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const leaseMs=120000;

// A generation request owns one prompt thread and one paused workflow. The
// publication transaction includes its lease fence and source binding.
export async function generateWorkflow(env,request,orgId,who,input,{makeCompleter=completer}={}){
 const by=String(who.session.github_id),login=who.user.login;
 const prompt=typeof input.prompt==='string'?input.prompt.trim():'';
 if(!prompt||prompt.length>4000)return {error:'Describe the automation in 1–4000 characters.',status:400};
 const requestId=input.requestId;
 if(requestId!==undefined&&(typeof requestId!=='string'||!/^[\w-]{16,100}$/.test(requestId)))return {error:'Invalid generation request ID.',status:400};
 if(input.captureSource&&!requestId)return {error:'A request ID is required to keep the source conversation.',status:400};
 let channel=null;
 if(input.channel){
  const room=await resolveChannel(env.DB,orgId,who.user,input.channel);
  if(!room||!await mayUseConversation(env.DB,orgId,by,room.key))return {error:'No such room.',status:403};
  channel=room.key;
 }
 if(input.captureSource&&!channel)return {error:'Choose a room for the source conversation.',status:400};
 const denied=await checkOutgoing(env,request,{orgId,login,text:prompt,ack:input.dlpAck===true,where:'workflow generation'});
 if(denied)return {response:denied};
 const fingerprint=await digest(JSON.stringify({prompt,channel,timezone:input.timezone||'UTC',captureSource:Boolean(input.captureSource),useModel:input.useModel!==false}));
 const announce=async workflowId=>{
  const id=`workflow-created-${workflowId}`;
  const message=await getMessage(env.DB,orgId,id);
  if(message&&!message.deleted_at){
   await mirrorIds(env.DB,orgId,[id]);
   await broadcastStored(env,orgId,message.channel,message).catch(()=>{});
  }
 };
 const token=crypto.randomUUID();
 const jobOf=()=>env.DB.prepare('SELECT * FROM hx_workflow_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(orgId,by,requestId).first();
 let job=null;
 if(requestId){
  await env.DB.prepare("INSERT OR IGNORE INTO hx_workflow_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status) VALUES(?,?,?,?,?,?,'running')")
   .bind(orgId,by,requestId,fingerprint,token,Date.now()+leaseMs).run();
  job=await jobOf();
  if(job.fingerprint!==fingerprint)return {error:'This request ID was already used for a different automation request.',status:409};
  if(job.status==='complete'){
   const workflow=await getWorkflow(env.DB,orgId,job.workflow_id,{viewerId:by});
   if(!workflow)return {error:'The generated automation is no longer available.',status:404};
   const origin=await workflowSource(env.DB,orgId,by,workflow.id);
   if(origin.error)return origin;
   await announce(workflow.id);
   return {workflow,source:JSON.parse(job.generated).source,replay:true};
  }
  if(job.lease_token!==token){
   const claimed=await env.DB.prepare("UPDATE hx_workflow_generation_jobs SET lease_token=?,lease_until=?,status='running' WHERE org_id=? AND user_id=? AND request_id=? AND fingerprint=? AND (status='failed' OR (status='running' AND lease_until<?))")
    .bind(token,Date.now()+leaseMs,orgId,by,requestId,fingerprint,Date.now()).run();
   if(!claimed.meta?.changes)return conflict();
   job=await jobOf();
  }
 }
 const release=async()=>{
  if(requestId)await env.DB.prepare("UPDATE hx_workflow_generation_jobs SET status='failed',lease_until=0 WHERE org_id=? AND user_id=? AND request_id=? AND lease_token=? AND status='running'")
   .bind(orgId,by,requestId,token).run();
 };
 try{
  let source;
  if(input.captureSource){
   const root=await postMessage(env.DB,{orgId,key:channel,authorLogin:login,body:prompt,clientId:'tmp-wf-'+await digest(JSON.stringify([orgId,by,requestId]))});
   if(root.error){await release();return root;}
   if(root.row.deleted_at||root.row.channel!==channel||root.row.body!==prompt){await release();return {error:'The source conversation changed. Start a new generation request.',status:409};}
   source={channel,threadId:root.row.id,body:prompt};
   if(!root.replay)await broadcastStored(env,orgId,channel,root.row).catch(()=>{});
  }
  let made=job?.generated?JSON.parse(job.generated):null;
  if(!made){
   const tables=await visibleResources(await listTables(env.DB,orgId),t=>mayUseTable(env.DB,orgId,t.id,by));
   const agents=[];
   for(const agent of await listAgents(env.DB,orgId,login))if(await mayAccessAgent(env.DB,orgId,agent,login))agents.push({id:agent.id,name:agent.name});
   const complete=input.useModel===false?null:await makeCompleter(env,orgId,by,'workflow_generate',{maxTokens:2400});
   made=await workflowFromPrompt(env.DB,orgId,by,{prompt,channel,timezone:input.timezone,complete,tables,agents});
   if(made.error){await release();return made;}
   if(requestId){
    const saved=await env.DB.prepare("UPDATE hx_workflow_generation_jobs SET generated=? WHERE org_id=? AND user_id=? AND request_id=? AND lease_token=? AND status='running' AND lease_until>?")
     .bind(JSON.stringify(made),orgId,by,requestId,token,Date.now()).run();
    if(!saved.meta?.changes)return conflict();
   }
  }
  const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=? AND user_github_id=? AND role!='guest'").bind(orgId,by).first();
  if(!member||(channel&&!await mayUseConversation(env.DB,orgId,by,channel))||!await mayViewWorkflow(env.DB,orgId,made.workflow,by)){
   await release();return {error:'The automation resources are no longer accessible.',status:403};
  }
  if(source){
   const root=await getMessage(env.DB,orgId,source.threadId);
   if(!root||root.deleted_at||root.parent_id||root.channel!==channel||root.body!==prompt){await release();return {error:'The source conversation changed. Start a new generation request.',status:409};}
  }
  const result=await createWorkflow(env.DB,orgId,{...made.workflow,enabled:false},by,{source,announcementLocale:who.user.locale||'en',
   ...(requestId?{commitGuard:id=>env.DB.prepare("UPDATE hx_workflow_generation_jobs SET workflow_id=CASE WHEN lease_token=? AND lease_until>? AND status='running' THEN ? ELSE NULL END,status='complete' WHERE org_id=? AND user_id=? AND request_id=?")
    .bind(token,Date.now(),id,orgId,by,requestId)}:{})});
  if(result.error){await release();return result;}
  if(result.announcementId)await announce(result.workflow.id);
  const {announcementId,...published}=result;
  return {...published,source:made.source};
 }catch(error){
  if(requestId){const current=await jobOf();if(current?.lease_token!==token||current.lease_until<=Date.now())return conflict();}
  await release();throw error;
 }
}

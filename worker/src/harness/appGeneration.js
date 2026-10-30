import { mirrorIds } from '../store/mirror.js';
import { appCreationSource, createApp, getApp, specFromPrompt } from './apps.js';
import { mayUseApp } from './resourceAccess.js';
import { mayUseConversation } from './conversationAccess.js';
import { resolveChannel, postMessage, getMessage } from '../channels.js';
import { broadcastStored } from '../channelRoutes.js';
import { checkOutgoing } from '../dlp.js';
import { completer } from './model.js';

const conflict = () => ({error:'This app is still being created. Try again shortly.',status:409});
const leaseMs = 120000;
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');

// The same request keeps its source thread and app across disconnects. A lease
// prevents two model calls in flight; a transaction fences an expired owner.
export async function generateApp(env, request, orgId, who, input, {makeCompleter=completer}={}) {
  const by=String(who.session.github_id), login=who.user.login;
  const prompt=typeof input.prompt==='string'?input.prompt.trim():'';
  if(!prompt || prompt.length>4000) return {error:'Describe the app in 1–4000 characters.',status:400};
  const requestId=input.requestId;
  if(requestId!==undefined && (typeof requestId!=='string'||!/^[\w-]{16,100}$/.test(requestId))) return {error:'Invalid generation request ID.',status:400};
  if(input.captureSource && !requestId) return {error:'A request ID is required to keep the source conversation.',status:400};
  let channel=null, privateByDefault=false;
  let sourceThreadId=input.sourceThreadId||null;
  if(sourceThreadId){
    const origin=await appCreationSource(env.DB,orgId,by,sourceThreadId);
    if(origin.error)return origin;
    channel=origin.source.channel; privateByDefault=origin.private;
  } else if(input.channel){
    const room=await resolveChannel(env.DB,orgId,who.user,input.channel);
    if(!room || !await mayUseConversation(env.DB,orgId,by,room.key))return {error:'No such room.',status:403};
    channel=room.key; privateByDefault=room.kind!=='business'||Boolean(room.private);
  }
  if(input.captureSource && !channel)return {error:'Choose a room for the source conversation.',status:400};
  const denied=await checkOutgoing(env,request,{orgId,login,text:prompt,ack:input.dlpAck===true,where:'app generation'});
  if(denied)return {response:denied};
  const name=typeof input.name==='string'?input.name.trim().slice(0,80):'';
  const fingerprint=await digest(JSON.stringify({prompt,name,channel,sourceThreadId,captureSource:Boolean(input.captureSource),useModel:input.useModel!==false}));
  const token=crypto.randomUUID();
  let job=null;
  const jobOf=()=>env.DB.prepare('SELECT * FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(orgId,by,requestId).first();
  if(requestId){
    await env.DB.prepare(`INSERT OR IGNORE INTO hx_app_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status)
      VALUES (?,?,?,?,?,?,'running')`).bind(orgId,by,requestId,fingerprint,token,Date.now()+leaseMs).run();
    job=await jobOf();
    if(job.fingerprint!==fingerprint)return {error:'This request ID was already used for a different app request.',status:409};
    if(job.status==='complete'){
      if(!await mayUseApp(env.DB,orgId,job.app_id,by))return {error:'The generated app is no longer available.',status:404};
      const made=JSON.parse(job.generated);
      return {app:await getApp(env.DB,orgId,job.app_id),source:made.source,room:made.room||null,replay:true};
    }
    if(job.lease_token!==token){
      const claimed=await env.DB.prepare(`UPDATE hx_app_generation_jobs SET lease_token=?,lease_until=?,status='running'
        WHERE org_id=? AND user_id=? AND request_id=? AND fingerprint=? AND (status='failed' OR (status='running' AND lease_until<?))`)
        .bind(token,Date.now()+leaseMs,orgId,by,requestId,fingerprint,Date.now()).run();
      if(!claimed.meta?.changes)return conflict();
      job=await jobOf();
    }
  }
  const release=async()=>{
    if(requestId)await env.DB.prepare("UPDATE hx_app_generation_jobs SET status='failed',lease_until=0 WHERE org_id=? AND user_id=? AND request_id=? AND lease_token=? AND status='running'")
      .bind(orgId,by,requestId,token).run();
  };
  try {
    if(input.captureSource && !sourceThreadId){
      // Client IDs are author-scoped. Include workspace and request in the
      // digest, so another generation cannot take over this source message.
      const clientId='tmp-app-'+(await digest(JSON.stringify([orgId,by,requestId])));
      const root=await postMessage(env.DB,{orgId,key:channel,authorLogin:login,body:prompt,clientId});
      if(root.error){await release();return root;}
      if(root.row.deleted_at || root.row.channel!==channel || root.row.body!==prompt){await release();return {error:'The source conversation changed. Start a new generation request.',status:409};}
      sourceThreadId=root.row.id;
      if(!root.replay)await broadcastStored(env,orgId,channel,root.row).catch(()=>{});
      // Do not invoke the channel's AI responder: this prompt is already
      // handled by app generation and must not start a second model call.
    }
    let made=job?.generated?JSON.parse(job.generated):null;
    if(!made){
      const complete=input.useModel===false?null:await makeCompleter(env,orgId,by,'app_generate',{maxTokens:2400});
      made=await specFromPrompt(prompt,{complete});
      if(made.error){await release();return made;}
      if(requestId){
        const saved=await env.DB.prepare(`UPDATE hx_app_generation_jobs SET generated=? WHERE org_id=? AND user_id=? AND request_id=? AND lease_token=? AND status='running' AND lease_until>?`)
          .bind(JSON.stringify(made),orgId,by,requestId,token,Date.now()).run();
        if(!saved.meta?.changes)return conflict();
      }
    }
    // Model work can outlive a membership or room grant.
    if(channel && !await mayUseConversation(env.DB,orgId,by,channel)){await release();return {error:'No such room.',status:403};}
    const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=? AND user_github_id=? AND role!='guest'").bind(orgId,by).first();
    if(!member){await release();return {error:'Workspace membership is required.',status:403};}
    const spec=made.spec;
    const result=await createApp(env.DB,{orgId,by,name:name||spec.name,tableName:spec.tableName||spec.name,description:spec.description,icon:spec.icon,
      columns:spec.columns,definition:spec.definition,template:spec.template||null,sample:spec.sample||[],channel,sourceThreadId,privateByDefault},
      {announceInSource:true,...(requestId?{commitGuard:appId=>env.DB.prepare(`UPDATE hx_app_generation_jobs
        SET app_id=CASE WHEN lease_token=? AND lease_until>? AND status='running' THEN ? ELSE NULL END,status='complete'
        WHERE org_id=? AND user_id=? AND request_id=?`).bind(token,Date.now(),appId,orgId,by,requestId)}:{})});
    if(result.error){await release();return result;}
    const {announcementId,...published}=result;
    if(announcementId){
      await mirrorIds(env.DB,orgId,[announcementId]);
      const message=await getMessage(env.DB,orgId,announcementId);
      if(message)await broadcastStored(env,orgId,channel,message).catch(()=>{});
    }
    return {...published,source:made.source,room:made.room||null};
  }catch(error){
    if(requestId && (await jobOf())?.lease_token!==token)return conflict();
    await release();throw error;
  }
}

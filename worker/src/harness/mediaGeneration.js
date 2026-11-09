import {allowed} from '../permissions.js';
import {loadAISettings} from '../orgAI.js';
import {getMode} from './mode.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {createFileLedger} from './fileVersionLedger.js';
import {uploadFileVersion} from './fileUpload.js';

export const IMAGE_MODEL='gpt-image-2.6-flare';
export const IMAGE_SIZE='1024x1024';
export const IMAGE_QUALITY='low';
// Provider image charges vary by output-token count. Never present a fixed
// dollar estimate as a quote; approval is explicit and warns that cost varies.
const MAX_PROMPT=4000, MAX_IMAGE_BYTES=25*1024*1024, LEASE_MS=5*60_000;
const error=(message,status=400)=>({error:message,status});
const estimate=()=>({currency:'USD',amountMicros:null,method:'provider-metered',note:'Cost varies with generated image output. Review your OpenAI usage and limits before approving.'});
const rowView=row=>({id:row.id,status:row.status,model:row.model,size:row.size,quality:row.quality,prompt:row.prompt,estimate:estimate(row.prompt),createdAt:row.created_at,approvedAt:row.approved_at,startedAt:row.started_at,finishedAt:row.finished_at,fileId:row.file_id,fileVersion:row.file_version,errorCode:row.error_code});
const mediaAccess=(actor='?3',org='j.org_id',scope='j.scope')=>`${fileScopeAuthority(org,scope,actor)} AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=${org} AND s.mode='harness') AND EXISTS(SELECT 1 FROM custom_agents a JOIN users u ON u.github_id=${actor} WHERE a.org_id=${org} AND ${scope}='ag:'||a.id||'|'||u.login AND a.owner_login=u.login AND a.deleted_at IS NULL)`;

async function enabled(db,orgId,userId){return await getMode(db,orgId)==='harness'&&await allowed(db,orgId,String(userId),'harness.build');}
async function workspaceKey(db,orgId){const settings=await loadAISettings(db,orgId);return settings.settingsReadFailed?null:settings.openaiKey||null;}

export async function prepareImageGeneration(db,orgId,userId,{scope,requestId,prompt}={}){
 userId=String(userId);
 if(!await enabled(db,orgId,userId))return error('Image generation is not allowed.',403);
 if(!await workspaceKey(db,orgId))return error('Add a workspace-owned OpenAI key in Tools → AI before requesting image generation. Deployment keys are never used for images.',409);
 if(typeof scope!=='string'||scope.length>300||!/^ag:[^|]{1,100}\|[A-Za-z0-9-]{1,100}$/.test(scope))return error('Image generation is only available in a private Agent conversation.',403);
 if(typeof requestId!=='string'||!/^[-\w]{1,80}$/.test(requestId)||typeof prompt!=='string'||!prompt.trim()||prompt.length>MAX_PROMPT)return error('Provide a stable request ID and an image prompt of up to 4,000 characters.');
 const body=prompt.trim();
 const prior=await db.prepare('SELECT * FROM hx_media_generation_jobs WHERE org_id=?1 AND created_by=?2 AND request_id=?3').bind(orgId,userId,requestId).first();
 if(prior){if(prior.scope!==scope||prior.prompt!==body||prior.model!==IMAGE_MODEL)return error('Request ID was already used for a different image.',409);return {job:rowView(prior)};}
 const id=crypto.randomUUID(),at=Date.now();
 const insert=await db.prepare(`INSERT OR IGNORE INTO hx_media_generation_jobs(id,org_id,created_by,scope,request_id,model,size,quality,prompt,estimated_micros,status,created_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,'awaiting_approval',?10 WHERE ${mediaAccess('?3','?2','?4')}
 AND (SELECT COUNT(*) FROM hx_media_generation_jobs WHERE org_id=?2 AND created_by=?3 AND status IN ('awaiting_approval','queued','running'))<5
 AND (SELECT COUNT(*) FROM hx_media_generation_jobs WHERE org_id=?2 AND status IN ('awaiting_approval','queued','running'))<25`).bind(id,orgId,userId,scope,requestId,IMAGE_MODEL,IMAGE_SIZE,IMAGE_QUALITY,body,at).run();
 if(!insert.meta?.changes)return error('The private conversation is unavailable or the media queue is full.',409);
 return readImageGeneration(db,orgId,userId,id);
}

export async function readImageGeneration(db,orgId,userId,id){
 userId=String(userId);if(!await enabled(db,orgId,userId))return error('Image generation is not allowed.',403);
 const row=await db.prepare(`SELECT j.* FROM hx_media_generation_jobs j WHERE j.id=?1 AND j.org_id=?2 AND j.created_by=?3 AND ${mediaAccess('?3')}`).bind(id,orgId,userId).first();
 return row?{job:rowView(row)}:error('No such image job.',404);
}

export async function listImageGenerations(db,orgId,userId,scope){
 userId=String(userId);if(!await enabled(db,orgId,userId))return error('Image generation is not allowed.',403);
 if(typeof scope!=='string'||scope.length>300||!scope.startsWith('ag:'))return error('Invalid private conversation.',400);
 const {results}=await db.prepare(`SELECT j.* FROM hx_media_generation_jobs j WHERE j.org_id=?1 AND j.created_by=?2 AND j.scope=?3 AND ${mediaAccess('?2')} ORDER BY j.created_at DESC,j.id DESC LIMIT 20`).bind(orgId,userId,scope).all();
 return {jobs:results.map(rowView)};
}

export async function approveImageGeneration(db,orgId,userId,id,expectedEstimateMicros){
 userId=String(userId);if(!await enabled(db,orgId,userId))return error('Image generation is not allowed.',403);
 if(!await workspaceKey(db,orgId))return error('The workspace OpenAI key is no longer available.',409);
 if(expectedEstimateMicros!==null)return error('The estimate changed. Review the current cost disclosure before approving.',409);
 const at=Date.now();
 const result=await db.prepare(`UPDATE hx_media_generation_jobs AS j SET status='queued',approved_at=?4
 WHERE j.id=?1 AND j.org_id=?2 AND j.created_by=?3 AND j.status='awaiting_approval' AND j.estimated_micros IS NULL AND ${mediaAccess('?3')}
 AND EXISTS(SELECT 1 FROM org_ai_settings ai WHERE ai.org_id=j.org_id AND ai.openai_key IS NOT NULL AND ai.openai_key!='')`).bind(id,orgId,userId,at).run();
 if(!result.meta?.changes)return readImageGeneration(db,orgId,userId,id);
 return readImageGeneration(db,orgId,userId,id);
}

export async function cancelImageGeneration(db,orgId,userId,id){
 userId=String(userId);if(!await enabled(db,orgId,userId))return error('Image generation is not allowed.',403);
 await db.prepare(`UPDATE hx_media_generation_jobs AS j SET status='cancelled',finished_at=?4 WHERE j.id=?1 AND j.org_id=?2 AND j.created_by=?3 AND j.status IN ('awaiting_approval','queued') AND ${mediaAccess('?3')}`).bind(id,orgId,userId,Date.now()).run();
 return readImageGeneration(db,orgId,userId,id);
}

const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export async function expireImageGenerationJobs(db,at=Date.now()){
 const running=await db.prepare(`UPDATE hx_media_generation_jobs SET status='failed',error_code='outcome_unknown',finished_at=?1,lease_hash=NULL
 WHERE status='running' AND (lease_until<=?1 OR deadline<=?1)`).bind(at).run();
 await db.prepare(`UPDATE hx_media_generation_jobs SET status='cancelled',finished_at=?1 WHERE status='awaiting_approval' AND created_at<=?2`).bind(at,at-30*24*60*60_000).run();
 return running;
}

export async function claimImageGenerationJob(db,{at=Date.now()}={}){
 await expireImageGenerationJobs(db,at);
 const lease=crypto.randomUUID()+crypto.randomUUID(),leaseHash=await sha(lease);
 const row=await db.prepare(`UPDATE hx_media_generation_jobs AS j SET status='running',lease_hash=?1,lease_until=?2+?3,deadline=?2+?3,started_at=?2
 WHERE j.id=(SELECT q.id FROM hx_media_generation_jobs q WHERE q.status='queued' AND q.approved_at IS NOT NULL ORDER BY q.created_at,q.id LIMIT 1)
 AND j.status='queued' AND ${mediaAccess('j.created_by')}
 AND EXISTS(SELECT 1 FROM org_ai_settings ai WHERE ai.org_id=j.org_id AND ai.openai_key IS NOT NULL AND ai.openai_key!='')
 RETURNING *`).bind(leaseHash,at,LEASE_MS).first();
 return row?{job:row,lease}:null;
}

export async function failClaimedImageGeneration(db,job,lease,errorCode){
 const leaseHash=await sha(lease);const safeCode=['workspace_key_missing','permission_revoked','provider_auth','provider_rejected','provider_rate_limited','provider_error','outcome_unknown','storage_failed'].includes(errorCode)?errorCode:'provider_error';
 await db.prepare("UPDATE hx_media_generation_jobs SET status='failed',error_code=?4,finished_at=?5,lease_hash=NULL WHERE id=?1 AND org_id=?2 AND status='running' AND lease_hash=?3")
  .bind(job.id,job.org_id,leaseHash,safeCode,Date.now()).run();
}

function bytesFromBase64(value){
 if(typeof value!=='string'||value.length>Math.ceil(MAX_IMAGE_BYTES*4/3))throw Error('image_too_large');
 const binary=atob(value);if(binary.length<8||binary.length>MAX_IMAGE_BYTES)throw Error('image_too_large');
 const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 if(![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))throw Error('image_invalid');
 return bytes;
}

async function saveGeneratedImage(env,job,bytes){
 const userId=String(job.created_by),fileId=`file-${job.id}`,path=`Generated images/${job.id}.png`;
 const created=await createFileLedger(env.DB,{orgId:job.org_id,fileId,scope:job.scope,path,createdBy:userId,origin:'agent'});
 if(!created.created){const prior=await env.DB.prepare("SELECT current_version FROM hx_workspace_files WHERE org_id=?1 AND id=?2 AND scope=?3 AND created_by=?4").bind(job.org_id,fileId,job.scope,userId).first();if(prior?.current_version>0)return {fileId,version:prior.current_version};if(!prior)throw Error('file_scope_revoked');}
 const saved=await uploadFileVersion(env,{orgId:job.org_id,fileId,userId,expectedVersion:0,stream:new Response(bytes,{headers:{'content-type':'image/png'}}).body,size:bytes.byteLength,contentType:'image/png'});
 if(!saved.saved){const prior=await env.DB.prepare("SELECT current_version FROM hx_workspace_files WHERE org_id=?1 AND id=?2 AND scope=?3 AND created_by=?4").bind(job.org_id,fileId,job.scope,userId).first();if(prior?.current_version>0)return {fileId,version:prior.current_version};throw Error('file_scope_revoked');}
 return {fileId,version:saved.version};
}

export async function runImageGenerationJob(env,job,lease){
 const leaseHash=await sha(lease),settings=await loadAISettings(env.DB,job.org_id);
 if(!settings.openaiKey){await failClaimedImageGeneration(env.DB,job,lease,'workspace_key_missing');return;}
 if(!await enabled(env.DB,job.org_id,job.created_by)){await failClaimedImageGeneration(env.DB,job,lease,'permission_revoked');return;}
 try{
  const response=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',signal:AbortSignal.timeout(240000),headers:{authorization:`Bearer ${settings.openaiKey}`,'content-type':'application/json','idempotency-key':`honmaru-image-${job.id}`},body:JSON.stringify({model:job.model,prompt:job.prompt,size:job.size,quality:job.quality,n:1,output_format:'png'})});
  if(!response.ok){const code=response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limited':response.status<500?'provider_rejected':'outcome_unknown';await failClaimedImageGeneration(env.DB,job,lease,code);return;}
  const data=await response.json();
  const encoded=data?.data?.[0]?.b64_json;if(typeof encoded!=='string'){await failClaimedImageGeneration(env.DB,job,lease,'outcome_unknown');return;}
  const bytes=bytesFromBase64(encoded),file=await saveGeneratedImage(env,job,bytes);
  const result=await env.DB.prepare(`UPDATE hx_media_generation_jobs SET status='succeeded',finished_at=?4,file_id=?5,file_version=?6,provider_request_id=?7,lease_hash=NULL
   WHERE id=?1 AND org_id=?2 AND status='running' AND lease_hash=?3 AND ${mediaAccess('created_by')}`)
   .bind(job.id,job.org_id,leaseHash,Date.now(),file.fileId,file.version,response.headers.get('x-request-id')?.slice(0,120)||null).run();
  if(!result.meta?.changes)throw Error('job_authority_changed');
 }catch(error){
  const code=error?.message==='image_too_large'||error?.message==='image_invalid'?'provider_rejected':error?.message==='file_scope_revoked'?'storage_failed':'outcome_unknown';
  await failClaimedImageGeneration(env.DB,job,lease,code);
 }
}

export async function processImageGenerationQueue(env,{limit=1,at=Date.now()}={}){
 if(!env.MEDIA)return {processed:0};let processed=0;
 for(let i=0;i<Math.max(1,Math.min(2,limit));i++){
  const claimed=await claimImageGenerationJob(env.DB,{at});if(!claimed)break;
  await runImageGenerationJob(env,claimed.job,claimed.lease);processed++;
 }
 return {processed};
}

export function imageConversationUrl(base,{orgId,scope,fileId}){
 try{const url=new URL(base);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;const channel=scope.slice(0,scope.lastIndexOf('|'));if(!channel.startsWith('ag:'))return null;url.search='';url.hash=`/c/${encodeURIComponent(channel)}?${new URLSearchParams({org:orgId,file:fileId})}`;return url.toString();}catch{return null;}
}

export async function decorateImageGeneration(env,job,{orgId,userId}={}){
 if(!job)return null;const view=typeof job.id==='string'?job:rowView(job);
 if(view.fileId){
  let source=job;
  if(!source.org_id||!source.scope)source=await env.DB.prepare('SELECT org_id,scope FROM hx_media_generation_jobs WHERE id=?1 AND org_id=?2 AND created_by=?3').bind(job.id,orgId,userId).first()||{};
  if(source.org_id&&source.scope)view.openUrl=imageConversationUrl(env.APP_WEB_URL,{orgId:source.org_id,scope:source.scope,fileId:view.fileId});
 }
 return view;
}

// Image creation is available only inside a private owned Agent. Preparing a
// job never spends provider credits: the member must approve it in the card.
export async function mediaAgentTools(env,{actor,fileScope,current,taint,fileUrl}){
 if(!env.MEDIA)return {};
 const {orgId,githubId:userId}=actor;
 const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 const wrap=run=>async(args={})=>{
  if(await getMode(env.DB,orgId)!=='harness'||!await current()||!await allowed(env.DB,orgId,String(userId),'harness.build'))return JSON.stringify({error:'Image generation is unavailable in this conversation.'});
  if(!args||typeof args!=='object'||Array.isArray(args))return JSON.stringify({error:'Invalid image request.'});
  if(taint)taint.value=true;
  return JSON.stringify(await run(args));
 };
 return {
  prepare_image_generation:{description:'Prepare one private PNG image-generation job for this Agent conversation. This does not call the provider or incur an image charge. Show the returned job card and wait for the member to explicitly approve its variable provider cost before saying generation will start. Never claim the image exists until get_image_generation_status reports succeeded and provides openUrl.',parameters:schema({requestId:{type:'string'},prompt:{type:'string'}}),strict:true,run:wrap(async({requestId,prompt})=>prepareImageGeneration(env.DB,orgId,String(userId),{scope:fileScope,requestId,prompt}))},
  get_image_generation_status:{description:'Read an image job that belongs to this private Agent conversation. Never claim completion while awaiting approval, queued, or running.',parameters:schema({jobId:{type:'string'}}),strict:true,run:wrap(async({jobId})=>{const match=await env.DB.prepare('SELECT 1 FROM hx_media_generation_jobs WHERE id=?1 AND org_id=?2 AND created_by=?3 AND scope=?4').bind(jobId,orgId,String(userId),fileScope).first();if(!match)return {error:'Image job is not in this conversation.'};const result=await readImageGeneration(env.DB,orgId,String(userId),jobId);if(result.job?.fileId)result.job.openUrl=fileUrl(result.job.fileId);return result})},
 };
}

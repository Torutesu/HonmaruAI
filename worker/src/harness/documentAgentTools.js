import {getMode} from './mode.js';
import {allowed} from '../permissions.js';
import {audit} from '../audit.js';
import {enqueueDocumentJob,readDocumentJob,cancelDocumentJob} from './documentJobs.js';

// Called only after fileAgentTools establishes an owned, private agent conversation.
export async function documentAgentTools(env,{actor,fileScope,current,taint,fileUrl}){
 const ready=await env.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('hx_document_jobs','hx_document_nodes')").first();
 if(ready?.n!==2)return {};
 const {orgId,githubId:userId}=actor;
 const nodes=async()=> (await env.DB.prepare(`SELECT g.id,g.name FROM hx_document_nodes n JOIN hx_gateways g ON g.id=n.gateway_id AND g.org_id=n.org_id JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by AND lower(m.role) IN ('owner','admin') WHERE n.org_id=?1 AND n.last_seen_at>?2 AND g.revoked_at IS NULL ORDER BY g.name,g.id`).bind(orgId,Date.now()-90000).all()).results;
 const wrap=run=>async(args={})=>{
  if(await getMode(env.DB,orgId)!=='harness'||!await current()||!await allowed(env.DB,orgId,userId,'harness.build'))return JSON.stringify({error:'Document conversion is not allowed in this conversation.'});
  if(!args||typeof args!=='object'||Array.isArray(args))return JSON.stringify({error:'Invalid document arguments.'});
  if(taint)taint.value=true;
  return JSON.stringify(await run(args));
 };
 const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 const scoped=async id=>{
  if(typeof id!=='string')return {error:'A document job ID is required.'};
  const result=await readDocumentJob(env.DB,orgId,userId,id);
  return result.job?.scope===fileScope?result:{error:'Document is not in this conversation.'};
 };
 const decorate=result=>{
  if(result.job?.fileId)result={...result,openUrl:fileUrl(result.job.fileId)};
  return result;
 };
 return {
  list_document_nodes:{description:'List connected nodes able to create PDF and Word files for this conversation. Use before create_document. No conversion is started.',parameters:schema({}),strict:true,run:wrap(async()=>({nodes:await nodes()}))},
  create_document:{description:'When the user requests a PDF or Word document, convert Markdown or HTML and save a new file in this conversation. Select gatewayId from list_document_nodes. Supply a stable requestId and reuse all arguments unchanged after a network failure. Never overwrites an existing file. Returns queued status, not completed output. Use get_document_status to check completion and include openUrl only when returned.',parameters:schema({gatewayId:{type:'string'},requestId:{type:'string'},path:{type:'string'},text:{type:'string'},inputFormat:{type:'string',enum:['markdown','html']},format:{type:'string',enum:['pdf','docx']}}),strict:true,run:wrap(async args=>{
   if(typeof args.requestId!=='string'||typeof args.gatewayId!=='string')return {error:'A request ID and document node are required.'};
   const prior=await env.DB.prepare('SELECT id FROM hx_document_jobs WHERE org_id=? AND created_by=? AND request_id=?').bind(orgId,userId,args.requestId).first();
   if(!prior&&!(await nodes()).some(n=>n.id===args.gatewayId))return {error:'Selected document node is unavailable. List nodes again.'};
   const result=await enqueueDocumentJob(env.DB,orgId,userId,{...args,scope:fileScope},{origin:'agent'});
   if(result.job)await audit(env,null,{orgId,action:'document.conversion_requested',actor:{type:'user',id:actor.login,name:actor.name},entity:{type:'document',id:result.job.id},details:{source:'conversation',agentName:actor.agentName,status:result.job.status}});
   return decorate(result);
  })},
  get_document_status:{description:'Read the conversion status of a document in this conversation. Do not claim completion while queued or running. A completed document includes openUrl.',parameters:schema({jobId:{type:'string'}}),strict:true,run:wrap(async({jobId})=>decorate(await scoped(jobId)))},
  cancel_document:{description:'Cancel a queued or running document conversion in this conversation when requested by the user. Does not delete a completed file.',parameters:schema({jobId:{type:'string'}}),strict:true,run:wrap(async({jobId})=>{
   const found=await scoped(jobId);if(found.error)return found;
   const result=await cancelDocumentJob(env.DB,orgId,userId,jobId);
   if(result.job)await audit(env,null,{orgId,action:'document.conversion_cancelled',actor:{type:'user',id:actor.login,name:actor.name},entity:{type:'document',id:jobId},details:{source:'conversation',agentName:actor.agentName,status:result.job.status}});
   return decorate(result);
  })},
 };
}

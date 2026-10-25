import {audit,person} from '../audit.js';
import {member,json} from './routes.js';
import {allowed} from '../permissions.js';
import {enforceSubject} from '../ratelimit.js';
import {listDocumentJobs,enqueueDocumentJob,readDocumentJob,cancelDocumentJob} from './documentJobs.js';
import {claimDocumentJob,heartbeatDocumentJob,failDocumentJob} from './documentLeases.js';
import {publishDocumentArtifact} from './documentArtifacts.js';
const failure=(message,status)=>json({message},status);
async function bounded(request,limit){
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Object.assign(Error('Request is too large.'),{status:413});chunks.push(value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function input(request,limit){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw Object.assign(Error('JSON input is required.'),{status:400});
 try{return JSON.parse(new TextDecoder().decode(await bounded(request,limit)));}catch(e){if(e.status)throw e;throw Object.assign(Error('Invalid JSON input.'),{status:400});}
}
export const isDocumentNodeRoute=path=>/^\/gateways\/documents\/(?:claim|jobs\/[^/]+\/(?:heartbeat|fail|artifact))$/.test(path);
export async function handleDocuments(request,env,url){
 const node=isDocumentNodeRoute(url.pathname),parts=url.pathname.split('/').filter(Boolean);
 const ready=await env.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('hx_document_jobs','hx_document_nodes')").first();
 if(ready.n!==2)return failure('Document conversion is not ready.',503);
 try{
  if(node){
   if(request.method!=='POST')return failure('Method not allowed.',405);
   const token=request.headers.get('authorization')?.match(/^Bearer (hgw_[A-Za-z0-9-]{64,100})$/)?.[1];
   if(!token)return failure('Node authentication required.',401);
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
   const g=await env.DB.prepare('SELECT * FROM hx_gateways WHERE token_hash=?1 AND revoked_at IS NULL').bind(hash).first();
   if(!g)return failure('Node authentication required.',401);
   if(!await allowed(env.DB,g.org_id,g.created_by,'workspace.mode'))return failure('Node owner access was revoked.',403);
   const limited=await enforceSubject(env,'gateway/node',`gateway:${g.id}`);if(limited)return limited;
   if(parts[2]==='claim'){
    const body=await input(request,4096);
    return json(await claimDocumentJob(env.DB,g.id,{capabilities:body?.capabilities}));
   }
   const identity={gatewayId:g.id,jobId:parts[3],lease:request.headers.get('x-honmaru-lease')};
   if(parts[4]==='artifact'){
    if(request.headers.get('content-type')!=='application/octet-stream')return failure('Binary document input is required.',400);
    // Authorization precedes accepting large document bytes; the publisher
    // checks again and supports authenticated identical retries after success.
    const {authorizeDocumentLease}=await import('./documentLeases.js');
    const active=await authorizeDocumentLease(env.DB,identity);
    if(!active){
     const done=await env.DB.prepare("SELECT 1 FROM hx_document_jobs WHERE id=?1 AND gateway_id=?2 AND status='succeeded'").bind(identity.jobId,g.id).first();
     if(!done)return failure('Document execution is no longer authorized.',409);
    }
    const bytes=await bounded(request,25*1024*1024);
    let result;try{result=await publishDocumentArtifact(env,identity,{bytes});}catch(e){if(/^Invalid document artifact/.test(e.message))return failure(e.message,400);throw e;}
    if(!result.saved)return failure('Document destination or execution is no longer available.',409);
    await audit(env,request,{orgId:g.org_id,action:'document.artifact_received',actor:{type:'integration',id:g.id,name:g.name},entity:{type:'file',id:result.fileId},details:{jobId:identity.jobId,version:result.version}});
    const {announceFileChanged}=await import('./fileEvents.js');await announceFileChanged(env,g.org_id,result.fileId);
    return json(result);
   }
   const result=parts[4]==='heartbeat'?await heartbeatDocumentJob(env.DB,identity):await failDocumentJob(env.DB,identity);
   return result.renewed||result.failed?json(result):failure('Document execution is no longer authorized.',409);
  }
  const orgId=url.searchParams.get('orgId'),who=await member(env,request,orgId);if(who.denied)return who.denied;
  const userId=String(who.session.github_id);let result;
  if(parts.length===3&&parts[2]==='nodes'&&request.method==='GET'){
   if(!await allowed(env.DB,orgId,userId,'harness.build'))return failure('Document conversion is not allowed.',403);
   const {results}=await env.DB.prepare(`SELECT g.id,g.name,n.last_seen_at AS lastSeenAt FROM hx_document_nodes n JOIN hx_gateways g ON g.id=n.gateway_id AND g.org_id=n.org_id JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by AND lower(m.role) IN ('owner','admin') WHERE n.org_id=?1 AND n.last_seen_at>?2 AND g.revoked_at IS NULL ORDER BY g.name,g.id`).bind(orgId,Date.now()-90000).all();
   return json({nodes:results});
  }
  if(parts.length===2&&request.method==='POST')result=await enqueueDocumentJob(env.DB,orgId,userId,await input(request,2000000));
  else if(parts.length===2&&request.method==='GET')result=await listDocumentJobs(env.DB,orgId,userId,url.searchParams.get('scope'));
  else if(parts.length===3&&request.method==='GET')result=await readDocumentJob(env.DB,orgId,userId,parts[2]);
  else if(parts.length===4&&parts[3]==='cancel'&&request.method==='POST')result=await cancelDocumentJob(env.DB,orgId,userId,parts[2]);
  else return failure('Method not allowed.',405);
  if(!result.error&&request.method==='POST')await audit(env,request,{orgId,action:parts[3]==='cancel'?'document.cancel_requested':'document.conversion_requested',actor:person(who.user),entity:{type:'document_job',id:result.job.id},details:{status:result.job.status}});
  return result.error?failure(result.error,result.status):json(result);
 }catch(e){if(e.status)return failure(e.message,e.status);throw e;}
}

import {documentOriginAuthority} from './documentAuthority.js';
// Authorized document admission and metadata-only status/history reads.
import {allowed} from '../permissions.js';
import {getMode} from './mode.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {workspaceFilePath} from './fileVersionLedger.js';
const error=(message,status=400)=>({error:message,status});
const view=row=>({id:row.id,status:row.status,gatewayId:row.gateway_id,scope:row.scope,path:row.path,createdAt:row.created_at,finishedAt:row.finished_at,fileId:row.file_id,version:row.file_version});
const metadata='d.id,d.status,d.gateway_id,d.scope,d.path,d.created_at,d.finished_at,d.file_id,d.file_version';
const access=fileScopeAuthority('d.org_id','d.scope','d.created_by');
async function enabled(db,orgId,userId){return await getMode(db,orgId)==='harness'&&await allowed(db,orgId,userId,'harness.build');}
export async function readDocumentJob(db,orgId,userId,jobId){
 userId=String(userId);
 if(!await enabled(db,orgId,userId))return error('Document conversion is not allowed.',403);
 const row=await db.prepare(`SELECT ${metadata} FROM hx_document_jobs d WHERE d.id=?1 AND d.org_id=?2 AND d.created_by=?3 AND ${access}`).bind(jobId,orgId,userId).first();
 return row?{job:view(row)}:error('No such document conversion.',404);
}
export async function listDocumentJobs(db,orgId,userId,scope){
 userId=String(userId);
 if(!await enabled(db,orgId,userId))return error('Document conversion is not allowed.',403);
 if(typeof scope!=='string'||!scope||scope.length>300)return error('Invalid document destination.');
 const {results}=await db.prepare(`SELECT ${metadata} FROM hx_document_jobs d WHERE d.org_id=?1 AND d.created_by=?2 AND d.scope=?3 AND ${access} ORDER BY d.created_at DESC,d.id DESC LIMIT 20`).bind(orgId,userId,scope).all();
 return {jobs:results.map(view)};
}
export async function enqueueDocumentJob(db,orgId,userId,input,{origin='human'}={}){
 if(!['human','agent'].includes(origin))return error('Invalid document origin.');
 userId=String(userId);
 if(!await enabled(db,orgId,userId))return error('Document conversion is not allowed.',403);
 if(!input||typeof input.text!=='string'||new TextEncoder().encode(input.text).length>2*1024*1024||!['markdown','html'].includes(input.inputFormat)||!['pdf','docx'].includes(input.format))return error('Invalid document conversion input.');
 if(typeof input.requestId!=='string'||! /^[\w-]{1,80}$/.test(input.requestId))return error('A stable request ID is required.');
 if(typeof input.scope!=='string'||input.scope.length>300||typeof input.gatewayId!=='string')return error('Invalid document destination.');
 let path;try{path=workspaceFilePath(input.path);}catch{return error('Invalid document path.');}
 if(!path.toLowerCase().endsWith('.'+input.format))return error('Document extension must match the output format.');
 const payload=JSON.stringify({text:input.text,inputFormat:input.inputFormat,format:input.format,...(origin==='agent'?{origin}: {})});
 // D1 limits apply to serialized rows, including JSON escaping and metadata.
 if(new TextEncoder().encode(payload).length>2000000-16384)return error('Serialized document input is too large.',413);
 const prior=await db.prepare('SELECT * FROM hx_document_jobs WHERE org_id=?1 AND created_by=?2 AND request_id=?3').bind(orgId,userId,input.requestId).first();
 if(prior){
  if(prior.payload!==payload||prior.scope!==input.scope||prior.path!==path||prior.gateway_id!==input.gatewayId)return error('Request ID was already used for a different document.',409);
  return readDocumentJob(db,orgId,userId,prior.id);
 }
 const id=crypto.randomUUID();
 const result=await db.prepare(`INSERT OR IGNORE INTO hx_document_jobs(id,org_id,gateway_id,created_by,request_id,scope,path,payload,status,created_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9
 WHERE ${fileScopeAuthority('?2','?6','?4')}
 AND ${documentOriginAuthority('?2','?6','?4','?8')}
 AND EXISTS(SELECT 1 FROM hx_gateways g WHERE g.id=?3 AND g.org_id=?2 AND g.revoked_at IS NULL)
 AND (SELECT COUNT(*) FROM hx_document_jobs WHERE org_id=?2 AND status IN ('queued','running'))<25`).bind(id,orgId,input.gatewayId,userId,input.requestId,input.scope,path,payload,Date.now()).run();
 if(!result.meta?.changes)return error('Document destination is unavailable or queue is full. Retry with the same request ID.',409);
 return readDocumentJob(db,orgId,userId,id);
}
export async function cancelDocumentJob(db,orgId,userId,jobId){
 const found=await readDocumentJob(db,orgId,userId,jobId);if(found.error)return found;
 await db.prepare(`UPDATE hx_document_jobs AS d SET status='cancelled',finished_at=?4,lease_hash=NULL WHERE id=?1 AND org_id=?2 AND created_by=?3 AND status IN ('queued','running') AND ${access}`).bind(jobId,orgId,String(userId),Date.now()).run();
 return readDocumentJob(db,orgId,userId,jobId);
}

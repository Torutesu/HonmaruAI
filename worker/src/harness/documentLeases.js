import {documentOriginAuthority} from './documentAuthority.js';
// Internal only: gateway identity must come from verified node authentication.
import {allowed} from '../permissions.js';
import {fileScopeAuthority} from './fileAuthority.js';
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export const documentLiveAuthority=`${fileScopeAuthority('d.org_id','d.scope','d.created_by')}
 AND ${documentOriginAuthority('d.org_id','d.scope','d.created_by','d.payload')}
 AND EXISTS(SELECT 1 FROM org_settings s WHERE s.org_id=d.org_id AND s.mode='harness')
 AND EXISTS(SELECT 1 FROM hx_gateways g JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by
 WHERE g.id=d.gateway_id AND g.org_id=d.org_id AND g.revoked_at IS NULL AND lower(m.role) IN ('owner','admin'))`;
async function nodeAllowed(db,gatewayId){
 const g=await db.prepare('SELECT org_id,created_by FROM hx_gateways WHERE id=?1 AND revoked_at IS NULL').bind(gatewayId).first();
 return g&&await allowed(db,g.org_id,g.created_by,'workspace.mode');
}
export async function expireDocumentJobs(db,at=Date.now()){
 return db.prepare(`UPDATE hx_document_jobs AS d SET status='failed',finished_at=?1,lease_hash=NULL
 WHERE status IN ('queued','running') AND (NOT (${documentLiveAuthority}) OR (status='queued' AND created_at<=?1-3600000)
 OR (status='running' AND (lease_until<=?1 OR deadline<=?1)))`).bind(at).run();
}
export async function claimDocumentJob(db,gatewayId,{capabilities=[],at=Date.now()}={}){
 if(!Array.isArray(capabilities)||!capabilities.includes('document-conversion-v1')||!await nodeAllowed(db,gatewayId))return {job:null};
 await db.prepare('INSERT INTO hx_document_nodes(gateway_id,org_id,last_seen_at) SELECT id,org_id,?2 FROM hx_gateways WHERE id=?1 ON CONFLICT(gateway_id) DO UPDATE SET last_seen_at=excluded.last_seen_at').bind(gatewayId,at).run();
 await expireDocumentJobs(db,at);
 const lease=crypto.randomUUID()+crypto.randomUUID(),leaseHash=await hash(lease);
 const row=await db.prepare(`UPDATE hx_document_jobs AS d SET status='running',lease_hash=?2,lease_until=?3+90000,deadline=?3+240000
 WHERE id=(SELECT q.id FROM hx_document_jobs q WHERE q.gateway_id=?1 AND q.status='queued' ORDER BY q.created_at,q.id LIMIT 1)
 AND status='queued' AND ${documentLiveAuthority}
 AND NOT EXISTS(SELECT 1 FROM hx_document_jobs busy WHERE busy.gateway_id=?1 AND busy.status='running')
 AND NOT EXISTS(SELECT 1 FROM hx_gateway_jobs busy WHERE busy.gateway_id=?1 AND busy.status='running') RETURNING *`).bind(gatewayId,leaseHash,at).first();
 if(!row)return {job:null};
 // Build permission may be customized beyond membership. Recheck before any
 // document content leaves the server, even after the atomic claim succeeds.
 if(!await allowed(db,row.org_id,row.created_by,'harness.build')){
  await db.prepare("UPDATE hx_document_jobs SET status='failed',lease_hash=NULL,finished_at=?2 WHERE id=?1 AND lease_hash=?3").bind(row.id,at,leaseHash).run();return {job:null};
 }
 return {job:{id:row.id,payload:JSON.parse(row.payload),lease,timeoutMs:150000}};
}
export async function authorizeDocumentLease(db,{gatewayId,jobId,lease},at=Date.now()){
 if(typeof lease!=='string'||lease.length>150||!await nodeAllowed(db,gatewayId))return null;
 const row=await db.prepare(`SELECT d.* FROM hx_document_jobs d WHERE id=?1 AND gateway_id=?2 AND status='running' AND lease_hash=?3
 AND lease_until>?4 AND deadline>?4 AND ${documentLiveAuthority}`).bind(jobId,gatewayId,await hash(lease),at).first();
 return row&&await allowed(db,row.org_id,row.created_by,'harness.build')?row:null;
}
export async function heartbeatDocumentJob(db,identity,at=Date.now()){
 const row=await authorizeDocumentLease(db,identity,at);if(!row)return {renewed:false};
 await db.prepare('UPDATE hx_document_nodes SET last_seen_at=?2 WHERE gateway_id=?1').bind(identity.gatewayId,at).run();
 const r=await db.prepare(`UPDATE hx_document_jobs AS d SET lease_until=MIN(?4+90000,deadline)
 WHERE id=?1 AND gateway_id=?2 AND lease_hash=?3 AND status='running' AND lease_until>?4 AND deadline>?4 AND ${documentLiveAuthority}`).bind(row.id,identity.gatewayId,row.lease_hash,at).run();
 return {renewed:Boolean(r.meta?.changes)};
}
export async function failDocumentJob(db,identity,at=Date.now()){
 const row=await authorizeDocumentLease(db,identity,at);if(!row)return {failed:false};
 const r=await db.prepare(`UPDATE hx_document_jobs AS d SET status='failed',finished_at=?4,lease_hash=NULL
 WHERE id=?1 AND gateway_id=?2 AND lease_hash=?3 AND status='running' AND lease_until>?4 AND deadline>?4 AND ${documentLiveAuthority}`).bind(row.id,identity.gatewayId,row.lease_hash,at).run();
 return {failed:Boolean(r.meta?.changes)};
}
export async function documentArtifactReceipt(db,{gatewayId,jobId,lease},contentHash,size){
 if(typeof lease!=='string'||lease.length>150||!await nodeAllowed(db,gatewayId))return null;
 const row=await db.prepare(`SELECT d.*,v.content_hash,v.size FROM hx_document_jobs d JOIN hx_workspace_file_versions v
 ON v.org_id=d.org_id AND v.file_id=d.file_id AND v.version=d.file_version
 WHERE d.id=?1 AND d.gateway_id=?2 AND d.lease_hash=?3 AND d.status='succeeded' AND v.content_hash=?4 AND v.size=?5
 AND ${documentLiveAuthority} AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)`)
 .bind(jobId,gatewayId,await hash(lease),contentHash,size).first();
 return row&&await allowed(db,row.org_id,row.created_by,'harness.build')?{saved:true,fileId:row.file_id,version:row.file_version}:null;
}

import {expireDocumentJobs} from './documentLeases.js';
import {deleteMediaKeys} from '../files.js';
export const DOCUMENT_JOB_RETENTION_MS=30*86400000;
export async function maintainDocumentJobs(db,at=Date.now(),env=null){
 if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_document_jobs'").first())return {removed:0};
 await expireDocumentJobs(db,at);
 if(env?.MEDIA){
  const {results=[]}=await db.prepare('SELECT org_id,job_id,object_key FROM hx_document_export_artifacts WHERE expires_at<=?1 ORDER BY expires_at,org_id,job_id LIMIT 100').bind(at).all();
  for(const row of results){
   await deleteMediaKeys(env,row.org_id,[row.object_key]);
   await db.batch([
    db.prepare('DELETE FROM hx_document_export_links WHERE org_id=?1 AND job_id=?2').bind(row.org_id,row.job_id),
    db.prepare('DELETE FROM hx_document_export_artifacts WHERE org_id=?1 AND job_id=?2 AND expires_at<=?3').bind(row.org_id,row.job_id,at),
   ]);
  }
 }
 await db.prepare(`DELETE FROM hx_document_export_links WHERE rowid IN
  (SELECT rowid FROM hx_document_export_links WHERE expires_at<=?1 ORDER BY expires_at,org_id,job_id LIMIT 100)`).bind(at).run();
 // Expired delivery receipts do not remove the independently versioned file.
 // Bound each sweep; account/workspace deletion removes the source sooner.
 const result=await db.prepare(`DELETE FROM hx_document_jobs WHERE id IN
  (SELECT id FROM hx_document_jobs WHERE status IN ('succeeded','failed','cancelled') AND finished_at<?1
   ORDER BY finished_at,id LIMIT 100)`).bind(at-DOCUMENT_JOB_RETENTION_MS).run();
 return {removed:result.meta?.changes||0};
}

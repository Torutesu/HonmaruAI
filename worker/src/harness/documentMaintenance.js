import {expireDocumentJobs} from './documentLeases.js';
export const DOCUMENT_JOB_RETENTION_MS=30*86400000;
export async function maintainDocumentJobs(db,at=Date.now()){
 if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_document_jobs'").first())return {removed:0};
 await expireDocumentJobs(db,at);
 // Expired delivery receipts do not remove the independently versioned file.
 // Bound each sweep; account/workspace deletion removes the source sooner.
 const result=await db.prepare(`DELETE FROM hx_document_jobs WHERE id IN
  (SELECT id FROM hx_document_jobs WHERE status IN ('succeeded','failed','cancelled') AND finished_at<?1
   ORDER BY finished_at,id LIMIT 100)`).bind(at-DOCUMENT_JOB_RETENTION_MS).run();
 return {removed:result.meta?.changes||0};
}

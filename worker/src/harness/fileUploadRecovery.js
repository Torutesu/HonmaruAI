import {deleteMediaKeys} from '../files.js';

// Internal until file lifecycle integration is complete. Cleanup records are
// durable tombstones: an R2 put can finish after its request/lease expires.
// Seeing an absent object once is therefore not enough to forget its key.
export async function recoverFileUploads(env,{now=Date.now(),limit=25}={}) {
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid recovery bounds.');
 const rows=(await env.DB.prepare('SELECT org_id,id,object_key FROM hx_workspace_file_uploads WHERE expires_at<=? ORDER BY expires_at,id LIMIT ?').bind(now,limit).all()).results;
 let cleaned=0,committed=0,failed=0;
 for(const row of rows){
  // The same SQL write that revokes the lease checks for a committed version.
  // An append either wins first and protects the blob, or loses its lease.
  const claimed=await env.DB.prepare(`UPDATE hx_workspace_file_uploads SET status='cleanup',expires_at=?1
   WHERE org_id=?2 AND id=?3 AND expires_at<=?4 AND NOT EXISTS
   (SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=?2 AND v.object_key=hx_workspace_file_uploads.object_key)`)
   .bind(now+60*60*1000,row.org_id,row.id,now).run();
  if(claimed.meta.changes===1){
   const errors=await deleteMediaKeys(env,row.org_id,[row.object_key]);
   if(errors)failed++;else cleaned++;
  }else{
   const removed=await env.DB.prepare(`DELETE FROM hx_workspace_file_uploads WHERE org_id=?1 AND id=?2 AND EXISTS
    (SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=?1 AND v.object_key=hx_workspace_file_uploads.object_key)`)
    .bind(row.org_id,row.id).run();
   committed+=removed.meta.changes;
  }
 }
 return {examined:rows.length,cleaned,committed,failed};
}

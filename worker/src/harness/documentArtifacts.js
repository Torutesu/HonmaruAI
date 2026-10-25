import {createHash} from 'node:crypto';
import {authorizeDocumentLease,documentLiveAuthority,documentArtifactReceipt} from './documentLeases.js';
import {deleteMediaKeys} from '../files.js';
// Internal binary delivery. Destination comes exclusively from the admitted
// job; a node may not choose a workspace, author, path or existing file.
export async function publishDocumentArtifact(env,identity,{bytes}){
 if(!(bytes instanceof Uint8Array)||bytes.length<5||bytes.length>25*1024*1024)throw Error('Invalid document artifact size.');
 const db=env.DB,contentHash=createHash('sha256').update(bytes).digest('hex');
 const row=await authorizeDocumentLease(db,identity);
 if(!row)return await documentArtifactReceipt(db,identity,contentHash,bytes.length)||{saved:false};
 const payload=JSON.parse(row.payload),format=payload.format;
 // Origin is assigned by trusted admission, never from node upload fields.
 const origin=payload.origin==='agent'?'agent':'human';
 const signature=Array.from(bytes.subarray(0,5));
 if(format==='pdf'?!signature.every((b,i)=>b===[37,80,68,70,45][i]):![80,75,3,4].every((b,i)=>signature[i]===b))throw Error('Invalid document artifact format.');
 const contentType=format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 const stageId=crypto.randomUUID(),fileId='file-'+row.id;
 const key=`org/${encodeURIComponent(row.org_id)}/workspace-files/${stageId}`,at=Date.now();
 const guard=`d.id=?1 AND d.gateway_id=?2 AND d.lease_hash=?3 AND d.status='running' AND d.lease_until>?4 AND d.deadline>?4 AND ${documentLiveAuthority}`;
 const staged=await db.prepare(`INSERT INTO hx_workspace_file_uploads(org_id,id,file_id,object_key,created_by,expected_version,created_at,expires_at,status)
 SELECT d.org_id,?5,?6,?7,d.created_by,0,?4,?4+300000,'uploading' FROM hx_document_jobs d WHERE ${guard}`)
 .bind(row.id,identity.gatewayId,row.lease_hash,at,stageId,fileId,key).run();
 if(!staged.meta?.changes)return {saved:false};
 const discard=async()=>{
  await db.prepare("UPDATE hx_workspace_file_uploads SET status='cleanup' WHERE org_id=?1 AND id=?2").bind(row.org_id,stageId).run();
  await deleteMediaKeys(env,row.org_id,[key]);
 };
 try{
  await env.MEDIA.put(key,bytes,{httpMetadata:{contentType}});
  const head=await env.MEDIA.head(key);if(!head||head.size!==bytes.length)throw Error('Stored document could not be verified.');
  if(!await authorizeDocumentLease(db,identity)){await discard();return {saved:false};}
  const commitAt=Date.now(),iso=new Date(commitAt).toISOString(),operation=crypto.randomUUID();
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO hx_workspace_files(org_id,id,scope,path,created_by,created_login,created_at,updated_at)
    SELECT d.org_id,?5,d.scope,d.path,d.created_by,(SELECT login FROM users WHERE github_id=d.created_by),?6,?6 FROM hx_document_jobs d WHERE ${guard}`)
    .bind(row.id,identity.gatewayId,row.lease_hash,commitAt,fileId,iso),
   db.prepare(`INSERT INTO hx_workspace_file_versions(org_id,file_id,version,operation_id,kind,object_key,content_hash,content_type,size,created_by,created_login,created_at)
    SELECT d.org_id,?5,1,?6,'content',?7,?8,?9,?10,d.created_by,(SELECT login FROM users WHERE github_id=d.created_by),?11
    FROM hx_document_jobs d JOIN hx_workspace_files f ON f.org_id=d.org_id AND f.id=?5 AND f.scope=d.scope AND f.path=d.path AND f.created_by=d.created_by AND f.current_version=0
    WHERE ${guard} AND EXISTS(SELECT 1 FROM hx_workspace_file_uploads s WHERE s.org_id=d.org_id AND s.id=?12 AND s.file_id=?5 AND s.object_key=?7 AND s.status='uploading' AND s.expires_at>?4)
    AND NOT EXISTS(SELECT 1 FROM media_deletions pending WHERE pending.key=?7)`)
    .bind(row.id,identity.gatewayId,row.lease_hash,commitAt,fileId,operation,key,contentHash,contentType,bytes.length,iso,stageId),
   db.prepare(`INSERT OR IGNORE INTO hx_workspace_file_origins(org_id,file_id,source) SELECT ?1,?2,?4 WHERE EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=?1 AND v.file_id=?2 AND v.operation_id=?3)`).bind(row.org_id,fileId,operation,origin),
   db.prepare(`UPDATE hx_workspace_files SET current_version=1,updated_at=?3 WHERE org_id=?1 AND id=?2 AND current_version=0
    AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=?1 AND v.file_id=?2 AND v.version=1 AND v.operation_id=?4)`).bind(row.org_id,fileId,iso,operation),
   db.prepare(`UPDATE hx_document_jobs SET status='succeeded',finished_at=?2,file_id=?3,file_version=1 WHERE id=?1 AND status='running'
    AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=hx_document_jobs.org_id AND v.file_id=?3 AND v.operation_id=?4)`)
    .bind(row.id,commitAt,fileId,operation),
  ]);
  const committed=await db.prepare('SELECT 1 FROM hx_workspace_file_versions WHERE org_id=?1 AND file_id=?2 AND object_key=?3').bind(row.org_id,fileId,key).first();
  if(!committed){await discard();return {saved:false};}
  await db.prepare('DELETE FROM hx_workspace_file_uploads WHERE org_id=?1 AND id=?2').bind(row.org_id,stageId).run();
  return {saved:true,fileId,version:1};
 }catch(error){
  // A lost successful batch response must not delete committed bytes.
  const committed=await db.prepare('SELECT 1 FROM hx_workspace_file_versions WHERE org_id=?1 AND file_id=?2 AND object_key=?3').bind(row.org_id,fileId,key).first();
  if(committed)return {saved:true,fileId,version:1};
  await discard();throw error;
 }
}

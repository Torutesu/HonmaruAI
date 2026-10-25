import {createHash} from 'node:crypto';
import {appendFileVersion,readFileVersionContent,FileVersionInputError} from './fileVersionLedger.js';
import {fileScopeAuthority} from './fileAuthority.js';
import {deleteMediaKeys} from '../files.js';

// Internal: not mounted until retention, purge, download and account cleanup
// are integrated. Each upload gets its own key; never overwrite a prior blob.
export async function uploadFileVersion(env,{orgId,fileId,userId,expectedVersion,stream,size,contentType='application/octet-stream',restoredFrom=null}) {
 if(!env.MEDIA)throw Error('File storage is unavailable.');
 if(!Number.isSafeInteger(size)||size<0||size>25*1024*1024||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=Number.MAX_SAFE_INTEGER)throw new FileVersionInputError('Invalid upload size or version.');
 if(restoredFrom!==null&&(!Number.isSafeInteger(restoredFrom)||restoredFrom<1||restoredFrom>expectedVersion))throw new FileVersionInputError('Invalid restore version.');
 if(typeof contentType!=='string'||contentType.length>200||!/^[-\w.+]+\/[-\w.+]+$/.test(contentType))throw new FileVersionInputError('Invalid content type.');
 if(!stream||typeof stream.pipeThrough!=='function')throw new FileVersionInputError('Upload stream is required.');
 const stageId=crypto.randomUUID(),objectKey=`org/${encodeURIComponent(orgId)}/workspace-files/${stageId}`,created=Date.now();
 const staged=await env.DB.prepare(`INSERT INTO hx_workspace_file_uploads(org_id,id,file_id,object_key,created_by,expected_version,created_at,expires_at,status)
  SELECT f.org_id,?4,f.id,?5,?3,?6,?7,?8,'uploading' FROM hx_workspace_files f
  WHERE f.org_id=?1 AND f.id=?2 AND f.current_version=?6 AND ${fileScopeAuthority('f.org_id','f.scope','?3')}`)
  .bind(orgId,fileId,userId,stageId,objectKey,expectedVersion,created,created+5*60*1000).run();
 if(staged.meta.changes!==1){await stream.cancel().catch(()=>{});return {saved:false};}
 try {
  const hash=createHash('sha256');let received=0;
  // Buffer only the validated, capped payload. Do not start an R2 stream
  // until length validation completes: cancellation of a partially consumed
  // FixedLengthStream can otherwise escape as an unhandled runtime rejection.
  const reader=stream.getReader(),body=new Uint8Array(size);
  try {
   for(;;){const {value,done}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array))throw new FileVersionInputError('Upload chunks must be bytes.');
    received+=value.byteLength;if(received>size)throw new FileVersionInputError('Upload length differs.');
    hash.update(value);body.set(value,received-value.byteLength);
   }
   if(received!==size)throw new FileVersionInputError('Upload length differs.');
  } catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
  await env.MEDIA.put(objectKey,body,{httpMetadata:{contentType}});
  const head=await env.MEDIA.head(objectKey);
  if(!head||head.size!==size)throw Error('Stored upload could not be verified.');
  const result=await appendFileVersion(env.DB,{orgId,fileId,createdBy:userId,expectedVersion,objectKey,contentHash:hash.digest('hex'),contentType,size,stageId,restoredFrom});
  if(!result.saved){await discardUpload(env,orgId,stageId,objectKey);return result;}
  // This deletion can fail after a successful commit; the cleanup path below
  // checks the authoritative version record before deleting any object.
  await env.DB.prepare('DELETE FROM hx_workspace_file_uploads WHERE org_id=? AND id=?').bind(orgId,stageId).run();
  return result;
 } catch(error) {
  const committed=await env.DB.prepare('SELECT version FROM hx_workspace_file_versions WHERE org_id=? AND file_id=? AND object_key=?').bind(orgId,fileId,objectKey).first();
  if(committed)return {saved:true,version:committed.version};
  // If that authoritative read fails, leave the tracked stage for recovery.
  await discardUpload(env,orgId,stageId,objectKey);
  throw error;
 }
}
// Copy bytes to a fresh object, so purging an older version cannot remove the
// restored version. The final ledger write rechecks source hash and purge state
// together with authority and the expected current version in one transaction.
export async function restoreFileVersion(env,{orgId,fileId,userId,expectedVersion,version}) {
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!Number.isSafeInteger(version)||version<1||version>expectedVersion)throw new FileVersionInputError('Invalid restore version.');
 const source=await readFileVersionContent(env.DB,{orgId,fileId,userId,version});
 if(!source)return {saved:false};
 const object=await env.MEDIA.get(source.objectKey);
 if(!object)return {saved:false};
 if(object.size!==source.size){await object.body.cancel().catch(()=>{});throw Error('Stored source size differs.');}
 return uploadFileVersion(env,{orgId,fileId,userId,expectedVersion,stream:object.body,size:source.size,contentType:source.contentType,restoredFrom:version});
}
async function discardUpload(env,orgId,stageId,objectKey) {
 await env.DB.prepare("UPDATE hx_workspace_file_uploads SET status='cleanup' WHERE org_id=? AND id=?").bind(orgId,stageId).run();
 await deleteMediaKeys(env,orgId,[objectKey]);
 // Keep the cleanup marker until a future sweeper confirms removal. A failed
 // R2 deletion is additionally recorded by the existing media retry mechanism.
}

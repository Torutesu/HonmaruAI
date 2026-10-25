// Internal storage primitive, intentionally not routed. Callers must authorize
// the caller identity before this ledger is exposed. Live scope authority is
// checked in SQL; R2 staging, retention/holds and purge remain separate
// required lifecycle integrations. Never call this with untrusted HTTP input.
import {fileScopeAuthority,fileDeleteAuthority} from './fileAuthority.js';
export class FileVersionInputError extends Error {}
const required=(value,name)=>{
 if(typeof value!=='string'||!value||value.length>1024||/[\u0000-\u001f\u007f]/.test(value))throw new FileVersionInputError(`Invalid ${name}.`);
 return value;
};
export function workspaceFilePath(value) {
 required(value,'path');
 if(value.startsWith('/')||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..'))throw new FileVersionInputError('Invalid workspace file path.');
 return value.normalize('NFC');
}
export async function createFileLedger(db,{orgId,fileId,scope,path,createdBy,at=new Date().toISOString()}) {
 for(const [name,value] of Object.entries({orgId,fileId,scope,createdBy,at}))required(value,name);
 path=workspaceFilePath(path);
 const result=await db.prepare(`INSERT OR IGNORE INTO hx_workspace_files(org_id,id,scope,path,created_by,created_login,created_at,updated_at)
 SELECT ?1,?2,?3,?4,?5,(SELECT login FROM users WHERE github_id=?5),?6,?6 WHERE ${fileScopeAuthority('?1','?3','?5')}`).bind(orgId,fileId,scope,path,createdBy,at).run();
 return {created:result.meta.changes===1};
}
export async function appendFileVersion(db,{orgId,fileId,expectedVersion,createdBy,kind='content',objectKey=null,contentHash=null,contentType=null,size=null,restoredFrom=null,stageId=null,at=new Date().toISOString()}) {
 for(const [name,value] of Object.entries({orgId,fileId,createdBy,at}))required(value,name);
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=Number.MAX_SAFE_INTEGER)throw new FileVersionInputError('Expected version is required.');
 if(!['content','deleted'].includes(kind))throw new FileVersionInputError('Invalid version kind.');
 if(kind==='deleted') {
  if([objectKey,contentHash,contentType,size,restoredFrom].some(value=>value!==null))throw new FileVersionInputError('Deletion has no content.');
 } else {
  required(objectKey,'object key');required(contentType,'content type');
  if(!objectKey.startsWith(`org/${encodeURIComponent(orgId)}/workspace-files/`)||!/^[a-f0-9]{64}$/.test(contentHash||'')||!Number.isSafeInteger(size)||size<0||size>25*1024*1024)throw new FileVersionInputError('Invalid content metadata.');
  if(restoredFrom!==null&&(!Number.isSafeInteger(restoredFrom)||restoredFrom<1||restoredFrom>expectedVersion))throw new FileVersionInputError('Invalid restore version.');
 }
 if(stageId!==null)required(stageId,'upload stage');
 const operationId=crypto.randomUUID(),version=expectedVersion+1;
 const results=await db.batch([
  db.prepare(`INSERT INTO hx_workspace_file_versions(org_id,file_id,version,operation_id,kind,object_key,content_hash,content_type,size,created_by,created_login,created_at,restored_from)
   SELECT f.org_id,f.id,?3,?4,?5,?6,?7,?8,?9,?10,(SELECT login FROM users WHERE github_id=?10),?11,?12 FROM hx_workspace_files f
   WHERE f.org_id=?1 AND f.id=?2 AND f.current_version=?13
    AND ${fileScopeAuthority('f.org_id','f.scope','?10')}
    AND (?5!='deleted' OR ${fileDeleteAuthority('f.org_id','f.created_by','?10','f.scope')})
    AND (?5='deleted' OR (NOT EXISTS(SELECT 1 FROM media_deletions pending WHERE pending.key=?6)
     AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_versions retired JOIN hx_workspace_file_purges gone ON gone.org_id=retired.org_id AND gone.file_id=retired.file_id AND gone.version=retired.version WHERE retired.org_id=f.org_id AND retired.object_key=?6)))
    AND (?14 IS NULL OR EXISTS(SELECT 1 FROM hx_workspace_file_uploads upload WHERE upload.org_id=f.org_id AND upload.file_id=f.id AND upload.id=?14 AND upload.object_key=?6 AND upload.created_by=?10 AND upload.expected_version=?13 AND upload.status='uploading' AND upload.expires_at>?15))
    AND (?12 IS NULL OR EXISTS(SELECT 1 FROM hx_workspace_file_versions old WHERE old.org_id=f.org_id AND old.file_id=f.id AND old.version=?12
      AND old.kind='content' AND old.content_hash=?7 AND old.content_type=?8 AND old.size=?9
      AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=old.org_id AND p.file_id=old.file_id AND p.version=old.version)))`)
   .bind(orgId,fileId,version,operationId,kind,objectKey,contentHash,contentType,size,createdBy,at,restoredFrom,expectedVersion,stageId,Date.now()),
  db.prepare(`UPDATE hx_workspace_files SET current_version=?3,updated_at=?4 WHERE org_id=?1 AND id=?2 AND current_version=?5
   AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=?1 AND v.file_id=?2 AND v.version=?3 AND v.operation_id=?6)`)
   .bind(orgId,fileId,version,at,expectedVersion,operationId)
 ]);
 return results[0].meta.changes===1&&results[1].meta.changes===1?{saved:true,version}:{saved:false};
}

// Metadata is safe to serialize; object storage keys stay in the internal
// content lookup below and must never be included in a history API response.
export async function listFileVersions(db,{orgId,fileId,userId,before=null,limit=50}) {
 for(const [name,value] of Object.entries({orgId,fileId,userId}))required(value,name);
 if(!Number.isInteger(limit)||limit<1||limit>100||(before!==null&&(!Number.isSafeInteger(before)||before<1)))throw new FileVersionInputError('Invalid history page.');
 const {results}=await db.prepare(`SELECT v.version,v.kind,v.content_type,v.size,CASE WHEN v.created_by='system:retention' OR EXISTS(SELECT 1 FROM users author WHERE author.github_id=v.created_by) THEN v.created_by ELSE 'deleted-user' END AS created_by,v.created_at,v.restored_from,
  f.current_version,v.version=f.current_version AS is_current,p.version IS NOT NULL AS purged
  FROM hx_workspace_file_versions v JOIN hx_workspace_files f ON f.org_id=v.org_id AND f.id=v.file_id
  LEFT JOIN hx_workspace_file_purges p ON p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version
  WHERE f.org_id=?1 AND f.id=?2 AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
   AND (?4 IS NULL OR v.version<?4) ORDER BY v.version DESC LIMIT ?5`)
  .bind(orgId,fileId,userId,before,limit).all();
 return (results||[]).map(row=>({version:row.version,kind:row.kind,contentType:row.content_type,size:row.size,createdBy:row.created_by,createdAt:row.created_at,restoredFrom:row.restored_from,currentVersion:row.current_version,isCurrent:Boolean(row.is_current),purged:Boolean(row.purged)}));
}

// Internal read receipt, not a signed URL. The object-serving path must recheck
// authority/purge immediately before handing bytes to the requester.
export async function readFileVersionContent(db,{orgId,fileId,userId,version}) {
 for(const [name,value] of Object.entries({orgId,fileId,userId}))required(value,name);
 if(!Number.isSafeInteger(version)||version<1)throw new FileVersionInputError('A content version is required.');
 const row=await db.prepare(`SELECT v.version,v.object_key,v.content_hash,v.content_type,v.size FROM hx_workspace_file_versions v
  JOIN hx_workspace_files f ON f.org_id=v.org_id AND f.id=v.file_id
  WHERE f.org_id=?1 AND f.id=?2 AND v.version=?4 AND v.kind='content'
   AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)`)
  .bind(orgId,fileId,userId,version).first();
 return row?{version:row.version,objectKey:row.object_key,contentHash:row.content_hash,contentType:row.content_type,size:row.size}:null;
}

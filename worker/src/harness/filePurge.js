import {fileScopeAuthority,fileDeleteAuthority} from './fileAuthority.js';
import {FileVersionInputError} from './fileVersionLedger.js';

// Internal human-administration operation. The eventual HTTP caller must bind
// userId to the authenticated human, never to a requested agent/principal.
export async function purgeFileVersion(db,input) {
 const count=await purgeVersions(db,input);return {purged:count===1};
}
export async function purgeDeletedFile(db,{expectedVersion,...input}) {
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new FileVersionInputError('Expected deleted version is required.');
 return {purgedCount:await purgeVersions(db,{...input,version:null,expectedVersion})};
}
async function purgeVersions(db,{orgId,fileId,userId,version,reason,expectedVersion=null}) {
 if((version!==null&&(!Number.isSafeInteger(version)||version<1))||typeof reason!=='string'||!reason.trim()||reason.length>1000||/[\u0000-\u001f\u007f]/.test(reason))throw new FileVersionInputError('A version and purge reason are required.');
 const at=new Date().toISOString();
 const results=await db.batch([
  db.prepare(`INSERT OR IGNORE INTO hx_workspace_file_purges(org_id,file_id,version,created_by,created_at,reason)
   SELECT f.org_id,f.id,v.version,?3,?5,?6 FROM hx_workspace_files f
   JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id
   WHERE f.org_id=?1 AND f.id=?2 AND (?4 IS NULL OR v.version=?4) AND v.kind='content' AND v.version!=f.current_version
    AND (?4 IS NOT NULL OR (f.current_version=?7 AND EXISTS(SELECT 1 FROM hx_workspace_file_versions current WHERE current.org_id=f.org_id AND current.file_id=f.id AND current.version=f.current_version AND current.kind='deleted')))
    AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
    AND ${fileDeleteAuthority('f.org_id','f.created_by','?3','f.scope')}
    AND NOT EXISTS(SELECT 1 FROM message_holds h WHERE h.org_id=f.org_id AND h.released_at IS NULL
     AND ((h.kind='channel' AND h.target=f.scope) OR (h.kind='person' AND (
      h.target IN (f.created_login,v.created_login)
      OR (?4 IS NULL AND EXISTS(SELECT 1 FROM hx_workspace_file_versions held WHERE held.org_id=f.org_id AND held.file_id=f.id AND held.created_login=h.target))
      OR EXISTS(SELECT 1 FROM (SELECT github_id,login FROM users UNION ALL SELECT user_id AS github_id,login FROM hx_file_account_erasures) u WHERE u.login=h.target AND (u.github_id IN (f.created_by,v.created_by)
       OR (?4 IS NULL AND EXISTS(SELECT 1 FROM hx_workspace_file_versions held WHERE held.org_id=f.org_id AND held.file_id=f.id AND held.created_by=u.github_id))))))))`)
   .bind(orgId,fileId,userId,version,at,reason.trim(),expectedVersion),
  // Persist the physical deletion request in the same transaction as the
  // irreversible logical purge. Shared legacy keys stay until all references
  // have been purged; new restores always have independent object keys.
  db.prepare(`INSERT OR IGNORE INTO media_deletions(key,org_id,attempts,last_error,created_at,next_at)
   SELECT v.object_key,v.org_id,0,NULL,?5,?5 FROM hx_workspace_file_versions v
   JOIN hx_workspace_file_purges p ON p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version
   WHERE v.org_id=?1 AND v.file_id=?2 AND (?4 IS NULL OR v.version=?4) AND p.created_by=?3 AND p.created_at=?5
    AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_versions other WHERE other.org_id=v.org_id AND other.object_key=v.object_key
     AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=other.org_id AND gone.file_id=other.file_id AND gone.version=other.version))`)
   .bind(orgId,fileId,userId,version,at)
 ]);
 return results[0].meta.changes;
}

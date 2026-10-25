// Retire expired historical content under the existing workspace file policy.
// Current content expiration uses a separate atomic tombstone transition;
// historical purging never silently removes the current version.
const eligible=`v.kind='content' AND v.version!=f.current_version
 AND typeof(g.retention_files_days)='integer' AND g.retention_files_days>0
 AND julianday(v.created_at)<julianday(?1)-g.retention_files_days
 AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)
 AND NOT EXISTS(SELECT 1 FROM message_holds h WHERE h.org_id=f.org_id AND h.released_at IS NULL AND
  ((h.kind='channel' AND h.target=f.scope) OR (h.kind='person' AND (h.target IN (f.created_login,v.created_login)
   OR EXISTS(SELECT 1 FROM (SELECT github_id,login FROM users UNION ALL SELECT user_id AS github_id,login FROM hx_file_account_erasures) author
    WHERE author.login=h.target AND author.github_id IN (f.created_by,v.created_by))))))`;
export async function pruneHistoricalFiles(db,{now=Date.now(),limit=25}={}) {
 if(!Number.isSafeInteger(now)||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid retention bounds.');
 const at=new Date(now).toISOString();
 const joins='FROM hx_workspace_file_versions v JOIN hx_workspace_files f ON f.org_id=v.org_id AND f.id=v.file_id JOIN org_governance g ON g.org_id=f.org_id';
 const rows=(await db.prepare(`SELECT v.org_id,v.file_id,v.version ${joins} WHERE ${eligible} ORDER BY v.created_at,v.org_id,v.file_id,v.version LIMIT ?2`).bind(at,limit).all()).results;
 let purged=0;
 for(const row of rows){
  const results=await db.batch([
   db.prepare(`INSERT OR IGNORE INTO hx_workspace_file_purges(org_id,file_id,version,created_by,created_at,reason)
    SELECT v.org_id,v.file_id,v.version,'system:retention',?1,'Workspace file retention' ${joins}
    WHERE v.org_id=?2 AND v.file_id=?3 AND v.version=?4 AND ${eligible}`).bind(at,row.org_id,row.file_id,row.version),
   db.prepare(`INSERT OR IGNORE INTO media_deletions(key,org_id,attempts,last_error,created_at,next_at)
    SELECT v.object_key,v.org_id,0,NULL,?1,?1 FROM hx_workspace_file_versions v
    JOIN hx_workspace_file_purges p ON p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version
    WHERE v.org_id=?2 AND v.file_id=?3 AND v.version=?4 AND p.created_by='system:retention' AND p.created_at=?1
     AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_versions other WHERE other.org_id=v.org_id AND other.object_key=v.object_key
      AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges gone WHERE gone.org_id=other.org_id AND gone.file_id=other.file_id AND gone.version=other.version))`)
    .bind(at,row.org_id,row.file_id,row.version),
  ]);
  purged+=results[0].meta.changes;
 }
 return {examined:rows.length,purged};
}

export async function expireCurrentFiles(db,{now=Date.now(),limit=25}={}) {
 if(!Number.isSafeInteger(now)||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid retention bounds.');
 const at=new Date(now).toISOString();
 const currentEligible=eligible.replace('v.version!=f.current_version','v.version=f.current_version');
 const joins='FROM hx_workspace_file_versions v JOIN hx_workspace_files f ON f.org_id=v.org_id AND f.id=v.file_id JOIN org_governance g ON g.org_id=f.org_id';
 const rows=(await db.prepare(`SELECT v.org_id,v.file_id,v.version ${joins} WHERE ${currentEligible} AND v.version<9007199254740991 ORDER BY v.created_at,v.org_id,v.file_id LIMIT ?2`).bind(at,limit).all()).results;
 let expired=0;
 for(const row of rows){
  const operation=crypto.randomUUID();
  const result=await db.batch([
   db.prepare(`INSERT INTO hx_workspace_file_versions(org_id,file_id,version,operation_id,kind,created_by,created_login,created_at)
    SELECT v.org_id,v.file_id,v.version+1,?5,'deleted','system:retention','system:retention',?1 ${joins}
    WHERE v.org_id=?2 AND v.file_id=?3 AND v.version=?4 AND ${currentEligible}`).bind(at,row.org_id,row.file_id,row.version,operation),
   db.prepare(`UPDATE hx_workspace_files SET current_version=?4+1,updated_at=?1 WHERE org_id=?2 AND id=?3 AND current_version=?4
    AND EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=?2 AND v.file_id=?3 AND v.version=?4+1 AND v.operation_id=?5)`)
    .bind(at,row.org_id,row.file_id,row.version,operation),
  ]);
  if(result[0].meta.changes===1&&result[1].meta.changes===1)expired++;
 }
 return {examined:rows.length,expired};
}

export async function maintainFileRetention(db,options) {
 const current=await expireCurrentFiles(db,options);
 const history=await pruneHistoricalFiles(db,options);
 return {current,history};
}

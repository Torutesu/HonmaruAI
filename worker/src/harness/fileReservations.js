// Empty reservations have no saved content. Keep a seven-day retry window;
// never remove a version, an unfenced upload, or metadata under legal hold.
export async function pruneEmptyFileReservations(db,{now=Date.now(),limit=25}={}) {
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isFinite(new Date(now).getTime()))throw new TypeError('Invalid reservation cleanup bounds.');
 const cutoff=new Date(now-7*24*60*60*1000).toISOString();
 const result=await db.prepare(`DELETE FROM hx_workspace_files WHERE (org_id,id) IN (
  SELECT f.org_id,f.id FROM hx_workspace_files f
  WHERE f.current_version=0 AND f.created_at<?1 AND f.updated_at<?1
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id)
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_uploads u WHERE u.org_id=f.org_id AND u.file_id=f.id AND u.status='uploading')
   AND NOT EXISTS(SELECT 1 FROM message_holds h WHERE h.org_id=f.org_id AND h.released_at IS NULL
    AND ((h.kind='channel' AND h.target=f.scope) OR (h.kind='person' AND
      (h.target=f.created_login OR EXISTS(SELECT 1 FROM (SELECT github_id,login FROM users UNION ALL SELECT user_id AS github_id,login FROM hx_file_account_erasures) author WHERE author.github_id=f.created_by AND author.login=h.target)))))
  ORDER BY f.created_at,f.org_id,f.id LIMIT ?2
 )`).bind(cutoff,limit).run();
 // Cleanup stage rows deliberately remain: their keys fence late storage puts.
 return {removed:result.meta.changes};
}

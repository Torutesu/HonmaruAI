// Trusted SQL expression. Compare delimited participants literally, never LIKE:
// a login containing '_' or '%' must not match somebody else's room.
export const personalFileScope = `( ?2 IS NOT NULL AND ?2!='' AND (
 (substr(f.scope,1,3)='dm:' AND (substr(f.scope,4,length(?2)+1)=?2||'|' OR substr(f.scope,-(length(?2)+1))='|'||?2))
 OR (substr(f.scope,1,3)='ag:' AND substr(f.scope,-(length(?2)+1))='|'||?2)))`;
const eligible=`${personalFileScope} AND NOT EXISTS(SELECT 1 FROM users WHERE github_id=?1)
 AND NOT EXISTS(SELECT 1 FROM message_holds h WHERE h.org_id=f.org_id AND h.released_at IS NULL AND
  ((h.kind='channel' AND h.target=f.scope) OR (h.kind='person' AND (h.target IN (?2,f.created_login)
   OR EXISTS(SELECT 1 FROM hx_workspace_file_versions held WHERE held.org_id=f.org_id AND held.file_id=f.id AND held.created_login=h.target)
   OR EXISTS(SELECT 1 FROM (SELECT github_id,login FROM users UNION ALL SELECT user_id AS github_id,login FROM hx_file_account_erasures) author WHERE author.login=h.target AND (author.github_id=f.created_by
    OR EXISTS(SELECT 1 FROM hx_workspace_file_versions held WHERE held.org_id=f.org_id AND held.file_id=f.id AND held.created_by=author.github_id)))))))`;

export async function erasePersonalFileBatch(db,userId,login) {
 const rows=(await db.prepare(`SELECT f.org_id,f.id FROM hx_workspace_files f WHERE ${eligible} ORDER BY f.org_id,f.id LIMIT 25`).bind(userId,login).all()).results;
 for(const row of rows){
  const condition=`f.org_id=?3 AND f.id=?4 AND ${eligible}`,at=new Date().toISOString();
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO media_deletions(key,org_id,attempts,last_error,created_at,next_at)
    SELECT v.object_key,v.org_id,0,NULL,?5,?5 FROM hx_workspace_file_versions v JOIN hx_workspace_files f ON f.org_id=v.org_id AND f.id=v.file_id
    WHERE ${condition} AND v.object_key IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_versions other WHERE other.org_id=v.org_id AND other.file_id!=v.file_id AND other.object_key=v.object_key
      AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=other.org_id AND p.file_id=other.file_id AND p.version=other.version))`)
    .bind(userId,login,row.org_id,row.id,at),
   db.prepare(`UPDATE hx_workspace_file_uploads SET status='cleanup',expires_at=0,created_by='',file_id=''
    WHERE org_id=?3 AND file_id=?4 AND EXISTS(SELECT 1 FROM hx_workspace_files f WHERE ${condition})`).bind(userId,login,row.org_id,row.id),
   db.prepare(`DELETE FROM hx_workspace_files AS f WHERE ${condition}`).bind(userId,login,row.org_id,row.id),
  ]);
 }
}

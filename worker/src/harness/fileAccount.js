// Called after account identity/membership removal. File content remains an
// organizational record; only identity fields may change. Active holds keep
// their evidence until release; personal-scope content is queued for removal.
import {erasePersonalFileBatch,personalFileScope} from './filePersonalErasure.js';
export async function queueFileAccountErasure(db,userId,login) {
 const exists=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_file_account_erasures'").first();
 if(!exists)return;
 const now=Date.now();
 await db.prepare('INSERT INTO hx_file_account_erasures(user_id,login,requested_at,next_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET next_at=excluded.next_at')
  .bind(userId,login,now,now).run();
}
export async function anonymizeFileAccount(db,userId,login) {
 const exists=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hx_workspace_files'").first();
 if(!exists)return;
 await erasePersonalFileBatch(db,userId,login);
 await db.batch([
  db.prepare(`UPDATE hx_workspace_file_versions AS v SET created_by='deleted-user',created_login='deleted-user'
   WHERE v.created_by=?1 AND NOT EXISTS(SELECT 1 FROM users WHERE github_id=?1)
    AND NOT EXISTS(SELECT 1 FROM message_holds h JOIN hx_workspace_files f ON f.org_id=v.org_id AND f.id=v.file_id
     WHERE h.org_id=v.org_id AND h.released_at IS NULL AND
     ((h.kind='channel' AND h.target=f.scope) OR (h.kind='person' AND h.target IN (v.created_login,f.created_login,?2))))`).bind(userId,login),
  db.prepare(`UPDATE hx_workspace_files AS f SET created_by='deleted-user',created_login='deleted-user'
   WHERE f.created_by=?1 AND NOT EXISTS(SELECT 1 FROM users WHERE github_id=?1)
    AND NOT EXISTS(SELECT 1 FROM message_holds h WHERE h.org_id=f.org_id AND h.released_at IS NULL AND
     ((h.kind='channel' AND h.target=f.scope) OR (h.kind='person' AND (h.target IN (f.created_login,?2)
      OR EXISTS(SELECT 1 FROM hx_workspace_file_versions v WHERE v.org_id=f.org_id AND v.file_id=f.id AND v.created_login=h.target)))))`).bind(userId,login),
  db.prepare(`DELETE FROM hx_file_account_erasures WHERE user_id=?1
   AND NOT EXISTS(SELECT 1 FROM users WHERE github_id=?1)
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_files WHERE created_by=?1)
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_versions WHERE created_by=?1)
   AND NOT EXISTS(SELECT 1 FROM hx_workspace_files f WHERE ${personalFileScope})`).bind(userId,login),
 ]);
}

// Bounded recovery; a queued request never authorizes deleting a live account.
// The stored login is retained only while held identities need reconciliation.
export async function recoverFileAccountErasures(db,{now=Date.now(),limit=25}={}) {
 if(!Number.isSafeInteger(now)||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid recovery bounds.');
 const rows=(await db.prepare('SELECT user_id,login FROM hx_file_account_erasures WHERE next_at<=? ORDER BY next_at,user_id LIMIT ?').bind(now,limit).all()).results;
 let completed=0;
 for(const row of rows){
  const claimed=await db.prepare('UPDATE hx_file_account_erasures SET next_at=? WHERE user_id=? AND next_at<=?').bind(now+3600000,row.user_id,now).run();
  if(claimed.meta.changes!==1)continue;
  await anonymizeFileAccount(db,row.user_id,row.login);
  if(!await db.prepare('SELECT 1 FROM hx_file_account_erasures WHERE user_id=?').bind(row.user_id).first())completed++;
 }
 return {examined:rows.length,completed};
}

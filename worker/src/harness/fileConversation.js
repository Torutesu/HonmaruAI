import {fileScopeAuthority} from './fileAuthority.js';

// Versioned files share ordinary channel replies, but not attachment IDs.
export async function conversationFile(db,{orgId,userId,fileId}){
 if(typeof fileId!=='string'||!/^(?:file-)?[a-f0-9-]{36}$/i.test(fileId))return null;
 const ready=await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges')").first();
 if(ready.n!==3)return null;
 return db.prepare(`SELECT f.id,f.scope AS channel,f.path AS name,v.version,1 AS versioned FROM hx_workspace_files f
  JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
  WHERE f.org_id=?1 AND f.id=?2 AND f.scope!='workspace' AND v.kind='content'
  AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
  AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)`)
  .bind(orgId,fileId,userId).first();
}

export async function workspaceFileConversation(db,{orgId,userId,file,create=false}){
 const id=`workspace-file-thread-${file.id}`;
 if(create)await db.prepare(`INSERT OR IGNORE INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at)
  SELECT ?4,f.org_id,f.scope,u.login,'message','ファイル: '||f.path||' (v'||v.version||')',?5
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
  JOIN users u ON u.github_id=?3
  WHERE f.org_id=?1 AND f.id=?2 AND f.scope=?6 AND f.scope!='workspace' AND v.kind='content'
  AND ${fileScopeAuthority('f.org_id','f.scope','?3')}
  AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)`)
  .bind(orgId,file.id,userId,id,new Date().toISOString(),file.channel).run();
 // A lookup is read-only; revalidate even if a caller held an earlier file snapshot.
 const live=await conversationFile(db,{orgId,userId,fileId:file.id});
 if(!live||live.channel!==file.channel)return {error:'No such file.',status:404};
 const row=await db.prepare('SELECT * FROM channel_messages WHERE org_id=? AND id=? AND channel=?').bind(orgId,id,file.channel).first();
 if(row?.deleted_at)return {error:'This file conversation was deleted.',status:410};
 if(create&&!row)return {error:'No such file.',status:404};
 return {row,threadId:row?.id||null};
}

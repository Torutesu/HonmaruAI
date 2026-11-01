import {conversationWriteAuthority} from './conversationWriteAuthority.js';

// Trusted parameter expressions, shared by the snapshot read and the reply
// INSERT. Record conversations remain independent of app source threads.
const replyAuthority = (org,app,user,table,row,channel,thread) => `
  a.org_id=${org} AND a.id=${app} AND m.user_github_id=${user} AND LOWER(COALESCE(m.role,'guest'))!='guest'
  AND (COALESCE(policy.visibility,'workspace')='workspace' OR a.created_by=${user})
  AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=${org} AND d.purge_started_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=${org})
  AND (${row}='' OR (
    EXISTS(SELECT 1 FROM hx_tables t JOIN hx_rows r ON r.org_id=t.org_id AND r.table_id=t.id
      WHERE t.org_id=${org} AND t.id=${table} AND r.id=${row}
        AND (a.table_id=${table} OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=${table})))
    AND NOT EXISTS(SELECT 1 FROM hx_apps linked LEFT JOIN hx_app_access lp ON lp.org_id=linked.org_id AND lp.app_id=linked.id
      WHERE linked.org_id=${org} AND (linked.table_id=${table} OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=linked.org_id AND e.app_id=linked.id AND e.table_id=${table}))
        AND COALESCE(lp.visibility,'workspace')!='workspace' AND linked.created_by IS NOT ${user})
    AND NOT EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=${org} AND e.table_id=${table} AND NOT EXISTS(SELECT 1 FROM hx_apps linked WHERE linked.org_id=e.org_id AND linked.id=e.app_id))))
  AND (${row}!='' OR (${channel} IS NULL AND s.app_id IS NULL) OR (
    s.channel=${channel} AND s.thread_id=${thread} AND root.id IS NOT NULL AND root.parent_id IS NULL AND root.deleted_at IS NULL
    AND ${conversationWriteAuthority(org,'s.channel',user)}
    AND (substr(s.channel,1,2)!='b:' OR (b.slug IS NOT NULL AND b.archived_at IS NULL AND room.deleted_at IS NULL))))`;

const replyFrom = `FROM hx_apps a JOIN memberships m ON m.org_id=a.org_id JOIN users u ON u.github_id=m.user_github_id
  LEFT JOIN hx_app_access policy ON policy.org_id=a.org_id AND policy.app_id=a.id
  LEFT JOIN hx_app_conversation_sources s ON s.org_id=a.org_id AND s.app_id=a.id AND ?5=''
  LEFT JOIN channel_messages root ON root.org_id=s.org_id AND root.id=s.thread_id AND root.channel=s.channel
  LEFT JOIN businesses b ON b.org_id=s.org_id AND 'b:'||b.slug=s.channel
  LEFT JOIN conversation_members cm ON cm.org_id=s.org_id AND cm.channel=s.channel AND cm.login=u.login
  LEFT JOIN hx_room_access room ON room.org_id=s.org_id AND room.channel=s.channel
  LEFT JOIN hx_room_guidelines g ON g.org_id=s.org_id AND g.channel=s.channel`;
const snapshotColumns=`m.created_at AS membershipSince,a.created_at AS appCreatedAt,
  CASE WHEN substr(s.channel,1,2)='b:' THEN b.created_at ELSE NULL END AS roomCreatedAt,
  CASE WHEN substr(s.channel,1,2)='b:' AND b.private=1 THEN cm.added_at ELSE NULL END AS roomMemberSince,
  CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.body,'') ELSE '' END AS guidelineBody,
  CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.version,0) ELSE 0 END AS guidelineVersion,
  CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.updated_at,'') ELSE '' END AS guidelineUpdatedAt`;
const authority=replyAuthority('?1','?2','?3','?4','?5','?6','?7');

export async function appReplySnapshot(db,orgId,appId,userId,scope,source) {
  return db.prepare(`SELECT ${snapshotColumns} ${replyFrom} WHERE ${authority}`)
    .bind(orgId,appId,String(userId),scope.tableId||'',scope.rowId||'',source?.channel||null,source?.threadId||null).first();
}

// The same authorization and guideline values must hold at the exact INSERT,
// not merely during an earlier async check.
export async function saveFencedAppReply(db,orgId,appId,userId,scope,source,snapshot,requestId,answer) {
  const result=await db.prepare(`INSERT OR IGNORE INTO hx_app_messages(org_id,app_id,table_id,row_id,author_id,request_id,body,created_at)
    SELECT ?1,?2,?4,?5,'__app_ai',?15,?16,?17 WHERE EXISTS(SELECT 1 ${replyFrom} WHERE ${authority}
      AND m.created_at IS ?8 AND a.created_at IS ?9
      AND (CASE WHEN substr(s.channel,1,2)='b:' THEN b.created_at ELSE NULL END) IS ?10
      AND (CASE WHEN substr(s.channel,1,2)='b:' AND b.private=1 THEN cm.added_at ELSE NULL END) IS ?11
      AND (CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.body,'') ELSE '' END) IS ?12
      AND (CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.version,0) ELSE 0 END) IS ?13
      AND (CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.updated_at,'') ELSE '' END) IS ?14)`)
    .bind(orgId,appId,String(userId),scope.tableId||'',scope.rowId||'',source?.channel||null,source?.threadId||null,
      snapshot.membershipSince,snapshot.appCreatedAt,snapshot.roomCreatedAt,snapshot.roomMemberSince,snapshot.guidelineBody,snapshot.guidelineVersion,snapshot.guidelineUpdatedAt,
      requestId,answer.slice(0,12000),new Date().toISOString()).run();
  if(!result.meta?.changes)return null;
  return db.prepare('SELECT sequence FROM hx_app_messages WHERE org_id=? AND app_id=? AND author_id=? AND request_id=?').bind(orgId,appId,'__app_ai',requestId).first();
}

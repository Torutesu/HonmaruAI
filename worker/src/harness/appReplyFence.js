import {skillSessionAuthority} from './skillSessionAuthority.js';
import {skillPolicyFingerprint,skillSsoDeadline} from './skillPolicyProof.js';
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
// Match appConversation's last 30 messages at or before the triggering ID.
// The same JSON expression is checked in the response INSERT.
const historyJson=`COALESCE((SELECT json_group_array(json_object('id',history.sequence,'authorId',history.author_id,'authorName',history.authorName,'body',history.body,'createdAt',history.created_at))
  FROM (SELECT hm.sequence,hm.author_id,CASE WHEN hm.author_id='__app_ai' THEN 'AI' ELSE COALESCE(hu.name,hu.login,'メンバー') END AS authorName,hm.body,hm.created_at
    FROM hx_app_messages hm LEFT JOIN users hu ON hu.github_id=hm.author_id
    WHERE hm.org_id=?1 AND hm.app_id=?2 AND hm.table_id=?4 AND hm.row_id=?5 AND hm.sequence<=?8 ORDER BY hm.sequence DESC LIMIT 30) history),'[]')`;
const snapshotColumns=`m.created_at AS membershipSince,a.created_at AS appCreatedAt,
  a.name AS appName,a.description AS appDescription,a.updated_at AS appUpdatedAt,
  (SELECT data FROM hx_rows WHERE org_id=?1 AND table_id=?4 AND id=?5) AS recordData,
  (SELECT updated_at FROM hx_rows WHERE org_id=?1 AND table_id=?4 AND id=?5) AS recordUpdatedAt,
  ${historyJson} AS historyJson,
  CASE WHEN substr(s.channel,1,2)='b:' THEN b.created_at ELSE NULL END AS roomCreatedAt,
  CASE WHEN substr(s.channel,1,2)='b:' AND b.private=1 THEN cm.added_at ELSE NULL END AS roomMemberSince,
  CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.body,'') ELSE '' END AS guidelineBody,
  CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.version,0) ELSE 0 END AS guidelineVersion,
  CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.updated_at,'') ELSE '' END AS guidelineUpdatedAt`;
const authority=replyAuthority('?1','?2','?3','?4','?5','?6','?7')+` AND EXISTS(SELECT 1 FROM hx_app_messages request WHERE request.org_id=?1 AND request.app_id=?2 AND request.table_id=?4 AND request.row_id=?5 AND request.sequence=?8 AND request.author_id=?3)`;
const sessionFence=(key,created,membership,fingerprint,deadline)=>`AND (m.created_at IS ${membership} AND EXISTS(SELECT 1 FROM sessions sess WHERE sess.token=${key} AND sess.github_id=?3 AND sess.created_at IS ${created}) AND ${skillSessionAuthority('?1','?3',key)} AND (${skillPolicyFingerprint('?1','?3',key)})=${fingerprint} AND ${skillSsoDeadline(deadline)})`;
const proofValues=proof=>[proof.key,proof.sessionCreatedAt,proof.membershipSince,proof.fingerprint,proof.ssoDeadline??null];

export async function appReplySnapshot(db,orgId,appId,userId,scope,source,messageId,proof) {
  return db.prepare(`SELECT ${snapshotColumns} ${replyFrom} WHERE ${authority} ${proof?sessionFence('?9','?10','?11','?12','?13'):''}`)
    .bind(orgId,appId,String(userId),scope.tableId||'',scope.rowId||'',source?.channel||null,source?.threadId||null,messageId,...(proof?proofValues(proof):[])).first();
}

// The same authorization, context and guideline values are checked inside
// every consequential write, including notification/status creation.
const snapshotGuard=proof=>`${authority}
  AND (m.created_at IS ?9 AND a.created_at IS ?10)
  AND (a.name IS ?19 AND a.description IS ?20 AND a.updated_at IS ?21
    AND (SELECT data FROM hx_rows WHERE org_id=?1 AND table_id=?4 AND id=?5) IS ?22
    AND (SELECT updated_at FROM hx_rows WHERE org_id=?1 AND table_id=?4 AND id=?5) IS ?23
    AND ${historyJson} IS ?24)
  ${proof?sessionFence('?25','?26','?27','?28','?29'):''}
  AND ((CASE WHEN substr(s.channel,1,2)='b:' THEN b.created_at ELSE NULL END) IS ?11
    AND (CASE WHEN substr(s.channel,1,2)='b:' AND b.private=1 THEN cm.added_at ELSE NULL END) IS ?12
    AND (CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.body,'') ELSE '' END) IS ?13
    AND (CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.version,0) ELSE 0 END) IS ?14
    AND (CASE WHEN substr(s.channel,1,2)='b:' THEN COALESCE(g.updated_at,'') ELSE '' END) IS ?15)`;
const fenceValues=(orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof)=>[
  orgId,appId,String(userId),scope.tableId||'',scope.rowId||'',source?.channel||null,source?.threadId||null,messageId,
  snapshot.membershipSince,snapshot.appCreatedAt,snapshot.roomCreatedAt,snapshot.roomMemberSince,snapshot.guidelineBody,snapshot.guidelineVersion,snapshot.guidelineUpdatedAt,
  requestId,answer.slice(0,12000),new Date().toISOString(),snapshot.appName,snapshot.appDescription,snapshot.appUpdatedAt,snapshot.recordData,snapshot.recordUpdatedAt,snapshot.historyJson,...(proof?proofValues(proof):[])
];
export async function saveFencedAppReply(db,orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof) {
  const values=fenceValues(orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof);
  const result=await db.prepare(`INSERT OR IGNORE INTO hx_app_messages(org_id,app_id,table_id,row_id,author_id,request_id,body,created_at)
    SELECT ?1,?2,?4,?5,'__app_ai',?16,?17,?18 WHERE EXISTS(SELECT 1 ${replyFrom} WHERE ${snapshotGuard(proof)})`).bind(...values).run();
  if(!result.meta?.changes)return null;
  return db.prepare('SELECT sequence FROM hx_app_messages WHERE org_id=? AND app_id=? AND author_id=? AND request_id=?').bind(orgId,appId,'__app_ai',requestId).first();
}

export async function completeFencedAppReply(db,orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof,replyId){
  const values=fenceValues(orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof);
  const params=[...values,...(proof?[]:[null,null,null,null,null]),replyId];
  const exists=`EXISTS(SELECT 1 ${replyFrom} WHERE ${snapshotGuard(proof)})`;
  const [notification,status]=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_app_notifications(org_id,app_id,message_id,user_id,kind)
      SELECT ?1,?2,?30,?3,'ai' WHERE ${exists} AND EXISTS(SELECT 1 FROM hx_app_ai_replies job WHERE job.org_id=?1 AND job.app_id=?2 AND job.message_id=?8 AND job.status='running')`).bind(...params),
    db.prepare(`UPDATE hx_app_ai_replies SET status='succeeded' WHERE org_id=?1 AND app_id=?2 AND message_id=?8 AND status='running' AND ${exists}`).bind(...params.slice(0,proof?29:24)),
  ]);
  return Boolean(status.meta?.changes && (notification.meta?.changes || await db.prepare("SELECT 1 FROM hx_app_notifications WHERE org_id=? AND app_id=? AND message_id=? AND user_id=? AND kind='ai'").bind(orgId,appId,replyId,String(userId)).first()));
}

export async function mayAnnounceFencedAppReply(db,orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof){
  const values=fenceValues(orgId,appId,userId,scope,source,snapshot,messageId,requestId,answer,proof);
  return Boolean(await db.prepare(`SELECT 1 ${replyFrom} WHERE ${snapshotGuard(proof)}`).bind(...values).first());
}

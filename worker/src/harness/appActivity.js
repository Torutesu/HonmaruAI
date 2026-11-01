import {conversationWriteAuthority} from './conversationWriteAuthority.js';
import {skillSessionAuthority} from './skillSessionAuthority.js';
import {currentSkillPolicy,skillPolicyFingerprint,skillSsoDeadline} from './skillPolicyProof.js';
import {currentIp} from '../requestContext.js';
import {roleIn} from '../permissions.js';

// The notification values and every ACL used to release them are selected in
// one SQLite snapshot. Record conversations never inherit an app source.
const activityFrom=`FROM hx_app_notifications n
  JOIN hx_app_messages m ON m.sequence=n.message_id AND m.org_id=n.org_id AND m.app_id=n.app_id
  JOIN hx_apps a ON a.id=n.app_id AND a.org_id=n.org_id
  JOIN memberships member ON member.org_id=n.org_id AND member.user_github_id=?2
  LEFT JOIN hx_app_access policy ON policy.org_id=a.org_id AND policy.app_id=a.id
  LEFT JOIN users u ON u.github_id=m.author_id
  LEFT JOIN hx_app_conversation_sources source ON source.org_id=a.org_id AND source.app_id=a.id AND m.row_id=''
  LEFT JOIN channel_messages root ON root.org_id=source.org_id AND root.id=source.thread_id AND root.channel=source.channel`;
const activityAuthority=`n.org_id=?1 AND n.user_id=?2 AND LOWER(COALESCE(member.role,'guest'))!='guest'
  AND (COALESCE(policy.visibility,'workspace')='workspace' OR a.created_by=?2)
  AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND (d.purge_started_at IS NOT NULL OR (COALESCE(d.due_at,'')!='' AND NOT (LOWER(member.role)='owner' OR (instr(?1,'/')>0 AND LOWER(member.role)='admin')))))
  AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)
  AND length(m.table_id)<=100 AND length(m.row_id)<=100
  AND ((m.table_id='' AND m.row_id='') OR (m.table_id!='' AND m.row_id!='' AND
    EXISTS(SELECT 1 FROM hx_tables t JOIN hx_rows r ON r.org_id=t.org_id AND r.table_id=t.id
      WHERE t.org_id=?1 AND t.id=m.table_id AND r.id=m.row_id AND (a.table_id=t.id OR EXISTS(
        SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=t.id)))
    AND NOT EXISTS(SELECT 1 FROM hx_apps linked LEFT JOIN hx_app_access lp ON lp.org_id=linked.org_id AND lp.app_id=linked.id
      WHERE linked.org_id=?1 AND (linked.table_id=m.table_id OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=linked.org_id AND e.app_id=linked.id AND e.table_id=m.table_id))
        AND COALESCE(lp.visibility,'workspace')!='workspace' AND linked.created_by IS NOT ?2)
    AND NOT EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=?1 AND e.table_id=m.table_id AND NOT EXISTS(
      SELECT 1 FROM hx_apps linked WHERE linked.org_id=e.org_id AND linked.id=e.app_id))))
  AND (m.row_id!='' OR source.app_id IS NULL OR (root.id IS NOT NULL AND root.parent_id IS NULL AND root.deleted_at IS NULL
    AND ${conversationWriteAuthority('?1','source.channel','?2')}))`;
const proofFence=(member,key,created,fingerprint,deadline)=>`AND member.created_at IS ${member} AND EXISTS(SELECT 1 FROM sessions sess WHERE sess.token=${key} AND sess.github_id=?2 AND sess.created_at IS ${created})
  AND ${skillSessionAuthority('?1','?2',key)} AND (${skillPolicyFingerprint('?1','?2',key)})=${fingerprint} AND ${skillSsoDeadline(deadline)}`;
const proofValid=p=>p&&typeof p.memberSince==='string'&&p.memberSince&&typeof p.sessionCreatedAt==='string'&&p.sessionCreatedAt&&typeof p.key==='string'&&p.key.startsWith('h1:')&&typeof p.fingerprint==='string'&&p.fingerprint;
const argsFor=(org,user,proof)=>[org,String(user),...(proof?[proof.memberSince,proof.key,proof.sessionCreatedAt,proof.fingerprint,proof.ssoDeadline??null]:[])];

// For network-enforced workspaces the IP must come from the trusted request,
// rather than an absent background context which policyDenial may ignore.
export function activityProofRequiresIp(fingerprint){
 try{const value=JSON.parse(fingerprint).network;const network=typeof value==='string'?JSON.parse(value):value;return Boolean(network?.enforce)}catch{return true}
}

export async function appActivityProof(env,orgId,who){
 try{
  const first=await currentSkillPolicy(env,orgId,who.session.github_id,who.session.token);
  if(!first.allowed)return null;
  // Apply the canonical legacy-workspace owner migration before the final
  // snapshot, then check the policy once again after that migration.
  await roleIn(env.DB,orgId,who.session.github_id);
  const checked=await currentSkillPolicy(env,orgId,who.session.github_id,who.session.token);
  if(checked.allowed&&who.membershipSince&&who.session.created_at&&who.session.token?.startsWith('h1:')&&(currentIp()||!activityProofRequiresIp(checked.fingerprint)))
   return {memberSince:who.membershipSince,key:who.session.token,sessionCreatedAt:who.session.created_at,fingerprint:checked.fingerprint,ssoDeadline:checked.ssoDeadline};
 }catch{/* Fail closed for app content. */}
 return null;
}

export async function visibleAppNotifications(db,orgId,userId,proof,appId=null,messageId=null,keys=null){
 if(proof!==undefined&&!proofValid(proof))return [];
 const args=argsFor(orgId,userId,proof);const filters=[];
 if(appId!==null){args.push(appId);filters.push(`n.app_id=?${args.length}`)}
 if(messageId!==null){args.push(messageId);filters.push(`n.message_id=?${args.length}`)}
 if(keys!==null){
  const ids=keys.filter(key=>/^a:[1-9][0-9]*$/.test(key)).slice(0,100).map(key=>key.slice(2));
  if(!ids.length)return [];
  args.push(JSON.stringify(ids));filters.push(`CAST(n.message_id AS TEXT) IN (SELECT value FROM json_each(?${args.length}))`);
 }
 const sql=`SELECT n.message_id,n.kind,n.read_at,m.body,m.table_id,m.row_id,m.created_at,m.app_id,a.name AS app_name,u.name AS author_name,u.login AS author_login
  ${activityFrom} WHERE ${activityAuthority} ${proof?proofFence('?3','?4','?5','?6','?7'):''} ${filters.map(filter=>`AND ${filter}`).join(' ')} ORDER BY m.sequence DESC LIMIT 100`;
 const {results}=await db.prepare(sql).bind(...args).all();
 return results||[];
}
export async function appActivity(db,orgId,userId,proof){
 return (await visibleAppNotifications(db,orgId,userId,proof)).map(row=>({
  key:`a:${row.message_id}`,type:row.kind==='ai'?'reply':'mention',unread:!row.read_at,at:row.created_at,
  app:{id:row.app_id,name:row.app_name,tableId:row.table_id||undefined,rowId:row.row_id||undefined},
  message:{id:`object_${row.message_id}`,channel:`app:${row.app_id}`,kind:row.kind==='ai'?'ai':'message',body:row.body,createdAt:row.created_at,authorName:row.author_name||row.author_login||'AI',parentId:null},
 }));
}
export async function readAppActivity(db,orgId,userId,keys=null,proof,appId=null){
 const wanted=keys===null?null:new Set(keys.filter(k=>/^a:[1-9][0-9]*$/.test(k)).slice(0,100));
 const rows=await visibleAppNotifications(db,orgId,userId,proof,appId,null,wanted===null?null:[...wanted]);
 if(!rows.length)return [];
 const results=await db.batch(rows.map(row=>db.prepare(`UPDATE hx_app_notifications SET read_at=COALESCE(read_at,?4)
   WHERE org_id=?1 AND user_id=?2 AND message_id=?3 AND EXISTS(SELECT 1 ${activityFrom} WHERE ${activityAuthority} ${proof?proofFence('?5','?6','?7','?8','?9'):''} AND n.message_id=?3)`)
   .bind(orgId,String(userId),row.message_id,new Date().toISOString(),...argsFor(orgId,userId,proof).slice(2))));
 return rows.filter((_row,index)=>results[index]?.meta?.changes).map(row=>`a:${row.message_id}`);
}

// Channel activity can contain ordinary channel keys too. Revalidate only
// app IDs so the existing channel/guest synchronization remains unchanged.
export async function appActivityDeliveryKeys(db,orgId,userId,keys,proof){
 const ordinary=keys.filter(key=>!key.startsWith('a:'));
 if(!proof||!keys.some(key=>key.startsWith('a:')))return ordinary;
 try{
  const rows=await visibleAppNotifications(db,orgId,userId,proof,null,null,keys);
  const allowed=new Set(rows.map(row=>`a:${row.message_id}`));
  return keys.filter(key=>!key.startsWith('a:')||allowed.has(key));
 }catch{return ordinary}
}

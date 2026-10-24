import {getWorkflow} from './workflows.js';
import {workflowSource} from './workflowSource.js';
import {postMessage} from '../channels.js';

// No destinations or recipients supplied by the caller: resolve stored intent.
// A persisted client ID makes retry after an uncertain acknowledgement safe.
export async function deliverWorkflowNotices(env,orgId,workflowId){
 const db=env.DB;
 const {results}=await db.prepare(`SELECT n.* FROM hx_workflow_safety_notices n
   JOIN hx_workflow_safety s ON s.org_id=n.org_id AND s.workflow_id=n.workflow_id AND s.generation=n.generation
   WHERE n.org_id=?1 AND n.workflow_id=?2 AND n.delivered_at IS NULL AND s.paused_at IS NOT NULL ORDER BY n.created_at LIMIT 10`)
   .bind(orgId,workflowId).all();
 let delivered=0;
 for(const notice of results){
  const workflow=await getWorkflow(db,orgId,workflowId,{viewerId:notice.recipient_id});
  if(!workflow||String(workflow.createdBy)!==String(notice.recipient_id))continue;
  const target=await workflowSource(db,orgId,notice.recipient_id,workflowId);
  if(target.error||!target.source||target.source.createdBy!==String(notice.recipient_id))continue;
  const identity=JSON.stringify([orgId,workflowId,notice.generation]);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
  const clientId='tmp-'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const user=await db.prepare('SELECT locale FROM users WHERE github_id=?1').bind(notice.recipient_id).first();
  const body=String(user?.locale||'').startsWith('ja')
   ? `自動化「${workflow.name}」は3回連続で失敗したため停止しました。実行履歴を確認してから再開してください。保留イベントは自動再生されません。`
   : `Automation “${workflow.name}” paused after three consecutive failures. Review its run history before resuming. Held events will not replay automatically.`;
  const result=await postMessage(db,{orgId,key:target.source.channel,parentId:target.source.threadId,authorLogin:'__workflow',kind:'ai',body,clientId,workflowNotice:{workflowId,generation:notice.generation,recipientId:String(notice.recipient_id)}});
  if(!result.row||result.row.channel!==target.source.channel||result.row.parent_id!==target.source.threadId)continue;
  await db.prepare('UPDATE hx_workflow_safety_notices SET delivered_at=COALESCE(delivered_at,?1) WHERE org_id=?2 AND workflow_id=?3 AND generation=?4 AND recipient_id=?5')
   .bind(new Date().toISOString(),orgId,workflowId,notice.generation,notice.recipient_id).run();
  if(!result.replay){
   const {broadcastStored}=await import('../channelRoutes.js');
   await broadcastStored(env,orgId,target.source.channel,result.row).catch(()=>{});
  }
  delivered++;
 }
 return delivered;
}

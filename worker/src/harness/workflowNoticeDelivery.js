import {getWorkflow} from './workflows.js';
import {workflowSource} from './workflowSource.js';
import {postMessage} from '../channels.js';

const clientIdFor=async identity=>{
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
 return 'tmp-'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
};

// A scheduled item is still enabled when its deployment-key budget is full.
// Keep one durable notice for each continuous exhaustion episode; recording
// the episode and outbox row together makes cron retries idempotent.
export async function recordScheduledBudgetSkip(db,orgId,workflow,reason,now=new Date().toISOString()){
 const statements=[
  db.prepare(`INSERT INTO hx_workflow_schedule_budget_state(org_id,workflow_id,episode,is_active,recipient_id,updated_at)
   VALUES(?1,?2,1,1,?3,?4) ON CONFLICT(org_id,workflow_id) DO UPDATE SET episode=episode+1,is_active=1,recipient_id=excluded.recipient_id,updated_at=excluded.updated_at
   WHERE hx_workflow_schedule_budget_state.is_active=0`).bind(orgId,workflow.id,String(workflow.createdBy),now),
  db.prepare(`INSERT OR IGNORE INTO hx_workflow_schedule_budget_notices(id,org_id,workflow_id,episode,recipient_id,reason,created_at)
   SELECT workflow_id||':'||episode,org_id,workflow_id,episode,recipient_id,?3,?4 FROM hx_workflow_schedule_budget_state state
   WHERE state.org_id=?1 AND state.workflow_id=?2 AND state.is_active=1 AND NOT EXISTS(
    SELECT 1 FROM hx_workflow_schedule_budget_notices n WHERE n.org_id=state.org_id AND n.workflow_id=state.workflow_id AND n.episode=state.episode)`)
   .bind(orgId,workflow.id,String(reason),now),
 ];
 await db.batch(statements);
}

export async function clearScheduledBudgetSkip(db,orgId,workflowId,now=new Date().toISOString()){
 await db.prepare(`UPDATE hx_workflow_schedule_budget_state SET is_active=0,updated_at=?1
  WHERE org_id=?2 AND workflow_id=?3 AND is_active=1`).bind(now,orgId,workflowId).run();
}

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
  const clientId=await clientIdFor(JSON.stringify(['pause',orgId,workflowId,notice.generation]));
  const user=await db.prepare('SELECT locale FROM users WHERE github_id=?1').bind(notice.recipient_id).first();
  const reason=workflow.safety?.pause_reason||'consecutive_failures',isJa=String(user?.locale||'').startsWith('ja');
  const ai=reason.startsWith('budget_ai_'),runBudget=reason.startsWith('budget_')&&!ai;
  const label=reason==='budget_ai_24h'?'24h':reason==='budget_ai_7d'?'7d':reason==='budget_ai_30d'?'30d':reason==='budget_daily'?'daily':reason==='budget_weekly'?'weekly':'monthly';
  const body=ai
   ?isJa?(reason==='budget_ai_unpriced'?`自動化「${workflow.name}」はAI使用量の単価を判定できないため停止しました。単価不明の利用が直近期間から外れるか、上限を変更すると次のトリガーから再開します。`:`自動化「${workflow.name}」は直近${label}のAI使用量概算上限に達したため、現在の実行後に停止しました。上限期間の経過後、次のトリガーから再開します。`)
    :reason==='budget_ai_unpriced'?`Automation “${workflow.name}” paused because some AI usage could not be priced. It can run again after that usage leaves its rolling window or its limit changes.`:`Automation “${workflow.name}” paused after its rolling ${label} estimated AI usage limit was reached. It can run again after the window resets.`
   :runBudget
    ?isJa?`自動化「${workflow.name}」は実行回数上限に達したため停止しました。期間がリセットされるか、上限を変更すると次のトリガーから再開します。`:`Automation “${workflow.name}” paused after reaching its run-count limit. It can run again after the window resets or its limit changes.`
    :isJa?`自動化「${workflow.name}」は3回連続で失敗したため停止しました。実行履歴を確認してから再開してください。保留イベントは自動再生されません。`:`Automation “${workflow.name}” paused after three consecutive failures. Review its run history before resuming. Held events will not replay automatically.`;
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

export async function deliverWorkflowAiBudgetNotices(env,orgId,workflowId){
 const db=env.DB;
 const {results}=await db.prepare(`SELECT * FROM hx_workflow_ai_budget_notices WHERE org_id=?1 AND workflow_id=?2 AND delivered_at IS NULL ORDER BY created_at LIMIT 10`).bind(orgId,workflowId).all();
 let delivered=0;
 for(const notice of results||[]){
  const workflow=await getWorkflow(db,orgId,workflowId,{viewerId:notice.recipient_id});
  if(!workflow||String(workflow.createdBy)!==String(notice.recipient_id))continue;
  const target=await workflowSource(db,orgId,notice.recipient_id,workflowId);
  if(target.error||!target.source||target.source.createdBy!==String(notice.recipient_id))continue;
  const user=await db.prepare('SELECT locale FROM users WHERE github_id=?1').bind(notice.recipient_id).first();
  const isJa=String(user?.locale||'').startsWith('ja');
  const used=(Number(notice.estimated_micros)||0)/1_000_000,limit=(Number(notice.limit_micros)||0)/1_000_000;
  const unpriced=Number(notice.unpriced_calls)||0;
  const period=notice.period==='24h'?(isJa?'直近24時間':'rolling 24 hours'):notice.period==='7d'?(isJa?'直近7日間':'rolling 7 days'):(isJa?'直近30日間':'rolling 30 days');
  const body=isJa?`自動化「${workflow.name}」の${period}のAI使用量が設定値に達したか、単価不明の利用を含んでいます（概算 $${used.toFixed(6)} / 上限 $${limit.toFixed(6)}${unpriced?`、単価不明 ${unpriced} 件`:''}）。記録したトークンからの概算であり、請求額ではありません。`:`Automation “${workflow.name}” reached its ${period} estimated AI usage limit${unpriced?` or includes ${unpriced} unpriced calls`:''} ($${used.toFixed(6)} of $${limit.toFixed(6)}). This is based on recorded tokens, not an invoice.`;
  const clientId=await clientIdFor(JSON.stringify(['ai-budget',orgId,notice.id]));
  const result=await postMessage(db,{orgId,key:target.source.channel,parentId:target.source.threadId,authorLogin:'__workflow',kind:'ai',body,clientId,workflowNotice:{workflowId,generation:'',recipientId:String(notice.recipient_id),budgetNoticeId:notice.id}});
  if(!result.row)console.warn('Workflow AI budget notice post rejected',result.error||result.code||'no message',notice.id);
  if(!result.row||result.row.channel!==target.source.channel||result.row.parent_id!==target.source.threadId)continue;
  await db.prepare('UPDATE hx_workflow_ai_budget_notices SET delivered_at=COALESCE(delivered_at,?1) WHERE org_id=?2 AND workflow_id=?3 AND id=?4').bind(new Date().toISOString(),orgId,workflowId,notice.id).run();
  if(!result.replay){const {broadcastStored}=await import('../channelRoutes.js');await broadcastStored(env,orgId,target.source.channel,result.row).catch(()=>{});}
  delivered++;
 }
 return delivered;
}

export async function deliverScheduledBudgetNotices(env,orgId,workflowId){
 const db=env.DB;
 const {results}=await db.prepare(`SELECT * FROM hx_workflow_schedule_budget_notices WHERE org_id=?1 AND workflow_id=?2 AND delivered_at IS NULL ORDER BY episode LIMIT 10`).bind(orgId,workflowId).all();
 let delivered=0;
 for(const notice of results||[]){
  const workflow=await getWorkflow(db,orgId,workflowId,{viewerId:notice.recipient_id});
  if(!workflow||String(workflow.createdBy)!==String(notice.recipient_id))continue;
  const target=await workflowSource(db,orgId,notice.recipient_id,workflowId);
  if(target.error||!target.source||target.source.createdBy!==String(notice.recipient_id))continue;
  const user=await db.prepare('SELECT locale FROM users WHERE github_id=?1').bind(notice.recipient_id).first();
  const isJa=String(user?.locale||'').startsWith('ja');
  const body=isJa
   ?`自動化「${workflow.name}」の今回のスケジュール実行は、ワークスペースのAI使用量概算上限に達したためスキップしました。自動化は有効のままで、次回の予定時刻に再試行します。上限期間が経過するか、管理者が上限を変更すると実行できます。この上限はHonmaruのデプロイキー利用を記録トークンから概算したもので、請求額ではなく、BYOK利用は対象外です。`
   :`Automation “${workflow.name}” skipped this scheduled run because the workspace's estimated AI usage limit was reached. It remains enabled and will try again at its next scheduled time. It can run after the budget window clears or an admin changes the limit. This limit estimates recorded deployment-key usage, is not an invoice, and does not cover BYOK usage.`;
  const clientId=await clientIdFor(JSON.stringify(['schedule-budget-skip',orgId,workflowId,notice.episode]));
  const result=await postMessage(db,{orgId,key:target.source.channel,parentId:target.source.threadId,authorLogin:'__workflow',kind:'ai',body,clientId,workflowNotice:{workflowId,generation:'',recipientId:String(notice.recipient_id),scheduleSkipNoticeId:notice.id}});
  if(!result.row||result.row.channel!==target.source.channel||result.row.parent_id!==target.source.threadId)continue;
  await db.prepare('UPDATE hx_workflow_schedule_budget_notices SET delivered_at=COALESCE(delivered_at,?1) WHERE org_id=?2 AND workflow_id=?3 AND id=?4 AND delivered_at IS NULL').bind(new Date().toISOString(),orgId,workflowId,notice.id).run();
  if(!result.replay){const {broadcastStored}=await import('../channelRoutes.js');await broadcastStored(env,orgId,target.source.channel,result.row).catch(()=>{});}
  delivered++;
 }
 return delivered;
}


export async function retryWorkflowNotices(env,{limit=25}={}){
 // Scheduled cross-workspace sweep; each delivery is scoped and reauthorized.
 const {results}=await env.DB.prepare(`SELECT n.org_id,n.workflow_id FROM hx_workflow_safety_notices n
   JOIN hx_workflow_safety s ON s.org_id=n.org_id AND s.workflow_id=n.workflow_id AND s.generation=n.generation
   JOIN hx_workflow_sources source ON source.org_id=n.org_id AND source.workflow_id=n.workflow_id
   WHERE n.delivered_at IS NULL AND s.paused_at IS NOT NULL
   ORDER BY COALESCE(n.last_attempt_at,''),n.created_at,n.org_id,n.workflow_id LIMIT ?1`)
   .bind(Math.max(1,Math.min(100,Number.isInteger(limit)?limit:25))).all();
 let delivered=0;
 for(const item of results){
  // Rotate failed/inaccessible destinations so one cannot starve later work.
  await env.DB.prepare('UPDATE hx_workflow_safety_notices SET last_attempt_at=?1 WHERE org_id=?2 AND workflow_id=?3 AND delivered_at IS NULL')
   .bind(new Date().toISOString(),item.org_id,item.workflow_id).run();
  try{delivered+=await deliverWorkflowNotices(env,item.org_id,item.workflow_id)}catch(error){console.warn('Workflow notice delivery deferred',error?.message)}
 }
 const {results:budgetResults}=await env.DB.prepare(`SELECT n.org_id,n.workflow_id,n.id FROM hx_workflow_ai_budget_notices n JOIN hx_workflow_sources source ON source.org_id=n.org_id AND source.workflow_id=n.workflow_id WHERE n.delivered_at IS NULL ORDER BY COALESCE(n.last_attempt_at,''),n.created_at,n.org_id,n.workflow_id LIMIT ?1`).bind(Math.max(1,Math.min(100,Number.isInteger(limit)?limit:25))).all();
 for(const item of budgetResults||[]){
  await env.DB.prepare('UPDATE hx_workflow_ai_budget_notices SET last_attempt_at=?1 WHERE id=?2 AND org_id=?3 AND workflow_id=?4 AND delivered_at IS NULL').bind(new Date().toISOString(),item.id,item.org_id,item.workflow_id).run();
  try{delivered+=await deliverWorkflowAiBudgetNotices(env,item.org_id,item.workflow_id)}catch(error){console.warn('Workflow AI budget notice delivery deferred',error?.message)}
 }
 const {results:scheduleResults}=await env.DB.prepare(`SELECT n.org_id,n.workflow_id,n.id FROM hx_workflow_schedule_budget_notices n JOIN hx_workflow_sources source ON source.org_id=n.org_id AND source.workflow_id=n.workflow_id WHERE n.delivered_at IS NULL ORDER BY COALESCE(n.last_attempt_at,''),n.created_at,n.org_id,n.workflow_id LIMIT ?1`).bind(Math.max(1,Math.min(100,Number.isInteger(limit)?limit:25))).all();
 for(const item of scheduleResults||[]){
  await env.DB.prepare('UPDATE hx_workflow_schedule_budget_notices SET last_attempt_at=?1 WHERE id=?2 AND org_id=?3 AND workflow_id=?4 AND delivered_at IS NULL').bind(new Date().toISOString(),item.id,item.org_id,item.workflow_id).run();
  try{delivered+=await deliverScheduledBudgetNotices(env,item.org_id,item.workflow_id)}catch(error){console.warn('Scheduled workflow budget notice delivery deferred',error?.message)}
 }
 return delivered;
}
export async function tryWorkflowNotice(env,orgId,workflowId){
 try{return await deliverWorkflowNotices(env,orgId,workflowId)+await deliverWorkflowAiBudgetNotices(env,orgId,workflowId)+await deliverScheduledBudgetNotices(env,orgId,workflowId)}catch(error){console.warn('Workflow notice delivery deferred',error?.message);return 0}
}

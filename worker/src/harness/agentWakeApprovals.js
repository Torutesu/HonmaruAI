const scopes=new Set(['once','ten_minutes','thread','room']);
const nowIso=()=>new Date().toISOString();
import {announceCards} from '../announce.js';
import {notifyCard} from '../notify.js';

// A missing static peer grant creates a private, idempotent request. This
// function never writes a handoff message or dispatch row.
export async function requestAgentWakeApproval(env,assignment,{requesterLogin,targetName,sourceAgentId,targetAgentId,operationId,brief,messageBody}) {
  const db=env.DB;
  if(!assignment || ![sourceAgentId,targetAgentId,operationId].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)
    || typeof brief!=='string'||!brief.trim()||brief.length>16000||typeof messageBody!=='string'||!messageBody.trim()||messageBody.length>20000)
    return {error:'Invalid Agent wake request.',status:400};
  requesterLogin=String(requesterLogin||'');
  if(!requesterLogin)return {error:'Approval requester is unavailable.',status:403};
  const existing=await db.prepare(`SELECT id,card_id AS cardId,status,source_agent_id AS sourceAgentId,target_agent_id AS targetAgentId,
      operation_id AS operationId,brief,message_body AS messageBody FROM hx_agent_wake_approvals
    WHERE org_id=?1 AND assignment_id=?2 AND source_generation=?3`).bind(assignment.org_id,assignment.id,assignment.generation).first();
  if(existing) {
    if(existing.sourceAgentId!==sourceAgentId||existing.targetAgentId!==targetAgentId||existing.operationId!==operationId
      ||existing.brief!==brief||existing.messageBody!==messageBody)return {error:'This assignment generation already has a different approval request.',status:409};
    if(existing.status==='pending' && await db.prepare(`SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?2 AND request_expires_at<=?3`).bind(assignment.org_id,existing.id,nowIso()).first()) {
      await expireAgentWakeApprovals(env,nowIso());
      return {approval:{...existing,status:'expired'},created:false};
    }
    return {approval:existing,created:false};
  }
  const id=crypto.randomUUID(),cardId=`agent-wake-${crypto.randomUUID()}`,createdAt=nowIso(),expires=new Date(Date.now()+10*60*1000).toISOString();
  const card={id:cardId,type:'approval',recipientUserID:requesterLogin,senderUserID:'agent:'+sourceAgentId,title:'Agent wake approval',
    summary:`An Agent wants to hand this task to ${targetName||targetAgentId}. Choose how long it may run.`,context:`Room ${assignment.channel}; thread ${assignment.thread_id}. Request: ${brief}. No work is dispatched until you approve.`,
    status:'pending',priority:'medium',createdAt,visibility:'personal',sourceApp:'Honmaru Harness',sourceDetail:'Agent wake approval',
    agentWakeApproval:{requestId:id,scopes:['once','ten_minutes','thread','room']}};
  const saved=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_agent_wake_approvals(org_id,id,assignment_id,source_generation,source_agent_id,target_agent_id,room_channel,thread_id,source_message_id,source_hash,requester_id,requester_login,requester_membership,operation_id,brief,message_body,card_id,status,request_expires_at,created_at,updated_at)
      SELECT ?1,?2,a.id,a.generation,?3,?4,a.channel,a.thread_id,a.source_message_id,a.source_hash,a.actor_id,?5,m.created_at,?6,?7,?8,?9,'pending',?10,?11,?11
      FROM hx_agent_assignments a JOIN users u ON u.github_id=a.actor_id JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=a.actor_id AND LOWER(COALESCE(m.role,'guest'))!='guest'
      WHERE a.org_id=?1 AND a.id=?12 AND a.generation=?13 AND a.current_agent_id=?3 AND a.status='running' AND u.login=?5
        AND NOT EXISTS(SELECT 1 FROM hx_agent_handoffs h WHERE h.org_id=?1 AND h.operation_id=?6)`)
      .bind(assignment.org_id,id,sourceAgentId,targetAgentId,requesterLogin,operationId,brief,messageBody,cardId,expires,createdAt,assignment.id,assignment.generation),
    db.prepare(`INSERT INTO cards(org_id,card_id,recipient_user_id,sender_user_id,created_at,data,status,priority,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,'pending','medium',?5 WHERE EXISTS(SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?7 AND status='pending' AND card_id=?2)`)
      .bind(assignment.org_id,cardId,requesterLogin,'agent:'+sourceAgentId,createdAt,JSON.stringify(card),id),
    db.prepare(`INSERT INTO card_events(id,org_id,card_id,type,action,actor_user_id,note,snapshot,created_at)
      SELECT ?1,?2,?3,'created',NULL,?4,'agent_wake_approval',?5,?6 WHERE EXISTS(SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?2 AND id=?7 AND status='pending' AND card_id=?3)`)
      .bind(crypto.randomUUID(),assignment.org_id,cardId,'agent:'+sourceAgentId,JSON.stringify(card),createdAt,id),
  ]);
  if(!saved[0].meta?.changes){
    const replay=await db.prepare(`SELECT id,card_id AS cardId,status FROM hx_agent_wake_approvals WHERE org_id=?1 AND assignment_id=?2 AND source_generation=?3`).bind(assignment.org_id,assignment.id,assignment.generation).first();
    return replay?{approval:replay,created:false}:{error:'Assignment changed before approval was requested.',status:409};
  }
  await announceCards(env,assignment.org_id,[card]).catch(()=>{});
  await notifyCard(env,{card,kind:'created',excludeLogin:null,orgId:assignment.org_id}).catch(()=>{});
  return {approval:{id,cardId,status:'pending'},card,created:true};
}

export async function decideAgentWakeApproval(db,orgId,card,actorLogin,actorId) {
  const option=card?.decision?.optionId || 'ten_minutes';
  const action=card?.decision?.action;
  const request=await db.prepare(`SELECT * FROM hx_agent_wake_approvals WHERE org_id=?1 AND card_id=?2`).bind(orgId,card?.id).first();
  if(!request||request.status!=='pending'||request.card_id!==card.id||request.requester_login!==card.recipientUserID
    ||String(actorLogin)!==request.requester_login||String(actorId||'')!==request.requester_id)return {settled:false};
  const membership=await db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND u.github_id=?2 AND u.login=?3 AND m.created_at=?4
      AND LOWER(COALESCE(m.role,'guest'))!='guest'`).bind(orgId,request.requester_id,request.requester_login,request.requester_membership).first();
  if(!membership)return {settled:false};
  const now=nowIso();
  const active=await db.prepare(`SELECT 1 FROM hx_agent_assignments a JOIN channel_messages m ON m.org_id=a.org_id AND m.id=a.source_message_id AND m.deleted_at IS NULL
    WHERE a.org_id=?1 AND a.id=?2 AND a.generation=?3 AND a.current_agent_id=?4 AND a.status='running'
      AND a.channel=?5 AND a.thread_id=?6 AND a.source_hash=?7 AND a.actor_id=?8`)
    .bind(orgId,request.assignment_id,request.source_generation,request.source_agent_id,request.room_channel,request.thread_id,request.source_hash,request.requester_id).first();
  if(!active){
    await db.batch([
      db.prepare(`UPDATE hx_agent_wake_approvals SET status='cancelled',updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(orgId,request.id,now),
      db.prepare(`UPDATE hx_agent_assignments SET status='cancelled',updated_at=?5 WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status='running'
        AND EXISTS(SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?6 AND status='cancelled')`).bind(orgId,request.assignment_id,request.source_generation,request.source_agent_id,now,request.id),
    ]);
    return {settled:false,cancelled:true};
  }
  if(Date.parse(request.request_expires_at)<=Date.now()) {
    await db.batch([
      db.prepare(`UPDATE hx_agent_wake_approvals SET status='expired',updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(orgId,request.id,now),
      db.prepare(`UPDATE hx_agent_assignments SET status='cancelled',updated_at=?6 WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status='running' AND mutation_id IS NULL
        AND EXISTS(SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?7 AND status='expired')`)
        .bind(orgId,request.assignment_id,request.source_generation,request.source_agent_id,request.requester_id,now,request.id),
    ]);
    return {settled:false,expired:true};
  }
  if(action==='decline') {
    const result=await db.batch([
      db.prepare(`UPDATE hx_agent_wake_approvals SET status='declined',decided_at=?3,decided_by=?4,updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending' AND request_expires_at>?3`).bind(orgId,request.id,now,actorId),
      db.prepare(`UPDATE hx_agent_assignments SET status='cancelled',updated_at=?6 WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status='running' AND mutation_id IS NULL
        AND EXISTS(SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?7 AND status='declined')`)
        .bind(orgId,request.assignment_id,request.source_generation,request.source_agent_id,request.requester_id,now,request.id),
    ]);
    return {settled:Boolean(result[0].meta?.changes),action:'decline'};
  }
  if(action!=='approve'||!scopes.has(option))return {settled:false};
  const expiry=option==='ten_minutes'?new Date(Date.now()+10*60*1000).toISOString():null;
  const grantId=crypto.randomUUID();
  const result=await db.batch([
    db.prepare(`UPDATE hx_agent_wake_approvals SET status='approved',grant_scope=?3,expires_at=?4,use_limit=?5,decided_at=?6,decided_by=?7,updated_at=?6
      WHERE org_id=?1 AND id=?2 AND status='pending' AND request_expires_at>?6 AND requester_id=?7
        AND EXISTS(SELECT 1 FROM hx_agent_assignments a WHERE a.org_id=?1 AND a.id=hx_agent_wake_approvals.assignment_id
          AND a.generation=hx_agent_wake_approvals.source_generation AND a.current_agent_id=hx_agent_wake_approvals.source_agent_id
          AND a.status='running' AND a.actor_id=hx_agent_wake_approvals.requester_id AND a.channel=hx_agent_wake_approvals.room_channel
          AND a.thread_id=hx_agent_wake_approvals.thread_id AND a.source_hash=hx_agent_wake_approvals.source_hash)
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=?1 AND m.user_github_id=hx_agent_wake_approvals.requester_id
          AND m.created_at=hx_agent_wake_approvals.requester_membership AND LOWER(COALESCE(m.role,'guest'))!='guest')
        AND (NOT EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=?1 AND b.slug=substr(hx_agent_wake_approvals.room_channel,3) AND b.private=1)
          OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.org_id=?1 AND cm.channel=hx_agent_wake_approvals.room_channel AND cm.login=hx_agent_wake_approvals.requester_login))
        AND EXISTS(SELECT 1 FROM channel_agents ca JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
          WHERE ca.org_id=?1 AND ca.channel=hx_agent_wake_approvals.room_channel AND ca.agent_id=hx_agent_wake_approvals.source_agent_id)
        AND EXISTS(SELECT 1 FROM channel_agents ca JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id AND a.deleted_at IS NULL
          WHERE ca.org_id=?1 AND ca.channel=hx_agent_wake_approvals.room_channel AND ca.agent_id=hx_agent_wake_approvals.target_agent_id)`)
      .bind(orgId,request.id,option,expiry,option==='once'?1:null,now,actorId),
    db.prepare(`INSERT OR IGNORE INTO hx_agent_wake_grants(org_id,id,approval_id,requester_id,requester_membership,source_agent_id,target_agent_id,room_channel,thread_id,scope,expires_at,use_limit,created_at,updated_at)
      SELECT ?1,?2,id,requester_id,requester_membership,source_agent_id,target_agent_id,room_channel,thread_id,?4,?5,?6,?7,?7 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?3 AND status='approved' AND decided_by=?8`)
      .bind(orgId,grantId,request.id,option,expiry,option==='once'?1:null,now,actorId),
  ]);
  return {settled:Boolean(result[0].meta?.changes&&result[1].meta?.changes),action:'approve',scope:option,request};
}

export async function activeAgentWakeGrant(db,{orgId,assignmentId,sourceAgentId,targetAgentId,operationId}) {
  const row=await db.prepare(`SELECT g.id FROM hx_agent_wake_grants g
    JOIN hx_agent_assignments a ON a.org_id=g.org_id AND a.id=?2
    JOIN hx_agent_wake_approvals approval ON approval.org_id=g.org_id AND approval.id=g.approval_id
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.requester_id AND m.created_at=g.requester_membership AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE g.org_id=?1 AND g.source_agent_id=?3 AND g.target_agent_id=?4 AND g.requester_id=a.actor_id
      AND g.room_channel=a.channel AND (g.scope!='thread' OR g.thread_id=a.thread_id)
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)
      AND (g.scope!='once' OR (approval.assignment_id=a.id AND approval.source_generation=a.generation AND approval.operation_id=?6))
      AND (g.use_limit IS NULL OR g.use_count<g.use_limit)
    ORDER BY g.created_at DESC LIMIT 1`).bind(orgId,assignmentId,sourceAgentId,targetAgentId,nowIso(),operationId).first();
  return row?.id||null;
}

export async function validAgentWakeGrantForHandoff(db,operation,now=nowIso()) {
  if(!operation?.wake_grant_id)return true;
  return Boolean(await db.prepare(`SELECT 1 FROM hx_agent_wake_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.requester_id AND m.created_at=g.requester_membership AND LOWER(COALESCE(m.role,'guest'))!='guest'
    WHERE g.org_id=?1 AND g.id=?2 AND g.source_agent_id=?3 AND g.target_agent_id=?4 AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>?5)
      AND (g.use_limit IS NULL OR g.use_count<g.use_limit OR (g.scope='once' AND g.use_count=g.use_limit AND EXISTS(
        SELECT 1 FROM hx_agent_wake_approvals a WHERE a.org_id=g.org_id AND a.id=g.approval_id AND a.operation_id=?6)))`)
    .bind(operation.org_id,operation.wake_grant_id,operation.source_agent_id,operation.target_agent_id,now,operation.operation_id).first());
}

export async function expireAgentWakeApprovals(env,now=nowIso()) {
  const db=env.DB;
  const {results=[]}=await db.prepare(`SELECT * FROM hx_agent_wake_approvals WHERE status='pending' AND request_expires_at<=?1 LIMIT 100`).bind(now).all();
  const changed=[];
  for(const request of results) {
    const cardRow=await db.prepare(`SELECT data FROM cards WHERE org_id=?1 AND card_id=?2`).bind(request.org_id,request.card_id).first();
    const result=await db.batch([
      db.prepare(`UPDATE hx_agent_wake_approvals SET status='expired',updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending' AND request_expires_at<=?3`).bind(request.org_id,request.id,now),
      db.prepare(`UPDATE hx_agent_assignments SET status='cancelled',updated_at=?5 WHERE org_id=?1 AND id=?2 AND generation=?3 AND current_agent_id=?4 AND status='running'
        AND EXISTS(SELECT 1 FROM hx_agent_wake_approvals WHERE org_id=?1 AND id=?6 AND status='expired')`).bind(request.org_id,request.assignment_id,request.source_generation,request.source_agent_id,now,request.id),
      db.prepare(`UPDATE cards SET status='rejected',updated_at=?3,data=json_set(data,'$.status','rejected','$.summary','This approval expired before a decision was made.') WHERE org_id=?1 AND card_id=?2 AND status='pending'`).bind(request.org_id,request.card_id,now),
    ]);
    if(result[0].meta?.changes&&cardRow?.data) {
      const card=JSON.parse(cardRow.data); card.status='rejected'; card.summary='This approval expired before a decision was made.';
      changed.push([request.org_id,card]);
    }
  }
  for(const [orgId,card] of changed)await announceCards(env,orgId,[card],{isNew:false}).catch(()=>{});
  return changed.length;
}

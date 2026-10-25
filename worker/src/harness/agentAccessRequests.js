import { mayAccessAgent } from './agents.js';
import { agentRoleState } from './agentRoles.js';

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const failure = (error, status = 409) => ({ error, status });

// Team scope is the discovery boundary for an access request. Personal agents
// remain private and are never disclosed through this list.
export async function requestableAgentOptions(db, orgId, login) {
  const member=await db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND u.login=?2 AND LOWER(COALESCE(m.role,'guest'))!='guest'`).bind(orgId,String(login)).first();
  if(!member)return [];
  const { results = [] } = await db.prepare(`SELECT a.id,a.name,a.emoji,a.avatar_url,a.owner_login,a.scope,a.provider
    FROM custom_agents a
    JOIN memberships owner_m ON owner_m.org_id=a.org_id AND owner_m.role!='guest'
    JOIN users owner_u ON owner_u.github_id=owner_m.user_github_id AND owner_u.login=a.owner_login
    WHERE a.org_id=?1 AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL
      AND a.owner_login!=?2
    ORDER BY a.name COLLATE NOCASE,a.id LIMIT 100`).bind(orgId,String(login)).all();
  const options = [];
  for (const agent of results) {
    if (await mayAccessAgent(db,orgId,{...agent,ownerLogin:agent.owner_login},login)) continue;
    const pending=await db.prepare(`SELECT status FROM hx_agent_access_requests r
      JOIN users u ON u.github_id=r.requester_id
      JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.requester_id
        AND m.created_at=r.requester_membership AND LOWER(COALESCE(m.role,'guest'))!='guest'
      WHERE r.org_id=?1 AND r.agent_id=?2 AND u.login=?3 AND r.status='pending' LIMIT 1`)
      .bind(orgId,agent.id,String(login)).first();
    options.push({id:agent.id,name:agent.name,emoji:agent.emoji||null,avatarUrl:agent.avatar_url||null,
      accessRequestStatus:pending?'pending':'none'});
  }
  return options;
}

// The room and the Agent have independent member lists. This preview names
// only current human room members who do not yet have Agent access.
export async function roomAgentAccessPlan(db,orgId,agentId,roomMembers,actorId) {
  const eligible=(roomMembers||[]).filter(m=>m.kind==='person'&&m.eligible),memberIds=[...new Set(eligible.map(m=>String(m.id)))].sort();
  if(!memberIds.length)return {missing:[],canGrantAccess:false};
  const {results=[]}=await db.prepare(`SELECT CAST(u.github_id AS TEXT) AS id,u.login,u.name,
    CASE WHEN (a.scope!='personal' OR a.owner_login=u.login) AND (
      p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
      OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=u.login))
      OR (a.scope='team' AND EXISTS(SELECT 1 FROM hx_agent_members r
        WHERE r.org_id=a.org_id AND r.agent_id=a.id AND r.user_id=u.github_id
          AND r.member_since=m.created_at AND LOWER(COALESCE(m.role,'guest'))!='guest'))
    ) THEN 1 ELSE 0 END AS has_access
    FROM custom_agents a JOIN users u ON u.github_id IN (SELECT value FROM json_each(?3))
    JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=u.github_id
      AND LOWER(COALESCE(m.role,'guest'))!='guest'
    LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
    WHERE a.org_id=?1 AND a.id=?2 AND a.deleted_at IS NULL
    ORDER BY u.name COLLATE NOCASE,u.github_id`).bind(orgId,agentId,JSON.stringify(memberIds)).all();
  const roleState=await agentRoleState(db,orgId,agentId);
  const canGrantAccess=Boolean(roleState?.members.some(m=>m.userId===String(actorId)&&(m.owner||m.role==='admin'||m.role==='member')));
  const roomMemberships=new Map(eligible.map(m=>[String(m.id),m.membership]));
  return {missing:results.filter(m=>!m.has_access).map(m=>({id:m.id,login:m.login,name:m.name||m.login,membership:roomMemberships.get(m.id)})),canGrantAccess};
}

// Compute the same prompt for every addable Agent in one query. Room member
// and Agent membership are independent; only eligible human room members are
// included in the grant choice.
export async function roomAgentAccessPlans(db,orgId,agentIds,roomMembers,actorId) {
  const agents=[...new Set((agentIds||[]).map(String))];
  const eligible=(roomMembers||[]).filter(m=>m.kind==='person'&&m.eligible),memberIds=[...new Set(eligible.map(m=>String(m.id)))];
  const roomMemberships=new Map(eligible.map(m=>[String(m.id),m.membership]));
  const plans=new Map(agents.map(id=>[id,{missing:[],canGrantAccess:false}]));
  if(!agents.length||!memberIds.length)return plans;
  const {results=[]}=await db.prepare(`SELECT a.id AS agent_id,a.scope,a.owner_login,
    CAST(u.github_id AS TEXT) AS id,u.login,u.name,
    CASE WHEN (a.scope!='personal' OR a.owner_login=u.login) AND (
      p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
      OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=u.login))
      OR (a.scope='team' AND EXISTS(SELECT 1 FROM hx_agent_members r
        WHERE r.org_id=a.org_id AND r.agent_id=a.id AND r.user_id=u.github_id
          AND r.member_since=m.created_at AND LOWER(COALESCE(m.role,'guest'))!='guest'))
    ) THEN 1 ELSE 0 END AS has_access,
    CASE WHEN a.owner_login=?4 OR (a.scope='team' AND EXISTS(SELECT 1 FROM hx_agent_members ar
      JOIN users au ON au.github_id=ar.user_id AND au.login=?4
      JOIN memberships am ON am.org_id=ar.org_id AND am.user_github_id=ar.user_id
        AND am.created_at=ar.member_since AND LOWER(COALESCE(am.role,'guest'))!='guest'
      WHERE ar.org_id=a.org_id AND ar.agent_id=a.id AND ar.role IN('admin','member'))
    ) THEN 1 ELSE 0 END AS can_grant
    FROM custom_agents a JOIN json_each(?2) aid ON aid.value=a.id
    JOIN users u ON u.github_id IN(SELECT value FROM json_each(?3))
    JOIN memberships m ON m.org_id=a.org_id AND m.user_github_id=u.github_id
      AND LOWER(COALESCE(m.role,'guest'))!='guest'
    LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
    WHERE a.org_id=?1 AND a.deleted_at IS NULL AND a.provider IS NULL
    ORDER BY a.id,u.name COLLATE NOCASE,u.github_id`).bind(orgId,JSON.stringify(agents),JSON.stringify(memberIds),String(actorId)).all();
  for(const row of results) {
    const plan=plans.get(row.agent_id);
    if(!plan)continue;
    plan.canGrantAccess=Boolean(row.can_grant);
    if(!row.has_access)plan.missing.push({id:row.id,login:row.login,name:row.name||row.login,membership:roomMemberships.get(row.id)});
  }
  return plans;
}

// Create a private, idempotent approval card. It grants only the requester
// access to the named Agent; it does not add that Agent to any room.
export async function createAgentAccessRequest(db,orgId,{agentId,requesterId,requestKey}) {
  requesterId=String(requesterId||'');
  if(typeof agentId!=='string'||!agentId||agentId.length>200||typeof requestKey!=='string'||!/^[-A-Za-z0-9_]{16,100}$/.test(requestKey))
    return failure('A valid team agent and request key are required.',400);
  const identity=await db.prepare(`SELECT u.github_id AS requesterId,u.login AS requesterLogin,u.name AS requesterName,
      m.created_at AS requesterMembership,LOWER(COALESCE(m.role,'guest')) AS requesterRole,
      a.name AS agentName,a.owner_login AS ownerLogin,owner.name AS ownerName
    FROM users u JOIN memberships m ON m.user_github_id=u.github_id
    JOIN custom_agents a ON a.org_id=m.org_id AND a.id=?3
    JOIN users owner ON owner.login=a.owner_login
    JOIN memberships owner_m ON owner_m.org_id=m.org_id AND owner_m.user_github_id=owner.github_id AND LOWER(COALESCE(owner_m.role,'guest'))!='guest'
    WHERE m.org_id=?1 AND u.github_id=?2 AND LOWER(COALESCE(m.role,'guest'))!='guest'
      AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL AND a.owner_login!=u.login`)
    .bind(orgId,requesterId,agentId).first();
  if(!identity)return failure('No such shared team agent.',404);
  const replay=await db.prepare(`SELECT id,card_id AS cardId,status FROM hx_agent_access_requests
    WHERE org_id=?1 AND requester_id=?2 AND request_key=?3`).bind(orgId,requesterId,requestKey).first();
  if(replay)return {request:{id:replay.id,cardId:replay.cardId,status:replay.status},created:false};
  if(await mayAccessAgent(db,orgId,{id:agentId,scope:'team',ownerLogin:identity.ownerLogin},identity.requesterLogin))
    return failure('You already have access to this agent.',409);
  const pending=await db.prepare(`SELECT id,card_id AS cardId,status FROM hx_agent_access_requests
    WHERE org_id=?1 AND agent_id=?2 AND requester_id=?3 AND requester_membership=?4 AND status='pending'`)
    .bind(orgId,agentId,requesterId,identity.requesterMembership).first();
  if(pending)return {request:{id:pending.id,cardId:pending.cardId,status:pending.status},created:false};

  const roleState=await agentRoleState(db,orgId,agentId);
  const approvers=(roleState?.members||[]).filter(member=>member.owner||member.role==='admin');
  if(!approvers.some(member=>member.login===identity.ownerLogin))return failure('The current Agent owner is not available to approve requests.');
  const id=newId('aar'),nonce=crypto.randomUUID(),createdAt=new Date().toISOString();
  const approverCards=approvers.map(approver=>{
    const cardId=`agent-access-${crypto.randomUUID()}`;
    const card={id:cardId,recipientUserID:approver.login,senderUserID:identity.requesterLogin,type:'approval',
      title:`${identity.requesterName||identity.requesterLogin}さんからAgent利用申請`,
      summary:`${identity.requesterName||identity.requesterLogin}さんが「${identity.agentName}」の継続利用を申請しています。承認するとこのAgentの利用権だけが付与され、ルームには追加されません。`,
      context:'申請者がAgentへアクセスできるようにするか確認してください。ルームへの参加や、Agentが読める会話の範囲はこの決定では変わりません。',
      priority:'medium',status:'pending',createdAt,sourceApp:'Honmaru Harness',sourceDetail:'Agent access request',
      visibility:'personal',originalLanguage:'ja',requestedBy:{login:identity.requesterLogin,name:identity.requesterName||identity.requesterLogin},
      agentAccessRequest:{requestId:id,agentId}};
    return {card,approver};
  });
  const primary=approverCards.find(item=>item.approver.login===identity.ownerLogin)||approverCards[0];
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_agent_access_requests
      (org_id,id,agent_id,requester_id,requester_login,requester_membership,owner_login,request_key,card_id,nonce,status,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11
      WHERE EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
        WHERE m.org_id=?1 AND m.user_github_id=?4 AND u.login=?5 AND m.created_at=?6 AND LOWER(COALESCE(m.role,'guest'))!='guest')
        AND EXISTS(SELECT 1 FROM custom_agents a JOIN users o ON o.login=a.owner_login
          JOIN memberships om ON om.org_id=a.org_id AND om.user_github_id=o.github_id AND LOWER(COALESCE(om.role,'guest'))!='guest'
          WHERE a.org_id=?1 AND a.id=?3 AND a.owner_login=?7 AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM hx_agent_access_requests r WHERE r.org_id=?1 AND r.agent_id=?3
          AND r.requester_id=?4 AND r.requester_membership=?6 AND r.status='pending')
        AND NOT EXISTS(SELECT 1 FROM hx_agent_members r JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.user_id
          AND m.created_at=r.member_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
          WHERE r.org_id=?1 AND r.agent_id=?3 AND r.user_id=?4)
        AND NOT EXISTS(SELECT 1 FROM hx_agent_profiles p WHERE p.org_id=?1 AND p.agent_id=?3
          AND (p.access='everyone' OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=?5))))`)
      .bind(orgId,id,agentId,requesterId,identity.requesterLogin,identity.requesterMembership,identity.ownerLogin,requestKey,primary.card.id,nonce,createdAt),
    ...approverCards.flatMap(({card,approver})=>[
      db.prepare(`INSERT INTO hx_agent_access_request_approvers(org_id,request_id,card_id,recipient_login,created_at)
        SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM hx_agent_access_requests WHERE org_id=?1 AND id=?2 AND nonce=?6)
          AND EXISTS(SELECT 1 FROM custom_agents a JOIN users au ON au.login=?4 JOIN memberships am
            ON am.org_id=a.org_id AND am.user_github_id=au.github_id AND LOWER(COALESCE(am.role,'guest'))!='guest'
            WHERE a.org_id=?1 AND a.id=?7 AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL
              AND (a.owner_login=au.login OR EXISTS(SELECT 1 FROM hx_agent_members ar JOIN memberships arm
                ON arm.org_id=ar.org_id AND arm.user_github_id=ar.user_id AND arm.created_at=ar.member_since
                  AND LOWER(COALESCE(arm.role,'guest'))!='guest'
                WHERE ar.org_id=a.org_id AND ar.agent_id=a.id AND ar.user_id=au.github_id AND ar.role='admin')))`)
        .bind(orgId,id,card.id,approver.login,createdAt,nonce,agentId),
      db.prepare(`INSERT INTO cards(org_id,card_id,recipient_user_id,sender_user_id,created_at,data,status,priority,decided_at,updated_at)
        SELECT ?1,?2,?3,?4,?5,?6,'pending','medium',NULL,?5
        WHERE EXISTS(SELECT 1 FROM hx_agent_access_request_approvers WHERE org_id=?1 AND request_id=?7 AND card_id=?2 AND status='pending')`)
        .bind(orgId,card.id,approver.login,identity.requesterLogin,createdAt,JSON.stringify(card),id),
      db.prepare(`INSERT INTO card_events(id,org_id,card_id,type,action,actor_user_id,note,snapshot,created_at)
        SELECT ?1,?2,?3,'created',NULL,?4,'agent_access_request',?5,?6
        WHERE EXISTS(SELECT 1 FROM hx_agent_access_request_approvers WHERE org_id=?2 AND request_id=?7 AND card_id=?3 AND status='pending')`)
        .bind(crypto.randomUUID(),orgId,card.id,identity.requesterLogin,JSON.stringify(card),createdAt,id),
    ]),
  ]);
  if(result[0].meta?.changes) {
    const {results:active=[]}=await db.prepare(`SELECT card_id AS cardId,recipient_login AS recipientLogin FROM hx_agent_access_request_approvers
      WHERE org_id=?1 AND request_id=?2 AND status='pending'`).bind(orgId,id).all();
    const activeLogins=new Set(active.map(row=>row.recipientLogin));
    const cards=approverCards.filter(item=>activeLogins.has(item.approver.login)).map(item=>item.card);
    return {request:{id,cardId:primary.card.id,status:'pending'},card:cards.find(item=>item.recipientUserID===identity.ownerLogin)||cards[0],cards,created:true};
  }
  const concurrent=await db.prepare(`SELECT id,card_id AS cardId,status FROM hx_agent_access_requests
    WHERE org_id=?1 AND agent_id=?2 AND requester_id=?3 AND requester_membership=?4 AND status='pending'`)
    .bind(orgId,agentId,requesterId,identity.requesterMembership).first();
  return concurrent?{request:{id:concurrent.id,cardId:concurrent.cardId,status:concurrent.status},created:false}
    :failure('Agent access or workspace membership changed. Reload and try again.');
}

// This runs after the card decision is persisted. The SQL claim and grant are
// fenced by the pending request, current requester incarnation and current
// Agent owner/admin authority; retries cannot issue a second grant.
export async function settleAgentAccessRequest(db,orgId,card) {
  const requestRef=card?.agentAccessRequest,decision=card?.decision;
  if(!requestRef?.requestId||!requestRef?.agentId||!decision?.action)return false;
  if(!['approve','choose','decline'].includes(decision.action))return false;
  const row=await db.prepare(`SELECT r.*,a.owner_login AS current_owner,a.scope,a.provider,a.deleted_at,
      ap.recipient_login AS approver_login,actor.github_id AS actor_id
    FROM hx_agent_access_requests r
    JOIN custom_agents a ON a.org_id=r.org_id AND a.id=r.agent_id
    JOIN hx_agent_access_request_approvers ap ON ap.org_id=r.org_id AND ap.request_id=r.id
      AND ap.card_id=?5 AND ap.recipient_login=?4 AND ap.status='pending'
    JOIN users actor ON actor.login=?4
    WHERE r.org_id=?1 AND r.id=?2 AND r.agent_id=?3 AND r.status='pending'`)
    .bind(orgId,requestRef.requestId,requestRef.agentId,String(decision.actorUserID||''),String(card.id||'')).first();
  if(!row||row.approver_login!==card.recipientUserID||row.requester_login!==card.senderUserID||String(decision.actorUserID)!==card.recipientUserID)return false;
  const action=decision.action==='decline'?'declined':'approved';
  const decidedAt=decision.decidedAt||new Date().toISOString(),actorLogin=String(decision.actorUserID||'');
  const settledCards=async()=>{
    const {results=[]}=await db.prepare(`SELECT c.data FROM cards c
      JOIN hx_agent_access_request_approvers ap ON ap.org_id=c.org_id AND ap.card_id=c.card_id
      WHERE c.org_id=?1 AND ap.request_id=?2 AND c.card_id!=?3 AND ap.status=?4`)
      .bind(orgId,row.id,String(card.id||''),action).all();
    return results.flatMap(({data})=>{try{return [JSON.parse(data)]}catch{return []}});
  };
  const authority=`EXISTS(SELECT 1 FROM custom_agents a JOIN users au ON au.login=?4
    JOIN memberships am ON am.org_id=a.org_id AND am.user_github_id=au.github_id AND LOWER(COALESCE(am.role,'guest'))!='guest'
    WHERE a.org_id=?1 AND a.id=?3 AND a.provider IS NULL AND a.deleted_at IS NULL AND a.scope='team'
      AND (a.owner_login=au.login OR EXISTS(SELECT 1 FROM hx_agent_members ar
        JOIN memberships arm ON arm.org_id=ar.org_id AND arm.user_github_id=ar.user_id
          AND arm.created_at=ar.member_since AND LOWER(COALESCE(arm.role,'guest'))!='guest'
        WHERE ar.org_id=a.org_id AND ar.agent_id=a.id AND ar.user_id=au.github_id AND ar.role='admin'))) `;
  if(action==='declined') {
    const result=await db.batch([
      db.prepare(`UPDATE hx_agent_access_requests SET status='declined',decided_by=?4,decided_at=?5
        WHERE org_id=?1 AND id=?2 AND agent_id=?3 AND status='pending' AND ${authority}
          AND EXISTS(SELECT 1 FROM hx_agent_access_request_approvers ap WHERE ap.org_id=?1 AND ap.request_id=?2
            AND ap.card_id=?6 AND ap.recipient_login=?4 AND ap.status='pending')`)
        .bind(orgId,row.id,row.agent_id,actorLogin,decidedAt,card.id),
      db.prepare(`UPDATE hx_agent_access_request_approvers SET status='declined',decided_at=?4
        WHERE org_id=?1 AND request_id=?2 AND status='pending'
          AND EXISTS(SELECT 1 FROM hx_agent_access_requests r WHERE r.org_id=?1 AND r.id=?2 AND r.status='declined' AND r.decided_by=?3)`)
        .bind(orgId,row.id,actorLogin,decidedAt),
      db.prepare(`UPDATE cards SET status='rejected',decided_at=?4,updated_at=?4,
          data=json_set(data,'$.status','rejected','$.decision',json_object('action','decline','actorUserID',?3,'decidedAt',?4,'note','Handled by another authorized Agent admin.'))
        WHERE org_id=?1 AND card_id!=?5 AND card_id IN(SELECT card_id FROM hx_agent_access_request_approvers WHERE org_id=?1 AND request_id=?2)
          AND EXISTS(SELECT 1 FROM hx_agent_access_requests r WHERE r.org_id=?1 AND r.id=?2 AND r.status='declined' AND r.decided_by=?3 AND r.decided_at=?4)`)
        .bind(orgId,row.id,actorLogin,decidedAt,card.id),
    ]);
    if(!result[0].meta?.changes)return false;
    return {settled:true,action:'decline',actorLogin,decidedAt,cards:await settledCards()};
  }
  if(row.deleted_at||row.scope!=='team'||row.provider!==null)return false;
  const nonce=crypto.randomUUID();
  const guardRequest=`EXISTS(SELECT 1 FROM hx_agent_access_requests r
      JOIN hx_agent_access_request_approvers ap ON ap.org_id=r.org_id AND ap.request_id=r.id
        AND ap.card_id=?6 AND ap.recipient_login=?4 AND ap.status='pending'
      JOIN memberships target
      ON target.org_id=r.org_id AND target.user_github_id=r.requester_id AND target.created_at=r.requester_membership
        AND LOWER(COALESCE(target.role,'guest'))!='guest'
      WHERE r.org_id=?1 AND r.id=?2 AND r.agent_id=?3 AND r.status='pending')`;
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_agent_access(org_id,agent_id,version)
      SELECT ?1,?3,0 WHERE ${authority} AND ${guardRequest}`)
      .bind(orgId,row.id,row.agent_id,actorLogin,decidedAt,card.id),
    db.prepare(`UPDATE hx_agent_access SET version=version+1,mutation_id=?7
      WHERE org_id=?1 AND agent_id=?3 AND ${authority} AND ${guardRequest}`)
      .bind(orgId,row.id,row.agent_id,actorLogin,decidedAt,card.id,nonce),
    db.prepare(`INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,updated_by,updated_at,member_since)
      SELECT ?1,?3,r.requester_id,'member',?4,?5,r.requester_membership
      FROM hx_agent_access_requests r JOIN hx_agent_access_request_approvers ap ON ap.org_id=r.org_id AND ap.request_id=r.id
        AND ap.card_id=?6 AND ap.recipient_login=?4 AND ap.status='pending'
      WHERE r.org_id=?1 AND r.id=?2 AND r.agent_id=?3 AND r.status='pending'
        AND EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?3 AND mutation_id=?7)
      ON CONFLICT(org_id,agent_id,user_id) DO UPDATE SET
        role=CASE WHEN hx_agent_members.member_since!=excluded.member_since THEN 'member' ELSE hx_agent_members.role END,
        member_since=excluded.member_since,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(orgId,row.id,row.agent_id,actorLogin,decidedAt,card.id,nonce),
    db.prepare(`UPDATE hx_agent_access_requests SET status='approved',decided_by=?4,decided_at=?5
      WHERE org_id=?1 AND id=?2 AND agent_id=?3 AND status='pending'
        AND ${guardRequest} AND EXISTS(SELECT 1 FROM hx_agent_access WHERE org_id=?1 AND agent_id=?3 AND mutation_id=?7)`)
      .bind(orgId,row.id,row.agent_id,actorLogin,decidedAt,card.id,nonce),
    db.prepare(`UPDATE hx_agent_access_request_approvers SET status='approved',decided_at=?4
      WHERE org_id=?1 AND request_id=?2 AND status='pending'
        AND EXISTS(SELECT 1 FROM hx_agent_access_requests r WHERE r.org_id=?1 AND r.id=?2 AND r.status='approved' AND r.decided_by=?3)`)
      .bind(orgId,row.id,actorLogin,decidedAt),
    db.prepare(`UPDATE cards SET status='approved',decided_at=?4,updated_at=?4,
        data=json_set(data,'$.status','approved','$.decision',json_object('action','approve','actorUserID',?3,'decidedAt',?4,'note','Handled by another authorized Agent admin.'))
      WHERE org_id=?1 AND card_id!=?5 AND card_id IN(SELECT card_id FROM hx_agent_access_request_approvers WHERE org_id=?1 AND request_id=?2)
        AND EXISTS(SELECT 1 FROM hx_agent_access_requests r WHERE r.org_id=?1 AND r.id=?2 AND r.status='approved' AND r.decided_by=?3 AND r.decided_at=?4)`)
      .bind(orgId,row.id,actorLogin,decidedAt,card.id),
  ]);
  if(!result[1].meta?.changes||!result[3].meta?.changes)return false;
  return {settled:true,action:'approve',actorLogin,decidedAt,cards:await settledCards()};
}

import { announceCards } from '../announce.js';
import { notifyCard } from '../notify.js';
import { sha256Hex } from '../auth.js';
import { getUserByLogin } from '../db.js';
import { mayRunAgent } from './agents.js';
import { mayUseConversation } from './conversationAccess.js';
import { getMode } from './mode.js';
import { agentFallbackPolicy, loadTeammate } from '../teammates.js';
import { serverText } from '../serverCopy.js';

const choices = new Set(['once', 'two_hours', 'today', 'always']);
const iso = value => new Date(value).toISOString();

export async function hasAgentFallbackPermission(db, orgId, agentId, ownerId, at = Date.now()) {
  const row = await db.prepare(`SELECT 1 FROM hx_agent_fallback_permissions
    WHERE org_id=?1 AND agent_id=?2 AND owner_id=?3 AND revoked_at IS NULL AND expires_at>?4`)
    .bind(orgId, agentId, String(ownerId), iso(at)).first();
  return Boolean(row);
}

function endOfOwnerDay(now, timezone) {
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0));
  const targetParts = { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate() };
  const utcGuess = target.getTime();
  const offsetAt = stamp => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(stamp)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - stamp;
  };
  let candidate = utcGuess - offsetAt(utcGuess);
  for (let i = 0; i < 3; i++) candidate = utcGuess - offsetAt(candidate);
  const check = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  if (check.year !== targetParts.year || check.month !== targetParts.month || check.day !== targetParts.day) return utcGuess + 24 * 60 * 60 * 1000;
  return candidate;
}

export async function requestAgentFallbackApproval(env, { orgId, agent, teammate, requester, channel, threadId, sourceMessageId, sourceBody, fallbackReason, at = Date.now() }) {
  const db = env.DB;
  if (!orgId || !agent?.id || !teammate?.remote?.gatewayId || !requester?.login || !requester?.github_id ||
      typeof channel !== 'string' || typeof threadId !== 'string' || typeof sourceMessageId !== 'string' ||
      typeof sourceBody !== 'string' || !sourceBody.trim() || !['offline', 'signed_out', 'runtime_unavailable', 'provider_limited', 'unavailable'].includes(fallbackReason))
    return { error: 'The fallback approval request is incomplete.' };
  if (await getMode(db, orgId).catch(() => null) !== 'harness' || !await mayRunAgent(db, orgId, agent, requester.github_id) ||
      !await mayUseConversation(db, orgId, requester.github_id, channel)) return { error: 'The requester no longer has access to this Agent or conversation.' };
  const owner = await getUserByLogin(db, agent.owner_login).catch(() => null);
  if (!owner?.login || !owner.github_id) return { error: 'The Agent owner is unavailable.' };
  const membership = await db.prepare(`SELECT user_github_id,created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2
    AND LOWER(TRIM(COALESCE(role,'guest')))!='guest'`).bind(orgId, String(owner.github_id)).first();
  const requesterMembership = await db.prepare(`SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2
    AND LOWER(TRIM(COALESCE(role,'guest')))!='guest'`).bind(orgId, String(requester.github_id)).first();
  if (!membership || !requesterMembership) return { error: 'The Agent owner or requester is no longer a workspace member.' };
  const source = await db.prepare(`SELECT id,channel,parent_id,body,deleted_at FROM channel_messages
    WHERE org_id=?1 AND id=?2 AND channel=?3`).bind(orgId, sourceMessageId, channel).first();
  if (!source || source.deleted_at || source.body !== sourceBody || (source.parent_id || source.id) !== threadId)
    return { error: 'The source message changed before approval was requested.' };
  const existing = await db.prepare(`SELECT id,card_id,status FROM hx_agent_fallback_approvals
    WHERE org_id=?1 AND agent_id=?2 AND source_message_id=?3`).bind(orgId, agent.id, sourceMessageId).first();
  if (existing) return { approval: existing, created: false };
  const id = crypto.randomUUID(), cardId = `agent-fallback-${crypto.randomUUID()}`;
  const createdAt = iso(at), expiresAt = iso(at + 24 * 60 * 60 * 1000);
  const agentName = agent.name || agent.handle;
  const card = {
    id: cardId, type: 'approval', recipientUserID: owner.login, senderUserID: `agent:${agent.id}`,
    title: serverText(owner.locale || 'en', 'agent.fallbackApprovalTitle', { agent: agentName }),
    summary: `${serverText(owner.locale || 'en', `agent.fallbackApprovalReason.${fallbackReason}`)} ${serverText(owner.locale || 'en', 'agent.fallbackApprovalSummary')}`,
    context: serverText(owner.locale || 'en', 'agent.fallbackApprovalContext', {
      requester: requester.name || requester.login, channel, thread: threadId, body: sourceBody,
    }),
    status: 'pending', priority: 'medium', createdAt, visibility: 'personal', sourceApp: 'Honmaru Harness', sourceDetail: 'Local Agent fallback',
    agentFallbackApproval: { requestId: id, choices: ['once', 'two_hours', 'today', 'always', 'computer'] },
  };
  const inserted = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO hx_agent_fallback_approvals(id,org_id,agent_id,gateway_id,owner_login,owner_id,owner_membership,requester_id,requester_login,requester_membership,channel,thread_id,source_message_id,source_hash,fallback_reason,card_id,status,expires_at,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,'pending',?17,?18,?18
      WHERE EXISTS(SELECT 1 FROM memberships m JOIN custom_agents a ON a.org_id=m.org_id JOIN org_settings o ON o.org_id=m.org_id
        WHERE m.org_id=?2 AND m.user_github_id=?6 AND m.created_at=?7 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
          AND a.id=?3 AND a.owner_login=?5 AND a.deleted_at IS NULL AND o.mode='harness')`)
      .bind(id, orgId, agent.id, teammate.remote.gatewayId, owner.login, String(owner.github_id), membership.created_at,
        String(requester.github_id), requester.login, requesterMembership.created_at, channel, threadId, sourceMessageId,
        await sha256Hex(sourceBody), fallbackReason, cardId, expiresAt, createdAt),
    db.prepare(`INSERT INTO cards(org_id,card_id,recipient_user_id,sender_user_id,created_at,data,status,priority,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,'pending','medium',?5 WHERE EXISTS(SELECT 1 FROM hx_agent_fallback_approvals WHERE org_id=?1 AND id=?7 AND card_id=?2 AND status='pending')`)
      .bind(orgId, cardId, owner.login, `agent:${agent.id}`, createdAt, JSON.stringify(card), id),
    db.prepare(`INSERT INTO card_events(id,org_id,card_id,type,action,actor_user_id,note,snapshot,created_at)
      SELECT ?1,?2,?3,'created',NULL,?4,'agent_fallback_approval',?5,?6 WHERE EXISTS(SELECT 1 FROM hx_agent_fallback_approvals WHERE org_id=?2 AND id=?7 AND status='pending')`)
      .bind(crypto.randomUUID(), orgId, cardId, `agent:${agent.id}`, JSON.stringify(card), createdAt, id),
  ]);
  if (!inserted[0]?.meta?.changes) {
    const replay = await db.prepare(`SELECT id,card_id,status FROM hx_agent_fallback_approvals WHERE org_id=?1 AND agent_id=?2 AND source_message_id=?3`)
      .bind(orgId, agent.id, sourceMessageId).first();
    return replay ? { approval: replay, created: false } : { error: 'Workspace or Agent access changed before approval was requested.' };
  }
  await announceCards(env, orgId, [card]).catch(() => {});
  await notifyCard(env, { card, kind: 'created', excludeLogin: null, orgId }).catch(() => {});
  return { approval: { id, cardId, status: 'pending' }, card, created: true };
}

export async function decideAgentFallbackApproval(env, orgId, card, actorLogin, actorId, at = Date.now()) {
  const db = env.DB, action = card?.decision?.action, choice = card?.decision?.optionId || 'once';
  if (!['approve', 'decline'].includes(action) || !choices.has(choice) && !(action === 'decline' && choice === 'computer')) return { settled: false };
  const request = await db.prepare(`SELECT * FROM hx_agent_fallback_approvals WHERE org_id=?1 AND card_id=?2`).bind(orgId, card?.id).first();
  if (!request || request.status !== 'pending' || request.owner_login !== card.recipientUserID ||
      String(actorLogin) !== request.owner_login || String(actorId || '') !== request.owner_id) return { settled: false };
  if (Date.parse(request.expires_at) <= at) {
    const expired = await db.prepare(`UPDATE hx_agent_fallback_approvals SET status='expired',updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending' AND expires_at<=?3`)
      .bind(orgId, request.id, iso(at)).run();
    return { settled: false, expired: Boolean(expired.meta?.changes) };
  }
  const currentOwner = await db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND m.user_github_id=?2 AND u.login=?3 AND m.created_at=?4 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'`)
    .bind(orgId, request.owner_id, request.owner_login, request.owner_membership).first();
  const currentRequester = await db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND m.user_github_id=?2 AND u.login=?3 AND m.created_at=?4 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'`)
    .bind(orgId, request.requester_id, request.requester_login, request.requester_membership).first();
  const agent = await db.prepare(`SELECT id,handle,name,owner_login,provider,deleted_at FROM custom_agents
    WHERE org_id=?1 AND id=?2`).bind(orgId, request.agent_id).first();
  const teammate = await loadTeammate(db, orgId, agent?.provider, env).catch(() => null);
  const source = await db.prepare(`SELECT channel,parent_id,body,deleted_at FROM channel_messages WHERE org_id=?1 AND id=?2`)
    .bind(orgId, request.source_message_id).first();
  const stillAllowed = Boolean(currentOwner && currentRequester && agent && !agent.deleted_at && agent.owner_login === request.owner_login &&
    teammate?.enabled && teammate.agentId === request.agent_id && teammate.remote?.gatewayId === request.gateway_id &&
    agentFallbackPolicy(teammate.remote) !== 'never' &&
    await getMode(db, orgId).catch(() => null) === 'harness' && source && !source.deleted_at && source.channel === request.channel &&
    (source.parent_id || request.source_message_id) === request.thread_id && await sha256Hex(source.body) === request.source_hash &&
    await mayRunAgent(db, orgId, agent, request.requester_id) && await mayUseConversation(db, orgId, request.requester_id, request.channel));
  const now = iso(at);
  if (!stillAllowed) {
    const result = await db.prepare(`UPDATE hx_agent_fallback_approvals SET status='cancelled',updated_at=?3 WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(orgId, request.id, now).run();
    return { settled: Boolean(result.meta?.changes), cancelled: true, request };
  }
  if (action === 'decline' || choice === 'computer') {
    const status = choice === 'computer' ? 'returned_to_node' : 'declined';
    const result = await db.prepare(`UPDATE hx_agent_fallback_approvals SET status=?3,scope=?4,decided_at=?5,decided_by=?6,updated_at=?5
      WHERE org_id=?1 AND id=?2 AND status='pending' AND expires_at>?5`).bind(orgId, request.id, status, choice, now, String(actorId)).run();
    return { settled: Boolean(result.meta?.changes), action: status, request: { ...request, status } };
  }
  const owner = await db.prepare(`SELECT timezone FROM users WHERE github_id=?1 AND login=?2`).bind(request.owner_id, request.owner_login).first();
  const grantExpiry = choice === 'two_hours' ? at + 2 * 60 * 60 * 1000 : choice === 'today' ? endOfOwnerDay(at, owner?.timezone || 'UTC') : null;
  const saved = await db.batch([
    db.prepare(`UPDATE hx_agent_fallback_approvals SET status='approved',scope=?3,allowance_expires_at=?4,decided_at=?5,decided_by=?6,updated_at=?5
      WHERE org_id=?1 AND id=?2 AND status='pending' AND expires_at>?5`)
      .bind(orgId, request.id, choice, grantExpiry == null ? null : iso(grantExpiry), now, String(actorId)),
    ...(choice === 'always' ? [db.prepare(`UPDATE ai_teammates SET remote=json_set(remote,'$.fallbackPolicy','always','$.fallbackPolicyConfigured',true,'$.fallbackToWorkspaceAI',true,'$.fallbackToWorkspaceAIConfigured',true),updated_at=?4,updated_by=?5
      WHERE org_id=?1 AND provider=?2 AND agent_id=?3 AND json_valid(remote)
        AND EXISTS(SELECT 1 FROM hx_agent_fallback_approvals WHERE org_id=?1 AND id=?6 AND status='approved')`)
      .bind(orgId, agent.provider, agent.id, now, request.owner_login, request.id)] : []),
    ...(grantExpiry != null ? [db.prepare(`INSERT INTO hx_agent_fallback_permissions(org_id,agent_id,owner_id,scope,expires_at,created_at,revoked_at)
      SELECT ?1,?2,?3,?4,?5,?6,NULL WHERE EXISTS(SELECT 1 FROM hx_agent_fallback_approvals WHERE org_id=?1 AND id=?7 AND status='approved')
      ON CONFLICT(org_id,agent_id) DO UPDATE SET owner_id=excluded.owner_id,scope=excluded.scope,expires_at=excluded.expires_at,created_at=excluded.created_at,revoked_at=NULL`)
      .bind(orgId, request.agent_id, request.owner_id, choice, iso(grantExpiry), now, request.id)] : []),
  ]);
  if (!saved[0]?.meta?.changes) return { settled: false };
  return { settled: true, action: 'approve', choice, expiresAt: grantExpiry == null ? null : iso(grantExpiry), request: { ...request, status: 'approved', scope: choice } };
}


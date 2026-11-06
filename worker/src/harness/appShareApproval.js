import { sha256Hex } from '../auth.js';
import { mayUseConversation } from './conversationAccess.js';
import { saveCard } from '../db.js';
import { appendCardEvent } from '../events.js';
import { announceCards } from '../announce.js';

const now = () => new Date().toISOString();
const id = () => 'appshare_req_' + crypto.randomUUID().replaceAll('-', '');
const assetsHash = custom => sha256Hex(JSON.stringify({ published: custom?.published || '', assets: custom?.publishedAssets || custom?.assets || [] }));
const publicCustom = app => {
  const custom = app?.definition?.custom;
  return custom && typeof custom.published === 'string' && custom.published.trim()
    && !custom.publishedCommit && !custom.publishedCommitApprovalId ? custom : null;
};

export async function requestPublicAppShareApproval(env, context, appId) {
  const { orgId, userId, login, agentId, channel, sourceMessageId, sourceThreadId, sourceBody } = context || {};
  if (![orgId, userId, login, agentId, channel, sourceMessageId].every(value => typeof value === 'string' && value)
      || typeof sourceBody !== 'string' || !appId || typeof appId !== 'string') return { error: 'This Agent turn cannot request an app link.', status: 400 };
  const db = env.DB;
  if (!await mayUseConversation(db, orgId, userId, channel)) return { error: 'The Agent no longer has access to this room.', status: 403 };
  const source = await db.prepare('SELECT body,channel,parent_id,deleted_at FROM channel_messages WHERE org_id=?1 AND id=?2').bind(orgId, sourceMessageId).first();
  if (!source || source.deleted_at || source.channel !== channel || source.body !== sourceBody || (source.parent_id || source.id) !== sourceThreadId) return { error: 'The source turn changed. Ask the Agent again.', status: 409 };
  const agent = await db.prepare(`SELECT a.scope,a.deleted_at FROM custom_agents a
    JOIN channel_agents ca ON ca.org_id=a.org_id AND ca.agent_id=a.id AND ca.channel=?3
    WHERE a.org_id=?1 AND a.id=?2`).bind(orgId, agentId, channel).first();
  if (!agent || agent.deleted_at || agent.scope !== 'team') return { error: 'Only an active managed Agent in this room can request an app link.', status: 403 };
  const member = await db.prepare("SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND role!='guest'").bind(orgId, userId).first();
  if (!member) return { error: 'The requester is no longer a workspace member.', status: 403 };
  const row = await db.prepare(`SELECT a.id,a.name,a.created_by,a.version,a.definition,COALESCE(x.version,0) AS access_version,x.room_channel
    FROM hx_apps a LEFT JOIN hx_app_access x ON x.org_id=a.org_id AND x.app_id=a.id
    WHERE a.org_id=?1 AND a.id=?2
      AND EXISTS(SELECT 1 FROM hx_app_links l WHERE l.org_id=a.org_id AND l.app_id=a.id AND l.channel=?3)`).bind(orgId, appId, channel).first();
  if (!row) return { error: 'The Agent can only request a link for an app attached to this room.', status: 404 };
  let definition;
  try { definition = JSON.parse(row.definition || '{}'); } catch { return { error: 'The app is unavailable.', status: 404 }; }
  const custom = publicCustom({ definition });
  if (!custom) return { error: 'Anyone links are available only for a published inline Custom App.', status: 409 };
  const existing = await db.prepare(`SELECT id FROM hx_app_public_share_requests
    WHERE org_id=?1 AND app_id=?2 AND agent_id=?3 AND room_channel=?4 AND source_message_id=?5 AND status='pending'`)
    .bind(orgId, appId, agentId, channel, sourceMessageId).first();
  if (existing) return { requestId: existing.id, status: 'pending', message: 'An approval request for this exact turn is already waiting.' };
  const requestId = id(), createdAt = now(), sourceHash = await sha256Hex(sourceBody), assetDigest = await assetsHash(custom);
  const inserted = await db.prepare(`INSERT INTO hx_app_public_share_requests
    (id,org_id,app_id,requester_id,requester_login,agent_id,room_channel,source_message_id,source_thread_id,source_hash,app_version,access_version,assets_hash,status,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'pending',?14
    WHERE EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=?2 AND m.id=?8 AND m.channel=?7 AND m.body=?15 AND m.deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM custom_agents a JOIN channel_agents ca ON ca.org_id=a.org_id AND ca.agent_id=a.id AND ca.channel=?7 WHERE a.org_id=?2 AND a.id=?6 AND a.scope='team' AND a.deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM hx_apps a JOIN hx_app_links l ON l.org_id=a.org_id AND l.app_id=a.id AND l.channel=?7 WHERE a.org_id=?2 AND a.id=?3 AND a.version=?11 AND json_extract(a.definition,'$.custom.published') IS NOT NULL AND json_extract(a.definition,'$.custom.publishedCommit') IS NULL)
      AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?2 AND app_id=?3),0)=?12`)
    .bind(requestId,orgId,appId,String(userId),login,agentId,channel,sourceMessageId,sourceThreadId||null,sourceHash,row.version,row.access_version,assetDigest,createdAt,sourceBody).run();
  if (!inserted.meta?.changes) return { error: 'The source turn or app changed. Ask the Agent again.', status: 409 };
  const owner = await db.prepare('SELECT login,name FROM users WHERE github_id=?1').bind(String(row.created_by)).first();
  if (owner?.login) {
    const cardId = 'app-share-approval-' + requestId;
    const card = {
      id: cardId, recipientUserID: owner.login, senderUserID: 'agent:' + agentId,
      type: 'approval', title: (context.agentName || 'A managed Agent') + ' requests an anyone link',
      summary: row.name + ' · #' + channel,
      context: 'The request is bound to the published App version and source turn shown here. Approval does not create a URL or token; the owner must still create a link in App Sharing.',
      priority: 'low', status: 'pending', createdAt, sourceApp: row.name,
      sourceDetail: 'Public link request · #' + channel,
      requestedBy: { login, name: owner.name || login },
      appPublicShareRequest: { requestId, appId, appVersion: row.version, accessVersion: row.access_version, agentId, roomChannel: channel, sourceMessageId, sourceThreadId: sourceThreadId || null },
    };
    await saveCard(db, orgId, card);
    await appendCardEvent(db, orgId, { cardId, type: 'created', actorUserId: login, note: 'app_public_share_request', snapshot: card });
    await announceCards(env, orgId, [card]);
  }
  return { requestId, status: 'pending', message: 'The app owner has an approval card for this exact published revision. No link has been created.' };
}

export async function listPublicAppShareApprovals(db, orgId, appId) {
  const { results = [] } = await db.prepare(`SELECT id,requester_login AS requesterLogin,agent_id AS agentId,room_channel AS roomChannel,
    source_message_id AS sourceMessageId,source_thread_id AS sourceThreadId,app_version AS appVersion,access_version AS accessVersion,
    status,created_at AS createdAt,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt
    FROM hx_app_public_share_requests WHERE org_id=?1 AND app_id=?2 ORDER BY created_at DESC LIMIT 50`).bind(orgId,appId).all();
  return { requests: results };
}

// Approval is a scope decision only. It deliberately creates no bearer token.
// Every condition is repeated in the conditional UPDATE so revocation, source
// edits, room removal or a new App release between the read and write fails closed.
export async function reviewPublicAppShareApproval(db, orgId, appId, requestId, reviewerId, decision, envForAnnounce = null) {
  if (!['approve','decline'].includes(decision)) return { error: 'Choose approve or decline.' };
  const request = await db.prepare('SELECT * FROM hx_app_public_share_requests WHERE org_id=?1 AND app_id=?2 AND id=?3 AND status=\'pending\'').bind(orgId,appId,requestId).first();
  if (!request) return { error: 'This approval request is no longer pending.', status: 409 };
  const app = await db.prepare('SELECT version,definition FROM hx_apps WHERE org_id=?1 AND id=?2').bind(orgId,appId).first();
  const source = await db.prepare('SELECT body FROM channel_messages WHERE org_id=?1 AND id=?2 AND channel=?3 AND deleted_at IS NULL').bind(orgId,request.source_message_id,request.room_channel).first();
  let definition = {};
  try { definition = JSON.parse(app?.definition || '{}'); } catch {}
  const custom = publicCustom({definition});
  const currentAssets = custom ? await assetsHash(custom) : '';
  const sourceStillLive = Boolean(source && await sha256Hex(source.body) === request.source_hash);
  const live = Boolean(app && Number(app.version) === Number(request.app_version) && custom
    && currentAssets === request.assets_hash
    && Number(await db.prepare('SELECT COALESCE((SELECT version FROM hx_app_access WHERE org_id=?1 AND app_id=?2),0) AS version').bind(orgId,appId).first().then(r=>r?.version || 0)) === Number(request.access_version)
    && sourceStillLive
    && await mayUseConversation(db,orgId,request.requester_id,request.room_channel)
    && await db.prepare(`SELECT 1 FROM custom_agents a JOIN channel_agents ca ON ca.org_id=a.org_id AND ca.agent_id=a.id AND ca.channel=?3
      WHERE a.org_id=?1 AND a.id=?2 AND a.scope='team' AND a.deleted_at IS NULL`).bind(orgId,request.agent_id,request.room_channel).first()
    && await db.prepare('SELECT 1 FROM hx_app_links WHERE org_id=?1 AND app_id=?2 AND channel=?3').bind(orgId,appId,request.room_channel).first());
  const status = decision === 'approve' && live ? 'approved' : decision === 'decline' ? 'declined' : 'stale';
  const at = now();
  const out = await db.prepare(`UPDATE hx_app_public_share_requests SET status=?1,reviewed_by=?2,reviewed_at=?3
    WHERE org_id=?4 AND app_id=?5 AND id=?6 AND status='pending'
      AND app_version=?7 AND access_version=?8 AND source_hash=?9 AND assets_hash=?10
      AND EXISTS(SELECT 1 FROM memberships reviewer WHERE reviewer.org_id=?4 AND reviewer.user_github_id=?15
        AND (reviewer.role IN ('owner','admin') OR reviewer.user_github_id=(SELECT created_by FROM hx_apps WHERE org_id=?4 AND id=?5)))
      AND (?1!='approved' OR (
        EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=?4 AND a.id=?5 AND a.version=?7
          AND json_extract(a.definition,'$.custom.published') IS NOT NULL
          AND json_extract(a.definition,'$.custom.publishedCommit') IS NULL
          AND json_extract(a.definition,'$.custom.publishedCommitApprovalId') IS NULL)
        AND EXISTS(SELECT 1 FROM channel_messages m WHERE m.org_id=?4 AND m.id=?11 AND m.channel=?12 AND m.body=?13 AND m.deleted_at IS NULL)
        AND EXISTS(SELECT 1 FROM channel_agents ca JOIN custom_agents a ON a.org_id=ca.org_id AND a.id=ca.agent_id WHERE ca.org_id=?4 AND ca.channel=?12 AND ca.agent_id=?14 AND a.scope='team' AND a.deleted_at IS NULL)
        AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?4 AND app_id=?5),0)=?8
        AND EXISTS(SELECT 1 FROM hx_app_links l WHERE l.org_id=?4 AND l.app_id=?5 AND l.channel=?12)
        AND EXISTS(SELECT 1 FROM memberships r WHERE r.org_id=?4 AND r.user_github_id=?16 AND r.role!='guest')
      ))`)
    .bind(status,String(reviewerId),at,orgId,appId,requestId,request.app_version,request.access_version,request.source_hash,request.assets_hash,request.source_message_id,request.room_channel,source?.body||'',request.agent_id,String(reviewerId),request.requester_id).run();
  if (!out.meta?.changes) return { error: 'The source turn or app changed while reviewing. Reload the request.', status: 409 };
  // Keep the owner's inbox card in sync when they decide from the App Sharing
  // panel; card decisions themselves already updated the card before relay settlement.
  const cardId = 'app-share-approval-' + requestId;
  const stored = await db.prepare('SELECT data FROM cards WHERE org_id=?1 AND card_id=?2').bind(orgId,cardId).first();
  if (stored?.data) {
    let card; try { card = JSON.parse(stored.data); } catch {}
    if (card && card.status === 'pending') {
      const cardAction = status === 'approved' ? 'approve' : 'decline';
      card.status = cardAction === 'approve' ? 'approved' : 'rejected';
      card.decision = { action: cardAction, actorUserID: String(reviewerId), decidedAt: at, ...(status === 'stale' ? { note: 'The source turn or published App changed; no link was created.' } : {}) };
      await saveCard(db, orgId, card);
      await appendCardEvent(db, orgId, { cardId, type: 'decided', action: cardAction, actorUserId: String(reviewerId), note: card.decision.note || null, snapshot: card });
      if (envForAnnounce) await announceCards(envForAnnounce, orgId, [card], { isNew: false });
    }
  }
  return { requestId, status, reviewedAt: at, tokenCreated: false };
}

export function publicAppShareAgentTools(env, context) {
  if (!context || context.kind !== 'business' || context.mode !== 'harness' || context.agentScope !== 'team' || !context.agentId || !context.sourceMessageId) return {};
  return {
    request_public_app_link: {
      description: 'Request workspace owner approval to make one published inline Custom App readable by anyone with a link. Use only for an app already attached to this room. This creates an approval request only; it never creates a public URL or token.',
      parameters: { type: 'object', properties: { appId: { type: 'string', description: 'The existing app ID shown in this room.' } }, required: ['appId'], additionalProperties: false },
      run: async ({ appId }) => {
        const result = await requestPublicAppShareApproval(env, context, appId);
        if (result.error) return 'Approval request was not created: ' + result.error;
        return result.message || 'The app owner has an approval request for this exact turn. No public link or token exists yet.';
      },
    },
  };
}

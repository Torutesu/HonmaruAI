import { executeTool } from '../composio.js';
import { connectorById } from '../connectors/index.js';

const MAX_TEXT = 4000;
const STALE_SEND_MS = 2 * 60_000;

export function slackActionResult(payload) {
  if (payload?.successful !== true) throw new Error('The Slack action did not report success.');
  const action = payload?.results?.[0]?.response ?? payload;
  if (action?.successful !== true || action?.error) throw new Error('The Slack action returned a provider error.');
  const data = action.data;
  if (!data || typeof data !== 'object' || data.ok === false || data.error) {
    throw new Error('The Slack action returned an unsuccessful provider response.');
  }
  return data;
}

export const slackDraftText = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: 'Write a message before saving the Slack draft.' };
  if (text.length > MAX_TEXT) return { error: `A Slack message is at most ${MAX_TEXT} characters.` };
  return { text };
};

export function slackTarget(value) {
  if (!value || typeof value !== 'object') return { error: 'Choose a Slack channel or DM.' };
  const channel = typeof value.channel_id === 'string' ? value.channel_id.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(channel)) return { error: 'The Slack channel ID is invalid.' };
  const thread = value.thread_ts == null || value.thread_ts === '' ? null : String(value.thread_ts).trim();
  if (thread && !/^\d{1,20}\.\d{1,9}$/.test(thread)) return { error: 'The Slack thread timestamp is invalid.' };
  return { channel, thread };
}

function conversationsFrom(payload) {
  // Composio's action response is { successful, data, error }; Slack's
  // conversations.list response is { ok, channels, response_metadata }.
  // Never treat an arbitrary object (or an error envelope) as verified data.
  if (payload?.successful !== true) throw new Error('Slack destination lookup did not succeed.');
  const action = payload?.results?.[0]?.response ?? payload;
  if (action?.successful !== true || action?.error) throw new Error('Slack destination lookup failed.');
  const data = action?.data ?? action;
  if (data?.ok === false || data?.error) throw new Error('Slack destination lookup failed.');
  const rows = data?.channels;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const channelId = String(row?.id ?? row?.channel_id ?? row?.conversation_id ?? '').trim();
    const name = String(row?.name ?? '').trim().slice(0,120);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId) || !name) return null;
    const type = row?.is_im ? 'im' : row?.is_mpim || row?.is_group_dm ? 'group_dm' : String(row?.type || 'channel').slice(0,32);
    return { channelId, name, type, private: Boolean(row?.is_private || row?.is_private_channel), groupDm: type === 'group_dm' };
  }).filter(Boolean);
}

export async function listSlackDestinations(env, providerUserId) {
  const connector = connectorById('slack');
  if (!env?.COMPOSIO_API_KEY || !connector) return [];
  const override = typeof env.CONNECTOR_TOOL_SLACK_LIST === 'string' ? env.CONNECTOR_TOOL_SLACK_LIST.trim() : '';
  const slug = override || 'SLACK_LIST_CONVERSATIONS';
  if (!/^[A-Z0-9_]+$/.test(slug)) throw new Error('Invalid Slack list tool name.');
  const payload = await executeTool(env.COMPOSIO_API_KEY, slug, String(providerUserId), {
    types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 200,
  });
  return conversationsFrom(payload);
}

export async function resolveSlackDestination(env, providerUserId, channelId) {
  const targets = await listSlackDestinations(env, providerUserId);
  return targets.find(target => target.channelId === String(channelId || '').trim()) || null;
}

function safeDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    revision: Number(row.revision),
    status: row.status,
    agent: { id: row.agent_id, name: row.agent_name || 'Agent' },
    target: { channelId: row.target_channel, name: row.target_name, label: row.target_type === 'im' ? 'Direct message' : row.target_type === 'group_dm' ? 'Group message' : 'Slack channel', type: row.target_type, private: Boolean(row.target_private), verified: true,
      ...(row.target_type === 'group_dm' ? { groupDm: true } : {}),
      ...(row.target_thread_ts ? { threadTs: row.target_thread_ts } : {}) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
  };
}

const SELECT_DRAFT = `SELECT d.*, a.name AS agent_name FROM hx_slack_drafts d
  JOIN custom_agents a ON a.org_id=d.org_id AND a.id=d.agent_id AND a.deleted_at IS NULL
  WHERE d.org_id=?1 AND d.id=?2 AND d.creator_github_id=?3 AND d.conversation=?4`;

export async function createSlackDraft(db, { orgId, agentId, creatorGithubId, creatorLogin, conversation,
  sourceMessageId, providerUserId, connectionVersion, targetChannel, targetName, targetType, targetPrivate, targetThreadTs, text }) {
  const id = `slack_draft_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO hx_slack_drafts
    (org_id,id,agent_id,creator_github_id,creator_login,conversation,source_message_id,provider_user_id,connection_version,
     target_channel,target_name,target_type,target_private,target_thread_ts,text,revision,status,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1,'pending',?16,?16)`)
    .bind(orgId,id,agentId,String(creatorGithubId),creatorLogin,conversation,sourceMessageId,String(providerUserId),
      connectionVersion,targetChannel,targetName,targetType,targetPrivate ? 1 : 0,targetThreadTs,text,now).run();
  return { id, revision: 1, status: 'pending' };
}

export async function readSlackDraft(db, { orgId, id, creatorGithubId, conversation }) {
  const row = await db.prepare(SELECT_DRAFT).bind(orgId,id,String(creatorGithubId),conversation).first();
  return safeDraft(row);
}

export async function getSlackDraftInternal(db, { orgId, id, creatorGithubId, conversation }) {
  return db.prepare(`SELECT d.*,a.name AS agent_name FROM hx_slack_drafts d
    JOIN custom_agents a ON a.org_id=d.org_id AND a.id=d.agent_id AND a.deleted_at IS NULL
    WHERE d.org_id=?1 AND d.id=?2 AND d.creator_github_id=?3 AND d.conversation=?4`)
    .bind(orgId,id,String(creatorGithubId),conversation).first();
}

export async function updateSlackDraft(db, { orgId, id, creatorGithubId, conversation, revision, text, target = null }) {
  const now = new Date().toISOString();
  const out = target
    ? await db.prepare(`UPDATE hx_slack_drafts SET text=?6,target_channel=?7,target_name=?8,target_type=?9,target_private=?10,target_thread_ts=NULL,revision=revision+1,updated_at=?11
      WHERE org_id=?1 AND id=?2 AND creator_github_id=?3 AND conversation=?4 AND revision=?5 AND status='pending'`)
      .bind(orgId,id,String(creatorGithubId),conversation,revision,text,target.channelId,target.name,target.type,target.private ? 1 : 0,now).run()
    : await db.prepare(`UPDATE hx_slack_drafts SET text=?6,revision=revision+1,updated_at=?7
    WHERE org_id=?1 AND id=?2 AND creator_github_id=?3 AND conversation=?4 AND revision=?5 AND status='pending'`)
      .bind(orgId,id,String(creatorGithubId),conversation,revision,text,now).run();
  if (!(out.meta?.changes > 0)) return null;
  return readSlackDraft(db,{orgId,id,creatorGithubId,conversation});
}

export async function discardSlackDraft(db, { orgId, id, creatorGithubId, conversation, revision }) {
  const now = new Date().toISOString();
  const out = await db.prepare(`UPDATE hx_slack_drafts SET status='discarded',revision=revision+1,updated_at=?6
    WHERE org_id=?1 AND id=?2 AND creator_github_id=?3 AND conversation=?4 AND revision=?5 AND status='pending'`)
    .bind(orgId,id,String(creatorGithubId),conversation,revision,now).run();
  if (!(out.meta?.changes > 0)) return null;
  const row=await db.prepare(`SELECT d.*,a.name AS agent_name FROM hx_slack_drafts d
    JOIN custom_agents a ON a.org_id=d.org_id AND a.id=d.agent_id
    WHERE d.org_id=?1 AND d.id=?2 AND d.creator_github_id=?3 AND d.conversation=?4`)
    .bind(orgId,id,String(creatorGithubId),conversation).first();
  return safeDraft(row);
}

export async function claimSlackDraft(db, { orgId, id, creatorGithubId, conversation, revision, connectionVersion }) {
  const claimId=crypto.randomUUID();
  const now=new Date().toISOString();
  const out=await db.prepare(`UPDATE hx_slack_drafts SET status='sending',claim_id=?7,updated_at=?8
    WHERE org_id=?1 AND id=?2 AND creator_github_id=?3 AND conversation=?4 AND revision=?5
      AND connection_version=?6 AND status='pending'`)
    .bind(orgId,id,String(creatorGithubId),conversation,revision,connectionVersion,claimId,now).run();
  if (!(out.meta?.changes > 0)) return null;
  const row=await db.prepare(`SELECT * FROM hx_slack_drafts WHERE org_id=?1 AND id=?2 AND creator_github_id=?3 AND conversation=?4 AND claim_id=?5`)
    .bind(orgId,id,String(creatorGithubId),conversation,claimId).first();
  return row ? { ...row, claim_id: claimId } : null;
}

export async function settleSlackDraft(db, { orgId, id, claimId, status, providerTs = null, errorCode = null }) {
  if (!['sent','unknown','failed'].includes(status)) throw new Error('Invalid Slack draft settlement.');
  const now=new Date().toISOString();
  await db.prepare(`UPDATE hx_slack_drafts SET status=?4,provider_ts=?5,error_code=?6,sent_at=CASE WHEN ?4='sent' THEN ?7 ELSE sent_at END,updated_at=?7
    WHERE org_id=?1 AND id=?2 AND claim_id=?3 AND status='sending'`)
    .bind(orgId,id,claimId,status,providerTs,errorCode,now).run();
  return db.prepare(`SELECT id,text,revision,status,target_channel,target_thread_ts,created_at,updated_at,agent_id FROM hx_slack_drafts
    WHERE org_id=?1 AND id=?2`).bind(orgId,id).first();
}

export async function releaseSlackDraftClaim(db, { orgId, id, claimId, errorCode = null }) {
  const now = new Date().toISOString();
  return db.prepare(`UPDATE hx_slack_drafts SET status='pending',claim_id=NULL,error_code=?4,updated_at=?5
    WHERE org_id=?1 AND id=?2 AND claim_id=?3 AND status='sending'`)
    .bind(orgId,id,claimId,errorCode,now).run();
}

/// A crashed provider request has an unknowable result. Retire its claim and
/// make the draft read-only rather than risking a duplicate Slack post.
export async function expireUncertainSlackSend(db, row, now = Date.now()) {
  if (!row || row.status !== 'sending' || now - Date.parse(row.updated_at) < STALE_SEND_MS) return false;
  const stamp = new Date(now).toISOString();
  const out = await db.prepare(`UPDATE hx_slack_drafts SET status='unknown',error_code='delivery_outcome_unknown',updated_at=?5
    WHERE org_id=?1 AND id=?2 AND claim_id=?3 AND status='sending' AND updated_at=?4`)
    .bind(row.org_id,row.id,row.claim_id,row.updated_at,stamp).run();
  return Boolean(out.meta?.changes > 0);
}

export function publicSlackDraft(row) { return safeDraft(row); }

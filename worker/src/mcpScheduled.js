import { getUserByGithubId } from './db.js';
import { resolveMcpConversation, mcpConversationContext } from './mcpConversation.js';
import { viewOf } from './channels.js';
import { prepareConversationMessage, acceptConversationMessage } from './conversationOperations.js';
import { emitMessage } from './webhooks.js';
import { McpInputError } from './mcpSupport.js';

export async function deliverMcpScheduledMessage(env, row, authority) {
  const membership = await env.DB.prepare('SELECT created_at,role FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(row.org_id, authority.user_id).first();
  if (!membership || membership.created_at !== authority.membership_since || String(membership.role).trim().toLowerCase() === 'guest') return { sent: false };
  let actor;
  if (authority.grant_id) {
    const { resolveMcpGrantActor } = await import('./mcpOAuth.js');
    actor = await resolveMcpGrantActor(env, { grantId: authority.grant_id });
  } else {
    const token = await env.DB.prepare('SELECT * FROM api_tokens WHERE id=?1 AND org_id=?2 AND github_id=?3').bind(authority.token_id, row.org_id, authority.user_id).first();
    if (!token || !token.expires_at || Date.parse(token.expires_at) <= Date.now()) return { sent: false };
    const user = await getUserByGithubId(env.DB, authority.user_id);
    const { parseScopes } = await import('./mcp.js');
    actor = user && { tokenId: token.id, orgId: token.org_id, githubId: String(authority.user_id), login: user.login, name: user.name || user.login, scopes: parseScopes(token.scopes), ssoBacked: Boolean(token.sso_backed) };
  }
  if (!actor || actor.orgId !== row.org_id || actor.login !== row.author_login || !actor.scopes.includes('chat:schedule')) return { sent: false };
  const { agentDenial } = await import('./mcp.js');
  if (await agentDenial(env, actor)) return { sent: false };
  // Only a refusal is "not sent", which closes the message. Any other error,
  // a database that failed for a moment, is left to throw so the caller's
  // hold runs out and the message is tried again.
  let context;
  try {
    const current = await mcpConversationContext(env, actor);
    const view = viewOf(row.channel, actor.login, current.members, current.access);
    if (!view) return { sent: false };
    context = await resolveMcpConversation(env, actor, view);
  } catch (err) {
    if (err instanceof McpInputError) return { sent: false };
    throw err;
  }
  const body = { body: row.body, parentId: row.parent_id, alsoChannel: Boolean(row.also_channel), clientId: `tmp-${row.id.replace(/^tmp-/, '')}` };
  const prepared = await prepareConversationMessage(env, null, { orgId: actor.orgId, user: context.user, resolved: context.resolved, body });
  if (prepared.denied) return { sent: false };
  const out = await acceptConversationMessage(env, { orgId: actor.orgId, user: context.user, resolved: context.resolved, body, prepared, conversationActorId: String(actor.githubId), mcpAuthority: { tokenId: actor.grantId ? null : actor.tokenId, grantId: actor.grantId || null, scope: 'chat:schedule' } });
  if (!out.row) return { sent: false };
  const { deliverAcceptedMessages } = await import('./channelRoutes.js');
  await Promise.all(['live', 'push'].map(kind => deliverAcceptedMessages(env, { kind, orgId: actor.orgId, messageId: out.row.id })));
  if (!out.replay) await emitMessage(env, actor.orgId, out.row);
  return { sent: true };
}

import { getUserByGithubId, isMember } from './db.js';
import { isGuest, accessFor } from './access.js';
import { listMembers } from './team.js';
import { resolveChannel, viewOf } from './channels.js';
import { McpInputError, requireMcpScope } from './mcpSupport.js';

export async function mcpConversationContext(env, actor) {
  if (!await isMember(env.DB, actor.orgId, actor.githubId) || await isGuest(env.DB, actor.orgId, actor.githubId)) throw new McpInputError('Workspace access is no longer available.');
  const user = await getUserByGithubId(env.DB, actor.githubId);
  if (!user || user.login !== actor.login) throw new McpInputError('Workspace access is no longer available.');
  const members = await listMembers(env.DB, actor.orgId, actor.githubId);
  return { user: { ...user, github_id: actor.githubId }, members, access: await accessFor(env.DB, actor.orgId, actor.login) };
}

export async function resolveMcpConversation(env, actor, conversation) {
  const context = await mcpConversationContext(env, actor);
  const resolved = await resolveChannel(env.DB, actor.orgId, context.user, conversation, context.members);
  if (!resolved || resolved.kind === 'agent') throw new McpInputError('No accessible conversation.');
  if (resolved.private) requireMcpScope(actor, 'chat:private');
  if (resolved.kind === 'dm' || resolved.kind === 'group') requireMcpScope(actor, 'chat:dm');
  return { ...context, resolved, view: viewOf(resolved.key, actor.login, context.members, context.access) };
}

export function messageLink(env, orgId, view, messageId) {
  const base = new URL(env.APP_WEB_URL || 'https://app.honmaruai.com');
  base.hash = `/m/${encodeURIComponent(messageId)}/${encodeURIComponent(orgId)}`;
  return base.toString();
}

export function mcpAudienceSql(scopes, alias = 'm') {
  const channel = `${alias}.channel`;
  const publicOnly = `NOT EXISTS (SELECT 1 FROM businesses mb WHERE mb.org_id = ?1 AND 'b:' || mb.slug = ${channel} AND mb.private = 1)`;
  const privateAllowed = scopes.includes('chat:private') ? '1' : publicOnly;
  const dmAllowed = scopes.includes('chat:dm') ? `OR ${channel} LIKE 'dm:%' OR ${channel} LIKE 'g:%'` : '';
  return `((${channel} LIKE 'b:%' AND ${privateAllowed}) ${dmAllowed})`;
}

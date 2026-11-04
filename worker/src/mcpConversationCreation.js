import { sha256Hex } from './auth.js';
import { listBusinesses } from './db.js';
import { MAX_GROUP, membersOf } from './access.js';
import { createManagedRoom } from './harness/roomCreation.js';
import { mcpConversationContext, resolveMcpConversation } from './mcpConversation.js';
import { McpInputError, requireMcpScope, mcpResult } from './mcpSupport.js';
import { announceTo } from './announce.js';
import { custom as customEvent } from './agui/events.js';

export async function createMcpConversation(env, actor, args) {
  const context = await mcpConversationContext(env, actor);
  const refs = [...new Set(args.memberRefs || [])].sort();
  const selected = context.members.filter(member => refs.includes(member.ref));
  if (selected.length !== refs.length) throw new McpInputError('Select current workspace members.');
  if (args.type === 'channel' && args.private) requireMcpScope(actor, 'chat:private');
  if (args.type !== 'channel') {
    requireMcpScope(actor, 'chat:dm');
    if (selected.some(member => member.login === actor.login) || !selected.length || selected.length + 1 > MAX_GROUP || (args.type === 'dm' && selected.length !== 1) || (args.type === 'group' && selected.length < 2)) throw new McpInputError('Select valid workspace members for this conversation.');
  }
  const current = context.members.find(member => member.userId === String(actor.githubId));
  if (!current) throw new McpInputError('Workspace access is no longer available.');
  const connection = actor.grantId || actor.tokenId;
  const key = `mcp-${await sha256Hex(`${connection}:${args.requestId}`)}`;
  const fingerprint = await sha256Hex(JSON.stringify({ type: args.type, name: args.name || '', private: Boolean(args.private), memberRefs: refs }));
  const binds = [actor.orgId, String(actor.githubId), connection, args.requestId];
  await env.DB.prepare(`INSERT OR IGNORE INTO mcp_conversation_requests(org_id,user_id,connection_id,request_id,fingerprint,membership_since,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND created_at=?6 AND LOWER(role)!='guest')`)
    .bind(...binds, fingerprint, current.joinedAt, new Date().toISOString()).run();
  const receipt = await env.DB.prepare('SELECT * FROM mcp_conversation_requests WHERE org_id=?1 AND user_id=?2 AND connection_id=?3 AND request_id=?4').bind(...binds).first();
  if (!receipt || receipt.fingerprint !== fingerprint || receipt.membership_since !== current.joinedAt) throw new McpInputError('This requestId belongs to different conversation content or membership. Use a new requestId.');
  if (args.type === 'channel') {
    const result = await createManagedRoom(env.DB, actor.orgId, actor.githubId, { requestId: key, name: args.name || '', private: Boolean(args.private), color: 'blue', guidelines: '', memberRefs: refs, agentIds: [] });
    if (result.error) throw new McpInputError(result.error);
    await env.DB.prepare('UPDATE mcp_conversation_requests SET channel=?5 WHERE org_id=?1 AND user_id=?2 AND connection_id=?3 AND request_id=?4').bind(...binds, result.room.channel).run();
    if (result.created) await announceTo(env, actor.orgId, await Promise.all(context.members.map(async member => ({ to: member.login, event: customEvent('businesses', { businesses: await listBusinesses(env.DB, actor.orgId, { viewer: member.login }) }) }))));
    return mcpResult({ conversation: { id: result.room.channel, name: result.room.name, type: 'channel', private: Boolean(args.private) }, created: result.created });
  }
  const people = [current, ...selected].sort((a, b) => a.login.localeCompare(b.login));
  const logins = people.map(member => member.login);
  let channel = receipt.channel;
  if (channel) {
    const view = args.type === 'dm' ? `dm:${selected[0].ref}` : channel;
    const resolved = await resolveMcpConversation(env, actor, view);
    if (resolved.resolved.key !== channel || (args.type === 'group' && JSON.stringify((await membersOf(env.DB, actor.orgId, channel)).sort()) !== JSON.stringify([...logins].sort()))) throw new McpInputError('Conversation membership changed. Use a new requestId.');
  } else {
    if (args.type === 'dm') channel = `dm:${[...logins].sort().join('|')}`;
    else {
      const existing = await env.DB.prepare(`SELECT channel FROM conversation_members WHERE org_id=?1 AND channel LIKE 'g:%' GROUP BY channel
        HAVING COUNT(*)=?2 AND SUM(CASE WHEN login IN(SELECT value FROM json_each(?3)) THEN 1 ELSE 0 END)=?2 ORDER BY channel LIMIT 1`)
        .bind(actor.orgId, logins.length, JSON.stringify(logins)).first();
      channel = existing?.channel || `g:${(await sha256Hex(`${actor.orgId}:${JSON.stringify(people.map(member => [member.userId, member.joinedAt]))}`)).slice(0, 16)}`;
      const previous = (await membersOf(env.DB, actor.orgId, channel)).sort();
      if (previous.length && JSON.stringify(previous) !== JSON.stringify([...logins].sort())) throw new McpInputError('Group membership changed. Open a new group in Honmaru.');
    }
    const snapshot = JSON.stringify([...people].sort((a, b) => a.userId.localeCompare(b.userId)).map(member => [member.userId, member.joinedAt, member.login]));
    const nonce = crypto.randomUUID();
    const groupUnchanged = args.type === 'group' ? ` AND ((SELECT COUNT(*) FROM conversation_members WHERE org_id=?1 AND channel=?5)=0 OR ((SELECT COUNT(*) FROM conversation_members WHERE org_id=?1 AND channel=?5)=json_array_length(?6) AND NOT EXISTS(SELECT 1 FROM conversation_members WHERE org_id=?1 AND channel=?5 AND login NOT IN(SELECT value FROM json_each(?6)))))` : '';
    const gate = `EXISTS(SELECT 1 FROM mcp_conversation_requests WHERE org_id=?1 AND user_id=?2 AND connection_id=?3 AND request_id=?4 AND channel=?5 AND creation_nonce=?9)`;
    const statements = [env.DB.prepare(`UPDATE mcp_conversation_requests SET channel=?5,creation_nonce=?8 WHERE org_id=?1 AND user_id=?2 AND connection_id=?3 AND request_id=?4 AND channel IS NULL
      AND (SELECT json_group_array(json_array(id,joined,login)) FROM (SELECT CAST(m.user_github_id AS TEXT) id,m.created_at joined,u.login FROM memberships m JOIN users u ON u.github_id=m.user_github_id
        WHERE m.org_id=?1 AND u.login IN(SELECT value FROM json_each(?6)) ORDER BY m.user_github_id))=?7${groupUnchanged}`)
      .bind(...binds, channel, JSON.stringify(logins), snapshot, nonce)];
    if (args.type === 'group') for (const login of logins) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO conversation_members(org_id,channel,login,added_by,added_at) SELECT ?1,?5,?6,?7,?8 WHERE ${gate}`)
      .bind(...binds, channel, login, actor.login, new Date().toISOString(), nonce));
    await env.DB.batch(statements);
    const saved = await env.DB.prepare('SELECT channel FROM mcp_conversation_requests WHERE org_id=?1 AND user_id=?2 AND connection_id=?3 AND request_id=?4').bind(...binds).first();
    if (!saved?.channel) throw new McpInputError('Workspace membership changed. Retry after refreshing members.');
    channel = saved.channel;
  }
  if (args.type === 'dm') return mcpResult({ conversation: { id: `dm:${selected[0].ref}`, name: selected[0].name, type: 'dm' } });
  await announceTo(env, actor.orgId, logins.map(login => ({ to: login, event: customEvent('channel_group', { view: channel, refs: context.members.filter(member => logins.includes(member.login) && member.login !== login).map(member => member.ref) }) })));
  return mcpResult({ conversation: { id: channel, type: 'group', memberRefs: refs } });
}

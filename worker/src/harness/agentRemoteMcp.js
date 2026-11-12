import { remoteMcpTools } from './remoteMcp.js';
import { remoteMcpOAuthStatus } from './remoteMcpOAuth.js';
import { mayRunAgent } from './agents.js';

async function currentGrants(db, orgId, agentId, githubId) {
  const { results = [] } = await db.prepare(`SELECT g.server_id FROM hx_agent_remote_mcp_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id
      AND m.created_at=g.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    JOIN hx_remote_mcp_servers s ON s.org_id=g.org_id AND s.id=g.server_id
    JOIN custom_agents a ON a.org_id=g.org_id AND a.id=g.agent_id AND a.deleted_at IS NULL
    WHERE g.org_id=?1 AND g.agent_id=?2 AND g.user_github_id=?3`)
    .bind(orgId, agentId, String(githubId)).all();
  return new Set(results.map((row) => row.server_id));
}

async function enabledToolNames(db, orgId, agentId, githubId, serverId, offeredTools) {
  const legacy = (await currentGrants(db, orgId, agentId, githubId)).has(serverId);
  const grants = await db.prepare(`SELECT g.tool_name FROM hx_agent_remote_mcp_tool_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id
      AND m.created_at=g.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    JOIN custom_agents a ON a.org_id=g.org_id AND a.id=g.agent_id AND a.deleted_at IS NULL
    WHERE g.org_id=?1 AND g.agent_id=?2 AND g.user_github_id=?3 AND g.server_id=?4`)
    .bind(orgId, agentId, String(githubId), serverId).all();
  const specific = new Set((grants.results || []).map(row => row.tool_name));
  return new Set(offeredTools.filter(tool => legacy || specific.has(tool._remote.toolName)).map(tool => tool._remote.toolName));
}

async function readOnlyToolsByServer(db, orgId) {
  const tools = await remoteMcpTools(db, orgId, { readOnlyOnly: true }).catch(() => []);
  const grouped = new Map();
  for (const tool of tools) {
    const id = tool?._remote?.serverId;
    if (id) grouped.set(id, [...(grouped.get(id) || []), tool]);
  }
  return grouped;
}

export async function agentRemoteMcpConnections(db, { orgId, agentId, githubId }) {
  if (!orgId || !agentId || !githubId) return [];
  const [servers, grants, grouped] = await Promise.all([
    db.prepare('SELECT id, name, auth_mode FROM hx_remote_mcp_servers WHERE org_id=?1 ORDER BY created_at, id').bind(orgId).all().catch(() => ({ results: [] })),
    currentGrants(db, orgId, agentId, githubId).catch(() => new Set()),
    readOnlyToolsByServer(db, orgId),
  ]);
  return Promise.all((servers.results || []).map(async (server) => {
    const offered = grouped.get(server.id) || [];
    const allowedTools = await enabledToolNames(db, orgId, agentId, githubId, server.id, offered);
    const readOnlyToolCount = offered.length;
    const oauthConnected = server.auth_mode !== 'oauth' || await remoteMcpOAuthStatus(db, orgId, server.id, githubId);
    const available = readOnlyToolCount > 0 && oauthConnected;
    return {
      serverId: server.id,
      name: server.name,
      available,
      enabled: available && (grants.has(server.id) || offered.length > 0 && allowedTools.size === offered.length),
      tools: offered.map(tool => ({ name: tool._remote.toolName, title: tool.title || tool._remote.toolName,
        description: tool.description || '', inputSchema: tool.inputSchema,
        enabled: available && allowedTools.has(tool._remote.toolName) })),
      readOnlyToolCount,
      needsOAuth: !oauthConnected,
    };
  }));
}

export async function setAgentRemoteMcpTool(env, { orgId, agentId, session, serverId, toolName, enabled }) {
  const id = String(serverId || '').trim(), name = String(toolName || '').trim();
  if (!id || id.length > 200 || !name || name.length > 200 || typeof enabled !== 'boolean')
    return { error: 'Choose a Remote MCP tool and whether to allow it.' };
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };
  const offered = await remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []);
  const tool = offered.find(item => item?._remote?.serverId === id && item?._remote?.toolName === name);
  if (!tool) return { error: 'This Remote MCP tool is not currently approved for read-only use.', status: 409 };
  const current = await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId });
  if (!current.some(item => item.serverId === id && item.available)) return { error: 'This Remote MCP server or Agent is unavailable.', status: 409 };
  const at = new Date().toISOString();
  const legacy = await currentGrants(env.DB, orgId, agentId, githubId);
  const convert = legacy.has(id) ? offered.filter(item => item?._remote?.serverId === id).map(item => env.DB.prepare(`
    INSERT OR IGNORE INTO hx_agent_remote_mcp_tool_grants(org_id,agent_id,user_github_id,membership_since,server_id,tool_name,created_at)
    SELECT ?1,?2,?3,m.created_at,?4,?5,?6 FROM memberships m
      JOIN custom_agents a ON a.org_id=m.org_id AND a.id=?2 AND a.deleted_at IS NULL
      JOIN hx_remote_mcp_servers s ON s.org_id=m.org_id AND s.id=?4
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'`)
    .bind(orgId, agentId, githubId, id, item._remote.toolName, at)) : [];
  const change = enabled
    ? env.DB.prepare(`INSERT INTO hx_agent_remote_mcp_tool_grants(org_id,agent_id,user_github_id,membership_since,server_id,tool_name,created_at)
      SELECT ?1,?2,?3,m.created_at,?4,?5,?6 FROM memberships m
      JOIN custom_agents a ON a.org_id=m.org_id AND a.id=?2 AND a.deleted_at IS NULL
      JOIN hx_remote_mcp_servers s ON s.org_id=m.org_id AND s.id=?4
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
      ON CONFLICT(org_id,agent_id,user_github_id,server_id,tool_name) DO UPDATE SET membership_since=excluded.membership_since,created_at=excluded.created_at`)
      .bind(orgId, agentId, githubId, id, name, at)
    : env.DB.prepare(`DELETE FROM hx_agent_remote_mcp_tool_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND server_id=?4 AND tool_name=?5`)
      .bind(orgId, agentId, githubId, id, name);
  const statements = [...convert];
  if (legacy.has(id)) statements.push(env.DB.prepare('DELETE FROM hx_agent_remote_mcp_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND server_id=?4').bind(orgId, agentId, githubId, id));
  statements.push(change);
  await env.DB.batch(statements);
  const verified = await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId });
  const enabledNow = verified.find(item => item.serverId === id)?.tools?.find(item => item.name === name)?.enabled === true;
  if (enabledNow !== enabled) return { error: 'The workspace, Agent, connection, or tool access changed. Reload and try again.', status: 409 };
  return { connections: verified };
}

export async function setAgentRemoteMcpConnection(env, { orgId, agentId, session, serverId, enabled }) {
  const id = String(serverId || '').trim();
  if (!id || id.length > 200 || typeof enabled !== 'boolean') {
    return { error: 'Choose a connected Remote MCP server and whether to allow it.' };
  }
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };

  if (enabled) {
    const current = await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId });
    const server = current.find((connection) => connection.serverId === id);
    if (!server?.available) return { error: 'This Remote MCP server has no workspace-approved read-only tools.', status: 409 };
    const result = await env.DB.prepare(`INSERT INTO hx_agent_remote_mcp_grants
        (org_id,agent_id,user_github_id,membership_since,server_id,created_at)
      SELECT ?1,?2,?3,m.created_at,?4,?5 FROM memberships m
      JOIN custom_agents a ON a.org_id=m.org_id AND a.id=?2 AND a.deleted_at IS NULL
      JOIN hx_remote_mcp_servers s ON s.org_id=m.org_id AND s.id=?4
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
      ON CONFLICT(org_id,agent_id,user_github_id,server_id) DO UPDATE SET
        membership_since=excluded.membership_since,created_at=excluded.created_at`)
      .bind(orgId, agentId, githubId, id, new Date().toISOString()).run();
    if (!result.meta?.changes && !(await currentGrants(env.DB, orgId, agentId, githubId)).has(id)) {
      return { error: 'The workspace, Agent, or Remote MCP server changed. Reload and try again.', status: 409 };
    }
    const verified = await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId });
    if (!verified.some((connection) => connection.serverId === id && connection.available && connection.enabled)) {
      await env.DB.prepare('DELETE FROM hx_agent_remote_mcp_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND server_id=?4')
        .bind(orgId, agentId, githubId, id).run();
      return { error: 'This Remote MCP server no longer has an approved read-only tool.', status: 409 };
    }
  } else {
    await env.DB.prepare('DELETE FROM hx_agent_remote_mcp_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND server_id=?4')
      .bind(orgId, agentId, githubId, id).run();
  }
  return { connections: await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId }) };
}

export async function mayUseAgentRemoteMcp(env, { orgId, agentId, session, serverId, toolName = null }) {
  const githubId = String(session?.github_id || '');
  if (!githubId || !orgId || !agentId || !serverId) return false;
  if (!await mayRunAgent(env.DB, orgId, { id: agentId }, githubId).catch(() => false)) return false;
  const [grants, tools] = await Promise.all([
    currentGrants(env.DB, orgId, agentId, githubId).catch(() => new Set()),
    remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []),
  ]);
  const matching = tools.filter(tool => tool?._remote?.serverId === serverId && (!toolName || tool?._remote?.toolName === toolName));
  if (!matching.length) return false;
  if (grants.has(serverId)) return true;
  const specific = await enabledToolNames(env.DB, orgId, agentId, githubId, serverId, tools).catch(() => new Set());
  return matching.every(tool => specific.has(tool._remote.toolName));
}

export async function agentRemoteMcpTools(env, { orgId, agentId, session }) {
  if (!session?.github_id || !await mayRunAgent(env.DB, orgId, { id: agentId }, session.github_id).catch(() => false)) return [];
  const connections = await agentRemoteMcpConnections(env.DB, {
    orgId, agentId, githubId: session?.github_id,
  });
  const tools = await remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []);
  const enabled = new Set(connections.flatMap(connection => (connection.tools || []).filter(tool => tool.enabled).map(tool => `${connection.serverId}\0${tool.name}`)));
  return tools.filter(tool => enabled.has(`${tool?._remote?.serverId}\0${tool?._remote?.toolName}`));
}

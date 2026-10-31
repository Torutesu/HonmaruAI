import { remoteMcpTools } from './remoteMcp.js';

async function currentGrants(db, orgId, agentId, githubId) {
  const { results = [] } = await db.prepare(`SELECT g.server_id FROM hx_agent_remote_mcp_grants g
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_github_id
      AND m.created_at=g.membership_since AND m.role!='guest'
    JOIN hx_remote_mcp_servers s ON s.org_id=g.org_id AND s.id=g.server_id
    JOIN custom_agents a ON a.org_id=g.org_id AND a.id=g.agent_id AND a.deleted_at IS NULL
    WHERE g.org_id=?1 AND g.agent_id=?2 AND g.user_github_id=?3`)
    .bind(orgId, agentId, String(githubId)).all();
  return new Set(results.map((row) => row.server_id));
}

async function readOnlyToolsByServer(db, orgId) {
  const tools = await remoteMcpTools(db, orgId, { readOnlyOnly: true }).catch(() => []);
  const counts = new Map();
  for (const tool of tools) {
    const id = tool?._remote?.serverId;
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

export async function agentRemoteMcpConnections(db, { orgId, agentId, githubId }) {
  if (!orgId || !agentId || !githubId) return [];
  const [servers, grants, counts] = await Promise.all([
    db.prepare('SELECT id, name FROM hx_remote_mcp_servers WHERE org_id=?1 ORDER BY created_at, id').bind(orgId).all().catch(() => ({ results: [] })),
    currentGrants(db, orgId, agentId, githubId).catch(() => new Set()),
    readOnlyToolsByServer(db, orgId),
  ]);
  return (servers.results || []).map((server) => {
    const readOnlyToolCount = counts.get(server.id) || 0;
    const available = readOnlyToolCount > 0;
    return {
      serverId: server.id,
      name: server.name,
      available,
      enabled: available && grants.has(server.id),
      readOnlyToolCount,
    };
  });
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
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND m.role!='guest'
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
  const [grants, tools] = await Promise.all([
    currentGrants(env.DB, orgId, agentId, githubId).catch(() => new Set()),
    remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []),
  ]);
  return grants.has(serverId) && tools.some((tool) =>
    tool?._remote?.serverId === serverId && (!toolName || tool?._remote?.toolName === toolName));
}

export async function agentRemoteMcpTools(env, { orgId, agentId, session }) {
  const connections = await agentRemoteMcpConnections(env.DB, {
    orgId, agentId, githubId: session?.github_id,
  });
  const enabled = new Set(connections.filter((connection) => connection.enabled).map((connection) => connection.serverId));
  if (!enabled.size) return [];
  const tools = await remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []);
  return tools.filter((tool) => enabled.has(tool?._remote?.serverId));
}

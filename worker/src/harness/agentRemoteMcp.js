import { remoteMcpTools } from './remoteMcp.js';
import { remoteMcpOAuthAccounts, remoteMcpOAuthShareType, remoteMcpOAuthStatus } from './remoteMcpOAuth.js';
import { mayRunAgent } from './agents.js';
import { getMode } from './mode.js';

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
  return new Set(offeredTools.filter(tool => (legacy && !tool._remote.requiresApproval) || specific.has(tool._remote.toolName)).map(tool => tool._remote.toolName));
}

async function readOnlyToolsByServer(db, orgId) {
  const tools = await remoteMcpTools(db, orgId, { workflowWritable: true }).catch(() => []);
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
  const result = [];
  for (const server of servers.results || []) {
    const offered = grouped.get(server.id) || [];
    const readOnlyToolCount = offered.filter(tool => !tool._remote.requiresApproval).length;
    let accounts;
    if (server.auth_mode === 'oauth') {
      accounts = await remoteMcpOAuthAccounts(db, { orgId, serverId: server.id, requesterId: githubId, agentId });
      if (!accounts.some(account => account.ownerId === String(githubId))) {
        accounts = [...accounts, { ownerId: String(githubId), ownerName: null, shareType: 'disconnected' }];
      }
    } else accounts = [{ ownerId: String(githubId), ownerName: null, shareType: 'own' }];
    for (const account of accounts) {
      if (account.shareType === 'agent' && !await mayRunAgent(db, orgId, { id: agentId }, account.ownerId).catch(() => false)) continue;
      const connected = server.auth_mode !== 'oauth' || await remoteMcpOAuthStatus(db, orgId, server.id, account.ownerId);
      const available = offered.length > 0 && connected;
      const personalOAuthAccess = server.auth_mode === 'oauth' && connected && account.ownerId === String(githubId);
      const shared = server.auth_mode === 'oauth' && connected && account.ownerId !== String(githubId);
      const persistentSharedAgentAccess = shared && account.shareType === 'agent';
      const allowedTools = account.ownerId === String(githubId)
        ? await enabledToolNames(db, orgId, agentId, githubId, server.id, offered)
        : new Set();
      result.push({
        serverId: server.id,
        name: server.name,
        connectionOwnerId: server.auth_mode === 'oauth' ? account.ownerId : null,
        connectionOwnerName: shared ? account.ownerName : null,
        shared,
        shareType: account.shareType,
        available,
        requestEnabled: available && server.auth_mode === 'oauth' && (personalOAuthAccess || shared),
        personalOAuthAccess,
        enabled: available && (persistentSharedAgentAccess || grants.has(server.id) || offered.length > 0 && allowedTools.size === offered.length),
        tools: offered.map(tool => ({ name: tool._remote.toolName, title: tool.title || tool._remote.toolName,
          description: tool.description || '', inputSchema: tool.inputSchema,
          enabled: available && (persistentSharedAgentAccess || allowedTools.has(tool._remote.toolName)),
          requestEnabled: available && server.auth_mode === 'oauth' && (personalOAuthAccess || shared) && !tool._remote.requiresApproval,
          requiresApproval: tool._remote.requiresApproval })),
        readOnlyToolCount,
        needsOAuth: server.auth_mode === 'oauth' && !connected,
      });
    }
  }
  return result;
}

// Workflow definitions may use workspace-approved write tools only behind a
// one-time human approval. Keep this catalog separate from an Agent's
// read-only grants so adding it here never widens an Agent's standing access.
export async function workflowRemoteMcpConnections(db, { orgId, agentId, githubId }) {
  if (!orgId || !agentId || !githubId) return [];
  const [tools, agentConnections] = await Promise.all([
    remoteMcpTools(db, orgId, { workflowWritable: true }).catch(() => []),
    agentRemoteMcpConnections(db, { orgId, agentId, githubId }).catch(() => []),
  ]);
  const byServer = new Map();
  for (const tool of tools) {
    const id = tool?._remote?.serverId;
    if (id) byServer.set(id, [...(byServer.get(id) || []), tool]);
  }
  return agentConnections.filter(connection => !connection.shared || connection.shareType === 'agent').map(connection => {
    const offered = byServer.get(connection.serverId) || [];
    const granted = new Set((connection.tools || []).filter(tool => tool.enabled).map(tool => tool.name));
    return {
      serverId: connection.serverId,
      connectionOwnerId: connection.shared ? connection.connectionOwnerId : null,
      connectionOwnerName: connection.shared ? connection.connectionOwnerName : null,
      shareType: connection.shareType,
      name: connection.shared ? `${connection.name} · ${connection.connectionOwnerName || 'Shared by member'}` : connection.name,
      available: offered.length > 0 && connection.available,
      needsOAuth: connection.needsOAuth,
      tools: offered.map(tool => ({
        name: tool._remote.toolName,
        title: tool.title || tool._remote.toolName,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
        requiresApproval: tool._remote.requiresApproval === true,
        enabled: connection.available && granted.has(tool._remote.toolName),
      })),
    };
  });
}

// Workflow Agent turns may use only explicit Agent grants or connections the
// owner deliberately shared with this Agent. A requester's own one-off OAuth
// access in chat does not become a persistent Workflow connection.
export async function workflowAgentRemoteMcpTools(env, { orgId, agentId, session }) {
  const githubId = String(session?.github_id || '');
  if (!githubId || !await mayRunAgent(env.DB, orgId, { id: agentId }, githubId).catch(() => false)) return [];
  const [connections, tools] = await Promise.all([
    agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId }),
    remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []),
  ]);
  const offered = [];
  for (const connection of connections) {
    if (connection.shared && connection.shareType !== 'agent') continue;
    for (const tool of tools) {
      if (tool?._remote?.serverId !== connection.serverId
        || !connection.tools?.some(item => item.name === tool._remote.toolName && item.enabled)) continue;
      if (!connection.shared) offered.push(tool);
      else offered.push({
        ...tool,
        name: `${tool.name}__owner_${connection.connectionOwnerId}`.slice(0, 120),
        title: `${tool.title || tool.name} · ${connection.connectionOwnerName || 'Shared connection'}`.slice(0, 120),
        description: `${tool.description || ''} This OAuth connection was shared with this Agent; access is rechecked for each call.`.slice(0, 2_000),
        _remote: { ...tool._remote, connectionOwnerId: connection.connectionOwnerId },
      });
    }
  }
  return offered;
}

export async function setAgentRemoteMcpTool(env, { orgId, agentId, session, serverId, toolName, enabled }) {
  const id = String(serverId || '').trim(), name = String(toolName || '').trim();
  if (!id || id.length > 200 || !name || name.length > 200 || typeof enabled !== 'boolean')
    return { error: 'Choose a Remote MCP tool and whether to allow it.' };
  const githubId = String(session?.github_id || '');
  if (!githubId) return { error: 'Sign in again before changing this connection.', status: 401 };
  const offered = await remoteMcpTools(env.DB, orgId, { workflowWritable: true }).catch(() => []);
  const tool = offered.find(item => item?._remote?.serverId === id && item?._remote?.toolName === name);
  if (!tool) return { error: 'This Remote MCP tool is not currently enabled for Workflow use.', status: 409 };
  const current = await agentRemoteMcpConnections(env.DB, { orgId, agentId, githubId });
  if (!current.some(item => item.serverId === id && item.available)) return { error: 'This Remote MCP server or Agent is unavailable.', status: 409 };
  const at = new Date().toISOString();
  const legacy = await currentGrants(env.DB, orgId, agentId, githubId);
  const convert = legacy.has(id) ? offered.filter(item => item?._remote?.serverId === id && !item?._remote?.requiresApproval).map(item => env.DB.prepare(`
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
    if (!server?.available) return { error: 'This Remote MCP server has no workspace-approved tools.', status: 409 };
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

export async function agentRemoteMcpAuthorizationStamp(env, { orgId, agentId, session, serverId, toolName, connectionOwnerId = null }) {
  const githubId = String(session?.github_id || '');
  const ownerId = String(connectionOwnerId || githubId);
  if (!githubId || !ownerId || !orgId || !agentId || !serverId || !toolName) return null;
  try {
    const workspaceMode = await getMode(env.DB, orgId).catch(() => null);
    if (workspaceMode !== 'harness') return null;
    const [access, memberships, legacyGrant, toolGrants, server, credential, shares] = await Promise.all([
      env.DB.prepare("SELECT a.created_at,a.updated_at,a.deleted_at,a.scope,a.owner_login,p.access,p.people,p.updated_at AS profile_updated_at,COALESCE(x.version,0) AS access_version,x.mutation_id AS access_mutation,(SELECT json_group_array(json_object('user',r.user_id,'since',r.member_since,'role',r.role,'updatedAt',r.updated_at)) FROM hx_agent_members r WHERE r.org_id=a.org_id AND r.agent_id=a.id) AS agent_members FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id LEFT JOIN hx_agent_access x ON x.org_id=a.org_id AND x.agent_id=a.id WHERE a.org_id=?1 AND a.id=?2").bind(orgId, agentId).first(),
      env.DB.prepare("SELECT user_github_id,created_at,role FROM memberships WHERE org_id=?1 AND user_github_id IN (?2,?3) ORDER BY user_github_id").bind(orgId, githubId, ownerId).all(),
      env.DB.prepare("SELECT rowid AS generation,membership_since,created_at FROM hx_agent_remote_mcp_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND server_id=?4").bind(orgId, agentId, githubId, serverId).first(),
      env.DB.prepare("SELECT rowid AS generation,tool_name,membership_since,created_at FROM hx_agent_remote_mcp_tool_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3 AND server_id=?4 ORDER BY tool_name").bind(orgId, agentId, githubId, serverId).all(),
      env.DB.prepare("SELECT s.auth_mode,s.updated_at,s.allowed_tools,s.tools_json FROM hx_remote_mcp_servers s WHERE s.org_id=?1 AND s.id=?2").bind(orgId, serverId).first(),
      env.DB.prepare("SELECT rowid AS generation,c.membership_since,c.created_at FROM hx_remote_mcp_oauth_credentials c WHERE c.org_id=?1 AND c.server_id=?2 AND c.user_github_id=?3").bind(orgId, serverId, ownerId).first(),
      env.DB.prepare("SELECT set_row.version,set_row.owner_membership_since,set_row.mutation_id,sh.audience_type,sh.audience_id,sh.audience_membership_since,sh.created_at FROM hx_remote_mcp_oauth_share_sets set_row LEFT JOIN hx_remote_mcp_oauth_shares sh ON sh.org_id=set_row.org_id AND sh.server_id=set_row.server_id AND sh.owner_github_id=set_row.owner_github_id WHERE set_row.org_id=?1 AND set_row.server_id=?2 AND set_row.owner_github_id=?3 ORDER BY sh.audience_type,sh.audience_id").bind(orgId, serverId, ownerId).all(),
    ]);
    return JSON.stringify({
      orgId, agentId, githubId, serverId, toolName, ownerId, workspaceMode,
      access: access || null,
      memberships: memberships?.results || [],
      legacyGrant: legacyGrant || null,
      toolGrants: toolGrants?.results || [],
      server: server || null,
      credential: credential || null,
      shares: shares?.results || [],
    });
  } catch {
    return null;
  }
}

export async function mayUseAgentRemoteMcp(env, { orgId, agentId, session, serverId, toolName = null, connectionOwnerId = null }) {
  const githubId = String(session?.github_id || '');
  if (!githubId || !orgId || !agentId || !serverId) return false;
  if (!await mayRunAgent(env.DB, orgId, { id: agentId }, githubId).catch(() => false)) return false;
  const accountOwner = String(connectionOwnerId || githubId);
  if (accountOwner !== githubId) {
    if (toolName === null || await remoteMcpOAuthShareType(env.DB, {
      orgId, serverId, ownerId: accountOwner, requesterId: githubId, agentId,
    }) !== 'agent') return false;
    if (!await mayRunAgent(env.DB, orgId, { id: agentId }, accountOwner).catch(() => false)) return false;
    if (!await remoteMcpOAuthStatus(env.DB, orgId, serverId, accountOwner).catch(() => false)) return false;
  }
  const [grants, tools] = await Promise.all([
    currentGrants(env.DB, orgId, agentId, githubId).catch(() => new Set()),
    remoteMcpTools(env.DB, orgId, { workflowWritable: true }).catch(() => []),
  ]);
  const matching = tools.filter(tool => tool?._remote?.serverId === serverId && (!toolName || tool?._remote?.toolName === toolName)
    && (tool._remote.requiresApproval ? toolName !== null : true));
  if (!matching.length) return false;
  if (accountOwner !== githubId) return true;
  const specific = await enabledToolNames(env.DB, orgId, agentId, githubId, serverId, tools).catch(() => new Set());
  if (grants.has(serverId) && matching.every(tool => !tool._remote.requiresApproval)) return true;
  return matching.every(tool => specific.has(tool._remote.toolName));
}

export async function mayUseAgentRemoteMcpForRequest(env, { orgId, agentId, session, serverId, toolName, connectionOwnerId = null }) {
  if (await getMode(env.DB, orgId).catch(() => null) !== 'harness') return false;
  if (await mayUseAgentRemoteMcp(env, { orgId, agentId, session, serverId, toolName, connectionOwnerId })) return true;
  const githubId = String(session?.github_id || '');
  if (!githubId || !orgId || !agentId || !serverId || !toolName) return false;
  if (!await mayRunAgent(env.DB, orgId, { id: agentId }, githubId).catch(() => false)) return false;
  const [server, readOnlyTools] = await Promise.all([
    env.DB.prepare('SELECT auth_mode FROM hx_remote_mcp_servers WHERE org_id=?1 AND id=?2').bind(orgId, serverId).first().catch(() => null),
    remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []),
  ]);
  if (server?.auth_mode !== 'oauth' || !readOnlyTools.some(tool => tool?._remote?.serverId === serverId && tool?._remote?.toolName === toolName)) return false;
  const accountOwner = String(connectionOwnerId || githubId);
  if (accountOwner === githubId) return remoteMcpOAuthStatus(env.DB, orgId, serverId, githubId).catch(() => false);
  const shareType = await remoteMcpOAuthShareType(env.DB, { orgId, serverId, ownerId: accountOwner, requesterId: githubId, agentId });
  return Boolean(shareType && ['agent','member','workspace'].includes(shareType)
    && await remoteMcpOAuthStatus(env.DB, orgId, serverId, accountOwner).catch(() => false));
}

export async function agentRemoteMcpTools(env, { orgId, agentId, session }) {
  if (!session?.github_id || !await mayRunAgent(env.DB, orgId, { id: agentId }, session.github_id).catch(() => false)) return [];
  const connections = await agentRemoteMcpConnections(env.DB, {
    orgId, agentId, githubId: session?.github_id,
  });
  const tools = await remoteMcpTools(env.DB, orgId, { readOnlyOnly: true }).catch(() => []);
  const offered = [];
  for (const connection of connections) {
    const accountTools = tools.filter(tool => tool?._remote?.serverId === connection.serverId
      && (connection.requestEnabled || connection.tools?.some(item => item.name === tool._remote?.toolName && item.enabled)));
    for (const tool of accountTools) {
      const connectionOwnerId = connection.connectionOwnerId || String(session.github_id);
      const shared = connection.shared === true;
      offered.push(shared ? {
        ...tool,
        name: `${tool.name}__owner_${connectionOwnerId}`.slice(0, 120),
        title: `${tool.title || tool.name} · ${connection.connectionOwnerName || 'Shared connection'}`.slice(0, 120),
        description: `${tool.description || ''} This OAuth connection was shared by ${connection.connectionOwnerName || 'a workspace member'}; access is checked again when the tool runs.`.slice(0, 2_000),
        _remote: { ...tool._remote, connectionOwnerId },
      } : tool);
    }
  }
  return offered;
}

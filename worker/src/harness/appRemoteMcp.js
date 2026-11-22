import { remoteMcpTools, callRemoteMcpTool } from './remoteMcp.js';
import { agentRemoteMcpConnections } from './agentRemoteMcp.js';
import { sourceAgent, memberLogin, mayUseAppAsMember, mayUseSourceAgent } from './appConnectionGrants.js';

const err = (error, status = 400) => ({ error, status });
const refOf = (serverId, toolName) => JSON.stringify([serverId, toolName]);

async function currentTool(db, orgId, serverId, toolName) {
  return (await remoteMcpTools(db, orgId, { readOnlyOnly: true })).find(tool =>
    tool?._remote?.serverId === serverId && tool?._remote?.toolName === toolName) || null;
}

async function getGrant(db, orgId, appId, serverId, toolName) {
  return db.prepare(`SELECT owner_github_id AS ownerId,membership_since AS membershipSince,
      source_agent_id AS sourceAgentId,created_at AS createdAt,COALESCE(grant_id,created_at) AS generation,granted_by AS grantedBy
    FROM hx_app_remote_mcp_grants WHERE org_id=?1 AND app_id=?2 AND server_id=?3 AND tool_name=?4`)
    .bind(orgId, appId, serverId, toolName).first();
}

async function getViewerGrant(db, orgId, appId, viewerId, serverId, toolName) {
  return db.prepare(`SELECT user_github_id AS ownerId,membership_since AS membershipSince,
      created_at AS createdAt,grant_id AS generation,granted_by AS grantedBy
    FROM hx_app_remote_mcp_viewer_grants
    WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3 AND server_id=?4 AND tool_name=?5`)
    .bind(orgId, appId, String(viewerId), serverId, toolName).first();
}

export async function appRemoteMcpViewerGrantAllowed(db, orgId, appId, viewerId, serverId, toolName, grantId) {
  if (!grantId || !await mayUseAppAsMember(db, orgId, appId, viewerId)) return false;
  const [member, grant, tool] = await Promise.all([
    memberLogin(db, orgId, viewerId),
    getViewerGrant(db, orgId, appId, viewerId, serverId, toolName),
    currentTool(db, orgId, serverId, toolName),
  ]);
  return Boolean(member && grant && grant.ownerId === String(viewerId)
    && grant.membershipSince === member.membershipSince && grant.generation === grantId && tool);
}

export async function appRemoteMcpForViewer(db, orgId, appId, viewerId) {
  if (!await mayUseAppAsMember(db, orgId, appId, viewerId)) return err('No such app.', 404);
  const source = await sourceAgent(db, orgId, appId);
  const sourceAccess = Boolean(source && await mayUseSourceAgent(db, orgId, source, viewerId));
  const [offered, directGrants, legacyGrants, actor] = await Promise.all([
    remoteMcpTools(db, orgId, { readOnlyOnly: true }),
    db.prepare(`SELECT server_id AS serverId,tool_name AS toolName
      FROM hx_app_remote_mcp_viewer_grants WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3`)
      .bind(orgId, appId, String(viewerId)).all(),
    sourceAccess ? db.prepare(`SELECT server_id AS serverId,tool_name AS toolName,owner_github_id AS ownerId,membership_since AS membershipSince
      FROM hx_app_remote_mcp_grants WHERE org_id=?1 AND app_id=?2 AND source_agent_id=?3`)
      .bind(orgId, appId, source.id).all() : Promise.resolve({ results: [] }),
    memberLogin(db, orgId, viewerId),
  ]);
  const direct = new Set((directGrants.results || []).map(row => refOf(row.serverId, row.toolName)));
  const { results: memberships = [] } = await db.prepare(`SELECT user_github_id AS ownerId,created_at AS membershipSince
    FROM memberships WHERE org_id=?1 AND LOWER(TRIM(COALESCE(role,'guest')))!='guest'`)
    .bind(orgId).all();
  const active = new Set(memberships.map(row => `${row.ownerId}:${row.membershipSince}`));
  const legacy = new Map((legacyGrants.results || []).filter(row => active.has(`${row.ownerId}:${row.membershipSince}`))
    .map(row => [refOf(row.serverId, row.toolName), row]));
  const agentConnections = sourceAccess ? await agentRemoteMcpConnections(db, { orgId, agentId: source.id, githubId: viewerId }) : [];
  const activeAgentTools = new Set(agentConnections.flatMap(server => (server.tools || []).filter(tool => tool.enabled).map(tool => refOf(server.serverId, tool.name))));
  const tools = [];
  for (const tool of offered) {
    const ref = tool._remote;
    const key = refOf(ref.serverId, ref.toolName);
    const oldGrant = legacy.get(key);
    let legacyAllowed = false;
    if (oldGrant && sourceAccess) {
      const ownerAccess = await mayUseSourceAgent(db, orgId, source, oldGrant.ownerId);
      if (ownerAccess) {
        const ownerTools = await agentRemoteMcpConnections(db, { orgId, agentId: source.id, githubId: oldGrant.ownerId });
        legacyAllowed = ownerTools.find(server => server.serverId === ref.serverId)?.tools?.some(item => item.name === ref.toolName && item.enabled) === true;
      }
    }
    const directAllowed = direct.has(key);
    tools.push({ serverId: ref.serverId, toolName: ref.toolName, title: tool.title, description: tool.description,
      inputSchema: tool.inputSchema, granted: directAllowed || legacyAllowed, canGrant: Boolean(actor),
      grantedByYou: directAllowed || oldGrant?.ownerId === String(viewerId) });
  }
  return { sourceAgent: source ? { id: source.id, name: source.name || source.id } : null, tools };
}

export async function changeAppRemoteMcpGrant(db, orgId, appId, actorId, input) {
  const serverId = String(input?.serverId || ''), toolName = String(input?.toolName || '');
  if (!['grant', 'revoke'].includes(input?.action) || !serverId || serverId.length > 200 || !toolName || toolName.length > 200)
    return err('Choose a Remote MCP tool and grant or revoke App access.');
  if (!await mayUseAppAsMember(db, orgId, appId, actorId)) return err('No such app.', 404);
  const actor = await memberLogin(db, orgId, actorId);
  if (!actor) return err('Only a current workspace member can manage this App tool grant.', 403);
  if (input.action === 'revoke') {
    await db.prepare(`DELETE FROM hx_app_remote_mcp_viewer_grants WHERE org_id=?1 AND app_id=?2 AND user_github_id=?3 AND server_id=?4 AND tool_name=?5`)
      .bind(orgId, appId, String(actorId), serverId, toolName).run();
    await db.prepare(`DELETE FROM hx_app_remote_mcp_grants WHERE org_id=?1 AND app_id=?2 AND owner_github_id=?3 AND server_id=?4 AND tool_name=?5`)
      .bind(orgId, appId, String(actorId), serverId, toolName).run();
    return { revoked: true };
  }
  const tool = await currentTool(db, orgId, serverId, toolName);
  if (!tool) return err('This tool is not currently approved for read-only use.', 409);
  const at = new Date().toISOString();
  const grantId = crypto.randomUUID();
  if (!await mayUseAppAsMember(db, orgId, appId, actorId)) return err('No current access to this App.', 403);
  await db.prepare(`INSERT INTO hx_app_remote_mcp_viewer_grants
      (org_id,app_id,user_github_id,membership_since,server_id,tool_name,granted_by,created_at,grant_id)
    SELECT ?1,?2,?3,?4,?5,?6,?3,?7,?8 WHERE EXISTS(
      SELECT 1 FROM memberships m JOIN hx_apps a ON a.org_id=m.org_id AND a.id=?2
      LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id
      LEFT JOIN hx_app_person_access person ON person.org_id=a.org_id AND person.app_id=a.id AND person.user_github_id=m.user_github_id
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND m.created_at=?4 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
        AND a.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones d WHERE d.org_id=?1)
        AND (a.created_by=?3 OR person.permission IN ('view','edit')
          OR (person.user_github_id IS NULL AND COALESCE(p.visibility,'workspace')='workspace')
          OR (person.user_github_id IS NULL AND p.room_channel IS NOT NULL AND EXISTS(
            SELECT 1 FROM businesses b JOIN users u ON u.github_id=m.user_github_id
            WHERE b.org_id=?1 AND 'b:'||b.slug=p.room_channel
              AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.org_id=?1 AND cm.channel=p.room_channel AND cm.login=u.login)))))
        )
    ON CONFLICT(org_id,app_id,user_github_id,server_id,tool_name) DO UPDATE SET
      membership_since=excluded.membership_since,granted_by=excluded.granted_by,created_at=excluded.created_at,grant_id=excluded.grant_id`)
    .bind(orgId, appId, String(actorId), actor.membershipSince, serverId, toolName, at, grantId).run();
  const grant = await getViewerGrant(db, orgId, appId, actorId, serverId, toolName);
  if (!grant || grant.createdAt !== at || grant.generation !== grantId || !await mayUseAppAsMember(db, orgId, appId, actorId))
    return err('App or membership access changed. Reload and try again.', 409);
  return { granted: true };
}

export async function invokeAppRemoteMcp(env, orgId, appId, viewerId, input) {
  const serverId = String(input?.serverId || ''), toolName = String(input?.toolName || '');
  if (!serverId || serverId.length > 200 || !toolName || toolName.length > 200 || !input?.args || typeof input.args !== 'object' || Array.isArray(input.args))
    return err('Choose a Remote MCP tool and valid arguments.');
  if (JSON.stringify(input.args).length > 64_000) return err('Tool arguments are too large.');
  if (!await mayUseAppAsMember(env.DB, orgId, appId, viewerId)) return err('No such app.', 404);
  const directGrant = await getViewerGrant(env.DB, orgId, appId, viewerId, serverId, toolName);
  if (directGrant) {
    const owner = await memberLogin(env.DB, orgId, viewerId);
    const tool = await currentTool(env.DB, orgId, serverId, toolName);
    if (!owner || owner.membershipSince !== directGrant.membershipSince || !tool
      || !await appRemoteMcpViewerGrantAllowed(env.DB, orgId, appId, viewerId, serverId, toolName, directGrant.generation))
      return err('This App tool grant or membership is no longer active.', 403);
    const pseudoAgent = { orgId, githubId: String(viewerId), login: owner.login, name: owner.name || owner.login, agentName: 'App' };
    const authorization = { kind: 'app', appId, viewerId: String(viewerId), toolName, grantId: directGrant.generation };
    const result = await callRemoteMcpTool(env, pseudoAgent, tool, input.args, { readOnlyOnly: true, authorization });
    if (!await appRemoteMcpViewerGrantAllowed(env.DB, orgId, appId, viewerId, serverId, toolName, directGrant.generation))
      return err('App, tool, or membership access changed during execution; the result was discarded.', 403);
    return { data: result };
  }
  const source = await sourceAgent(env.DB, orgId, appId);
  if (!source || !await mayUseSourceAgent(env.DB, orgId, source, viewerId)) return err('No current access to the source Agent.', 403);
  const grant = await getGrant(env.DB, orgId, appId, serverId, toolName);
  if (!grant || grant.sourceAgentId !== source.id) return err('This tool has not been shared with this App.', 403);
  const owner = await memberLogin(env.DB, orgId, grant.ownerId);
  if (!owner || owner.membershipSince !== grant.membershipSince || !await mayUseSourceAgent(env.DB, orgId, source, grant.ownerId)) return err('The connection owner no longer has access.', 403);
  const tool = await currentTool(env.DB, orgId, serverId, toolName);
  const agentGrant = await agentRemoteMcpConnections(env.DB, { orgId, agentId: source.id, githubId: grant.ownerId });
  if (!tool || !agentGrant.find(item => item.serverId === serverId)?.tools?.some(item => item.name === toolName && item.enabled)) return err('The source Agent’s read-only access was revoked.', 403);
  const pseudoAgent = { orgId, githubId: grant.ownerId, login: owner.login, name: source.name || source.id, agentName: source.name || source.id };
  const result = await callRemoteMcpTool(env, pseudoAgent, tool, input.args, { readOnlyOnly: true, authorization: {
    kind: 'app', agentId: source.id, toolName, appId, viewerId,
  } });
  const [appStillAccessible, sourceAfter, sourceStillAccessible, grantAfter, ownerAfter, toolAfter, agentAfter] = await Promise.all([
    mayUseAppAsMember(env.DB, orgId, appId, viewerId),
    sourceAgent(env.DB, orgId, appId),
    mayUseSourceAgent(env.DB, orgId, source, viewerId),
    getGrant(env.DB, orgId, appId, serverId, toolName),
    memberLogin(env.DB, orgId, grant.ownerId),
    currentTool(env.DB, orgId, serverId, toolName),
    agentRemoteMcpConnections(env.DB, { orgId, agentId: source.id, githubId: grant.ownerId }),
  ]);
  if (!appStillAccessible || sourceAfter?.id !== source.id || !sourceStillAccessible || !grantAfter || grantAfter.generation !== grant.generation ||
      !ownerAfter || ownerAfter.membershipSince !== grant.membershipSince || !toolAfter ||
      !agentAfter.find(item => item.serverId === serverId)?.tools?.some(item => item.name === toolName && item.enabled))
    return err('App, Agent, tool, or owner access changed during execution; the result was discarded.', 403);
  return { data: result };
}

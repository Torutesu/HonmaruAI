import { getMode } from './mode.js';
import { remoteMcpTools } from './remoteMcp.js';

const safeJSON = value => { try { return JSON.parse(value); } catch { return null; } };

export async function workflowRemoteMcpAuthorizationStamp(env, { orgId, workflowId, actorId, offered, requiresApproval = false }) {
  try {
    const ref = offered?._remote;
    if (!ref?.serverId || !ref?.toolName || !offered?.name || !orgId || !workflowId || !actorId
      || await getMode(env.DB, orgId).catch(() => null) !== 'harness') return null;
    const canonicalTools = await remoteMcpTools(env.DB, orgId, { workflowWritable: true });
    const canonical = canonicalTools.find(tool => tool?._remote?.serverId === ref.serverId
      && tool?._remote?.toolName === ref.toolName
      && Boolean(tool?._remote?.requiresApproval) === Boolean(requiresApproval));
    if (!canonical || canonical.name !== offered.name || ref.connectionOwnerId) return null;
    const row = await env.DB.prepare(`SELECT w.created_by AS workflowOwnerId,w.updated_at AS workflowUpdatedAt,
        g.generation AS grantGeneration,g.created_at AS grantCreatedAt,g.granted_by AS grantedBy,
        s.auth_mode AS authMode,s.updated_at AS serverUpdatedAt,s.allowed_tools AS allowedTools,
        s.write_tools AS writeTools,s.tools_json AS toolsJson,actor.created_at AS actorMembershipSince,
        maker.created_at AS ownerMembershipSince,os.updated_at AS modeUpdatedAt
      FROM hx_workflows w
      JOIN hx_workflow_remote_mcp_tool_grants g ON g.org_id=w.org_id AND g.workflow_id=w.id
        AND g.server_id=?3 AND g.tool_name=?4
      JOIN hx_remote_mcp_servers s ON s.org_id=g.org_id AND s.id=g.server_id
      JOIN memberships actor ON actor.org_id=w.org_id AND actor.user_github_id=?5
        AND LOWER(TRIM(COALESCE(actor.role,'guest')))!='guest'
      JOIN memberships maker ON maker.org_id=w.org_id AND maker.user_github_id=w.created_by
        AND LOWER(TRIM(COALESCE(maker.role,'guest')))!='guest'
      JOIN org_settings os ON os.org_id=w.org_id AND os.mode='harness'
      WHERE w.org_id=?1 AND w.id=?2 AND s.auth_mode='headers'
        AND EXISTS(SELECT 1 FROM json_each(s.allowed_tools) a WHERE a.value=?4)
      LIMIT 1`).bind(orgId, workflowId, ref.serverId, ref.toolName, String(actorId)).first();
    if (!row) return null;
    const toolDescriptor = (safeJSON(row.toolsJson) || []).find(item => item?.name === ref.toolName);
    if (!toolDescriptor) return null;
    return JSON.stringify({ orgId, workflowId, actorId: String(actorId), workflowOwnerId: String(row.workflowOwnerId),
      workflowUpdatedAt: row.workflowUpdatedAt, serverId: ref.serverId, toolName: ref.toolName,
      grantGeneration: row.grantGeneration, grantCreatedAt: row.grantCreatedAt, grantedBy: row.grantedBy,
      authMode: row.authMode, serverUpdatedAt: row.serverUpdatedAt, allowedTools: row.allowedTools,
      writeTools: row.writeTools, toolsJson: row.toolsJson, actorMembershipSince: row.actorMembershipSince,
      ownerMembershipSince: row.ownerMembershipSince, modeUpdatedAt: row.modeUpdatedAt,
      requiresApproval: Boolean(requiresApproval) });
  } catch { return null; }
}

export async function workflowRemoteMcpAllowed(env, identity) {
  return Boolean(await workflowRemoteMcpAuthorizationStamp(env, identity));
}

export function workflowRemoteMcpCheckpointFence(stamp) {
  try {
    const v = JSON.parse(stamp);
    if (![v.orgId,v.workflowId,v.workflowOwnerId,v.actorId,v.actorMembershipSince,v.ownerMembershipSince,
      v.serverId,v.toolName,v.grantGeneration,v.grantCreatedAt,v.workflowUpdatedAt,v.serverUpdatedAt,v.modeUpdatedAt].every(x => typeof x === 'string' && x.length > 0)) return null;
    return { ...v };
  } catch { return null; }
}

export function workflowRemoteMcpStepDeclarations(steps) {
  const result = new Map();
  for (const step of steps || []) if (step?.type === 'connection' && step.source === 'remote_mcp' && !step.agentId) {
    const key = JSON.stringify([step.serverId, step.toolName]);
    result.set(key, { serverId: step.serverId, toolName: step.toolName });
  }
  return [...result.values()];
}

export async function listWorkflowRemoteMcpCatalog(db, orgId) {
  const tools = await remoteMcpTools(db, orgId, { workflowWritable: true }).catch(() => []);
  const { results = [] } = await db.prepare('SELECT id,name,auth_mode AS authMode FROM hx_remote_mcp_servers WHERE org_id=?1').bind(orgId).all();
  const names = new Map(results.map(row => [row.id, row]));
  const groups = new Map();
  for (const tool of tools) {
    const ref = tool?._remote;
    if (!ref?.serverId || !ref?.toolName || names.get(ref.serverId)?.authMode !== 'headers') continue;
    const group = groups.get(ref.serverId) || { serverId: ref.serverId, name: names.get(ref.serverId).name, available: true, tools: [] };
    group.tools.push({ name: ref.toolName, title: tool.title, description: tool.description,
      inputSchema: tool.inputSchema, enabled: true, requiresApproval: Boolean(ref.requiresApproval) });
    groups.set(ref.serverId, group);
  }
  for (const [id, server] of names) if (server.authMode === 'oauth') groups.set(id, {
    serverId: id, name: server.name, available: false, needsOAuth: true, tools: [],
  });
  return [...groups.values()];
}

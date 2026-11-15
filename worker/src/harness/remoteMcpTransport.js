import { allowed } from '../permissions.js';
import { remoteMcpEgressRequest } from './remoteMcpEgress.js';

const ONLINE_WINDOW_MS = 90_000;

/**
 * Dispatch one Remote MCP/OAuth HTTP exchange through the Gateway explicitly
 * assigned to this workspace connection. There is deliberately no Worker
 * fetch fallback: an offline or revoked node must stop the request.
 */
export async function remoteMcpFetch(env, { orgId, serverId, actorId, authorization = null }, request) {
  const id = String(actorId || '');
  if (!orgId || !serverId || !id || !env.DATA_KEY) {
    throw new Error('A connected Remote MCP gateway and workspace encryption are required.');
  }
  const principal = await env.DB.prepare(`SELECT m.created_at AS membershipSince
    FROM memberships m
    WHERE m.org_id=?1 AND m.user_github_id=?2 AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'`)
    .bind(orgId, id).first();
  if (!principal) throw new Error('A current workspace member account is required for Remote MCP access.');
  const row = await env.DB.prepare(`SELECT s.egress_gateway_id AS gatewayId, g.last_seen_at AS lastSeenAt, g.created_by AS gatewayOwner
    FROM hx_remote_mcp_servers s JOIN hx_gateways g ON g.org_id=s.org_id AND g.id=s.egress_gateway_id
    WHERE s.org_id=?1 AND s.id=?2 AND g.revoked_at IS NULL`)
    .bind(orgId, serverId).first();
  if (!row?.gatewayId) throw new Error('Choose a trusted, connected Gateway for this Remote MCP server before using it.');
  if (!Number.isFinite(Number(row.lastSeenAt)) || Number(row.lastSeenAt) < Date.now() - ONLINE_WINDOW_MS) {
    throw new Error('The selected Remote MCP Gateway is offline. Reconnect it; direct network fallback is disabled.');
  }
  if (!await allowed(env.DB, orgId, row.gatewayOwner, 'workspace.mode')) {
    throw new Error('The selected Remote MCP Gateway owner no longer has workspace access.');
  }
  const response = await remoteMcpEgressRequest(env, {
    orgId,
    serverId,
    actorId: id,
    membershipSince: principal.membershipSince,
    authorization,
  }, request);
  if (response?.error) throw new Error('The assigned Gateway could not complete the Remote MCP request.');
  return response;
}

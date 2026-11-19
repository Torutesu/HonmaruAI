import { aad, openField, sealField, useSecretKey } from "../secrets.js";
import { allowed } from "../permissions.js";

const REQUEST_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 1_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30_000;
const LEASE_MS = 35_000;
const RETAIN_MS = 2 * 60_000;
const NODE_ONLINE_MS = 90_000;
const enc = new TextEncoder();
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
});
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
const sha256 = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(value)))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");

function egressAad(row, field) { return aad.remoteMcpEgress(row.org_id, row.id, field); }

function safeUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || !hostname.includes(".") || !/^[a-z0-9.-]+$/.test(hostname)
      || hostname.includes("..") || /^[0-9.]+$/.test(hostname) || hostname.includes(":")
      || /(^|\.)(localhost|local|internal|home\.arpa|lan|test|invalid|example|onion)$/.test(hostname)) return null;
  url.hostname = hostname;
  url.port = "";
  return url.toString();
}

function cleanRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid Remote MCP egress request.");
  const keys = Object.keys(request);
  if (keys.some((key) => !["url", "method", "headers", "body", "timeoutMs", "authorization"].includes(key))) throw new Error("Invalid Remote MCP egress request.");
  const url = safeUrl(request.url);
  const method = String(request.method || "GET").toUpperCase();
  if (!url || !["GET", "POST"].includes(method)) throw new Error("Remote MCP egress requires a public HTTPS URL and GET or POST method.");
  if (!Array.isArray(request.headers) || request.headers.length > 20) throw new Error("Invalid Remote MCP egress headers.");
  const names = new Set();
  const headers = request.headers.map((entry) => {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const value = typeof entry?.value === "string" ? entry.value : "";
    const key = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
        ["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization"].includes(key) ||
        names.has(key) || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid Remote MCP egress headers.");
    names.add(key);
    return { name, value };
  });
  const body = request.body == null ? null : String(request.body);
  if (body != null && enc.encode(body).byteLength > REQUEST_LIMIT) throw new Error("Remote MCP egress request is too large.");
  let authorization;
  if (request.authorization !== undefined) {
    const value = request.authorization;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["kind", "agentId", "toolName", "appId", "viewerId", "connectionOwnerId"].includes(key))) throw new Error("Invalid Remote MCP egress authorization context.");
    const kind = value.kind || (typeof value.agentId === "string" && typeof value.toolName === "string" ? "agent" : "member");
    if (kind !== "admin" && kind !== "member" && kind !== "agent" && kind !== "agent-request" && kind !== "app") throw new Error("Invalid Remote MCP egress authorization context.");
    authorization = {
      kind,
      ...(typeof value.agentId === "string" && value.agentId.length <= 200 ? { agentId: value.agentId } : {}),
      ...(typeof value.toolName === "string" && value.toolName.length <= 200 ? { toolName: value.toolName } : {}),
      ...(typeof value.appId === "string" && value.appId.length <= 200 ? { appId: value.appId } : {}),
      ...(typeof value.viewerId === "string" && value.viewerId.length <= 200 ? { viewerId: value.viewerId } : {}),
      ...(typeof value.connectionOwnerId === "string" && value.connectionOwnerId.length <= 200 ? { connectionOwnerId: value.connectionOwnerId } : {}),
    };
    if ((authorization.kind === "agent" || authorization.kind === "agent-request") && (!authorization.agentId || !authorization.toolName)) throw new Error("Agent egress requires an exact Agent and tool authorization.");
    if (authorization.kind === "app" && (!authorization.appId || !authorization.viewerId)) throw new Error("App egress requires a current App viewer.");
  }
  const timeoutMs = Number.isInteger(request.timeoutMs) ? Math.max(1_000, Math.min(request.timeoutMs, MAX_TIMEOUT_MS)) : DEFAULT_TIMEOUT_MS;
  const cleaned = { url, method, headers, body, timeoutMs, ...(authorization ? { authorization } : {}) };
  if (enc.encode(JSON.stringify(cleaned)).byteLength > REQUEST_LIMIT) throw new Error("Remote MCP egress request is too large.");
  return cleaned;
}

function cleanResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Remote MCP egress response.");
  if (value.error !== undefined) {
    if (typeof value.error !== "string" || !value.error.trim() || value.error.length > 300) throw new Error("Invalid Remote MCP egress error.");
    return { error: value.error };
  }
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599 || typeof value.body !== "string") throw new Error("Invalid Remote MCP egress response.");
  if (enc.encode(value.body).byteLength > RESPONSE_LIMIT) throw new Error("Remote MCP egress response is too large.");
  const headers = {};
  if (value.headers != null) {
    if (typeof value.headers !== "object" || Array.isArray(value.headers) || Object.keys(value.headers).some((name) => !["content-type", "mcp-session-id", "www-authenticate"].includes(name.toLowerCase()))) throw new Error("Invalid Remote MCP egress response headers.");
    for (const [name, valueText] of Object.entries(value.headers)) {
      if (typeof valueText !== "string" || valueText.length > 4096 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(valueText)) throw new Error("Invalid Remote MCP egress response headers.");
      headers[name.toLowerCase()] = valueText;
    }
  }
  return { status: value.status, headers, body: value.body };
}

async function authorizationStillValid(db, row, authorization = null) {
  try {
    const member = await db.prepare(`SELECT role,created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2`)
      .bind(row.org_id, row.actor_id).first();
    if (!member || member.created_at !== row.membership_since || String(member.role || "guest").trim().toLowerCase() === "guest") return false;
    const server = await db.prepare(`SELECT egress_gateway_id FROM hx_remote_mcp_servers WHERE org_id=?1 AND id=?2`)
      .bind(row.org_id, row.server_id).first();
    if (!server || server.egress_gateway_id !== row.gateway_id) return false;
    const gateway = await db.prepare(`SELECT id,created_by,revoked_at,last_seen_at FROM hx_gateways WHERE org_id=?1 AND id=?2`)
      .bind(row.org_id, row.gateway_id).first();
    if (!gateway || gateway.revoked_at != null) return false;
    const ownerStillAdmin = await allowed(db, row.org_id, String(gateway.created_by), "workspace.mode").catch(() => false);
    if (!ownerStillAdmin) return false;
    if (authorization?.kind === "admin" && !await allowed(db, row.org_id, row.actor_id, "workspace.mode").catch(() => false)) return false;
    if ((authorization?.kind === "agent" || authorization?.kind === "agent-request" || authorization?.kind === "app" || authorization?.agentId) && authorization.agentId && authorization.toolName) {
      const gate = authorization.kind === "agent-request" ? "mayUseAgentRemoteMcpForRequest" : "mayUseAgentRemoteMcp";
      const module = await import("./agentRemoteMcp.js");
      if (!await module[gate]({ DB: db }, {
        orgId: row.org_id,
        agentId: authorization.agentId,
        session: { github_id: row.actor_id },
        serverId: row.server_id,
        toolName: authorization.toolName,
        connectionOwnerId: authorization.connectionOwnerId || null,
      }).catch(() => false)) return false;
    }
    if (authorization?.kind === "app" && authorization.appId && authorization.viewerId) {
      const { mayUseAppAsMember } = await import("./appConnectionGrants.js");
      if (!await mayUseAppAsMember(db, row.org_id, authorization.appId, authorization.viewerId).catch(() => false)) return false;
    }
    return true;
  } catch { return false; }
}

async function openRequest(env, row) {
  const raw = await openField(row.request, egressAad(row, "request"));
  if (!raw) return null;
  try { return cleanRequest(JSON.parse(raw)); } catch { return null; }
}

async function openResponse(env, row) {
  const raw = await openField(row.response, egressAad(row, "response"));
  if (!raw) return null;
  try { return cleanResponse(JSON.parse(raw)); } catch { return null; }
}

async function loadGateway(db, gatewayId, orgId, at, { requireOnline = true } = {}) {
  const row = await db.prepare(`SELECT id,org_id,created_by,revoked_at,last_seen_at FROM hx_gateways WHERE org_id=?1 AND id=?2`)
    .bind(orgId, gatewayId).first();
  if (!row || row.revoked_at != null || (requireOnline && (!Number.isFinite(Number(row.last_seen_at)) || Number(row.last_seen_at) < at - NODE_ONLINE_MS))) return null;
  if (!await allowed(db, orgId, String(row.created_by), "workspace.mode").catch(() => false)) return null;
  return row;
}

/// Create an encrypted, single-use request and wait for the assigned Gateway.
/// `authorization` is optional, non-secret context used to recheck
/// Agent/App grants at claim, completion and response-read time.
export async function remoteMcpEgressRequest(env, { orgId, serverId, actorId, authorization = null }, request) {
  if (!env?.DATA_KEY) throw new Error("Workspace encryption is required for Remote MCP egress.");
  if (!orgId || !serverId || !actorId) throw new Error("Remote MCP egress needs an active workspace member.");
  useSecretKey(env);
  const cleaned = cleanRequest({ ...request, ...(authorization ? { authorization } : {}) });
  const at = now();
  const member = await env.DB.prepare(`SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(TRIM(COALESCE(role,'guest')))!='guest'`)
    .bind(orgId, String(actorId)).first();
  if (!member) throw new Error("Remote MCP access requires a current workspace member.");
  const server = await env.DB.prepare(`SELECT egress_gateway_id FROM hx_remote_mcp_servers WHERE org_id=?1 AND id=?2`)
    .bind(orgId, serverId).first();
  if (!server?.egress_gateway_id) throw new Error("Assign a trusted execution node to this Remote MCP server before connecting it.");
  const gateway = await loadGateway(env.DB, server.egress_gateway_id, orgId, at);
  if (!gateway) throw new Error("The assigned Remote MCP execution node is offline or no longer authorized.");
  await expireRemoteMcpEgress(env.DB, orgId, at);
  if (authorization?.kind === "admin" && !await allowed(env.DB, orgId, String(actorId), "workspace.mode").catch(() => false)) {
    throw new Error("Only a workspace administrator can perform this Remote MCP operation.");
  }
  if (!await authorizationStillValid(env.DB, {
    org_id: orgId, server_id: serverId, gateway_id: gateway.id, actor_id: String(actorId), membership_since: member.created_at,
  }, authorization)) throw new Error("Remote MCP access changed before the request was queued.");
  const id = uuid();
  const row = { id, org_id: orgId, server_id: serverId, gateway_id: gateway.id, actor_id: String(actorId), membership_since: member.created_at };
  const requestSealed = await sealField(JSON.stringify(cleaned), egressAad(row, "request"), orgId);
  if (requestSealed === JSON.stringify(cleaned)) throw new Error("Workspace encryption is required for Remote MCP egress.");
  const timeoutMs = Math.min(cleaned.timeoutMs, MAX_TIMEOUT_MS);
  const deadline = at + timeoutMs;
  const expires = deadline + RETAIN_MS;
  await env.DB.prepare(`INSERT INTO hx_remote_mcp_egress
    (id,org_id,server_id,gateway_id,actor_id,membership_since,request,response,status,lease_hash,lease_until,deadline,created_at,finished_at,expires_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,'queued',NULL,NULL,?8,?9,NULL,?10)`)
    .bind(id, orgId, serverId, gateway.id, String(actorId), member.created_at, requestSealed, deadline, at, expires).run();
  try {
    while (now() < deadline) {
      const rowNow = await env.DB.prepare(`SELECT * FROM hx_remote_mcp_egress WHERE org_id=?1 AND id=?2 AND server_id=?3 AND gateway_id=?4 AND actor_id=?5`)
        .bind(orgId, id, serverId, gateway.id, String(actorId)).first();
      if (!rowNow) throw new Error("Remote MCP egress request expired.");
      if (["cancelled", "failed"].includes(rowNow.status)) throw new Error("The assigned Remote MCP execution node could not complete the request.");
      if (rowNow.status === "succeeded") {
        const currentRequest = await openRequest(env, rowNow);
        if (!currentRequest || !await authorizationStillValid(env.DB, rowNow, currentRequest.authorization)) throw new Error("Remote MCP access changed while the request was running.");
        const response = await openResponse(env, rowNow);
        if (!response) throw new Error("The Remote MCP response could not be opened.");
        return response;
      }
      if (!await authorizationStillValid(env.DB, rowNow, authorization)) {
        await env.DB.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?3,expires_at=?4
          WHERE org_id=?1 AND id=?2 AND status IN ('queued','running')`).bind(orgId, id, now(), now() + RETAIN_MS).run();
        throw new Error("Remote MCP access changed while the request was running.");
      }
      const activeGateway = await loadGateway(env.DB, gateway.id, orgId, now());
      if (!activeGateway) throw new Error("The assigned Remote MCP execution node went offline or was revoked.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await env.DB.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?3,expires_at=?4
      WHERE org_id=?1 AND id=?2 AND status IN ('queued','running')`).bind(orgId, id, now(), now() + RETAIN_MS).run();
    throw new Error("Remote MCP request timed out while waiting for the assigned execution node.");
  } catch (error) {
    await env.DB.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?3,expires_at=?4
      WHERE org_id=?1 AND id=?2 AND status IN ('queued','running')`).bind(orgId, id, now(), now() + RETAIN_MS).run().catch(() => {});
    throw error;
  }
}

export async function claimRemoteMcpEgress(db, env, gateway, { at = now() } = {}) {
  if (!env?.DATA_KEY || !gateway?.id || !gateway?.org_id) return null;
  useSecretKey(env);
  const current = await loadGateway(db, gateway.id, gateway.org_id, at);
  if (!current) return null;
  const lease = secret();
  const row = await db.prepare(`UPDATE hx_remote_mcp_egress SET status='running',lease_hash=?3,lease_until=MIN(?2+?4,deadline)
    WHERE org_id=?1 AND id=(SELECT e.id FROM hx_remote_mcp_egress e
      JOIN hx_remote_mcp_servers s ON s.org_id=e.org_id AND s.id=e.server_id AND s.egress_gateway_id=e.gateway_id
      JOIN memberships m ON m.org_id=e.org_id AND m.user_github_id=e.actor_id AND m.created_at=e.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
      WHERE e.org_id=?1 AND e.gateway_id=?5 AND e.status='queued' AND e.deadline>?2 AND e.expires_at>?2
      ORDER BY e.created_at,e.id LIMIT 1)
      AND gateway_id=?5 AND status='queued' AND deadline>?2 AND expires_at>?2
      AND EXISTS(SELECT 1 FROM hx_gateways g WHERE g.org_id=?1 AND g.id=?5 AND g.revoked_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM hx_remote_mcp_egress active WHERE active.org_id=?1 AND active.gateway_id=?5 AND active.status='running')
    RETURNING *`).bind(gateway.org_id, at, await sha256(lease), LEASE_MS, gateway.id).first();
  if (!row) return null;
  const request = await openRequest(env, row);
  if (!request || !await authorizationStillValid(db, row, request.authorization)) {
    await db.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?4,expires_at=?5
      WHERE org_id=?1 AND id=?2 AND gateway_id=?3 AND status='running' AND lease_hash=?6`)
      .bind(row.org_id, row.id, row.gateway_id, at, at + RETAIN_MS, await sha256(lease)).run();
    return null;
  }
  return { id: row.id, lease, request, timeoutMs: Math.max(1_000, Math.min(Number(row.deadline) - at, MAX_TIMEOUT_MS)) };
}

export async function heartbeatRemoteMcpEgress(db, env, gateway, { jobId, lease, at = now() }) {
  if (!env?.DATA_KEY || typeof jobId !== "string" || typeof lease !== "string") return false;
  useSecretKey(env);
  const row = await db.prepare(`SELECT * FROM hx_remote_mcp_egress WHERE org_id=?1 AND id=?2 AND gateway_id=?3 AND status='running' AND lease_hash=?4 AND lease_until>?5 AND deadline>?5`)
    .bind(gateway.org_id, jobId, gateway.id, await sha256(lease), at).first();
  if (!row) return false;
  const request = await openRequest(env, row);
  if (!request || !await authorizationStillValid(db, row, request.authorization)) return false;
  const changed = await db.prepare(`UPDATE hx_remote_mcp_egress SET lease_until=MIN(?5+?6,deadline)
    WHERE org_id=?1 AND id=?2 AND gateway_id=?3 AND status='running' AND lease_hash=?4 AND lease_until>?5 AND deadline>?5`)
    .bind(row.org_id, jobId, gateway.id, await sha256(lease), at, LEASE_MS).run();
  return Boolean(changed.meta?.changes);
}

export async function finishRemoteMcpEgress(db, env, gateway, { jobId, lease, result, at = now() }) {
  if (!env?.DATA_KEY || typeof jobId !== "string" || typeof lease !== "string") return { ok: false, status: 409 };
  useSecretKey(env);
  let cleaned;
  try { cleaned = cleanResponse(result); } catch { return { ok: false, status: 400 }; }
  const leaseHash = await sha256(lease);
  const row = await db.prepare(`SELECT * FROM hx_remote_mcp_egress WHERE org_id=?1 AND id=?2 AND gateway_id=?3 AND status='running' AND lease_hash=?4 AND lease_until>?5 AND deadline>?5`)
    .bind(gateway.org_id, jobId, gateway.id, leaseHash, at).first();
  if (!row) {
    const done = await db.prepare(`SELECT status FROM hx_remote_mcp_egress WHERE org_id=?1 AND id=?2 AND gateway_id=?3`)
      .bind(gateway.org_id, jobId, gateway.id).first();
    return done?.status === "succeeded" || done?.status === "failed" || done?.status === "cancelled"
      ? { ok: true, alreadyFinished: true }
      : { ok: false, status: 409 };
  }
  const request = await openRequest(env, row);
  if (!request || !await authorizationStillValid(db, row, request.authorization)) {
    await db.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?4,expires_at=?5
      WHERE org_id=?1 AND id=?2 AND gateway_id=?3 AND status='running' AND lease_hash=?6`)
      .bind(row.org_id, row.id, gateway.id, at, at + RETAIN_MS, leaseHash).run();
    return { ok: false, status: 409 };
  }
  const responseSealed = await sealField(JSON.stringify(cleaned), egressAad(row, "response"), row.org_id);
  if (!responseSealed || responseSealed === JSON.stringify(cleaned)) return { ok: false, status: 503 };
  const status = cleaned.error ? "failed" : "succeeded";
  const saved = await db.prepare(`UPDATE hx_remote_mcp_egress SET status=?5,response=?6,finished_at=?7,expires_at=?8
    WHERE org_id=?1 AND id=?2 AND gateway_id=?3 AND status='running' AND lease_hash=?4 AND lease_until>?7 AND deadline>?7`)
    .bind(row.org_id, row.id, gateway.id, leaseHash, status, responseSealed, at, at + RETAIN_MS).run();
  return saved.meta?.changes ? { ok: true } : { ok: false, status: 409 };
}

export async function cancelRemoteMcpEgressForServer(db, orgId, serverId, at = now()) {
  const result = await db.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?3,expires_at=?4
    WHERE org_id=?1 AND server_id=?2 AND status IN ('queued','running')`).bind(orgId, serverId, at, at + RETAIN_MS).run();
  return Number(result.meta?.changes || 0);
}

export async function cancelRemoteMcpEgressForGateway(db, orgId, gatewayId, at = now()) {
  const result = await db.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?3,expires_at=?4
    WHERE org_id=?1 AND gateway_id=?2 AND status IN ('queued','running')`).bind(orgId, gatewayId, at, at + RETAIN_MS).run();
  return Number(result.meta?.changes || 0);
}

export async function expireRemoteMcpEgress(db, orgId, at = now()) {
  if (!orgId) return { cancelled: 0, deleted: 0 };
  const changed = await db.prepare(`UPDATE hx_remote_mcp_egress SET status='cancelled',lease_hash=NULL,finished_at=?2,expires_at=?2+?3
    WHERE org_id=?1 AND status IN ('queued','running') AND (deadline<=?2 OR expires_at<=?2)`).bind(orgId, at, RETAIN_MS).run();
  const deleted = await db.prepare(`DELETE FROM hx_remote_mcp_egress WHERE org_id=?1 AND id IN (
    SELECT id FROM hx_remote_mcp_egress WHERE org_id=?1 AND expires_at<=?2 ORDER BY expires_at,id LIMIT 500
  )`).bind(orgId, at).run();
  return { cancelled: Number(changed.meta?.changes || 0), deleted: Number(deleted.meta?.changes || 0) };
}

/// Node-side route handler. The normal Gateway route may pass its already
/// authenticated gateway row as the optional fifth argument.
export async function handleRemoteMcpEgressNode(request, env, url, input, auth = null) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "gateways" || parts[1] !== "remote-mcp") return null;
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  const gateway = auth?.gateway;
  if (!gateway?.id || !gateway?.org_id) return json({ message: "Node authentication required." }, 401);
  const ownerCanManage = await allowed(env.DB, gateway.org_id, String(gateway.created_by), "workspace.mode").catch(() => false);
  if (!ownerCanManage || gateway.revoked_at != null) return json({ message: "Node owner access was revoked." }, 403);
  const at = Number.isFinite(auth.now) ? auth.now : now();
  await env.DB.prepare("UPDATE hx_gateways SET last_seen_at=?3 WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL").bind(gateway.org_id, gateway.id, at).run();
  const action = parts[2];
  if (action === "claim" && parts.length === 3) {
    const job = await claimRemoteMcpEgress(env.DB, env, gateway, { at });
    return json({ job });
  }
  const match = url.pathname.match(/^\/gateways\/remote-mcp\/jobs\/([a-f0-9-]{36})\/(heartbeat|finish)$/);
  if (!match) return json({ message: "No such endpoint." }, 404);
  const [, jobId, operation] = match;
  if (operation === "heartbeat") {
    const ok = await heartbeatRemoteMcpEgress(env.DB, env, gateway, { jobId, lease: input?.lease, at });
    return ok ? json({ ok: true }) : json({ message: "Remote MCP egress is no longer authorized." }, 409);
  }
  const result = await finishRemoteMcpEgress(env.DB, env, gateway, { jobId, lease: input?.lease, result: input?.result, at });
  return result.ok ? json({ ok: true, ...(result.alreadyFinished ? { code: "already_finished" } : {}) })
    : json({ message: result.status === 400 ? "Invalid Remote MCP response." : "Remote MCP egress is no longer authorized." }, result.status || 409);
}

export { cleanRequest as cleanRemoteMcpEgressRequest, cleanResponse as cleanRemoteMcpEgressResponse };

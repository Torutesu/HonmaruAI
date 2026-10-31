import { aad, openField, sealField } from "../secrets.js";
import { audit } from "../audit.js";
import { isPublicUrl } from "../links.js";
import { getMode } from "./mode.js";

const REMOTE_MCP_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TOOL_SCHEMA_BYTES = 32_000;
const RESERVED_HEADERS = new Set([
  "accept", "connection", "content-length", "content-type", "host", "mcp-protocol-version",
  "mcp-session-id", "origin", "transfer-encoding", "upgrade",
]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-session-token, x-ai-key, authorization",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  },
});

function parseJSON(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || null;
}

export function safeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(String(value || "").trim()); } catch { return null; }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) return null;
  if (!isPublicUrl(endpoint.toString())) return null;
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || !host.includes(".") || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return null;
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return null;
  if (/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)) return null;
  if (["metadata.google.internal", "metadata.google", "instance-data.ec2.internal"].includes(host)) return null;
  // Only HTTPS's standard port is accepted. This keeps connection strings
  // from becoming a route to private services on an otherwise public host.
  if (endpoint.port && endpoint.port !== "443") return null;
  endpoint.hostname = host;
  endpoint.port = "";
  return endpoint.toString();
}

export function cleanHeaders(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 20) return null;
  const seen = new Set();
  const headers = [];
  for (const row of input) {
    const name = String(row?.name || "").trim();
    const value = String(row?.value || "");
    const key = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || RESERVED_HEADERS.has(key) || seen.has(key)) return null;
    if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    seen.add(key);
    headers.push({ name, value });
  }
  return headers;
}

export function cleanTools(value) {
  if (!Array.isArray(value) || value.length > 500) return [];
  const names = new Set();
  const tools = [];
  for (const item of value) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const inputSchema = item?.inputSchema;
    if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name) || names.has(name)) continue;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) || inputSchema.type !== "object") continue;
    let encoded;
    try { encoded = JSON.stringify(inputSchema); } catch { continue; }
    if (encoded.length > MAX_TOOL_SCHEMA_BYTES) continue;
    names.add(name);
    tools.push({
      name,
      title: String(item.title || name).slice(0, 120),
      description: String(item.description || "").slice(0, 2_000),
      inputSchema,
    });
  }
  return tools;
}

export function toolName(serverId, name) {
  const prefix = String(serverId).replace(/-/g, "").slice(0, 8);
  const readable = String(name).normalize("NFKD").replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "tool";
  // FNV-1a keeps names stable and makes normalization collisions unlikely.
  let hash = 0x811c9dc5;
  for (const char of String(name)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `mcp_${prefix}_${readable}_${hash.toString(16).padStart(8, "0")}`;
}

async function loadHeaders(env, row) {
  const value = await openField(row.auth_headers, aad.remoteMcpHeaders(row.org_id, row.id), row.org_id);
  if (value == null) throw new Error("The connection key cannot be opened. Check workspace encryption settings.");
  const headers = cleanHeaders(parseJSON(value, null));
  if (!headers) throw new Error("The saved authentication headers are invalid.");
  return headers;
}

async function readBounded(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("MCP server response is too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("MCP server response is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseRpcBody(body, contentType, expectedId) {
  if (/text\/event-stream/i.test(contentType)) {
    const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    for (const line of data) {
      if (!line || line === "[DONE]") continue;
      const parsed = parseJSON(line, null);
      if (parsed && parsed.id === expectedId) return parsed;
    }
    throw new Error("MCP server did not return the requested response.");
  }
  const parsed = parseJSON(body, null);
  if (!parsed || parsed.jsonrpc !== "2.0" || parsed.id !== expectedId) throw new Error("MCP server returned an invalid response.");
  return parsed;
}

async function postRpc(endpoint, headers, message, { protocol, sessionId, deadline } = {}) {
  const requestHeaders = new Headers();
  for (const header of headers) requestHeaders.set(header.name, header.value);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("accept", "application/json, text/event-stream");
  if (protocol) requestHeaders.set("mcp-protocol-version", protocol);
  if (sessionId) requestHeaders.set("mcp-session-id", sessionId);
  const remaining = deadline ? deadline - Date.now() : 15_000;
  if (remaining <= 0) throw new Error("Remote MCP request timed out.");
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(message),
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(15_000, remaining)),
    });
  } catch {
    throw new Error("Could not reach the MCP server over HTTPS.");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("MCP server redirects are blocked. Use its final HTTPS endpoint.");
  if (!response.ok) throw new Error(`MCP server returned HTTP ${response.status}. Check its URL and authentication.`);
  if (message.id == null && (response.status === 202 || response.status === 204)) return { response, rpc: null };
  const contentType = response.headers.get("content-type") || "";
  if (!/application\/json|text\/event-stream/i.test(contentType)) throw new Error("MCP server must return JSON or a Server-Sent Event response.");
  const text = await readBounded(response);
  return { response, rpc: message.id == null ? null : parseRpcBody(text, contentType, message.id) };
}

async function withMcp(endpoint, headers, action) {
  const deadline = Date.now() + 25_000;
  const init = await postRpc(endpoint, headers, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Honmaru AI", version: "1.0.0" } },
  }, { deadline });
  if (init.rpc.error) throw new Error("MCP server rejected initialization. Check its supported protocol and authentication.");
  const protocol = REMOTE_MCP_PROTOCOLS.includes(init.rpc.result?.protocolVersion) ? init.rpc.result.protocolVersion : "2025-06-18";
  const sessionId = init.response.headers.get("mcp-session-id") || null;
  await postRpc(endpoint, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, { protocol, sessionId, deadline });
  return action({ protocol, sessionId, deadline });
}

async function listToolsAt(endpoint, headers) {
  return withMcp(endpoint, headers, async ({ protocol, sessionId, deadline }) => {
    const listed = await postRpc(endpoint, headers, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { protocol, sessionId, deadline });
    if (listed.rpc.error) throw new Error("MCP server could not list its tools.");
    return cleanTools(listed.rpc.result?.tools);
  });
}

function publicServer(row) {
  const tools = cleanTools(parseJSON(row.tools_json, []));
  const headers = parseJSON(row.auth_headers, "[]");
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    hasAuthentication: Boolean(String(row.auth_headers || "").startsWith("enc:v1:") || String(row.auth_headers || "").startsWith("enc:v2:") || (Array.isArray(headers) && headers.length)),
    tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
    allowedTools: parseJSON(row.allowed_tools, []),
    connectedAt: row.connected_at || null,
    createdAt: row.created_at,
  };
}

async function getServer(db, orgId, id) {
  return db.prepare("SELECT * FROM hx_remote_mcp_servers WHERE org_id = ?1 AND id = ?2").bind(orgId, id).first();
}

async function writeAudit(env, request, who, orgId, action, row, details = {}) {
  await audit(env, request, {
    orgId,
    action,
    actor: { type: "user", id: who.user.login, name: who.user.name || who.user.login },
    entity: row ? { type: "remote_mcp_server", id: row.id, name: row.name } : null,
    details,
  });
}

export async function handleRemoteMcp(request, env, url, input, { orgId, who, canManage }) {
  if (!orgId) return json({ message: "orgId is required." }, 400);
  if (await getMode(env.DB, orgId) !== "harness") return json({ message: "Remote MCP connections are available in Harness mode." }, 404);
  const match = url.pathname.match(/^\/remote-mcp(?:\/([^/]+)(?:\/(discover|tools))?)?$/);
  if (!match) return null;
  const [, id, operation] = match;

  if (request.method === "GET" && !id) {
    const { results = [] } = await env.DB.prepare("SELECT * FROM hx_remote_mcp_servers WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 20").bind(orgId).all();
    return json({ servers: results.map(publicServer), canManage });
  }
  if (request.method === "POST" && !id) {
    if (!canManage) return json({ message: "Only a workspace admin can add a Remote MCP server." }, 403);
    const name = cleanName(input?.name);
    const endpoint = safeEndpoint(input?.endpoint);
    const headers = cleanHeaders(input?.headers);
    if (!name || !endpoint) return json({ message: "Enter a name and a valid public HTTPS endpoint without a query string or embedded credentials." }, 400);
    if (!headers) return json({ message: "Headers must have unique valid names and values, with at most 20 entries." }, 400);
    if (headers.length && !env.DATA_KEY) return json({ message: "Workspace encryption is required before authentication headers can be saved." }, 503);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_remote_mcp_servers WHERE org_id = ?1").bind(orgId).first();
    if (Number(count?.n || 0) >= 20) return json({ message: "This workspace has reached its limit of 20 Remote MCP servers." }, 409);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sealedHeaders = headers.length ? await sealField(JSON.stringify(headers), aad.remoteMcpHeaders(orgId, id), orgId) : "[]";
    await env.DB.prepare(`INSERT INTO hx_remote_mcp_servers (id, org_id, name, endpoint, auth_headers, tools_json, allowed_tools, created_by, created_at, updated_at, connected_at)
      VALUES (?1, ?2, ?3, ?4, ?5, '[]', '[]', ?6, ?7, ?7, NULL)`)
      .bind(id, orgId, name, endpoint, sealedHeaders, String(who.session.github_id), now).run();
    const row = await getServer(env.DB, orgId, id);
    await writeAudit(env, request, who, orgId, "remote_mcp.server_added", row, { endpointHost: new URL(endpoint).hostname, authHeaderCount: headers.length });
    return json({ server: publicServer(row) }, 201);
  }
  if (!id) return json({ message: "Method not allowed." }, 405);
  const row = await getServer(env.DB, orgId, id);
  if (!row) return json({ message: "No such Remote MCP server." }, 404);
  if (!canManage) return json({ message: "Only a workspace admin can manage Remote MCP servers." }, 403);

  if (request.method === "POST" && operation === "discover") {
    const endpoint = safeEndpoint(row.endpoint);
    if (!endpoint) return json({ message: "This saved endpoint is no longer allowed." }, 400);
    let headers;
    let tools;
    try {
      headers = await loadHeaders(env, row);
      tools = await listToolsAt(endpoint, headers);
    } catch (err) {
      return json({ message: err instanceof Error ? err.message : "Could not connect to the MCP server." }, 502);
    }
    const allowedTools = parseJSON(row.allowed_tools, []).filter((name) => tools.some((tool) => tool.name === name));
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE hx_remote_mcp_servers SET tools_json = ?3, allowed_tools = ?4, connected_at = ?5, updated_at = ?5 WHERE org_id = ?1 AND id = ?2")
      .bind(orgId, id, JSON.stringify(tools), JSON.stringify(allowedTools), now).run();
    const updated = await getServer(env.DB, orgId, id);
    await writeAudit(env, request, who, orgId, "remote_mcp.server_discovered", updated, { toolCount: tools.length });
    return json({ server: publicServer(updated) });
  }
  if (request.method === "PUT" && operation === "tools") {
    const offered = cleanTools(parseJSON(row.tools_json, []));
    if (!Array.isArray(input?.allowedTools)) return json({ message: "allowedTools must be a list." }, 400);
    const allowedTools = [...new Set(input.allowedTools.filter((name) => typeof name === "string" && offered.some((tool) => tool.name === name)))];
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE hx_remote_mcp_servers SET allowed_tools = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2")
      .bind(orgId, id, JSON.stringify(allowedTools), now).run();
    const updated = await getServer(env.DB, orgId, id);
    await writeAudit(env, request, who, orgId, "remote_mcp.tools_changed", updated, { allowedToolCount: allowedTools.length });
    return json({ server: publicServer(updated) });
  }
  if (request.method === "DELETE" && !operation) {
    await env.DB.prepare("DELETE FROM hx_remote_mcp_servers WHERE org_id = ?1 AND id = ?2").bind(orgId, id).run();
    await writeAudit(env, request, who, orgId, "remote_mcp.server_removed", row);
    return json({ removed: true });
  }
  return json({ message: "Method not allowed." }, 405);
}

/// The MCP tools a token may see. Connections and their allowlists are both
/// workspace-owned; an agent still needs the separate execute token scope.
export async function remoteMcpTools(db, orgId) {
  const { results = [] } = await db.prepare("SELECT id, name, tools_json, allowed_tools FROM hx_remote_mcp_servers WHERE org_id = ?1 ORDER BY created_at").bind(orgId).all();
  const exposed = [];
  for (const row of results) {
    const allowed = new Set(parseJSON(row.allowed_tools, []));
    for (const tool of cleanTools(parseJSON(row.tools_json, []))) {
      if (!allowed.has(tool.name)) continue;
      const name = toolName(row.id, tool.name);
      exposed.push({
        name,
        title: `${row.name}: ${tool.title}`.slice(0, 120),
        description: `Connected Remote MCP server “${row.name}”. ${tool.description || `Call the ${tool.name} tool.`}`.slice(0, 2_000),
        inputSchema: tool.inputSchema,
        _remote: { serverId: row.id, toolName: tool.name },
      });
    }
  }
  return exposed;
}

export async function callRemoteMcpTool(env, agent, offeredTool, args) {
  const ref = offeredTool?._remote;
  if (!ref || !args || typeof args !== "object" || Array.isArray(args)) return null;
  if (JSON.stringify(args).length > 64_000) return { content: [{ type: "text", text: "Tool arguments are too large." }], isError: true };
  const row = await getServer(env.DB, agent.orgId, ref.serverId);
  if (!row || !parseJSON(row.allowed_tools, []).includes(ref.toolName)) return { content: [{ type: "text", text: "This remote MCP tool is no longer enabled." }], isError: true };
  const endpoint = safeEndpoint(row.endpoint);
  if (!endpoint) return { content: [{ type: "text", text: "This Remote MCP endpoint is no longer allowed." }], isError: true };
  try {
    const headers = await loadHeaders(env, row);
    const result = await withMcp(endpoint, headers, async ({ protocol, sessionId, deadline }) => {
      const called = await postRpc(endpoint, headers, {
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: ref.toolName, arguments: args },
      }, { protocol, sessionId, deadline });
      if (called.rpc.error) return { content: [{ type: "text", text: "The remote MCP server rejected this tool call." }], isError: true };
      const value = called.rpc.result;
      if (!value || typeof value !== "object" || !Array.isArray(value.content)) return { content: [{ type: "text", text: "The remote MCP server returned an invalid tool result." }], isError: true };
      return value;
    });
    await audit(env, null, {
      orgId: agent.orgId,
      action: "remote_mcp.tool_called",
      actor: { type: "user", id: agent.login, name: `${agent.agentName} (${agent.name})` },
      entity: { type: "remote_mcp_server", id: row.id, name: row.name },
      details: { tool: ref.toolName, outcome: result.isError ? "error" : "success" },
      outcome: result.isError ? "failure" : "success",
    });
    return result;
  } catch (err) {
    await audit(env, null, {
      orgId: agent.orgId,
      action: "remote_mcp.tool_called",
      actor: { type: "user", id: agent.login, name: `${agent.agentName} (${agent.name})` },
      entity: { type: "remote_mcp_server", id: row.id, name: row.name },
      details: { tool: ref.toolName },
      outcome: "failure",
    });
    return { content: [{ type: "text", text: err instanceof Error ? err.message : "Remote MCP tool call failed." }], isError: true };
  }
}

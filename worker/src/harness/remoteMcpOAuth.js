import { aad, openField, sealField } from "../secrets.js";
import { isPublicUrl } from "../links.js";
import { audit } from "../audit.js";
import { remoteMcpFetch } from "./remoteMcpTransport.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const STATE_MINUTES = 10;
const MAX_METADATA_BYTES = 64_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
});

function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(value))));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeOAuthUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !isPublicUrl(url.toString())) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..") || /^[0-9.]+$/.test(host)
    || /(^|\.)(localhost|local|internal|home\.arpa|lan|test|invalid|example|onion)$/.test(host)
    || ["metadata.google.internal", "metadata.google", "instance-data.ec2.internal"].includes(host)) return null;
  if (url.port && url.port !== "443") return null;
  url.hostname = host;
  url.port = "";
  return url.toString();
}

function parseJSON(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function readBounded(response, max = MAX_METADATA_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("OAuth server metadata is too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("OAuth server metadata is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return dec.decode(bytes);
}

function responseFromEgress(result) {
  const body = [204, 205, 304].includes(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers: result.headers });
}

async function fetchJson(env, egress, url, { method = "GET", body = null, headers = {} } = {}) {
  const endpoint = safeOAuthUrl(url);
  if (!endpoint) throw new Error("OAuth endpoints must use a public HTTPS host without embedded credentials or fragments.");
  let response;
  try {
    const requestHeaders = { accept: "application/json", ...(body == null ? {} : { "content-type": "application/json" }), ...headers };
    const result = await remoteMcpFetch(env, egress, { url: endpoint, method,
      headers: Object.entries(requestHeaders).map(([name, value]) => ({ name, value: String(value) })),
      ...(body == null ? {} : { body: JSON.stringify(body) }), timeoutMs: 12_000 });
    response = responseFromEgress(result);
  } catch {
    throw new Error("Could not reach the OAuth server over HTTPS.");
  }
  if (response.status >= 300 && response.status < 400) throw new Error("OAuth server redirects are blocked. Use its final HTTPS metadata URL.");
  const text = await readBounded(response);
  const data = parseJSON(text);
  if (!response.ok || !data || typeof data !== "object" || Array.isArray(data)) {
    const message = typeof data?.error === "string" ? data.error : "OAuth server returned invalid metadata.";
    throw new Error(response.ok ? message : `OAuth server returned HTTP ${response.status}.`);
  }
  return data;
}

function authParameter(header, key) {
  const pattern = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^,\\s]+))`, "i");
  const match = String(header || "").match(pattern);
  return match ? (match[1] ?? match[2] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : null;
}

async function challengeAt(env, egress, endpoint) {
  try {
    const result = await remoteMcpFetch(env, egress, { url: endpoint, method: "POST",
      headers: [{ name: "content-type", value: "application/json" }, { name: "accept", value: "application/json, text/event-stream" }],
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Honmaru AI", version: "1.0.0" } } }),
      timeoutMs: 10_000 });
    const response = responseFromEgress(result);
    const header = response.status === 401 || response.status === 403 ? response.headers.get("www-authenticate") : null;
    await response.body?.cancel().catch(() => {});
    return header || "";
  } catch { return ""; }
}

function protectedResourceCandidates(endpoint, challenge) {
  const fromChallenge = authParameter(challenge, "resource_metadata");
  const target = new URL(endpoint);
  const path = target.pathname.replace(/\/+$/, "");
  const candidates = [
    fromChallenge,
    `${target.origin}/.well-known/oauth-protected-resource${path === "/" ? "" : path}`,
    `${target.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean).map(safeOAuthUrl).filter(Boolean);
  return [...new Set(candidates)];
}

async function discoverProtectedResource(env, egress, endpoint) {
  const challenge = await challengeAt(env, egress, endpoint);
  let metadata = null;
  let lastError = null;
  for (const candidate of protectedResourceCandidates(endpoint, challenge)) {
    try { metadata = await fetchJson(env, egress, candidate); break; } catch (err) { lastError = err; }
  }
  if (!metadata) throw new Error(lastError?.message || "The MCP server did not publish OAuth Protected Resource Metadata.");
  const resource = safeOAuthUrl(metadata.resource || endpoint);
  if (!resource || resource !== endpoint) {
    throw new Error("The OAuth resource metadata does not identify the configured MCP server.");
  }
  const issuers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : [];
  // Preserve the issuer's exact serialized value. OAuth issuer identifiers
  // are compared byte-for-byte; URL serialization can add a trailing slash.
  const issuer = issuers.find((value) => {
    if (typeof value !== "string" || value !== value.trim() || !safeOAuthUrl(value)) return false;
    return !new URL(value).search;
  }) || null;
  if (!issuer) throw new Error("The MCP server did not publish a public HTTPS authorization server.");
  const scopeHint = authParameter(challenge, "scope");
  let scopes = typeof scopeHint === "string" ? scopeHint : "";
  if (!scopes && Array.isArray(metadata.scopes_supported)) {
    scopes = metadata.scopes_supported.filter((scope) => typeof scope === "string" && scope.length <= 200 && !/[\u0000-\u001f]/.test(scope)).slice(0, 100).join(" ");
  }
  if (scopes.length > 2000 || /[\u0000-\u001f]/.test(scopes)) throw new Error("The MCP server published invalid OAuth scopes.");
  return { metadata, issuer, resource, scope: scopes || null };
}

async function discoverAuthorizationServer(env, egress, issuer) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
  let metadata = null;
  let lastError = null;
  for (const candidate of candidates) {
    if (!safeOAuthUrl(candidate)) continue;
    try { metadata = await fetchJson(env, egress, candidate); break; } catch (err) { lastError = err; }
  }
  if (!metadata) throw new Error(lastError?.message || "The OAuth server does not publish authorization server metadata.");
  if (typeof metadata.issuer !== "string" || metadata.issuer !== issuer) {
    throw new Error("The OAuth server metadata issuer does not match the advertised issuer.");
  }
  const authorizationEndpoint = safeOAuthUrl(metadata.authorization_endpoint);
  const tokenEndpoint = safeOAuthUrl(metadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("The OAuth server metadata is missing safe authorization or token endpoints.");
  if (metadata.code_challenge_methods_supported && (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256"))) {
    throw new Error("The OAuth server does not support the required PKCE S256 method.");
  }
  return {
    ...metadata,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: safeOAuthUrl(metadata.registration_endpoint),
  };
}

function supportedTokenAuthMethods(metadata) {
  const advertised = metadata.token_endpoint_auth_methods_supported;
  const methods = Array.isArray(advertised)
    ? advertised.filter((method) => ["none", "client_secret_basic", "client_secret_post"].includes(method))
    : ["client_secret_basic"];
  return [...new Set(methods)];
}

function chooseTokenAuthMethod(metadata, { hasSecret = false } = {}) {
  const methods = supportedTokenAuthMethods(metadata);
  if (hasSecret) {
    if (methods.includes("client_secret_basic")) return "client_secret_basic";
    if (methods.includes("client_secret_post")) return "client_secret_post";
  }
  if (methods.includes("none")) return "none";
  return null;
}

function chooseRegistrationTokenAuthMethod(metadata) {
  const methods = supportedTokenAuthMethods(metadata);
  if (methods.includes("none")) return "none";
  if (methods.includes("client_secret_basic")) return "client_secret_basic";
  if (methods.includes("client_secret_post")) return "client_secret_post";
  return null;
}

async function loadClient(env, row) {
  if (!row.oauth_client) return null;
  const raw = await openField(row.oauth_client, aad.remoteMcpOAuthClient(row.org_id, row.id));
  if (!raw) return null;
  const value = parseJSON(raw);
  if (!value || typeof value.clientId !== "string" || !value.clientId.trim()) return null;
  return {
    clientId: value.clientId.slice(0, 500),
    clientSecret: typeof value.clientSecret === "string" ? value.clientSecret : "",
    clientSecretExpiresAt: Number.isFinite(Number(value.clientSecretExpiresAt)) ? Number(value.clientSecretExpiresAt) : 0,
    issuer: typeof value.issuer === "string" ? value.issuer : "",
    portable: value.portable === true,
  };
}

async function saveClient(env, row, client) {
  if (!env.DATA_KEY) throw new Error("Workspace encryption is required before OAuth client credentials can be saved.");
  const sealed = await sealField(JSON.stringify(client), aad.remoteMcpOAuthClient(row.org_id, row.id), row.org_id);
  await env.DB.prepare("UPDATE hx_remote_mcp_servers SET oauth_client = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2")
    .bind(row.org_id, row.id, sealed, new Date().toISOString()).run();
}

async function registerClient(env, row, metadata, redirectUri, egress) {
  const issuer = typeof metadata.issuer === "string" ? metadata.issuer : "";
  if (row.oauth_registration === "manual") {
    const client = await loadClient(env, row);
    if (!client) throw new Error("This server needs a client ID and client secret. Ask a workspace admin to complete the OAuth setup.");
    if (client.issuer && client.issuer !== issuer) throw new Error("The saved client credentials belong to a different authorization server. Update them before reconnecting.");
    if (!client.issuer) {
      client.issuer = issuer;
      await saveClient(env, row, client);
    }
    if (client.clientSecretExpiresAt && client.clientSecretExpiresAt <= Math.floor(Date.now() / 1000)) {
      throw new Error("The registered OAuth client secret has expired. Update its credentials and reconnect.");
    }
    const tokenAuthMethod = chooseTokenAuthMethod(metadata, { hasSecret: Boolean(client.clientSecret) });
    if (!tokenAuthMethod) throw new Error("The OAuth server requires a client authentication method that these credentials do not support.");
    return { ...client, tokenAuthMethod };
  }
  const cached = await loadClient(env, row);
  if (metadata.client_id_metadata_document_supported === true) {
    const clientId = `${new URL(redirectUri).origin}/.well-known/oauth-client`;
    if (cached?.portable && cached.clientId === clientId) return cached;
    const client = { clientId, clientSecret: "", clientSecretExpiresAt: 0, issuer: "", portable: true, tokenAuthMethod: "none" };
    await saveClient(env, row, client);
    return client;
  }
  if (cached && !cached.portable && cached.issuer === issuer && (!cached.clientSecretExpiresAt || cached.clientSecretExpiresAt > Math.floor(Date.now() / 1000))) return cached;
  if (!metadata.registration_endpoint) throw new Error("Automatic client registration is unavailable for this OAuth server. Choose manual registration and enter its client ID.");
  const tokenAuthMethod = chooseRegistrationTokenAuthMethod(metadata);
  if (!tokenAuthMethod) throw new Error("This OAuth server does not support a token endpoint authentication method Honmaru can register.");
  const registered = await fetchJson(env, egress, metadata.registration_endpoint, {
    method: "POST",
    body: {
      redirect_uris: [redirectUri],
      client_name: "Honmaru AI",
      application_type: "web",
      token_endpoint_auth_method: tokenAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  const clientId = typeof registered.client_id === "string" ? registered.client_id.trim() : "";
  if (!clientId || clientId.length > 500 || /[\u0000-\u001f\u007f]/.test(clientId)) throw new Error("The OAuth registration endpoint did not return a valid client ID.");
  const client = {
    clientId,
    clientSecret: typeof registered.client_secret === "string" ? registered.client_secret : "",
    clientSecretExpiresAt: Number.isFinite(Number(registered.client_secret_expires_at)) ? Number(registered.client_secret_expires_at) : 0,
    issuer,
    portable: false,
    tokenAuthMethod,
  };
  if (registered.token_endpoint_auth_method && registered.token_endpoint_auth_method !== tokenAuthMethod) {
    throw new Error("The OAuth server registered a different token authentication method than requested.");
  }
  if (tokenAuthMethod !== "none" && !client.clientSecret) {
    throw new Error("The OAuth server did not return the client secret required by its registration.");
  }
  await saveClient(env, row, client);
  return client;
}

async function membership(env, orgId, userId) {
  return env.DB.prepare("SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2 AND LOWER(TRIM(COALESCE(role,'guest')))!='guest'")
    .bind(orgId, String(userId)).first();
}

export async function startRemoteMcpOAuth(env, url, { orgId, serverId, userId }) {
  if (!env.DATA_KEY) throw new Error("Workspace encryption is required before OAuth credentials can be saved.");
  const row = await env.DB.prepare("SELECT * FROM hx_remote_mcp_servers WHERE org_id=?1 AND id=?2")
    .bind(orgId, serverId).first();
  if (!row) throw new Error("No such Remote MCP server.");
  if (row.auth_mode !== "oauth") throw new Error("This Remote MCP server uses headers instead of OAuth.");
  const activeMembership = await membership(env, orgId, userId);
  if (!activeMembership) throw new Error("A current workspace member account is required to connect OAuth.");
  const endpoint = safeOAuthUrl(row.endpoint);
  if (!endpoint) throw new Error("This saved MCP endpoint is no longer allowed.");
  const egress = { orgId, serverId, actorId: String(userId) };
  const resourceInfo = await discoverProtectedResource(env, egress, endpoint);
  const authorizationServer = await discoverAuthorizationServer(env, egress, resourceInfo.issuer);
  const redirectUri = `${url.origin}/remote-mcp/oauth/callback`;
  await env.DB.prepare("DELETE FROM hx_remote_mcp_oauth_states WHERE org_id=?1 AND expires_at <= ?2").bind(orgId, new Date().toISOString()).run();
  const client = await registerClient(env, row, authorizationServer, redirectUri, egress);
  const state = randomToken(32);
  const stateHash = await hash(state);
  const verifier = randomToken(48);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Date.now();
  const expiresAt = new Date(now + STATE_MINUTES * 60_000).toISOString();
  const codeVerifier = await sealField(verifier, aad.remoteMcpOAuthVerifier(orgId, stateHash), orgId);
  await env.DB.prepare(`INSERT INTO hx_remote_mcp_oauth_states
    (state_hash,org_id,server_id,user_github_id,membership_since,code_verifier,client_secret,token_auth_method,issuer,token_endpoint,redirect_uri,client_id,resource,scope,require_issuer,created_at,expires_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`)
    .bind(stateHash, orgId, serverId, String(userId), activeMembership.created_at, codeVerifier,
      client.clientSecret ? await sealField(client.clientSecret, `hx_remote_mcp_oauth_states.client_secret:${orgId}:${stateHash}`, orgId) : "",
      client.tokenAuthMethod || "none", resourceInfo.issuer, authorizationServer.token_endpoint, redirectUri, client.clientId, resourceInfo.resource, resourceInfo.scope,
      authorizationServer.authorization_response_iss_parameter_supported === true ? 1 : 0,
      new Date(now).toISOString(), expiresAt).run();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: resourceInfo.resource,
  });
  if (resourceInfo.scope) params.set("scope", resourceInfo.scope);
  const authorizeUrl = new URL(authorizationServer.authorization_endpoint);
  for (const [key, value] of params) authorizeUrl.searchParams.set(key, value);
  return { authorizeUrl: authorizeUrl.toString(), expiresAt };
}

export function remoteMcpOAuthClientMetadata(url, env) {
  const clientId = `${url.origin}/.well-known/oauth-client`;
  const appUrl = safeOAuthUrl(env?.APP_WEB_URL);
  const body = {
    client_id: clientId,
    client_name: "Honmaru AI",
    redirect_uris: [`${url.origin}/remote-mcp/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    ...(appUrl ? { client_uri: appUrl } : {}),
  };
  return new Response(JSON.stringify(body), {
    headers: { "cache-control": "public, max-age=300", "content-type": "application/json", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
  });
}

function callbackPage({ ok, appUrl }) {
  const link = appUrl && safeOAuthUrl(appUrl) ? appUrl : "";
  const label = ok ? "OAuth connection saved to your Honmaru account." : "OAuth connection could not be completed. Return to Honmaru and try again.";
  const content = link
    ? `<p><a href="${link}">Return to Honmaru</a></p>`
    : "";
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Honmaru OAuth</title><body><main><h1>${ok ? "Connected" : "Connection failed"}</h1><p>${label}</p>${content}</main></body></html>`, {
    status: ok ? 200 : 400,
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
  });
}

function formEncode(value) {
  return new URLSearchParams([["value", String(value)]]).toString().slice("value=".length);
}

function basicAuthorization(clientId, clientSecret) {
  const encoded = enc.encode(`${formEncode(clientId)}:${formEncode(clientSecret)}`);
  return `Basic ${btoa(String.fromCharCode(...encoded))}`;
}

async function exchangeToken(env, egress, url, form, clientSecret = "", tokenAuthMethod = "none") {
  const endpoint = safeOAuthUrl(url);
  if (!endpoint) throw new Error("The token endpoint is no longer allowed.");
  const body = new URLSearchParams(form);
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (tokenAuthMethod === "client_secret_basic") {
    if (!clientSecret) throw new Error("The OAuth client secret is unavailable.");
    const clientId = body.get("client_id") || "";
    if (!clientId) throw new Error("The OAuth client ID is unavailable.");
    body.delete("client_id");
    body.delete("client_secret");
    headers.authorization = basicAuthorization(clientId, clientSecret);
  } else if (tokenAuthMethod === "client_secret_post") {
    if (!clientSecret) throw new Error("The OAuth client secret is unavailable.");
    body.set("client_secret", clientSecret);
  } else if (tokenAuthMethod !== "none") {
    throw new Error("The OAuth client authentication method is not supported.");
  }
  let response;
  try {
    const result = await remoteMcpFetch(env, egress, { url: endpoint, method: "POST",
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: body.toString(), timeoutMs: 15_000 });
    response = responseFromEgress(result);
  } catch { throw new Error("Could not reach the OAuth token endpoint over HTTPS."); }
  if (response.status >= 300 && response.status < 400) throw new Error("OAuth token endpoint redirects are blocked.");
  const data = parseJSON(await readBounded(response), null);
  if (!response.ok || !data || typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 16_384
    || (data.refresh_token != null && (typeof data.refresh_token !== "string" || data.refresh_token.length > 16_384))
    || (data.token_type && String(data.token_type).toLowerCase() !== "bearer")) {
    throw new Error("The OAuth server did not issue a usable bearer token.");
  }
  return data;
}

export async function finishRemoteMcpOAuth(env, url) {
  const state = url.searchParams.get("state") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return callbackPage({ ok: false, appUrl: env.APP_WEB_URL });
  const stateHash = await hash(state);
  // The high-entropy state hash is globally unique, so this callback lookup can identify exactly one pending row without a workspace context.
  const row = await env.DB.prepare("DELETE FROM hx_remote_mcp_oauth_states WHERE state_hash=?1 RETURNING *").bind(stateHash).first().catch(() => null);
  if (!row || row.expires_at <= new Date().toISOString()) return callbackPage({ ok: false, appUrl: env.APP_WEB_URL });
  const fail = async (reason) => {
    await audit(env, null, { orgId: row.org_id, action: "remote_mcp.oauth_failed", actor: { type: "user", id: row.user_github_id }, entity: { type: "remote_mcp_server", id: row.server_id }, details: { reason: String(reason).slice(0, 120) }, outcome: "failure" }).catch(() => {});
    return callbackPage({ ok: false, appUrl: env.APP_WEB_URL });
  };
  if (!row.redirect_uri || `${url.origin}${url.pathname}` !== row.redirect_uri) return fail("redirect_uri_mismatch");
  if (url.searchParams.has("iss") && url.searchParams.get("iss") !== row.issuer) return fail("issuer_mismatch");
  if (row.require_issuer && !url.searchParams.has("iss")) return fail("issuer_missing");
  if (url.searchParams.has("error")) return fail("authorization_denied");
  const code = url.searchParams.get("code") || "";
  if (!code || code.length > 4096) return fail("authorization_code_missing");
  const activeMembership = await membership(env, row.org_id, row.user_github_id);
  if (!activeMembership || activeMembership.created_at !== row.membership_since) return fail("membership_changed");
  const verifier = await openField(row.code_verifier, aad.remoteMcpOAuthVerifier(row.org_id, row.state_hash));
  if (!verifier) return fail("pkce_state_unavailable");
  const server = await env.DB.prepare("SELECT id FROM hx_remote_mcp_servers WHERE org_id=?1 AND id=?2 AND auth_mode='oauth'")
    .bind(row.org_id, row.server_id).first();
  if (!server) return fail("server_removed");
  const egress = { orgId: row.org_id, serverId: row.server_id, actorId: row.user_github_id };
  const stateSecret = row.client_secret ? await openField(row.client_secret, `hx_remote_mcp_oauth_states.client_secret:${row.org_id}:${row.state_hash}`) : "";
  if (row.client_secret && !stateSecret) return fail("client_configuration_changed");
  let tokens;
  try {
    tokens = await exchangeToken(env, egress, row.token_endpoint, {
      grant_type: "authorization_code", code, redirect_uri: row.redirect_uri,
      client_id: row.client_id, code_verifier: verifier, resource: row.resource,
    }, stateSecret || "", row.token_auth_method || "none");
  } catch (err) { return fail(err?.message || "token_exchange_failed"); }
  if (!env.DATA_KEY) return fail("workspace_encryption_required");
  const now = new Date().toISOString();
  const credential = {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
    clientSecret: stateSecret || "",
    expiresAt: Number.isFinite(Number(tokens.expires_in)) && Number(tokens.expires_in) >= 0
      ? Date.now() + Math.min(Number(tokens.expires_in), 365 * 24 * 60 * 60) * 1000 : 0,
    scope: typeof tokens.scope === "string" ? tokens.scope.slice(0, 2000) : row.scope || "",
    tokenEndpoint: row.token_endpoint,
    issuer: row.issuer,
    clientId: row.client_id,
    tokenAuthMethod: row.token_auth_method || "none",
    resource: row.resource,
  };
  const sealed = await sealField(JSON.stringify(credential), aad.remoteMcpOAuthCredential(row.org_id, row.server_id, row.user_github_id, row.membership_since), row.org_id);
  await env.DB.prepare(`INSERT INTO hx_remote_mcp_oauth_credentials
    (org_id,server_id,user_github_id,membership_since,credential,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?6)
    ON CONFLICT(org_id,server_id,user_github_id) DO UPDATE SET
      membership_since=excluded.membership_since,credential=excluded.credential,updated_at=excluded.updated_at`)
    .bind(row.org_id, row.server_id, row.user_github_id, row.membership_since, sealed, now).run();
  await audit(env, null, { orgId: row.org_id, action: "remote_mcp.oauth_connected", actor: { type: "user", id: row.user_github_id }, entity: { type: "remote_mcp_server", id: row.server_id }, details: { scopes: credential.scope ? credential.scope.split(/\s+/).length : 0 } }).catch(() => {});
  return callbackPage({ ok: true, appUrl: env.APP_WEB_URL });
}

export async function remoteMcpOAuthStatus(db, orgId, serverId, userId) {
  const row = await db.prepare(`SELECT 1 AS connected FROM hx_remote_mcp_oauth_credentials c
    JOIN memberships m ON m.org_id=c.org_id AND m.user_github_id=c.user_github_id AND m.created_at=c.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    WHERE c.org_id=?1 AND c.server_id=?2 AND c.user_github_id=?3`).bind(orgId, serverId, String(userId)).first().catch(() => null);
  return Boolean(row?.connected);
}

const shareIds = value => Array.isArray(value) && value.length <= 100
  && value.every(id => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id));

export async function remoteMcpOAuthShareSettings(db, orgId, serverId, ownerId) {
  const owner = await db.prepare(`SELECT c.membership_since AS membershipSince FROM hx_remote_mcp_oauth_credentials c
    JOIN memberships m ON m.org_id=c.org_id AND m.user_github_id=c.user_github_id
      AND m.created_at=c.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    JOIN hx_remote_mcp_servers s ON s.org_id=c.org_id AND s.id=c.server_id AND s.auth_mode='oauth'
    WHERE c.org_id=?1 AND c.server_id=?2 AND c.user_github_id=?3`)
    .bind(orgId, serverId, String(ownerId)).first().catch(() => null);
  if (!owner) return null;
  const [state, shares] = await Promise.all([
    db.prepare(`SELECT version FROM hx_remote_mcp_oauth_share_sets WHERE org_id=?1 AND server_id=?2
      AND owner_github_id=?3 AND owner_membership_since=?4`).bind(orgId, serverId, String(ownerId), owner.membershipSince).first(),
    db.prepare(`SELECT sh.audience_type AS type,sh.audience_id AS id FROM hx_remote_mcp_oauth_shares sh
      WHERE sh.org_id=?1 AND sh.server_id=?2 AND sh.owner_github_id=?3 AND EXISTS(
        SELECT 1 FROM hx_remote_mcp_oauth_share_sets set_row WHERE set_row.org_id=?1 AND set_row.server_id=?2
          AND set_row.owner_github_id=?3 AND set_row.owner_membership_since=?4)
        AND (sh.audience_type='workspace' OR (sh.audience_type='member' AND EXISTS(
          SELECT 1 FROM memberships m WHERE m.org_id=sh.org_id AND CAST(m.user_github_id AS TEXT)=sh.audience_id
            AND m.created_at=sh.audience_membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'))
          OR (sh.audience_type='agent' AND EXISTS(SELECT 1 FROM custom_agents a WHERE a.org_id=sh.org_id
            AND a.id=sh.audience_id AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL)))`)
      .bind(orgId, serverId, String(ownerId), owner.membershipSince).all(),
  ]);
  const rows = shares.results || [];
  return {
    version: Number(state?.version || 0),
    everyone: rows.some(row => row.type === 'workspace' && row.id === '*'),
    memberIds: rows.filter(row => row.type === 'member').map(row => String(row.id)),
    agentIds: rows.filter(row => row.type === 'agent').map(row => String(row.id)),
  };
}

export async function saveRemoteMcpOAuthShares(db, orgId, serverId, ownerId, input) {
  ownerId = String(ownerId || '');
  const expectedVersion = input?.version;
  const everyone = input?.everyone;
  const memberIds = input?.memberIds;
  const agentIds = input?.agentIds;
  if (!ownerId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || typeof everyone !== 'boolean'
    || !shareIds(memberIds) || !shareIds(agentIds) || new Set(memberIds).size !== memberIds.length
    || new Set(agentIds).size !== agentIds.length || memberIds.some(id => id === ownerId)
    || (everyone && memberIds.length)) return { error: 'Choose a valid connection audience and reload before saving.', status: 400 };
  if (memberIds.length + agentIds.length > 100) return { error: 'Choose no more than 100 people and Agents.', status: 400 };

  const memberJson = JSON.stringify(memberIds), agentJson = JSON.stringify(agentIds);
  const mutation = crypto.randomUUID(), now = new Date().toISOString();
  const ownerIsCurrent = `EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_credentials c
    JOIN memberships m ON m.org_id=c.org_id AND m.user_github_id=c.user_github_id
      AND m.created_at=c.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    JOIN hx_remote_mcp_servers s ON s.org_id=c.org_id AND s.id=c.server_id AND s.auth_mode='oauth'
    WHERE c.org_id=?1 AND c.server_id=?2 AND c.user_github_id=?3
      AND c.membership_since=hx_remote_mcp_oauth_share_sets.owner_membership_since)`;
  const allMembersCurrent = `NOT EXISTS(SELECT 1 FROM json_each(?4) picked
    WHERE NOT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.github_id=m.user_github_id
      WHERE m.org_id=?1 AND CAST(m.user_github_id AS TEXT)=picked.value AND m.user_github_id!=?3
        AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'))`;
  const allAgentsAvailableToOwner = `NOT EXISTS(SELECT 1 FROM json_each(?5) picked
    WHERE NOT EXISTS(SELECT 1 FROM custom_agents a JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
      JOIN users owner ON owner.github_id=?3 JOIN memberships om ON om.org_id=a.org_id AND om.user_github_id=owner.github_id
        AND LOWER(TRIM(COALESCE(om.role,'guest')))!='guest'
      WHERE a.org_id=?1 AND a.id=picked.value AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL
        AND (a.owner_login=owner.login OR p.access='everyone'
          OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.people) THEN p.people ELSE '[]' END) allowed WHERE allowed.value=owner.login))
          OR EXISTS(SELECT 1 FROM hx_agent_members ar WHERE ar.org_id=a.org_id AND ar.agent_id=a.id
            AND ar.user_id=owner.github_id AND ar.member_since=om.created_at))))`;
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO hx_remote_mcp_oauth_share_sets
      (org_id,server_id,owner_github_id,owner_membership_since,version,mutation_id,updated_at)
      SELECT c.org_id,c.server_id,c.user_github_id,c.membership_since,0,NULL,?4 FROM hx_remote_mcp_oauth_credentials c
      JOIN memberships m ON m.org_id=c.org_id AND m.user_github_id=c.user_github_id
        AND m.created_at=c.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
      JOIN hx_remote_mcp_servers s ON s.org_id=c.org_id AND s.id=c.server_id AND s.auth_mode='oauth'
      WHERE c.org_id=?1 AND c.server_id=?2 AND c.user_github_id=?3`)
      .bind(orgId, serverId, ownerId, now),
    db.prepare(`UPDATE hx_remote_mcp_oauth_share_sets SET version=version+1,mutation_id=?6,updated_at=?7
      WHERE org_id=?1 AND server_id=?2 AND owner_github_id=?3 AND version=?8
        AND ${ownerIsCurrent} AND ${allMembersCurrent} AND ${allAgentsAvailableToOwner}
      RETURNING version`).bind(orgId, serverId, ownerId, memberJson, agentJson, mutation, now, expectedVersion),
    db.prepare(`DELETE FROM hx_remote_mcp_oauth_shares WHERE org_id=?1 AND server_id=?2 AND owner_github_id=?3
      AND EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_share_sets WHERE org_id=?1 AND server_id=?2 AND owner_github_id=?3 AND mutation_id=?4)`)
      .bind(orgId, serverId, ownerId, mutation),
  ];
  if (everyone) statements.push(db.prepare(`INSERT INTO hx_remote_mcp_oauth_shares
    (org_id,server_id,owner_github_id,audience_type,audience_id,audience_membership_since,created_at)
    SELECT ?1,?2,?3,'workspace','*',NULL,?5 WHERE EXISTS(
      SELECT 1 FROM hx_remote_mcp_oauth_share_sets WHERE org_id=?1 AND server_id=?2 AND owner_github_id=?3 AND mutation_id=?4)`)
    .bind(orgId, serverId, ownerId, mutation, now));
  if (memberIds.length) statements.push(db.prepare(`INSERT INTO hx_remote_mcp_oauth_shares
    (org_id,server_id,owner_github_id,audience_type,audience_id,audience_membership_since,created_at)
    SELECT ?1,?2,?3,'member',CAST(m.user_github_id AS TEXT),m.created_at,?6 FROM json_each(?4) picked
    JOIN memberships m ON m.org_id=?1 AND CAST(m.user_github_id AS TEXT)=picked.value
      AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    WHERE EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_share_sets WHERE org_id=?1 AND server_id=?2 AND owner_github_id=?3 AND mutation_id=?5)`)
    .bind(orgId, serverId, ownerId, memberJson, mutation, now));
  if (agentIds.length) statements.push(db.prepare(`INSERT INTO hx_remote_mcp_oauth_shares
    (org_id,server_id,owner_github_id,audience_type,audience_id,audience_membership_since,created_at)
    SELECT ?1,?2,?3,'agent',a.id,NULL,?6 FROM json_each(?4) picked
    JOIN custom_agents a ON a.org_id=?1 AND a.id=picked.value AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL
    WHERE EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_share_sets WHERE org_id=?1 AND server_id=?2 AND owner_github_id=?3 AND mutation_id=?5)`)
    .bind(orgId, serverId, ownerId, agentJson, mutation, now));
  const result = await db.batch(statements);
  if (!result[1]?.meta?.changes) return { error: 'The connection or audience changed. Reload and try again.', status: 409 };
  const settings = await remoteMcpOAuthShareSettings(db, orgId, serverId, ownerId);
  if (!settings || settings.version !== expectedVersion + 1
    || settings.everyone !== everyone
    || settings.memberIds.length !== memberIds.length || memberIds.some(id => !settings.memberIds.includes(id))
    || settings.agentIds.length !== agentIds.length || agentIds.some(id => !settings.agentIds.includes(id)))
    return { error: 'The connection or audience changed. Reload and try again.', status: 409 };
  return { settings };
}

export async function remoteMcpOAuthAccounts(db, { orgId, serverId, requesterId, agentId }) {
  if (!orgId || !serverId || !requesterId || !agentId) return [];
  const { results = [] } = await db.prepare(`SELECT c.user_github_id AS ownerId,
      COALESCE(owner.name,owner.login) AS ownerName,
      CASE WHEN c.user_github_id=?3 THEN 'own'
        WHEN EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_shares sh WHERE sh.org_id=c.org_id AND sh.server_id=c.server_id
          AND sh.owner_github_id=c.user_github_id AND sh.audience_type='agent' AND sh.audience_id=?4) THEN 'agent'
        WHEN EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_shares sh JOIN memberships recipient
          ON recipient.org_id=sh.org_id AND CAST(recipient.user_github_id AS TEXT)=sh.audience_id
            AND recipient.created_at=sh.audience_membership_since AND LOWER(TRIM(COALESCE(recipient.role,'guest')))!='guest'
          WHERE sh.org_id=c.org_id AND sh.server_id=c.server_id AND sh.owner_github_id=c.user_github_id
            AND sh.audience_type='member' AND CAST(recipient.user_github_id AS TEXT)=?3) THEN 'member'
        ELSE 'workspace' END AS shareType
    FROM hx_remote_mcp_oauth_credentials c
    JOIN memberships owner_membership ON owner_membership.org_id=c.org_id AND owner_membership.user_github_id=c.user_github_id
      AND owner_membership.created_at=c.membership_since AND LOWER(TRIM(COALESCE(owner_membership.role,'guest')))!='guest'
    JOIN users owner ON owner.github_id=c.user_github_id
    JOIN hx_remote_mcp_servers s ON s.org_id=c.org_id AND s.id=c.server_id AND s.auth_mode='oauth'
    JOIN memberships requester ON requester.org_id=c.org_id AND CAST(requester.user_github_id AS TEXT)=?3
      AND LOWER(TRIM(COALESCE(requester.role,'guest')))!='guest'
    WHERE c.org_id=?1 AND c.server_id=?2 AND (
      CAST(c.user_github_id AS TEXT)=?3
      OR EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_shares sh WHERE sh.org_id=c.org_id AND sh.server_id=c.server_id
        AND sh.owner_github_id=c.user_github_id AND sh.audience_type='workspace' AND sh.audience_id='*')
      OR EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_shares sh WHERE sh.org_id=c.org_id AND sh.server_id=c.server_id
        AND sh.owner_github_id=c.user_github_id AND sh.audience_type='member' AND sh.audience_id=?3
          AND sh.audience_membership_since=requester.created_at)
      OR EXISTS(SELECT 1 FROM hx_remote_mcp_oauth_shares sh WHERE sh.org_id=c.org_id AND sh.server_id=c.server_id
        AND sh.owner_github_id=c.user_github_id AND sh.audience_type='agent' AND sh.audience_id=?4
          AND EXISTS(SELECT 1 FROM custom_agents a WHERE a.org_id=?1 AND a.id=?4 AND a.scope='team' AND a.provider IS NULL AND a.deleted_at IS NULL)))
    ORDER BY ownerName COLLATE NOCASE,owner.login,c.user_github_id`)
    .bind(orgId, serverId, String(requesterId), agentId).all().catch(() => ({ results: [] }));
  return results.map(row => ({ ownerId: String(row.ownerId), ownerName: row.ownerName || 'Workspace member', shareType: row.shareType }));
}

export async function remoteMcpOAuthShareType(db, { orgId, serverId, ownerId, requesterId, agentId }) {
  const accounts = await remoteMcpOAuthAccounts(db, { orgId, serverId, requesterId, agentId });
  return accounts.find(account => account.ownerId === String(ownerId))?.shareType || null;
}

export async function disconnectRemoteMcpOAuth(db, orgId, serverId, userId) {
  const result = await db.prepare(`DELETE FROM hx_remote_mcp_oauth_credentials
    WHERE org_id=?1 AND server_id=?2 AND user_github_id=?3
      AND membership_since=(SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?3 AND LOWER(TRIM(COALESCE(role,'guest')))!='guest')`)
    .bind(orgId, serverId, String(userId)).run();
  return Boolean(result.meta?.changes);
}

async function refreshCredential(env, row, credential, authorization = null, actorId = row.user_github_id) {
  if (!credential.refreshToken) return null;
  const server = await env.DB.prepare("SELECT id FROM hx_remote_mcp_servers WHERE org_id=?1 AND id=?2 AND auth_mode='oauth'")
    .bind(row.org_id, row.server_id).first();
  if (!server) return null;
  let tokens;
  try {
    tokens = await exchangeToken(env, { orgId: row.org_id, serverId: row.server_id, actorId, authorization }, credential.tokenEndpoint, {
      grant_type: "refresh_token", refresh_token: credential.refreshToken,
      client_id: credential.clientId, resource: credential.resource,
    }, typeof credential.clientSecret === "string" ? credential.clientSecret : "", credential.tokenAuthMethod || "none");
  } catch { return await latestUsableCredential(env, row); }
  const updated = {
    ...credential,
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : credential.refreshToken,
    expiresAt: Number.isFinite(Number(tokens.expires_in)) && Number(tokens.expires_in) >= 0
      ? Date.now() + Math.min(Number(tokens.expires_in), 365 * 24 * 60 * 60) * 1000 : 0,
    scope: typeof tokens.scope === "string" ? tokens.scope.slice(0, 2000) : credential.scope,
  };
  const sealed = await sealField(JSON.stringify(updated), aad.remoteMcpOAuthCredential(row.org_id, row.server_id, row.user_github_id, row.membership_since), row.org_id);
  const saved = await env.DB.prepare("UPDATE hx_remote_mcp_oauth_credentials SET credential=?5,updated_at=?6 WHERE org_id=?1 AND server_id=?2 AND user_github_id=?3 AND membership_since=?4 AND credential=?7")
    .bind(row.org_id, row.server_id, row.user_github_id, row.membership_since, sealed, new Date().toISOString(), row.credential).run();
  if (Number(saved.meta?.changes) === 0) return (await latestUsableCredential(env, row)) || updated;
  return updated;
}

async function latestUsableCredential(env, row) {
  const current = await env.DB.prepare(`SELECT credential FROM hx_remote_mcp_oauth_credentials
    WHERE org_id=?1 AND server_id=?2 AND user_github_id=?3 AND membership_since=?4`)
    .bind(row.org_id, row.server_id, row.user_github_id, row.membership_since).first().catch(() => null);
  if (!current?.credential || current.credential === row.credential) return null;
  const raw = await openField(current.credential, aad.remoteMcpOAuthCredential(row.org_id, row.server_id, row.user_github_id, row.membership_since));
  const value = parseJSON(raw);
  if (!value || typeof value.accessToken !== "string" || !value.accessToken || (value.expiresAt && value.expiresAt <= Date.now() + 30_000)) return null;
  return value;
}

export async function remoteMcpOAuthAccessToken(env, { orgId, serverId, userId, actorId = userId, authorization = null }) {
  const row = await env.DB.prepare(`SELECT c.* FROM hx_remote_mcp_oauth_credentials c
    JOIN memberships m ON m.org_id=c.org_id AND m.user_github_id=c.user_github_id AND m.created_at=c.membership_since AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
    JOIN hx_remote_mcp_servers s ON s.org_id=c.org_id AND s.id=c.server_id AND s.auth_mode='oauth'
    WHERE c.org_id=?1 AND c.server_id=?2 AND c.user_github_id=?3`)
    .bind(orgId, serverId, String(userId)).first();
  if (!row) return { token: null, error: "Connect your own OAuth account to this Remote MCP server first." };
  const raw = await openField(row.credential, aad.remoteMcpOAuthCredential(row.org_id, row.server_id, row.user_github_id, row.membership_since));
  const credential = parseJSON(raw);
  if (!credential || typeof credential.accessToken !== "string" || !credential.accessToken) {
    return { token: null, error: "The OAuth credential is unavailable. Reconnect this Remote MCP server." };
  }
  if (credential.expiresAt && credential.expiresAt <= Date.now() + 30_000) {
    const refreshed = await refreshCredential(env, row, credential, authorization, actorId);
    if (!refreshed) return { token: null, error: "The OAuth authorization expired. Reconnect this Remote MCP server." };
    return { token: refreshed.accessToken, error: null };
  }
  return { token: credential.accessToken, error: null };
}

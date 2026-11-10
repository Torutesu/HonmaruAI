import { sha256Hex } from './auth.js';
import { getSession, getUserByGithubId, listUserOrgs } from './db.js';
import { policyDenial } from './policy.js';
import { ssoRequiredFor } from './sso.js';
import { ipDenial } from './governance.js';
import { deactivatedHere } from './scim.js';
import { enforce } from './ratelimit.js';
import { audit } from './audit.js';
import { allowedOrigins } from './cors.js';
import { MCP_CONNECTOR_SCOPES, MCP_SCOPE_INFO } from './mcpScopes.js';

const HOUR = 3600000;
const MONTH = 30 * 24 * HOUR;
const PREFIX = '/mcp/oauth';
const noStore = { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'access-control-allow-origin': '*' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: noStore });
const error = (code, description, status = 400) => json({ error: code, error_description: description }, status);
const random = prefix => prefix + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const parse = raw => JSON.parse(raw);
const loopback = u => u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
function validUrl(raw) {
  try {
    const u = new URL(raw);
    return !raw.includes('#') && !u.username && !u.password && !u.hash && (u.protocol === 'https:' || loopback(u)) ? u.href : null;
  } catch { return null; }
}
export function mcpResource(env, request) {
  const raw = env.MCP_PUBLIC_URL || new URL('/mcp', request.url).href;
  const value = validUrl(raw);
  if (!value || new URL(value).search || new URL(value).pathname !== '/mcp') throw new Error('Invalid MCP_PUBLIC_URL.');
  return value;
}
function baseUrl(env, request) { return new URL(mcpResource(env, request)).origin; }
async function body(request) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  let size = 0;
  const parts = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 16384) { await reader.cancel(); throw new Error('Body too large.'); }
    parts.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const text = new TextDecoder().decode(bytes);
  const type = (request.headers.get('content-type') || '').split(';')[0];
  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(text);
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new Error('Duplicate field.');
    return Object.fromEntries(params);
  }
  if (type !== 'application/json') throw new Error('Unsupported content type.');
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an object.');
  return result;
}
function scopeList(raw) {
  const scopes = typeof raw === 'string' ? raw.trim().split(/\s+/).filter(Boolean) : raw;
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > MCP_CONNECTOR_SCOPES.length || scopes.some(s => !MCP_CONNECTOR_SCOPES.includes(s))) return null;
  return [...new Set(scopes)];
}
async function sessionFor(env, request) {
  const session = await getSession(env.DB, request.headers.get('x-session-token'));
  return session ? { session, user: await getUserByGithubId(env.DB, session.github_id) } : null;
}
async function currentGrant(env, grantId) {
  const grant = await env.DB.prepare(`SELECT g.*, c.name AS client_name FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id=g.client_id
    JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.user_id AND m.created_at=g.membership_since
    WHERE g.id=?1 AND g.revoked_at IS NULL AND g.expires_at>?2 AND c.disabled_at IS NULL AND lower(trim(coalesce(m.role,'guest')))!='guest'
    AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=g.org_id AND (d.purge_started_at IS NOT NULL OR d.due_at<=?3))`)
    .bind(grantId, Date.now(), new Date().toISOString()).first();
  if (!grant || await deactivatedHere(env.DB, grant.org_id, grant.user_id, { fresh: true })) return null;
  if (!grant.sso_backed && await ssoRequiredFor(env.DB, grant.org_id, grant.user_id, { fresh: true })) return null;
  return grant;
}
export async function resolveMcpGrantActor(env, { grantId }) {
  const grant = await currentGrant(env, grantId);
  if (!grant) return null;
  const user = await getUserByGithubId(env.DB, grant.user_id);
  if (!user?.login) return null;
  return { orgId: grant.org_id, githubId: grant.user_id, login: user.login, name: user.name || user.login,
    tokenId: `oauth:${grant.id}`, agentName: grant.client_name, scopes: parse(grant.scopes), ssoBacked: Boolean(grant.sso_backed),
    grantId: grant.id, clientId: grant.client_id, authorization: { kind: 'oauth', grantId: grant.id, clientId: grant.client_id }, resource: grant.resource };
}
export async function isMcpOAuthGrantCurrent(env, grantId) { return Boolean(await currentGrant(env, grantId)); }
export async function resolveMcpOAuthToken(env, header, request) {
  const match = /^Bearer (hmoa_[a-f0-9]{64})$/i.exec(header || '');
  if (!match) return null;
  const token = await env.DB.prepare("SELECT grant_id FROM mcp_oauth_tokens WHERE token_hash=?1 AND kind='access' AND expires_at>?2 AND consumed_at IS NULL")
    .bind(await sha256Hex(match[1]), Date.now()).first();
  if (!token) return null;
  const actor = await resolveMcpGrantActor(env, { grantId: token.grant_id });
  if (!actor || (request && actor.resource !== mcpResource(env, request))) return null;
  if (request && await ipDenial(env, actor.orgId, request.headers.get('CF-Connecting-IP') || '', { fresh: true })) return null;
  await env.DB.prepare('UPDATE mcp_oauth_grants SET last_used_at=?1 WHERE id=?2').bind(Date.now(), actor.grantId).run();
  return actor;
}
export async function sweepMcpOAuth(env) {
  const now = Date.now();
  for (const table of ['mcp_oauth_requests', 'mcp_oauth_codes', 'mcp_oauth_tokens', 'mcp_oauth_grants']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE expires_at<=?1 LIMIT 500)`).bind(now).run();
  }
}
async function recordRevocation(env, request, grant, reason, actor = { type: 'system' }) {
  if (!grant) return;
  await audit(env, request, { orgId: grant.org_id, action: 'mcp.connection_revoked', actor,
    entity: { type: 'mcp_connection', id: grant.id }, details: { clientId: grant.client_id, reason } });
}
async function revokeGrant(env, request, grantId, reason) {
  const grant = await env.DB.prepare('UPDATE mcp_oauth_grants SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL RETURNING id,org_id,client_id').bind(Date.now(), grantId).first();
  await recordRevocation(env, request, grant, reason);
}
async function issueTokens(env, grant) {
  const access = random('hmoa_'), refresh = random('hmor_'), now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO mcp_oauth_tokens(token_hash,grant_id,kind,expires_at) VALUES(?1,?2,'access',?3)").bind(await sha256Hex(access), grant.id, Math.min(now + HOUR, grant.expires_at)),
    env.DB.prepare("INSERT INTO mcp_oauth_tokens(token_hash,grant_id,kind,expires_at) VALUES(?1,?2,'refresh',?3)").bind(await sha256Hex(refresh), grant.id, grant.expires_at),
  ]);
  return json({ access_token: access, token_type: 'Bearer', expires_in: Math.floor((Math.min(now + HOUR, grant.expires_at) - now) / 1000), refresh_token: refresh, scope: parse(grant.scopes).join(' ') });
}
async function exchange(env, request, input) {
  if (request.headers.has('authorization') || typeof input.client_id !== 'string' || input.resource !== mcpResource(env, request)) return error('invalid_request', 'A registered public client and exact resource are required.');
  const client = await env.DB.prepare('SELECT id FROM mcp_oauth_clients WHERE id=?1 AND disabled_at IS NULL').bind(input.client_id).first();
  if (!client) return error('invalid_client', 'Unknown client.', 401);
  if (input.grant_type === 'authorization_code') {
    if (!/^hmoc_[a-f0-9]{64}$/.test(input.code || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier || '')) return error('invalid_grant', 'Invalid authorization code.');
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.code_verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const code = await env.DB.prepare(`UPDATE mcp_oauth_codes SET consumed_at=?1 WHERE code_hash=?2 AND client_id=?3 AND redirect_uri=?4 AND resource=?5 AND challenge=?6 AND expires_at>?1 AND consumed_at IS NULL RETURNING grant_id`)
      .bind(Date.now(), await sha256Hex(input.code), input.client_id, input.redirect_uri || '', input.resource, challenge).first();
    const grant = code && await currentGrant(env, code.grant_id);
    if (!grant) return error('invalid_grant', 'Invalid authorization code.');
    if (await ipDenial(env, grant.org_id, request.headers.get('CF-Connecting-IP') || '', { fresh: true })) return error('access_denied', 'Workspace network policy denied this request.', 403);
    return issueTokens(env, grant);
  }
  if (input.grant_type === 'refresh_token') {
    if (!/^hmor_[a-f0-9]{64}$/.test(input.refresh_token || '')) return error('invalid_grant', 'Invalid refresh token.');
    const hash = await sha256Hex(input.refresh_token);
    const existing = await env.DB.prepare("SELECT t.*,g.client_id,g.resource FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=?1 AND t.kind='refresh'").bind(hash).first();
    if (!existing || existing.client_id !== input.client_id || existing.resource !== input.resource) return error('invalid_grant', 'Invalid refresh token.');
    if (existing.consumed_at) {
      await revokeGrant(env, request, existing.grant_id, 'refresh_replay');
      return error('invalid_grant', 'Refresh token has already been used. Reconnect this app.');
    }
    const grant = await currentGrant(env, existing.grant_id);
    if (!grant || existing.expires_at <= Date.now() || (input.scope && input.scope !== parse(grant.scopes).join(' '))) return error('invalid_grant', 'Invalid refresh token.');
    if (await ipDenial(env, grant.org_id, request.headers.get('CF-Connecting-IP') || '', { fresh: true })) return error('access_denied', 'Workspace network policy denied this request.', 403);
    const consumed = await env.DB.prepare('UPDATE mcp_oauth_tokens SET consumed_at=?1 WHERE token_hash=?2 AND consumed_at IS NULL AND expires_at>?1 RETURNING grant_id').bind(Date.now(), hash).first();
    if (!consumed) {
      await revokeGrant(env, request, grant.id, 'refresh_replay');
      return error('invalid_grant', 'Refresh token has already been used. Reconnect this app.');
    }
    return issueTokens(env, grant);
  }
  return error('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

export async function handleMcpOAuth(request, env, url = new URL(request.url)) {
  const path = url.pathname;
  const protectedPath = path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp';
  const serverPath = path === '/.well-known/oauth-authorization-server';
  if (protectedPath || serverPath) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', ...noStore } });
    const base = baseUrl(env, request);
    return json(protectedPath ? { resource: mcpResource(env, request), authorization_servers: [base], scopes_supported: MCP_CONNECTOR_SCOPES, bearer_methods_supported: ['header'] } : {
      issuer: base, authorization_endpoint: `${base}${PREFIX}/authorize`, token_endpoint: `${base}${PREFIX}/token`, revocation_endpoint: `${base}${PREFIX}/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: MCP_CONNECTOR_SCOPES,
    });
  }
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const origin = request.headers.get('origin');
  const allowed = new Set([...allowedOrigins(env), new URL(request.url).origin, ...String(env.MCP_CORS_ORIGINS || '').split(/[\s,]+/).filter(Boolean)]);
  if (origin && !allowed.has(origin)) return error('access_denied', 'Origin is not allowed.', 403);
  const limited = await enforce(env, request, path === `${PREFIX}/token` ? 'mcp/oauth-token' : 'mcp/oauth');
  if (limited) return limited;
  try {
    if (path === `${PREFIX}/authorize` && request.method === 'GET') {
      for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) return error('invalid_request', 'Duplicate authorization parameter.');
      const input = Object.fromEntries(url.searchParams);
      const client = typeof input.client_id === 'string' && await env.DB.prepare('SELECT * FROM mcp_oauth_clients WHERE id=?1 AND disabled_at IS NULL').bind(input.client_id).first();
      const scopes = scopeList(input.scope);
      if (!client || !parse(client.redirect_uris).includes(input.redirect_uri)) return error('invalid_request', 'Unknown client or redirect URI.');
      if (input.response_type !== 'code' || input.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge || '') || input.resource !== mcpResource(env, request) || !scopes || typeof input.state !== 'string' || !input.state || input.state.length > 1024) return error('invalid_request', 'Use code, S256 PKCE, an exact resource, state, and supported scopes.');
      const id = random('hmreq_');
      await env.DB.prepare('INSERT INTO mcp_oauth_requests(id,client_id,redirect_uri,resource,scopes,state,challenge,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(id, client.id, input.redirect_uri, input.resource, JSON.stringify(scopes), input.state, input.code_challenge, Date.now() + 10 * 60000).run();
      const app = new URL(env.APP_WEB_URL || new URL(request.url).origin);
      if (app.protocol !== 'https:' && !loopback(app)) return error('server_error', 'The consent page is not configured.', 503);
      app.hash = `/mcp/consent/${id}`;
      return new Response(null, { status: 302, headers: { location: app.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    if (path === `${PREFIX}/token` && request.method === 'POST') return exchange(env, request, await body(request));
    if (path === `${PREFIX}/revoke` && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.token !== 'string' || typeof input.client_id !== 'string') return error('invalid_request', 'Token and client_id are required.');
      const grant = await env.DB.prepare('UPDATE mcp_oauth_grants SET revoked_at=?1 WHERE client_id=?2 AND revoked_at IS NULL AND id IN(SELECT grant_id FROM mcp_oauth_tokens WHERE token_hash=?3) RETURNING id,org_id,client_id').bind(Date.now(), input.client_id, await sha256Hex(input.token)).first();
      await recordRevocation(env, request, grant, 'client_revocation');
      return json({});
    }
    const who = await sessionFor(env, request);
    if (!who?.user) return error('unauthorized', 'Sign in to Honmaru to continue.', 401);
    if (path === `${PREFIX}/scopes` && request.method === 'GET') return json({ scopes: MCP_SCOPE_INFO });
    if (path === `${PREFIX}/clients`) {
      if (request.method === 'GET') {
        const rows = await env.DB.prepare('SELECT id,name,redirect_uris,created_at FROM mcp_oauth_clients WHERE owner_id=?1 AND disabled_at IS NULL ORDER BY created_at DESC LIMIT 20').bind(String(who.session.github_id)).all();
        return json({ clients: rows.results.map(r => ({ id: r.id, name: r.name, redirectUris: parse(r.redirect_uris), createdAt: r.created_at })), resource: mcpResource(env, request) });
      }
      if (request.method === 'POST') {
        const input = await body(request);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !Array.isArray(input.redirectUris) || !input.redirectUris.length || input.redirectUris.length > 10 || input.redirectUris.some(uri => typeof uri !== 'string' || uri.length > 2048 || validUrl(uri) !== uri)) return error('invalid_client_metadata', 'Provide an app name and exact HTTPS or loopback redirect URIs without fragments.');
        const id = random('hmclient_');
        const saved = await env.DB.prepare('INSERT INTO mcp_oauth_clients(id,owner_id,name,redirect_uris,created_at) SELECT ?1,?2,?3,?4,?5 WHERE (SELECT COUNT(*) FROM mcp_oauth_clients WHERE owner_id=?2 AND disabled_at IS NULL)<20 RETURNING id')
          .bind(id, String(who.session.github_id), input.name.trim(), JSON.stringify([...new Set(input.redirectUris)]), Date.now()).first();
        return saved ? json({ client_id: id, client_name: input.name.trim(), redirect_uris: input.redirectUris, token_endpoint_auth_method: 'none' }, 201) : error('invalid_request', 'Revoke an existing app before registering another.');
      }
    }
    if (path.startsWith(`${PREFIX}/clients/`) && request.method === 'DELETE') {
      const row = await env.DB.prepare('UPDATE mcp_oauth_clients SET disabled_at=?1 WHERE id=?2 AND owner_id=?3 RETURNING id').bind(Date.now(), path.slice(`${PREFIX}/clients/`.length), String(who.session.github_id)).first();
      return row ? json({ revoked: true }) : error('not_found', 'App not found.', 404);
    }
    if (path === `${PREFIX}/connections` && request.method === 'GET') {
      const rows = await env.DB.prepare(`SELECT g.id,g.org_id,g.scopes,g.created_at,g.last_used_at,g.expires_at,g.client_id,c.name,c.redirect_uris FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id=g.client_id WHERE g.user_id=?1 AND g.revoked_at IS NULL AND g.expires_at>?2 AND c.disabled_at IS NULL ORDER BY g.created_at DESC LIMIT 100`).bind(String(who.session.github_id), Date.now()).all();
      return json({ connections: rows.results.map(r => ({ id: r.id, orgId: r.org_id, name: r.name, clientId: r.client_id, redirectOrigins: [...new Set(parse(r.redirect_uris).map(uri => new URL(uri).origin))], scopes: parse(r.scopes), createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at })) });
    }
    if (path.startsWith(`${PREFIX}/connections/`) && request.method === 'DELETE') {
      const row = await env.DB.prepare('UPDATE mcp_oauth_grants SET revoked_at=?1 WHERE id=?2 AND user_id=?3 RETURNING id,org_id,client_id').bind(Date.now(), path.slice(`${PREFIX}/connections/`.length), String(who.session.github_id)).first();
      await recordRevocation(env, request, row, 'user_disconnect', { type: 'user', id: who.user.login, name: who.user.name });
      return row ? json({ revoked: true }) : error('not_found', 'Connection not found.', 404);
    }
    const match = new RegExp(`^${PREFIX}/requests/(hmreq_[a-f0-9]{64})$`).exec(path);
    if (match && ['GET', 'POST'].includes(request.method)) {
      const pending = await env.DB.prepare(`SELECT r.*,c.name AS client_name FROM mcp_oauth_requests r JOIN mcp_oauth_clients c ON c.id=r.client_id WHERE r.id=?1 AND r.expires_at>?2 AND r.consumed_at IS NULL AND c.disabled_at IS NULL`).bind(match[1], Date.now()).first();
      if (!pending) return error('invalid_request', 'This connection request expired or was already used. Restart from your app.');
      const requested = parse(pending.scopes);
      if (request.method === 'GET') return json({ clientName: pending.client_name, clientId: pending.client_id, redirectOrigin: new URL(pending.redirect_uri).origin, scopes: MCP_SCOPE_INFO.filter(s => requested.includes(s.name)), workspaces: (await listUserOrgs(env.DB, who.session.github_id)).filter(o => String(o.role).trim().toLowerCase() !== 'guest') });
      const input = await body(request);
      if (input.approve !== true && input.approve !== false) return error('invalid_request', 'Choose Allow or Deny.');
      const redirect = new URL(pending.redirect_uri);
      redirect.searchParams.set('state', pending.state);
      if (!input.approve) {
        const consumed = await env.DB.prepare('UPDATE mcp_oauth_requests SET consumed_at=?1 WHERE id=?2 AND consumed_at IS NULL AND expires_at>?1 RETURNING id').bind(Date.now(), pending.id).first();
        if (!consumed) return error('invalid_request', 'Request already used.');
        redirect.searchParams.set('error', 'access_denied');
        return json({ redirectUrl: redirect.href });
      }
      const granted = scopeList(input.scopes);
      if (typeof input.orgId !== 'string' || !granted || granted.some(s => !requested.includes(s))) return error('invalid_scope', 'Choose a workspace and a subset of the requested permissions.');
      const member = await env.DB.prepare('SELECT role,created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(input.orgId, String(who.session.github_id)).first();
      if (!member || String(member.role).trim().toLowerCase() === 'guest') return error('access_denied', 'Workspace membership is required.', 403);
      const denied = await policyDenial(env, who.session, input.orgId, { fresh: true });
      if (denied) return json(denied.body, denied.status);
      const consumed = await env.DB.prepare('UPDATE mcp_oauth_requests SET consumed_at=?1 WHERE id=?2 AND consumed_at IS NULL AND expires_at>?1 RETURNING id').bind(Date.now(), pending.id).first();
      if (!consumed) return error('invalid_request', 'Request already used.');
      const grantId = random('hmgrant_'), code = random('hmoc_'), now = Date.now();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO mcp_oauth_grants(id,client_id,org_id,user_id,membership_since,scopes,resource,sso_backed,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)')
          .bind(grantId, pending.client_id, input.orgId, String(who.session.github_id), member.created_at, JSON.stringify(granted), pending.resource, who.session.auth_method === 'sso' && who.session.sso_org_id === input.orgId ? 1 : 0, now, now + MONTH),
        env.DB.prepare('INSERT INTO mcp_oauth_codes(code_hash,grant_id,client_id,redirect_uri,resource,challenge,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7)')
          .bind(await sha256Hex(code), grantId, pending.client_id, pending.redirect_uri, pending.resource, pending.challenge, now + 300000),
      ]);
      await audit(env, request, { orgId: input.orgId, action: 'mcp.connection_granted', actor: { type: 'user', id: who.user.login, name: who.user.name }, entity: { type: 'mcp_connection', id: grantId }, details: { clientId: pending.client_id, scopes: granted } });
      redirect.searchParams.set('code', code);
      return json({ redirectUrl: redirect.href });
    }
    return error('not_found', 'OAuth endpoint not found.', 404);
  } catch {
    return error('invalid_request', 'The request could not be processed. Check the parameters and try again.');
  }
}

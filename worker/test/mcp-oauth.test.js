import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import { handleMcpOAuth, resolveMcpOAuthToken, resolveMcpGrantActor, sweepMcpOAuth } from '../src/mcpOAuth.js';
import { createSession, upsertUser, upsertMembership } from '../src/db.js';
const ORG = 'personal:mcp-oauth', resource = 'https://example.com/mcp', verifier = 'a'.repeat(64);
const configuration = () => ({ ...env, APP_WEB_URL: 'https://app.honmaruai.com', MCP_PUBLIC_URL: resource });
let session, client;
const call = (path, { method = 'GET', data, token, headers = {} } = {}) => handleMcpOAuth(new Request(`https://example.com${path}`, { method, headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-session-token': token } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }), configuration());
async function authorization(extra = {}) {
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return call(`/mcp/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', resource, scope: 'chat:read chat:write chat:private', state: 'client-state', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, ...extra })}`);
}
async function requestId() {
  const response = await authorization();
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location')).hash.split('/').pop();
}
async function consent(scopes = ['chat:read']) {
  const id = await requestId();
  const response = await call(`/mcp/oauth/requests/${id}`, { method: 'POST', token: session, data: { approve: true, orgId: ORG, scopes } });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  const redirect = new URL(result.redirectUrl);
  expect(redirect.searchParams.get('state')).toBe('client-state');
  return { id, code: redirect.searchParams.get('code') };
}
const exchange = (code, extra = {}) => call('/mcp/oauth/token', { method: 'POST', data: { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: 'https://client.example/callback', resource, code, code_verifier: verifier, ...extra } });
async function token() {
  const response = await exchange((await consent()).code);
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
const actor = value => resolveMcpOAuthToken(configuration(), `Bearer ${value}`, new Request(resource));
beforeEach(async () => {
  await upsertUser(env.DB, { githubId: '7401', login: 'mcp-user', name: 'MCP User', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '7401', 'admin');
  session = await createSession(env.DB, '7401', 'github-unused');
  const response = await call('/mcp/oauth/clients', { method: 'POST', token: session, data: { name: 'Claw test', redirectUris: ['https://client.example/callback'] } });
  expect(response.status).toBe(201);
  client = await response.json();
});
test('discovery advertises PKCE and registered public clients', async () => {
  const metadata = await (await call('/.well-known/oauth-authorization-server')).json();
  expect(metadata).toMatchObject({ issuer: 'https://example.com', token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
  expect(metadata.registration_endpoint).toBeUndefined();
  expect((await (await call('/.well-known/oauth-protected-resource/mcp')).json()).resource).toBe(resource);
});
test('real-session consent issues a hashed token for selected scopes and workspace', async () => {
  const granted = await token(), who = await actor(granted.access_token);
  expect(who).toMatchObject({ orgId: ORG, login: 'mcp-user', scopes: ['chat:read'], clientId: client.client_id });
  const connections = await (await call('/mcp/oauth/connections', { token: session })).json();
  expect(connections.connections).toEqual([expect.objectContaining({ clientId: client.client_id, redirectOrigins: ['https://client.example'] })]);
  expect(await resolveMcpGrantActor(configuration(), { grantId: who.grantId })).toMatchObject({ login: 'mcp-user' });
  const rows = await env.DB.prepare('SELECT * FROM mcp_oauth_tokens').all();
  expect(JSON.stringify(rows)).not.toContain(granted.access_token);
  expect(JSON.stringify(rows)).not.toContain(granted.refresh_token);
});
test('authorization refuses redirect changes, duplicate parameters, missing state, and plain PKCE', async () => {
  expect((await authorization({ redirect_uri: 'https://evil.example/' })).status).toBe(400);
  expect((await authorization({ code_challenge_method: 'plain' })).status).toBe(400);
  expect((await authorization({ state: '' })).status).toBe(400);
  const response = await call(`/mcp/oauth/authorize?client_id=${client.client_id}&client_id=other`);
  expect(response.status).toBe(400); expect(response.headers.get('location')).toBeNull();
});
test('consent requires a real session, workspace membership, and requested scopes', async () => {
  const id = await requestId();
  expect((await call(`/mcp/oauth/requests/${id}`)).status).toBe(401);
  expect((await call(`/mcp/oauth/requests/${id}`, { method: 'POST', token: session, data: { approve: true, orgId: 'other', scopes: ['chat:read'] } })).status).toBe(403);
  expect((await call(`/mcp/oauth/requests/${id}`, { method: 'POST', token: session, data: { approve: true, orgId: ORG, scopes: ['files:write'] } })).status).toBe(400);
  expect((await call(`/mcp/oauth/requests/${id}`, { method: 'POST', token: session, data: { approve: false } })).status).toBe(200);
  expect((await call(`/mcp/oauth/requests/${id}`, { token: session })).status).toBe(400);
});
test('exchange validates PKCE, client, redirect, and audience before consuming code once', async () => {
  const { code } = await consent();
  expect((await exchange(code, { code_verifier: 'b'.repeat(64) })).status).toBe(400);
  expect((await exchange(code, { client_id: 'another' })).status).toBe(401);
  expect((await exchange(code, { redirect_uri: 'https://client.example/other' })).status).toBe(400);
  expect((await exchange(code, { resource: 'https://other.example/mcp' })).status).toBe(400);
  expect((await exchange(code)).status).toBe(200);
  expect((await exchange(code)).status).toBe(400);
});
test('concurrent exchanges have one winner', async () => {
  const { code } = await consent();
  const responses = await Promise.all([exchange(code), exchange(code)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM mcp_oauth_tokens WHERE kind='access'").first()).n).toBe(1);
});
test('expired requests and codes cannot issue tokens', async () => {
  const id = await requestId();
  await env.DB.prepare('UPDATE mcp_oauth_requests SET expires_at=0 WHERE id=?1').bind(id).run();
  expect((await call(`/mcp/oauth/requests/${id}`, { token: session })).status).toBe(400);
  const { code } = await consent();
  await env.DB.prepare('UPDATE mcp_oauth_codes SET expires_at=0').run();
  expect((await exchange(code)).status).toBe(400);
});
test('refresh rotates and reuse revokes the grant', async () => {
  const first = await token();
  const data = { grant_type: 'refresh_token', client_id: client.client_id, resource, refresh_token: first.refresh_token };
  const response = await call('/mcp/oauth/token', { method: 'POST', data });
  expect(response.status).toBe(200);
  const next = await response.json();
  expect(next.refresh_token).not.toBe(first.refresh_token);
  expect(await actor(next.access_token)).not.toBeNull();
  expect((await call('/mcp/oauth/token', { method: 'POST', data })).status).toBe(400);
  expect(await actor(next.access_token)).toBeNull();
});
test('disconnect and client revocation invalidate outstanding tokens', async () => {
  const first = await token(), who = await actor(first.access_token);
  expect((await call(`/mcp/oauth/connections/${who.grantId}`, { method: 'DELETE', token: session })).status).toBe(200);
  expect(await actor(first.access_token)).toBeNull();
  const second = await token();
  expect((await call(`/mcp/oauth/clients/${client.client_id}`, { method: 'DELETE', token: session })).status).toBe(200);
  expect(await actor(second.access_token)).toBeNull();
});
test('removal and rejoining cannot restore a grant', async () => {
  const first = await token();
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG, '7401').run();
  expect(await actor(first.access_token)).toBeNull();
  await upsertMembership(env.DB, ORG, '7401', 'member');
  await env.DB.prepare("UPDATE memberships SET created_at='2030-01-01T00:00:00.000Z' WHERE org_id=?1").bind(ORG).run();
  expect(await actor(first.access_token)).toBeNull();
});
test('guest conversion, expiry, and audience mismatch fail closed', async () => {
  const first = await token();
  expect(await resolveMcpOAuthToken({ ...configuration(), MCP_PUBLIC_URL: 'https://different.example/mcp' }, `Bearer ${first.access_token}`, new Request('https://different.example/mcp'))).toBeNull();
  await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=?1").bind(ORG).run();
  expect(await actor(first.access_token)).toBeNull();
  await env.DB.prepare("UPDATE memberships SET role='member' WHERE org_id=?1").bind(ORG).run();
  await env.DB.prepare('UPDATE mcp_oauth_grants SET expires_at=0').run();
  expect(await actor(first.access_token)).toBeNull();
});
test('unregistered origins and unsafe redirects are rejected', async () => {
  expect((await call('/mcp/oauth/clients', { method: 'POST', token: session, headers: { origin: 'https://evil.example' }, data: { name: 'Bad app', redirectUris: ['https://client.example/callback'] } })).status).toBe(403);
  for (const redirect of ['javascript:alert(1)', 'http://example.com/callback', 'https://x.test/cb#fragment', 'https://x.test/cb#', 'https://user:pass@x.test/cb']) {
    expect((await call('/mcp/oauth/clients', { method: 'POST', token: session, data: { name: 'Bad app', redirectUris: [redirect] } })).status).toBe(400);
  }
});

test('SSO policy storage failures cannot authorize a connector', async () => {
  const first = await token();
  const DB = {
    prepare(sql) {
      if (sql.includes('FROM org_sso WHERE')) return { bind: () => ({ first: () => Promise.reject(new Error('SSO storage unavailable')) }) };
      return env.DB.prepare(sql);
    },
  };
  await expect(resolveMcpOAuthToken({ ...configuration(), DB }, `Bearer ${first.access_token}`, new Request(resource))).rejects.toThrow('SSO storage unavailable');
});
test('expiry cleanup retains live credentials and consumed refresh replay evidence', async () => {
  const first = await token();
  const response = await call('/mcp/oauth/token', { method: 'POST', data: { grant_type: 'refresh_token', client_id: client.client_id, resource, refresh_token: first.refresh_token } });
  const next = await response.json();
  const id = await requestId();
  await env.DB.prepare('UPDATE mcp_oauth_requests SET expires_at=0 WHERE id=?1').bind(id).run();
  await env.DB.prepare('UPDATE mcp_oauth_codes SET expires_at=0').run();
  await sweepMcpOAuth(configuration());
  expect(await env.DB.prepare('SELECT id FROM mcp_oauth_requests WHERE id=?1').bind(id).first()).toBeNull();
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM mcp_oauth_codes').first()).n).toBe(0);
  expect(await actor(next.access_token)).not.toBeNull();
  expect((await call('/mcp/oauth/token', { method: 'POST', data: { grant_type: 'refresh_token', client_id: client.client_id, resource, refresh_token: first.refresh_token } })).status).toBe(400);
  expect(await actor(next.access_token)).toBeNull();
});

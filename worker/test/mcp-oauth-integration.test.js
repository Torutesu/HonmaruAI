import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { upsertUser, upsertMembership, createSession } from '../src/db.js';

let session;
const base = 'https://example.com';
const call = (path, method = 'GET', input, token) => worker.fetch(new Request(base + path, {
  method, headers: { ...(input ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-session-token': token } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}),
}), env);
const rpc = (token, method, params) => worker.fetch(new Request(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env);

beforeEach(async () => {
  await upsertUser(env.DB, { githubId: 'oauth-integration', login: 'integration', name: 'Integration', locale: 'en' });
  await upsertMembership(env.DB, 'personal:integration', 'oauth-integration', 'admin');
  session = await createSession(env.DB, 'oauth-integration', 'test');
});

test('a real-session consent grants a client scoped MCP access and revocation ends it', async () => {
  const metadata = await (await call('/.well-known/oauth-protected-resource/mcp')).json();
  expect(metadata.resource).toBe(base + '/mcp');
  expect((await rpc('', 'tools/list', {})).headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
  const server = await (await call('/.well-known/oauth-authorization-server')).json();
  expect(server.code_challenge_methods_supported).toEqual(['S256']);
  const client = await (await call('/mcp/oauth/clients', 'POST', { name: 'Integration client', redirectUris: ['https://client.example/callback'] }, session)).json();
  const verifier = 'v'.repeat(64);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', resource: metadata.resource, scope: 'chat:read', state: 'independent-state', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
  const authorization = await call('/mcp/oauth/authorize?' + query);
  expect(authorization.status).toBe(302);
  const requestId = new URL(authorization.headers.get('location')).hash.split('/').at(-1);
  expect((await call('/mcp/oauth/requests/' + requestId)).status).toBe(401);
  const consent = await (await call('/mcp/oauth/requests/' + requestId, 'POST', { approve: true, orgId: 'personal:integration', scopes: ['chat:read'] }, session)).json();
  const redirect = new URL(consent.redirectUrl);
  expect(redirect.searchParams.get('state')).toBe('independent-state');
  const exchange = { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: 'https://client.example/callback', resource: metadata.resource };
  const tokens = await (await call('/mcp/oauth/token', 'POST', exchange)).json();
  expect(tokens.access_token).toMatch(/^hmoa_/);
  expect((await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-11-25' })).status).toBe(200);
  const listing = await (await rpc(tokens.access_token, 'tools/list', {})).json();
  expect(listing.result.tools.every(tool => tool.name !== 'run_javascript' && tool.name !== 'request_decision')).toBe(true);
  expect((await (await rpc(tokens.access_token, 'tools/call', { name: 'get_playbook', arguments: {} })).json()).result.isError).toBe(true);
  const grants = await (await call('/mcp/oauth/connections', 'GET', undefined, session)).json();
  expect(grants.connections).toHaveLength(1);
  expect((await call('/mcp/oauth/connections/' + grants.connections[0].id, 'DELETE', undefined, session)).status).toBe(200);
  expect((await rpc(tokens.access_token, 'tools/list', {})).status).toBe(401);
  expect((await call('/mcp/oauth/token', 'POST', exchange)).status).toBe(400);
});

test('configured browser clients keep CORS through the Worker token endpoint and preflight', async () => {
  const configured = { ...env, MCP_CORS_ORIGINS: 'https://client.example' };
  for (const origin of ['https://client.example', 'https://untrusted.example']) {
    const preflight = await worker.fetch(new Request(base + '/mcp/oauth/token', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }), configured);
    const exchange = await worker.fetch(new Request(base + '/mcp/oauth/token', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code' }) }), configured);
    if (origin === 'https://client.example') {
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(exchange.status).toBe(400);
      expect(exchange.headers.get('access-control-allow-origin')).toBe('*');
    } else {
      expect(preflight.status).toBe(403);
      expect(exchange.status).toBe(403);
    }
  }
});

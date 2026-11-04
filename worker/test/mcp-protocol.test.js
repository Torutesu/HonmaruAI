import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { createApiToken } from '../src/mcp.js';
import { upsertUser, upsertMembership } from '../src/db.js';
import { validateMcpInput, McpInputError } from '../src/mcpSupport.js';

let token;
beforeEach(async () => {
  await upsertUser(env.DB, { githubId: 'protocol-user', login: 'protocol', name: 'Protocol', locale: 'en' });
  await upsertMembership(env.DB, 'personal:protocol', 'protocol-user', 'admin');
  token = (await createApiToken(env.DB, { orgId: 'personal:protocol', githubId: 'protocol-user', name: 'Client' })).token;
});
const rpc = (body, headers = {}) => worker.fetch(new Request('https://example.com/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), env);

test('negotiates current transport while retaining older supported clients', async () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect((await response.json()).result.protocolVersion).toBe(version);
  }
  expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-protocol-version': 'unsupported' })).status).toBe(400);
});

test('rejects a batch without executing or silently dropping any operation', async () => {
  const response = await rpc(Array.from({ length: 21 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'request_decision', arguments: { title: 'must not happen' } } })));
  expect(response.status).toBe(400);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM cards WHERE org_id=?').bind('personal:protocol').first()).n).toBe(0);
});

test('notifications return no body and cannot invoke a write tool', async () => {
  const response = await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'request_decision', arguments: { title: 'must not happen' } } });
  expect(response.status).toBe(202);
  expect(await response.text()).toBe('');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM cards WHERE org_id=?').bind('personal:protocol').first()).n).toBe(0);
});

test('rejects malformed envelopes, argument shapes, invalid JSON and oversized input', async () => {
  for (const body of [{ jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]) {
    expect(await (await rpc(body)).json()).toMatchObject({ jsonrpc: '2.0', id: body.id === 1 ? 1 : null, error: { code: -32600 } });
  }
  expect((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_playbook', arguments: [] } })).json()).error.code).toBe(-32602);
  expect((await rpc('{')).status).toBe(400);
  expect((await rpc('x'.repeat(1024 * 1024 + 1))).status).toBe(413);
  expect((await rpc('{}', { 'content-type': 'text/plain' })).status).toBe(415);
});

test('validates browser origins before both calls and preflights', async () => {
  expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://untrusted.example' })).status).toBe(403);
  expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://app.honmaruai.com' })).status).toBe(200);
  const response = await worker.fetch(new Request('https://example.com/mcp', { method: 'OPTIONS', headers: { origin: 'https://untrusted.example' } }), env);
  expect(response.status).toBe(403);
  const allowed = await worker.fetch(new Request('https://example.com/mcp', { method: 'OPTIONS', headers: { origin: 'https://client.example' } }), { ...env, MCP_CORS_ORIGINS: 'https://client.example' });
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get('access-control-allow-headers')).toContain('x-honmaru-token');
});

test('validates connector schemas without coercing or accepting hidden actor arguments', () => {
  const schema = { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, body: { type: 'string', maxLength: 10 } }, required: ['limit'], additionalProperties: false };
  expect(() => validateMcpInput({ limit: 1, body: 'hello' }, schema)).not.toThrow();
  for (const input of [{ limit: '1' }, { limit: 0 }, { limit: 51 }, { limit: 1, body: 'too much text' }, { limit: 1, orgId: 'other' }, [], {}]) expect(() => validateMcpInput(input, schema)).toThrow(McpInputError);
});

import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { createApiToken } from '../src/mcp.js';
import { upsertUser, upsertMembership, upsertBusiness } from '../src/db.js';
import { CHAT_TOOLS } from '../src/mcpChatTools.js';
import { CONTENT_TOOLS } from '../src/mcpContentTools.js';

const orgId = 'personal:connector';
let token;
const configured = () => ({ ...env, MCP_CORS_ORIGINS: 'https://connector.example' });
const rpc = async (name, args = {}, credential = token) => {
  const response = await worker.fetch(new Request('https://example.com/mcp', { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }) }), configured());
  expect(response.status).toBe(200);
  return (await response.json()).result;
};
beforeEach(async () => {
  await upsertUser(env.DB, { githubId: 'connector', login: 'connector', name: 'Connector', locale: 'en' });
  await upsertMembership(env.DB, orgId, 'connector', 'admin');
  await upsertBusiness(env.DB, orgId, { name: 'General', createdBy: 'connector' });
  token = (await createApiToken(env.DB, { orgId, githubId: 'connector', name: 'Integration', scopes: [...new Set([...CHAT_TOOLS, ...CONTENT_TOOLS].map(tool => tool.scope))] })).token;
});

test('registry discovers explicit tools, validates arguments and preserves legacy boundaries', async () => {
  const listing = await rpc('tools/list');
  const names = listing.tools.map(tool => tool.name);
  expect(new Set(names).size).toBe(names.length);
  for (const tool of [...CHAT_TOOLS, ...CONTENT_TOOLS]) expect(names).toContain(tool.name);
  expect(names).not.toContain('request_decision');
  expect((await rpc('send_message', { conversationId: 'b:general', body: 'invalid', requestId: 'once-once', orgId: 'other' })).isError).toBe(true);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=?1').bind(orgId).first()).n).toBe(0);
  const legacy = (await createApiToken(env.DB, { orgId, githubId: 'connector', name: 'Legacy', scopes: ['read', 'write'] })).token;
  expect((await rpc('tools/list', {}, legacy)).tools.map(tool => tool.name)).not.toContain('read_channel');
  expect((await rpc('read_channel', { conversationId: 'b:general' }, legacy)).isError).toBe(true);
});

test('actual MCP upload, completion and protected download preserve bytes and browser CORS', async () => {
  const reserved = await rpc('get_file_upload_url', { conversation: 'b:general', name: 'proof.txt', contentType: 'text/plain', size: 5, requestId: 'upload-proof' });
  expect(reserved.isError).not.toBe(true);
  const { uploadId, uploadUrl } = reserved.structuredContent;
  const preflight = await worker.fetch(new Request(uploadUrl, { method: 'OPTIONS', headers: { origin: 'https://connector.example', 'access-control-request-method': 'PUT' } }), configured());
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
  expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  const uploaded = await worker.fetch(new Request(uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${token}`, origin: 'https://connector.example', 'content-type': 'text/plain', 'content-length': '5' }, body: 'proof' }), configured());
  expect(uploaded.status).toBe(201);
  expect(uploaded.headers.get('access-control-allow-origin')).toBe('*');
  const completed = await rpc('complete_file_upload', { uploadId });
  expect(completed.isError).not.toBe(true);
  const info = completed.structuredContent.file;
  const download = await worker.fetch(new Request(info.contentUrl, { headers: { authorization: `Bearer ${token}`, origin: 'https://connector.example' } }), configured());
  expect(download.status).toBe(200);
  expect(download.headers.get('access-control-allow-origin')).toBe('*');
  expect(await download.text()).toBe('proof');
  expect((await worker.fetch(new Request(info.contentUrl), configured())).status).toBe(401);
  expect((await worker.fetch(new Request(info.contentUrl, { headers: { authorization: `Bearer ${token}`, origin: 'https://untrusted.example' } }), configured())).status).toBe(403);
});

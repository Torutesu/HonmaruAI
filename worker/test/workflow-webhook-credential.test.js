import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';
import { LIMITS } from '../src/ratelimit.js';
import { HARNESS_TOOL_SCOPE } from '../src/harness/mcpTools.js';
import { signWorkflowWebhook } from '../src/harness/workflowWebhookSignature.js';

// The workflow webhook credential is handled like the Room webhook credential
// (issue #961): stored only as a digest, sent only in a header, rate limited,
// and never returned by a read, whether over HTTP or MCP.

const ORG = 'personal:hookcred';
let toru;
const call = (path, init = {}) => worker.fetch(new Request('https://example.com' + path, init), { ...env, OPENAI_API_KEY: undefined });
const headers = (token) => ({ 'content-type': 'application/json', 'x-session-token': token });
const send = (method, path, token, body) => call(path, { method, headers: headers(token), body: JSON.stringify({ orgId: ORG, ...body }) });
const stored = async (id) => (await env.DB.prepare('SELECT hook_secret FROM hx_workflows WHERE org_id=?1 AND id=?2').bind(ORG, id).first()).hook_secret;
const sha256 = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
let delivery = 0;
const deliver = async (id, secret, { query = false, ip = '203.0.113.7' } = {}) => {
  const body = '{}', eventId = `evt-${++delivery}`, timestamp = String(Math.floor(Date.now() / 1000));
  return call(`/hooks/workflows/${id}${query ? `?secret=${secret}` : ''}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'cf-connecting-ip': ip,
      ...(query ? {} : { 'x-hook-secret': secret }),
      'x-webhook-timestamp': timestamp, 'x-webhook-event-id': eventId,
      'x-webhook-signature': await signWorkflowWebhook(secret, timestamp, eventId, body),
    },
    body,
  });
};
const makeHook = async () => {
  const { app } = await (await send('POST', '/apps', toru, { name: 'Orders', columns: [{ name: 'Order', type: 'text' }] })).json();
  const response = await send('POST', '/workflows', toru, { name: 'Inbound order', trigger: { type: 'webhook' }, steps: [{ type: 'add_row', tableId: app.tableId, values: { Order: '{{input.id}}' } }] });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
};

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.exec('DELETE FROM rate_limits');
  await upsertUser(env.DB, { githubId: '9601', login: 'toru', name: 'Toru', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '9601', 'admin');
  toru = await createSession(env.DB, '9601', 'gho_toru');
  await send('PUT', '/orgs/mode', toru, { mode: 'harness' });
});

test('a new webhook secret is returned once and stored only as a digest', async () => {
  const made = await makeHook();
  expect(made.workflow.hookSecret).toMatch(/^[0-9a-f]{48}$/);
  expect(made.hookUrl).toBe(`https://example.com/hooks/workflows/${made.workflow.id}`);
  expect(await stored(made.workflow.id)).toBe(`sha256:${await sha256(made.workflow.hookSecret)}`);
  const shown = await (await call(`/workflows/${made.workflow.id}?orgId=${ORG}`, { headers: headers(toru) })).json();
  expect(JSON.stringify(shown)).not.toContain(made.workflow.hookSecret);
  expect(shown.workflow).toMatchObject({ webhookActive: true });
  expect((await deliver(made.workflow.id, made.workflow.hookSecret)).status).toBe(202);
  expect((await deliver(made.workflow.id, 'f'.repeat(48))).status).toBe(404);
});

test('the secret is accepted in the header only, never from the query string', async () => {
  const made = await makeHook();
  const viaQuery = await deliver(made.workflow.id, made.workflow.hookSecret, { query: true });
  expect(viaQuery.status).toBe(400);
  expect((await viaQuery.json()).message).toMatch(/X-Hook-Secret header/);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs WHERE org_id=?1').bind(ORG).first();
  expect(n).toBe(0);
});

test('a legacy clear-text secret keeps working and is hashed on first use or read', async () => {
  const legacy = 'a'.repeat(48);
  const made = await makeHook();
  await env.DB.prepare('UPDATE hx_workflows SET hook_secret=?3, webhook_signature_required=0 WHERE org_id=?1 AND id=?2').bind(ORG, made.workflow.id, legacy).run();
  // Unsigned legacy senders keep working: they predate signing.
  const unsigned = await call(`/hooks/workflows/${made.workflow.id}`, { method: 'POST', headers: { 'x-hook-secret': legacy }, body: '{}' });
  expect(unsigned.status).toBe(202);
  expect(await stored(made.workflow.id)).toBe(`sha256:${await sha256(legacy)}`);
  expect((await call(`/hooks/workflows/${made.workflow.id}`, { method: 'POST', headers: { 'x-hook-secret': legacy }, body: '{}' })).status).toBe(202);

  const other = await makeHook();
  await env.DB.prepare('UPDATE hx_workflows SET hook_secret=?3 WHERE org_id=?1 AND id=?2').bind(ORG, other.workflow.id, legacy).run();
  const shown = await (await call(`/workflows/${other.workflow.id}?orgId=${ORG}`, { headers: headers(toru) })).json();
  expect(JSON.stringify(shown)).not.toContain(legacy);
  expect(await stored(other.workflow.id)).toBe(`sha256:${await sha256(legacy)}`);
});

test('repeated deliveries from one address are rate limited', async () => {
  const made = await makeHook();
  const { max, windowSeconds } = LIMITS['webhooks/workflow'];
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO rate_limits(bucket,subject,window_start,count) VALUES(?1,?2,?3,?4)')
    .bind('webhooks/workflow', 'i:198.51.100.9', now - (now % windowSeconds), max).run();
  expect((await deliver(made.workflow.id, made.workflow.hookSecret, { ip: '198.51.100.9' })).status).toBe(429);
  expect((await deliver(made.workflow.id, made.workflow.hookSecret, { ip: '198.51.100.10' })).status).toBe(202);
});

test('MCP get_workflow is a read tool that never returns the secret; rotation returns a new one once', async () => {
  expect(HARNESS_TOOL_SCOPE.get_workflow).toBe('read');
  const made = await makeHook();
  const mint = async (scopes) => (await (await send('POST', '/tokens', toru, { name: 'Agent', scopes })).json()).token;
  let seq = 0;
  const tool = async (bearer, name, args) => (await (await call('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
  })).json()).result;
  const reader = await mint(['read']);
  const shown = await tool(reader, 'get_workflow', { workflowId: made.workflow.id });
  expect(shown.isError).not.toBe(true);
  expect(JSON.stringify(shown)).not.toContain(made.workflow.hookSecret);
  expect(shown.structuredContent.webhook).toEqual({ active: true, signatureRequired: true });
  expect((await tool(reader, 'rotate_workflow_webhook', { workflowId: made.workflow.id, expectedUpdatedAt: shown.structuredContent.workflow.updatedAt })).isError).toBe(true);

  const writer = await mint(['read', 'write']);
  const rotated = (await tool(writer, 'rotate_workflow_webhook', { workflowId: made.workflow.id, expectedUpdatedAt: shown.structuredContent.workflow.updatedAt })).structuredContent;
  expect(rotated).toMatchObject({ active: true, secret: expect.stringMatching(/^[0-9a-f]{48}$/) });
  expect(await stored(made.workflow.id)).toBe(`sha256:${await sha256(rotated.secret)}`);
  expect((await deliver(made.workflow.id, made.workflow.hookSecret)).status).toBe(404);
  expect((await deliver(made.workflow.id, rotated.secret)).status).toBe(202);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processRemoteMcpEgressOne, serveRemoteMcpEgress } from '../client.mjs';

test('Remote MCP egress claims through the Gateway and finishes only the bounded HTTPS result', async () => {
  const calls = [];
  const job = { id: '123e4567-e89b-42d3-a456-426614174000', lease: 'one-time-lease', timeoutMs: 4000,
    request: { url: 'https://mcp.example.com/rpc', method: 'POST', headers: [], body: '{}', timeoutMs: 4000 } };
  const result = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' };
  const call = async (path, body) => {
    calls.push({ path, body });
    if (path === 'remote-mcp/claim') return { job };
    return { ok: true };
  };
  let requestArgs;
  assert.equal(await processRemoteMcpEgressOne(call, { request: async (...args) => { requestArgs = args; return result; } }), true);
  assert.equal(requestArgs[0], job.request);
  assert.equal(requestArgs[1].timeoutMs, 4000);
  assert.ok(requestArgs[1].signal instanceof AbortSignal);
  assert.deepEqual(calls.map(({ path }) => path), ['remote-mcp/claim', `remote-mcp/jobs/${job.id}/finish`]);
  assert.deepEqual(calls.at(-1).body, { lease: job.lease, result });
});

test('Remote MCP egress returns only bounded generic failure text and does not expose host details', async () => {
  const calls = [];
  const job = { id: '123e4567-e89b-42d3-a456-426614174000', lease: 'lease', request: { url: 'https://mcp.example.com' } };
  await processRemoteMcpEgressOne(async (path, body) => {
    calls.push({ path, body });
    return path.endsWith('/claim') ? { job } : { ok: true };
  }, { request: async () => { throw new Error('/Users/private/.ssh/id_rsa'); } });
  assert.deepEqual(calls.at(-1).body.result, { error: 'Gateway could not complete the Remote MCP HTTPS request.' });
  assert.doesNotMatch(JSON.stringify(calls), /id_rsa|private/);
});

test('Remote MCP egress loop stops on abort and treats a revoked Gateway as terminal', async () => {
  const controller = new AbortController();
  let claims = 0;
  await assert.rejects(serveRemoteMcpEgress(async () => {
    claims += 1;
    throw Object.assign(new Error('revoked'), { status: 403 });
  }, { signal: controller.signal }), /revoked/);
  assert.equal(claims, 1);

  controller.abort();
  await serveRemoteMcpEgress(async () => { throw new Error('must not claim after abort'); }, { signal: controller.signal });
});

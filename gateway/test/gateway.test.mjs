import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerArgs, validatePayload, IMAGE } from '../runner.mjs';
import { gatewayClient, processOne } from '../client.mjs';
const token = `hgw_${'a'.repeat(72)}`;
test('remote payload cannot choose host mounts, image, environment or command', () => {
  assert.deepEqual(validatePayload({ code: 'return 42', image: 'evil', mounts: ['/Users'], env: { SECRET: 'x' } }), { code: 'return 42', input: null });
  const args = containerArgs('honmaru-12345678-1234-1234-1234-123456789abc');
  assert.ok(args.includes(IMAGE));
  for (const flag of ['--volume', '--mount', '--env', '--privileged', '--publish']) assert.ok(!args.includes(flag));
  for (const [flag, value] of [['--network', 'none'], ['--uid', '65534'], ['--memory', '512m']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.throws(() => containerArgs('$(bad)'));
  assert.throws(() => validatePayload({ code: 'x'.repeat(65537) }));
});
test('client requires encrypted transport and refuses redirects carrying node credentials', async () => {
  for (const url of ['http://example.com', 'https://name:pass@example.com', 'https://example.com?token=x']) assert.throws(() => gatewayClient(url, token));
  let observed;
  const call = gatewayClient('https://example.com', token, async (url, options) => { observed = { url, options }; return Response.json({ job: null }); });
  await call('claim');
  assert.equal(observed.options.redirect, 'error');
  assert.equal(observed.url.href, 'https://example.com/gateways/claim');
  assert.equal(observed.options.headers.authorization, `Bearer ${token}`);
});
test('execution returns only its assigned lease and structured result', async () => {
  const calls = [];
  const call = async (path, body) => { calls.push([path, body]); return path === 'claim' ? { job: { id: 'job', lease: 'lease', payload: { code: 'return 42' }, timeoutMs: 60000 } } : { ok: true }; };
  await processOne(call, { run: async (payload, options) => { assert.equal(payload.code, 'return 42'); assert.equal(options.timeoutMs, 60000); return { status: 'succeeded', stdout: '42', stderr: '', exitCode: 0 }; } });
  assert.deepEqual(calls[1], ['jobs/job/finish', { lease: 'lease', status: 'succeeded', stdout: '42', stderr: '', exitCode: 0 }]);
});
test('local runtime failures do not leak host error details', async () => {
  let result;
  await processOne(async (path, body) => path === 'claim' ? { job: { id: 'job', lease: 'lease', payload: { code: 'x' } } } : (result = body), { run: async () => { throw new Error('/Users/private/token'); } });
  assert.equal(result.status, 'failed');
  assert.ok(!result.stderr.includes('/Users'));
});

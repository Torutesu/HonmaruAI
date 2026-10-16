import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servicePlist } from '../launchd.mjs';
import { serve } from '../client.mjs';
test('service plist escapes paths, starts on login and restarts only failed exits without credentials', () => {
  const xml = servicePlist({ node: '/node', service: '/a&b/service.mjs', config: '/config.json', directory: '/gateway', home: '/Users/test' });
  assert.ok(xml.includes('/a&amp;b/service.mjs'));
  assert.ok(xml.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(xml.includes('<key>SuccessfulExit</key><false/>'));
  assert.ok(!xml.includes('HONMARU_GATEWAY_TOKEN'));
  assert.throws(() => servicePlist({ node: 'node' }));
});
test('unavailable runtime prevents a job from being claimed and retries later', async () => {
  let claims = 0, failures = 0;
  await serve(async () => { claims++; }, { once: true, beforeClaim: async () => { throw new Error('runtime down'); }, onError: () => failures++ });
  assert.equal(claims, 0); assert.equal(failures, 1);
});
test('recovered runtime permits claims while revoked credentials stop the service', async () => {
  let checked = false;
  await assert.rejects(serve(async () => { assert.ok(checked); throw Object.assign(new Error('revoked'), { status: 401 }); }, { beforeClaim: async () => { checked = true; } }), /revoked/);
});

test('runtime stopped with exit zero still triggers restart, running runtime is preserved', async () => {
  const { ensureRuntime } = await import('../runtime.mjs');
  const config = { containerBinary: '/container', containerInstallRoot: '/install', containerAppRoot: '/data' };
  const calls = [];
  await ensureRuntime(config, async (binary, args) => { calls.push(args); return { stdout: 'apiserver is not running and not registered with launchd\n' }; });
  assert.deepEqual(calls[1], ['system', 'start', '--install-root', '/install', '--app-root', '/data']);
  calls.length = 0;
  await ensureRuntime(config, async (binary, args) => { calls.push(args); return { stdout: 'FIELD VALUE\nstatus              running\nclient.version 1.5.0\n' }; });
  assert.equal(calls.length, 1);
});

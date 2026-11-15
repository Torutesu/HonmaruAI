import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requestRemoteMcp, resolvePublicHost } from '../remote-mcp-http.mjs';

function fakeRequest({ statusCode = 200, headers = { 'content-type': 'application/json' }, chunks = ['{}'], timeout = false } = {}) {
  let options, sentBody;
  const request = (opts, onResponse) => {
    options = opts;
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.setTimeout = (_ms, callback) => { if (timeout) queueMicrotask(callback); };
    req.end = body => {
      sentBody = body;
      if (timeout) return;
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.headers = headers;
      response.destroy = () => {};
      onResponse(response);
      queueMicrotask(() => {
        for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      });
    };
    return req;
  };
  return { request, read: () => ({ options, sentBody }) };
}

test('rejects mixed public and private DNS answers before opening a socket', async () => {
  let opened = false;
  const resolver = async (_host, options) => {
    assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  };
  await assert.rejects(requestRemoteMcp({ url: 'https://mcp.example.com/rpc' }, {
    resolve: host => resolvePublicHost(host, resolver),
    request: () => { opened = true; throw new Error('socket must not open'); },
  }), /non-public address/);
  assert.equal(opened, false);
});

test('pins the validated address even if DNS changes before the HTTPS socket connects', async () => {
  let resolutions = 0;
  const resolved = async host => {
    resolutions++;
    assert.equal(host, 'mcp.example.com');
    return { address: '8.8.8.8', family: 4 };
  };
  const fake = fakeRequest();
  const result = await requestRemoteMcp({ url: 'https://mcp.example.com/rpc', method: 'POST', body: '{"ok":true}' }, {
    resolve: resolved, request: fake.request,
  });
  const { options, sentBody } = fake.read();
  assert.equal(resolutions, 1);
  assert.equal(Buffer.from(sentBody).toString('utf8'), '{"ok":true}');
  const pinned = await new Promise((resolve, reject) => options.lookup(options.hostname, {}, (err, address, family) => err ? reject(err) : resolve({ address, family })));
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
  await assert.rejects(new Promise((resolve, reject) => options.lookup('other.example.com', {}, err => err ? reject(err) : resolve())), /does not match/);
  assert.deepEqual(result, { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
});

test('keeps original Host and TLS SNI while requiring certificate verification', async () => {
  const fake = fakeRequest({ statusCode: 302, headers: { location: 'https://elsewhere.example/' }, chunks: [''] });
  const result = await requestRemoteMcp({ url: 'https://mcp.example.com:443/a?cursor=x', method: 'GET', headers: { authorization: 'Bearer secret', Host: 'internal' } }, {
    resolve: async () => ({ address: '1.1.1.1', family: 4 }), request: fake.request,
  });
  const { options } = fake.read();
  assert.equal(options.hostname, 'mcp.example.com');
  assert.equal(options.servername, 'mcp.example.com');
  assert.equal(options.headers.host, 'mcp.example.com');
  assert.equal(options.headers.authorization, 'Bearer secret');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.port, 443);
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, undefined);
});

test('rejects private, mapped, reserved and non-global IPv4/IPv6 answers', async () => {
  for (const address of [
    '10.0.0.1', '100.64.0.1', '169.254.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1',
    '::1', '::ffff:127.0.0.1', '64:ff9b::808:808', '2001:db8::1', 'fc00::1', 'fe80::1', 'ff02::1',
  ]) {
    const family = address.includes(':') ? 6 : 4;
    await assert.rejects(resolvePublicHost('mcp.example.com', async () => [{ address, family }]), /non-public address/);
  }
  assert.deepEqual(await resolvePublicHost('mcp.example.com', async () => [{ address: '2001:4860:4860::8888', family: 6 }]), {
    address: '2001:4860:4860::8888', family: 6,
  });
});

test('returns redirects without following them', async () => {
  let calls = 0;
  const fake = fakeRequest({ statusCode: 307, headers: { location: 'https://private.example/secret' }, chunks: ['redirect'] });
  const result = await requestRemoteMcp({ url: 'https://mcp.example.com/rpc' }, {
    resolve: async () => ({ address: '8.8.4.4', family: 4 }),
    request: (...args) => { calls++; return fake.request(...args); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 307);
  assert.equal(result.body, 'redirect');
});

test('enforces timeout and response size limits', async () => {
  const timed = fakeRequest({ timeout: true });
  await assert.rejects(requestRemoteMcp({ url: 'https://mcp.example.com/rpc' }, {
    resolve: async () => ({ address: '8.8.8.8', family: 4 }), request: timed.request, timeoutMs: 100,
  }), /timed out/);
  const large = fakeRequest({ headers: { 'content-length': '9' }, chunks: ['123456789'] });
  await assert.rejects(requestRemoteMcp({ url: 'https://mcp.example.com/rpc' }, {
    resolve: async () => ({ address: '8.8.8.8', family: 4 }), request: large.request, maxResponseBytes: 8,
  }), /too large/);
});

test('DNS resolution shares the request deadline and respects cancellation', async () => {
  await assert.rejects(requestRemoteMcp({ url: 'https://mcp.example.com/rpc' }, {
    resolve: () => new Promise(() => {}), request: fakeRequest().request, timeoutMs: 10,
  }), /timed out/);
  const controller = new AbortController();
  const pending = requestRemoteMcp({ url: 'https://mcp.example.com/rpc' }, {
    resolve: () => new Promise(() => {}), request: fakeRequest().request, timeoutMs: 1000, signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('refuses unsafe URL schemes, credentials, fragments, ports and request headers', async () => {
  const safe = { resolve: async () => ({ address: '8.8.8.8', family: 4 }), request: fakeRequest().request };
  for (const url of ['http://mcp.example.com/rpc', 'https://name:pass@mcp.example.com/rpc', 'https://mcp.example.com/rpc#x', 'https://mcp.example.com:8443/rpc']) {
    await assert.rejects(requestRemoteMcp({ url }, safe), /HTTPS URL/);
  }
  await assert.rejects(requestRemoteMcp({ url: 'https://mcp.example.com', headers: { 'x-key': 'bad\r\nvalue' } }, safe), /headers are invalid/);
  await assert.rejects(requestRemoteMcp({ url: 'https://mcp.example.com', body: 'x'.repeat(128_001) }, safe), /body is too large/);
});

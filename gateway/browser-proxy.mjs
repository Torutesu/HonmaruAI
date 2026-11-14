import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const IPV6_BLOCKED = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
];

function ipv4Number(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split('.').reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0);
}

function ipv6Number(value) {
  if (net.isIP(value) !== 6) return null;
  let source = value.toLowerCase();
  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    const v4 = ipv4Number(source.slice(lastColon + 1));
    if (v4 === null) return null;
    source = `${source.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - left.length - right.length;
  if (gap < 0 || (halves.length === 1 && gap !== 0)) return null;
  const words = [...left, ...Array(gap).fill('0'), ...right];
  return words.reduce((number, word) => (number << 16n) | BigInt(`0x${word || '0'}`), 0n);
}

function cidrContains(address, network, prefix, family) {
  const value = family === 4 ? ipv4Number(address) : ipv6Number(address);
  const base = family === 4 ? ipv4Number(network) : ipv6Number(network);
  if (value === null || base === null) return false;
  const bits = family === 4 ? 32 : 128;
  const shift = BigInt(bits - prefix);
  return (BigInt(value) >> shift) === (BigInt(base) >> shift);
}

export function isPublicAddress(address) {
  const family = net.isIP(String(address || ''));
  if (family === 4) return !IPV4_BLOCKED.some(([network, prefix]) => cidrContains(address, network, prefix, 4));
  if (family !== 6) return false;
  // IPv4-mapped and IPv4-compatible IPv6 literals make classification easy to
  // get wrong. Browser egress does not need them, so deny them outright.
  if (String(address).toLowerCase().startsWith('::ffff:')) return false;
  if (!cidrContains(address, '2000::', 3, 6)) return false;
  return !IPV6_BLOCKED.some(([network, prefix]) => cidrContains(address, network, prefix, 6));
}

function normalizedHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\u0000-\u0020\u007f/@\\]/.test(value)) return null;
  const raw = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (net.isIP(raw)) return raw.toLowerCase();
  try {
    const hostname = new URL(`https://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname.length > 253 || net.isIP(hostname)) return null;
    if (hostname.split('.').some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
    return hostname;
  } catch { return null; }
}

export async function resolvePublicAddress(host, lookup = dns.lookup, lookupTimeoutMs = 5000) {
  const normalized = normalizedHost(host);
  if (!normalized) throw new Error('Browser destination host is invalid.');
  if (net.isIP(normalized)) {
    if (!isPublicAddress(normalized)) throw new Error('Browser destination is not public.');
    return { address: normalized, family: net.isIP(normalized) };
  }
  let lookupTimer;
  let answers;
  try {
    answers = await Promise.race([
      lookup(normalized, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        lookupTimer = setTimeout(() => reject(new Error('Browser destination lookup timed out.')), lookupTimeoutMs);
      }),
    ]);
  } finally { clearTimeout(lookupTimer); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 32) throw new Error('Browser destination did not resolve safely.');
  const unique = [...new Map(answers.map(answer => [`${answer.family}:${answer.address}`, answer])).values()];
  if (unique.some(answer => ![4, 6].includes(answer.family) || !isPublicAddress(answer.address))) {
    throw new Error('Browser destination did not resolve safely.');
  }
  // Prefer IPv4 for compatibility, but keep the exact validated address so a
  // second DNS lookup cannot rebind the request to a private target.
  return unique.find(answer => answer.family === 4) || unique[0];
}

function parseAuthority(authority, expectedPort = null) {
  if (typeof authority !== 'string' || !authority || authority.length > 300 || /[\u0000-\u0020\u007f/@\\]/.test(authority)) return null;
  let host, port;
  if (authority.startsWith('[')) {
    const match = authority.match(/^\[([0-9a-f:.]+)\]:(\d{1,5})$/i);
    if (!match) return null;
    host = match[1]; port = Number(match[2]);
  } else {
    const match = authority.match(/^([^:]+):(\d{1,5})$/);
    if (!match) return null;
    host = match[1]; port = Number(match[2]);
  }
  if (expectedPort !== null && port !== expectedPort) return null;
  // CONNECT permits arbitrary raw TCP. Limit it to the TLS port used by
  // ordinary HTTPS; plain HTTP and ws:// go through the checked port-80 path.
  if (port !== 443) return null;
  const normalized = normalizedHost(host);
  return normalized ? { host: normalized, port } : null;
}

function safeHeaders(headers, host) {
  const clean = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key)) continue;
    if (key === 'host') continue;
    clean[key] = value;
  }
  clean.host = net.isIP(host) === 6 ? `[${host}]` : host;
  clean.connection = 'close';
  return clean;
}

function safeUpgradeHeaders(headers, host) {
  const clean = safeHeaders(headers, host);
  clean.connection = 'Upgrade';
  clean.upgrade = 'websocket';
  return clean;
}

function parseWebSocketUrl(value) {
  try {
    const url = new URL(value);
    if (!['ws:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || (url.port && url.port !== '80')) return null;
    const host = normalizedHost(url.hostname);
    if (!host) return null;
    return { host, path: `${url.pathname}${url.search}` || '/' };
  } catch { return null; }
}

export function createBrowserEgressProxy({ lookup = dns.lookup, connect = net.connect, request = http.request, timeoutMs = 15000 } = {}) {
  const server = http.createServer(async (incoming, outgoing) => {
    let target;
    try {
      const url = new URL(incoming.url);
      if (url.protocol !== 'http:' || url.username || url.password || url.hash || (url.port && url.port !== '80')) throw new Error();
      const host = normalizedHost(url.hostname);
      if (!host) throw new Error();
      target = { host, port: 80, path: `${url.pathname}${url.search}` || '/' };
    } catch {
      outgoing.writeHead(400, { connection: 'close' }).end('Invalid browser destination.');
      return;
    }
    try {
      const resolved = await resolvePublicAddress(target.host, lookup);
      if (incoming.aborted || outgoing.destroyed) return;
      const upstream = request({ hostname: resolved.address, family: resolved.family, port: target.port,
        method: incoming.method, path: target.path, headers: safeHeaders(incoming.headers, target.host), agent: false, timeout: timeoutMs });
      upstream.on('timeout', () => upstream.destroy(new Error('Browser egress timed out.')));
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.on('response', response => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
        response.on('error', () => outgoing.destroy());
      });
      upstream.on('upgrade', (response, socket, head) => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        if (head?.length) outgoing.write(head);
        socket.pipe(outgoing).pipe(socket);
      });
      incoming.once('aborted', () => upstream.destroy());
      outgoing.once('close', () => { if (!outgoing.writableEnded) upstream.destroy(); });
      incoming.pipe(upstream);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(403, { connection: 'close' });
      outgoing.end('Browser destination is not allowed.');
    }
  });

  // WebSocket upgrades are emitted by the server, not by the normal request
  // handler. Route ws:// over the same DNS-pinned egress path; wss:// uses the
  // CONNECT handler below. Never let Node resolve the original hostname again.
  server.on('upgrade', async (incoming, client, head) => {
    const target = parseWebSocketUrl(incoming.url);
    if (!target || String(incoming.headers.upgrade || '').toLowerCase() !== 'websocket') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let upstream;
    try {
      const resolved = await resolvePublicAddress(target.host, lookup);
      if (incoming.aborted || client.destroyed) return;
      upstream = connect({ host: resolved.address, family: resolved.family, port: 80, timeout: timeoutMs });
      const timer = setTimeout(() => upstream.destroy(new Error('Browser egress timed out.')), timeoutMs);
      timer.unref?.();
      upstream.once('connect', () => {
        clearTimeout(timer);
        const headers = safeUpgradeHeaders(incoming.headers, target.host);
        const lines = [`${incoming.method} ${target.path} HTTP/${incoming.httpVersion}`];
        for (const [name, value] of Object.entries(headers)) {
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () => {
        clearTimeout(timer);
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      client.once('close', () => upstream.destroy());
    } catch {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  server.on('connect', async (incoming, client, head) => {
    const target = parseAuthority(incoming.url);
    if (!target) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    let upstream;
    try {
      const resolved = await resolvePublicAddress(target.host, lookup);
      if (incoming.aborted || client.destroyed) return;
      upstream = connect({ host: resolved.address, family: resolved.family, port: target.port, timeout: timeoutMs });
      const timer = setTimeout(() => upstream.destroy(new Error('Browser egress timed out.')), timeoutMs);
      timer.unref?.();
      upstream.once('connect', () => {
        clearTimeout(timer);
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Honmaru\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () => {
        clearTimeout(timer);
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      client.once('close', () => upstream.destroy());
    } catch {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 10000);
  server.keepAliveTimeout = 1000;
  return {
    server,
    async listen(port = 0) {
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid browser proxy port.');
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen);
        server.listen(port, '127.0.0.1');
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

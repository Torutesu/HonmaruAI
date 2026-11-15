import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 128_000;

const deniedV4 = new net.BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) deniedV4.addSubnet(subnet, prefix, 'ipv4');
const deniedV6 = new net.BlockList();
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) deniedV6.addSubnet(subnet, prefix, 'ipv6');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !deniedV4.check(address, 'ipv4');
  if (family !== 6) return false;
  // Publicly routable IPv6 unicast is allocated from 2000::/3. The reserved,
  // transition, documentation, and special-purpose parts of that range above
  // are denied explicitly.
  return globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}

export async function resolvePublicHost(hostname, resolver = dns.lookup) {
  if (typeof hostname !== 'string' || !hostname || net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('Remote MCP host is not allowed.');
  }
  let answers;
  try { answers = await resolver(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('Could not resolve the Remote MCP host.'); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 32) throw new Error('Remote MCP host has no usable address.');
  const normalized = answers.map(answer => ({ address: answer?.address, family: Number(answer?.family) }));
  if (normalized.some(answer => !answer.address || net.isIP(answer.address) !== answer.family || !isPublicAddress(answer.address))) {
    throw new Error('Remote MCP host resolved to a non-public address.');
  }
  return normalized[0];
}

function boundedRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Remote MCP request.');
  let url;
  try { url = new URL(input.url); } catch { throw new Error('Remote MCP URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Remote MCP requests require a public HTTPS URL on port 443.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || net.isIP(hostname.replace(/^\[|\]$/g, '')) || hostname.length > 253 || /[\u0000-\u0020\u007f]/.test(hostname)) {
    throw new Error('Remote MCP host is not allowed.');
  }
  const method = typeof input.method === 'string' ? input.method : 'GET';
  if (!/^[A-Z]{1,16}$/.test(method)) throw new Error('Remote MCP method is invalid.');
  const body = input.body == null ? null : Buffer.isBuffer(input.body) ? input.body : typeof input.body === 'string' ? Buffer.from(input.body) : null;
  if (input.body != null && !body) throw new Error('Remote MCP request body is invalid.');
  if (body && body.byteLength > MAX_REQUEST_BYTES) throw new Error('Remote MCP request body is too large.');
  const headers = {};
  const pairs = input.headers instanceof Headers ? [...input.headers.entries()] : Object.entries(input.headers || {});
  for (const [rawName, rawValue] of pairs) {
    const name = String(rawName).trim();
    const value = String(rawValue);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Remote MCP request headers are invalid.');
    const lower = name.toLowerCase();
    if (['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization'].includes(lower)) continue;
    headers[lower] = value;
  }
  headers.host = url.host;
  headers.connection = 'close';
  if (body) headers['content-length'] = String(body.byteLength);
  return { url, hostname, method, headers, body };
}

function pinnedLookup(address) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (String(hostname).toLowerCase().replace(/\.$/, '') !== address.host) {
      callback(new Error('Remote MCP DNS pin does not match the requested host.'));
      return;
    }
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}

function responseHeaders(headers) {
  const result = {};
  for (const name of ['content-type', 'mcp-session-id', 'www-authenticate']) {
    const value = headers?.[name];
    if (typeof value === 'string' && value.length <= 8192) result[name] = value;
  }
  return result;
}

export async function requestRemoteMcp(input, {
  resolve = resolvePublicHost,
  request = https.request,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal,
} = {}) {
  const safe = boundedRequest(input);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Remote MCP timeout is invalid.');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) throw new Error('Remote MCP response limit is invalid.');
  const deadlineAt = Date.now() + timeoutMs;
  let resolveTimer;
  let removeAbort = () => {};
  const resolutionLimit = new Promise((_, reject) => {
    resolveTimer = setTimeout(() => reject(new Error('Remote MCP request timed out.')), Math.max(1, deadlineAt - Date.now()));
    if (signal) {
      const abort = () => reject(new Error('Remote MCP request was cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
    }
  });
  let resolved;
  try {
    if (signal?.aborted) throw new Error('Remote MCP request was cancelled.');
    resolved = await Promise.race([resolve(safe.hostname), resolutionLimit]);
  } finally {
    clearTimeout(resolveTimer);
    removeAbort();
  }
  if (!resolved || !isPublicAddress(resolved.address) || resolved.family !== net.isIP(resolved.address)) throw new Error('Remote MCP host resolved to a non-public address.');
  if (signal?.aborted) throw new Error('Remote MCP request was cancelled.');
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Remote MCP request timed out.');

  const options = {
    protocol: 'https:',
    hostname: safe.hostname,
    servername: safe.hostname,
    port: 443,
    path: `${safe.url.pathname}${safe.url.search}`,
    method: safe.method,
    headers: safe.headers,
    rejectUnauthorized: true,
    lookup: pinnedLookup({ ...resolved, host: safe.hostname }),
    timeout: remainingMs,
  };

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const deadline = setTimeout(() => {
      req.destroy(new Error('Remote MCP request timed out.'));
    }, remainingMs);
    const abort = () => req.destroy(new Error('Remote MCP request was cancelled.'));
    let req;
    try { req = request(options, response => {
      const declared = Number(response.headers?.['content-length']);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        response.destroy?.();
        req.destroy(new Error('Remote MCP response is too large.'));
        return;
      }
      response.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxResponseBytes) {
          response.destroy?.();
          req.destroy(new Error('Remote MCP response is too large.'));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => finish(null, {
        status: Number(response.statusCode) || 0,
        headers: responseHeaders(response.headers),
        body: Buffer.concat(chunks, size).toString('utf8'),
      }));
      response.on('error', error => finish(error));
    }); } catch (error) { clearTimeout(deadline); finish(error); return; }
    req.on('error', error => finish(error));
    req.setTimeout?.(remainingMs, () => req.destroy(new Error('Remote MCP request timed out.')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    req.end(safe.body || undefined);
  });
}


import readline from 'node:readline';

const url = process.env.HONMARU_ACP_MCP_URL;
const token = process.env.HONMARU_ACP_MCP_TOKEN;
const MAX_LINE = 128 * 1024;
let relayUrl = null;
try {
  const candidate = new URL(url);
  if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1' && candidate.pathname === '/mcp' && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && /^[a-f0-9]{64}$/.test(token || '')) relayUrl = candidate;
} catch {}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function relay(method, params = {}) {
  if (!relayUrl || !token) throw new Error('Workspace tools are not configured.');
  const response = await fetch(relayUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Workspace tool request failed.');
  return body;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (Buffer.byteLength(line) > MAX_LINE) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } });
    continue;
  }
  let message;
  try { message = JSON.parse(line); }
  catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
    continue;
  }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid request.' } });
    continue;
  }
  if (message.method.startsWith('notifications/')) continue;
  if (message.id === undefined) continue;
  try {
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: ['2025-03-26', '2024-11-05'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'honmaru-workspace', version: '1.0.0' },
      };
    } else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list' || message.method === 'tools/call') result = await relay(message.method, message.params || {});
    else throw Object.assign(new Error('Method not found.'), { code: -32601 });
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32000, message: String(error.message || 'Workspace tool request failed.').slice(0, 500) } });
  }
}

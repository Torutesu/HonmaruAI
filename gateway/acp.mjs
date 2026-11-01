import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_PROMPT_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 48 * 1024;

function agentConfig(acpAgents, key) {
  if (!AGENT_ID.test(String(key || ''))) throw new Error('Unknown local ACP agent.');
  const entry = acpAgents && Object.hasOwn(acpAgents, key) ? acpAgents[key] : null;
  if (!entry || typeof entry !== 'object' || !isAbsolute(entry.command) || !isAbsolute(entry.cwd)) throw new Error('Unknown local ACP agent.');
  if (!Array.isArray(entry.args) || entry.args.length > 40 || entry.args.some(arg => typeof arg !== 'string' || arg.length > 1024)) throw new Error('Invalid local ACP agent configuration.');
  if (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env) || Object.entries(entry.env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(k) || typeof v !== 'string' || v.length > 4096))) throw new Error('Invalid local ACP agent configuration.');
  return entry;
}

function safeEnvironment(overrides = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...(overrides || {}) };
}

function signalAgent(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  child.kill(signal);
}

class StdioJsonRpc {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#read(chunk));
    child.on('error', error => this.#fail(error));
    child.on('exit', (code, signal) => this.#fail(new Error(`ACP agent exited (${code ?? signal ?? 'unknown'}).`)));
  }

  #read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES * 2) return this.#fail(new Error('ACP output is too large.'));
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.#fail(new Error('ACP output is too large.'));
      let message;
      try { message = JSON.parse(line); } catch { return this.#fail(new Error('ACP agent sent invalid JSON-RPC.')); }
      this.#message(message);
    }
  }

  #message(message) {
    if (message?.jsonrpc !== '2.0') return this.#fail(new Error('ACP agent sent an invalid JSON-RPC message.'));
    if (message.id !== undefined && message.method) {
      // No host file, terminal, or other arbitrary client capability is
      // advertised. Permission requests are explicitly rejected by default.
      if (message.method === 'session/request_permission') {
        const options = Array.isArray(message.params?.options) ? message.params.options : [];
        const reject = options.find(option => option.kind === 'reject_once') || options.find(option => option.kind === 'reject_always');
        this.#write({ jsonrpc: '2.0', id: message.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
      } else {
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is not supported.' } });
      }
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('ACP request failed.'));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) this.onNotification(message);
  }

  #write(message) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ACP request timed out.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.#write({ jsonrpc: '2.0', method, params }); }

  #fail(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function chunkText(content) {
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text') return String(content.text || '');
  if (content.type === 'resource') return String(content.resource?.text || '');
  return '';
}

async function startWorkspaceMcp(mcpCall) {
  if (typeof mcpCall !== 'function') throw new Error('Workspace MCP relay is unavailable.');
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const chunks = [];
    let size = 0;
    try {
      if (request.method !== 'POST' || request.url !== '/mcp') throw Object.assign(new Error('Not found.'), { status: 404 });
      if (request.headers.authorization !== `Bearer ${token}`) throw Object.assign(new Error('Unauthorized.'), { status: 401 });
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || !['tools/list', 'tools/call'].includes(input.method)) throw Object.assign(new Error('Unsupported MCP method.'), { status: 400 });
      const result = await mcpCall(input.method, input.params || {});
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > 210 * 1024) throw Object.assign(new Error('Result too large.'), { status: 413 });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(body);
    } catch (error) {
      response.writeHead(error.status || 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: error.status ? error.message : 'Workspace MCP request failed.' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  return {
    server,
    config: {
      name: 'honmaru-workspace',
      command: process.execPath,
      args: [fileURLToPath(new URL('./acp-mcp-bridge.mjs', import.meta.url))],
      env: [
        { name: 'HONMARU_ACP_MCP_URL', value: `http://127.0.0.1:${address.port}/mcp` },
        { name: 'HONMARU_ACP_MCP_TOKEN', value: token },
      ],
    },
  };
}

/** Run one ACP v1 prompt through a command explicitly configured on this node.
 * The job can select an allowlist key, but can never choose a command, args,
 * cwd, environment, MCP server, filesystem capability, or terminal.
 */
export async function runAcp(payload, { acpAgents = {}, signal, timeoutMs = 60000, mcpCall } = {}) {
  const cfg = agentConfig(acpAgents, payload?.agentKey);
  const prompt = String(payload?.prompt || '');
  if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error('Invalid ACP prompt.');
  const child = spawn(cfg.command, cfg.args, {
    cwd: cfg.cwd,
    env: safeEnvironment(cfg.env),
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const rpc = new StdioJsonRpc(child);
  const text = [];
  let textBytes = 0;
  let sessionId = null;
  let loadedSession = false;
  let promptRequestId = null;
  let workspaceMcp = null;
  let abort;
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  const startedAt = Date.now();
  rpc.onNotification = message => {
    if (message.method !== 'session/update') return;
    const update = message.params?.update;
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    const value = chunkText(update.content);
    if (value && textBytes < MAX_TEXT_BYTES) {
      const allowed = Buffer.from(value).subarray(0, MAX_TEXT_BYTES - textBytes).toString('utf8');
      text.push(allowed); textBytes += Buffer.byteLength(allowed);
    }
  };
  abort = () => {
    if (sessionId) rpc.notify('session/cancel', { sessionId });
    if (promptRequestId !== null) rpc.notify('$/cancel_request', { id: promptRequestId });
    signalAgent(child, 'SIGTERM');
    setTimeout(() => signalAgent(child, 'SIGKILL'), 1500).unref?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('ACP run cancelled.');
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      // This gateway does not expose host filesystem or terminal operations
      // to the ACP process. Keep the negotiated capabilities explicit.
      clientCapabilities: { fs: false, terminal: false },
      clientInfo: { name: 'HonmaruAI', title: 'HonmaruAI local gateway', version: '1.0.0' },
    }, Math.min(15000, remaining()));
    if (initialized.protocolVersion !== 1) throw new Error('ACP protocol version is not supported.');
    const authMethods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
    // ACP agents own their sign-in and credentials. The host must not call
    // `authenticate`; an operator signs into the provider on this Mac first.
    if (authMethods.some(method => method?.type === 'terminal')) throw new Error('This ACP agent requires an interactive login. Sign it in on the Mac first.');
    if (payload.workspaceTools === true) workspaceMcp = await startWorkspaceMcp(mcpCall);
    const sessionParams = { cwd: cfg.cwd, mcpServers: workspaceMcp ? [workspaceMcp.config] : [] };
    if (payload.sessionId && initialized.agentCapabilities?.loadSession) {
      try {
        await rpc.request('session/load', { ...sessionParams, sessionId: payload.sessionId }, Math.min(15000, remaining()));
        sessionId = payload.sessionId;
        loadedSession = true;
        text.length = 0;
        textBytes = 0;
      } catch {
        // A removed or expired session gets a clean ACP session; callers also
        // send the visible conversation context when available.
      }
    }
    if (!sessionId) {
      const created = await rpc.request('session/new', sessionParams, Math.min(15000, remaining()));
      if (typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('ACP agent did not create a session.');
      sessionId = created.sessionId;
    }
    if (signal?.aborted) throw new Error('ACP run cancelled.');
    const requestId = rpc.nextId;
    promptRequestId = requestId;
    const prior = !loadedSession && Array.isArray(payload.context) ? payload.context.map(line => String(line || '').slice(0, 4000)).filter(Boolean).slice(-30).join('\n') : '';
    const promptBlocks = [];
    if (prior) promptBlocks.push({ type: 'text', text: `Earlier conversation:\n${prior}` });
    promptBlocks.push({ type: 'text', text: prompt });
    const result = await rpc.request('session/prompt', { sessionId, prompt: promptBlocks }, remaining());
    if (signal?.aborted) throw new Error('ACP run cancelled.');
    const answer = text.join('').trim();
    return { status: result.stopReason === 'cancelled' ? 'failed' : 'succeeded', stdout: JSON.stringify({ text: answer, sessionId, stopReason: result.stopReason || null }), stderr: '', exitCode: 0 };
  } finally {
    if (workspaceMcp) {
      workspaceMcp.server.closeAllConnections?.();
      await new Promise(resolve => workspaceMcp.server.close(() => resolve()));
    }
    signal?.removeEventListener('abort', abort);
    promptRequestId = null;
    signalAgent(child, 'SIGTERM');
    await new Promise(resolve => setTimeout(() => { signalAgent(child, 'SIGKILL'); resolve(); }, 300));
  }
}

export function configuredAcpAgentIds(acpAgents) {
  if (!acpAgents || typeof acpAgents !== 'object' || Array.isArray(acpAgents)) return [];
  return Object.keys(acpAgents).filter(key => {
    try { agentConfig(acpAgents,key); return true; } catch { return false; }
  });
}

export function validateAcpAgents(acpAgents) {
  if (acpAgents === undefined || acpAgents === null) return [];
  if (!acpAgents || typeof acpAgents !== 'object' || Array.isArray(acpAgents) || Object.keys(acpAgents).length > 20) throw new Error('ACP agent configuration must be an object with at most 20 entries.');
  for (const key of Object.keys(acpAgents)) agentConfig(acpAgents,key);
  return Object.keys(acpAgents).sort();
}

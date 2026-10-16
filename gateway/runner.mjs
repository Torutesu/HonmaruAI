import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const IMAGE = 'docker.io/library/node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
// Only this fixed bootstrap runs in the VM. No task code executes on macOS.
const BOOTSTRAP = `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',async()=>{try{const task=JSON.parse(raw);const fn=new (Object.getPrototypeOf(async function(){}).constructor)('input',task.code);const result=await fn(task.input);process.stdout.write(JSON.stringify(result===undefined?null:result));}catch(e){console.error(String(e?.stack||e));process.exitCode=1;}});`;

export function validatePayload(payload) {
  if (!payload || typeof payload.code !== 'string' || !payload.code.trim()) throw new Error('JavaScript code is required.');
  const clean = { code: payload.code, input: payload.input ?? null };
  if (Buffer.byteLength(JSON.stringify(clean)) > 65536) throw new Error('Execution input is too large.');
  return clean;
}

export function containerArgs(name) {
  if (!/^honmaru-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid execution name.');
  return ['run', '--rm', '--name', name, '--network', 'none', '--no-dns', '--read-only', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--uid', '65534', '--gid', '65534', '--cpus', '1', '--memory', '512m',
    '--ulimit', 'nofile=256:256', '--ulimit', 'nproc=128:128', '--progress', 'none', '-i', IMAGE, 'node', '-e', BOOTSTRAP];
}

function control(binary, args) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

export async function runIsolated(payload, { binary = process.env.HONMARU_CONTAINER_BIN || 'container', timeoutMs = 60000, signal } = {}) {
  const clean = validatePayload(payload);
  if (signal?.aborted) return { status: 'failed', stdout: '', stderr: 'Execution cancelled.', exitCode: null };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Invalid execution timeout.');
  const name = `honmaru-${randomUUID()}`;
  let status = null, killPromise, forceTimer;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), seen = 0;
  const child = spawn(binary, containerArgs(name), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const stop = reason => {
    if (status) return;
    status = reason;
    // Kill the VM workload, not just the CLI which is attached to it.
    killPromise = control(binary, ['kill', '--signal', 'KILL', name]);
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 6000);
  };
  const capture = target => chunk => {
    const remaining = Math.max(0, 32768 - seen);
    seen += chunk.length;
    if (target === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
    else stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    if (seen > 32768) stop('failed');
  };
  child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
  child.stdin.on('error', () => {});
  const abort = () => stop('failed');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('timed_out'), timeoutMs);
  try {
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    child.stdin.end(JSON.stringify(clean));
    const code = await completed;
    if (killPromise) await killPromise;
    const result = { status: status || (code === 0 ? 'succeeded' : 'failed'), stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: code };
    if (seen > 32768) result.stderr += '\nOutput limit exceeded.';
    if (signal?.aborted) result.stderr += '\nExecution cancelled.';
    // JSON escaping can expand control characters beyond the wire limit.
    while (Buffer.byteLength(JSON.stringify(result)) > 65000) {
      result.stdout = result.stdout.slice(0, Math.floor(result.stdout.length / 2));
      result.stderr = result.stderr.slice(0, Math.floor(result.stderr.length / 2));
    }
    return result;
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort);
    // Also cleans up boot failures; --rm covers normal exits.
    await control(binary, ['delete', '--force', name]);
  }
}

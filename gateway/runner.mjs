import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const IMAGE = 'docker.io/library/node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
// Trusted bootstraps run inside the VM. No task code executes on macOS.
const BOOTSTRAP = `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',async()=>{try{const task=JSON.parse(raw);const env=Object.freeze(Object.assign(Object.create(null),task.environment||{}));if(task.files){const fs=await import('node:fs/promises');const path=await import('node:path');const root='/tmp/honmaru-work';await fs.mkdir(root,{recursive:true,mode:0o700});for(const file of task.files){const target=path.join(root,...file.path.split('/'));await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,Buffer.from(file.base64,'base64'),{flag:'wx',mode:0o600});}process.chdir(root);}let result;if(task.language==='typescript'){const {stripTypeScriptTypes}=await import('node:module');const code=stripTypeScriptTypes(task.code,{mode:'transform',sourceUrl:'workflow.ts'});const module=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));if(typeof module.default!=='function')throw new Error('TypeScript modules must export a default function.');result=await module.default(task.input,env);}else{const fn=new (Object.getPrototypeOf(async function(){}).constructor)('input','env',task.code);result=await fn(task.input,env);}process.stdout.write(JSON.stringify(result===undefined?null:result));}catch(e){console.error(String(e?.stack||e));process.exitCode=1;}});`;

export function validateEnvironment(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app environment.');
  const entries=Object.entries(value);
  if(entries.length>25)throw new Error('Too many app environment values.');
  const reserved=new Set(['__PROTO__','CONSTRUCTOR','PROTOTYPE','PATH','HOME','PWD','TMPDIR','NODE_OPTIONS']);
  let total=0;const result={};
  for(const [name,secret] of entries){
    if(!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)||reserved.has(name)||name.startsWith('HONMARU_'))throw new Error('Invalid app environment name.');
    if(typeof secret!=='string'||!secret.length||secret.length>4000)throw new Error('Invalid app environment value.');
    total+=secret.length;if(total>12000)throw new Error('App environment values are too large.');
    result[name]=secret;
  }
  return result;
}

export function validateFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > 8) throw new Error('Invalid execution files.');
  const seen = new Set(), kinds = new Map();
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).sort().join(',') !== 'base64,path' ||
        typeof file.path !== 'string' || typeof file.base64 !== 'string') throw new Error('Invalid execution file.');
    const path=file.path;
    if (!path || path.length>240 || path.startsWith('/') || path.includes('\\') || path.includes(':') ||
        /[\u0000-\u001f\u007f]/.test(path) || path.endsWith('/')) throw new Error('Invalid execution file path.');
    const parts=path.split('/');
    if(parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))) throw new Error('Invalid execution file path.');
    if(seen.has(path)) throw new Error('Duplicate execution file path.');
    seen.add(path);
    for(let i=1;i<parts.length;i++){const parent=parts.slice(0,i).join('/');if(seen.has(parent))throw new Error('Conflicting execution file paths.');kinds.set(parent,'directory');}
    if(kinds.get(path)==='directory')throw new Error('Conflicting execution file paths.');
    kinds.set(path,'file');
    if(file.base64.length>4*Math.ceil(256*1024/3)||file.base64.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))throw new Error('Invalid execution file encoding.');
    const size=file.base64.length/4*3-(file.base64.endsWith('==')?2:file.base64.endsWith('=')?1:0);
    if(size>256*1024)throw new Error('Execution file is too large or invalid.');
    total+=size;if(total>1024*1024)throw new Error('Execution files are too large.');
  }
  return files;
}

export function validatePayload(payload, { environment } = {}) {
  if (!payload || typeof payload.code !== 'string' || !payload.code.trim()) throw new Error('JavaScript code is required.');
  if(payload.language!==undefined&&!['javascript','typescript'].includes(payload.language))throw new Error('Unsupported execution language.');
  const files=validateFiles(payload.files);
  const clean = { code: payload.code, input: payload.input ?? null, ...(payload.language==='typescript'?{language:'typescript'}:{}), ...(files.length?{files}:{}) };
  const env=validateEnvironment(environment);
  const baseBytes=Buffer.byteLength(JSON.stringify({code:clean.code,input:clean.input,...(clean.language?{language:clean.language}:{})}));
  if (baseBytes > 65536) throw new Error('Execution input is too large.');
  if(Object.keys(env).length)clean.environment=env;
  if (Buffer.byteLength(JSON.stringify(clean)) > 1600000) throw new Error('Execution input is too large.');
  return clean;
}

export function containerArgs(name, bootstrap = BOOTSTRAP) {
  if (!/^honmaru-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid execution name.');
  return ['run', '--rm', '--name', name, '--network', 'none', '--no-dns', '--read-only', '--tmpfs', '/tmp:size=16M,mode=1777',
    '--cap-drop', 'ALL', '--uid', '65534', '--gid', '65534', '--cpus', '1', '--memory', '512m',
    '--ulimit', 'nofile=256:256', '--ulimit', 'nproc=128:128', '--progress', 'none', '-i', IMAGE, 'node', '-e', bootstrap];
}

function control(binary, args) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

export async function runIsolated(payload, { binary = process.env.HONMARU_CONTAINER_BIN || 'container', timeoutMs = 60000, signal, environment, spawnProcess = spawn, controlProcess = control } = {}) {
  const clean = validatePayload(payload,{environment});
  if (signal?.aborted) return { status: 'failed', stdout: '', stderr: 'Execution cancelled.', exitCode: null };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Invalid execution timeout.');
  const name = `honmaru-${randomUUID()}`;
  let status = null, killPromise, forceTimer;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), seen = 0;
  const child = spawnProcess(binary, containerArgs(name), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const stop = reason => {
    if (status) return;
    status = reason;
    // Kill the VM workload, not just the CLI which is attached to it.
    killPromise = controlProcess(binary, ['kill', '--signal', 'KILL', name]);
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
    await controlProcess(binary, ['delete', '--force', name]);
  }
}

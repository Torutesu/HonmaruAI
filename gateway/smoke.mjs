import assert from 'node:assert/strict';
import { runIsolated } from './runner.mjs';
const result = await runIsolated({ code: 'return { value: input.a + input.b, platform: process.platform, uid: process.getuid() }', input: { a: 20, b: 22 } });
assert.equal(result.status, 'succeeded', result.stderr);
assert.deepEqual(JSON.parse(result.stdout), { value: 42, platform: 'linux', uid: 65534 });
console.log('Isolated execution passed: non-root Linux VM returned 42.');
const isolation = await runIsolated({ code: `const fs = await import('node:fs'); const net = await import('node:net');
let homeVisible = fs.existsSync('/Users/tt'); let writableRoot = false;
try { fs.writeFileSync('/honmaru-test', 'x'); writableRoot = true; } catch {}
const network = await new Promise(resolve => { const s = net.createConnection({host:'1.1.1.1',port:443}); s.on('connect',()=>{s.destroy();resolve(true)}); s.on('error',()=>resolve(false));s.setTimeout(1000,()=>{s.destroy();resolve(false)}); });
return {homeVisible,writableRoot,network};` });
assert.equal(isolation.status, 'succeeded', isolation.stderr);
assert.deepEqual(JSON.parse(isolation.stdout), { homeVisible: false, writableRoot: false, network: false });
console.log('Isolation passed: host home absent, root read-only, outbound network unavailable.');
const timeout = await runIsolated({ code: 'while(true){}' }, { timeoutMs: 3000 });
assert.equal(timeout.status, 'timed_out');
console.log('Timeout passed: runaway execution terminated.');

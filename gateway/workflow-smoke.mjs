import assert from 'node:assert/strict';
import {runWorkflowIsolated} from './workflow-runner.mjs';
let stored={},revision=0;
const operations=[];
const stateOperation=async(method,params)=>{
 operations.push(method);
 if(method==='state.get')return {found:revision>0,state:stored,revision};
 if(params.expectedRevision!==revision)return {saved:false};
 stored=params.state;return {saved:true,revision:++revision};
};
const first=await runWorkflowIsolated({context:{workspaceId:'fixture',timezone:'UTC'},code:`
import {state,ctx} from '@honmaru/workflow-sdk';
const previous=await state.get({view:'checkpoint'});
const result:number=(previous.state?.count??0)+1;
const receipt=await state.set({count:result},{validationStatus:'pending'});
if(!receipt.saved)throw Error('Not saved');
const restored=await state.get({view:'checkpoint'});
console.log(JSON.stringify({count:restored.state.count,workspace:ctx.workspaceId,platform:process.platform,uid:process.getuid()}));
export default function(){throw Error('Default export must not be invoked');}
`},{stateOperation});
assert.equal(first.status,'succeeded',first.stderr);
assert.deepEqual(JSON.parse(first.stdout),{count:1,workspace:'fixture',platform:'linux',uid:65534});
assert.deepEqual(operations,['state.get','state.set','state.get']);
const second=await runWorkflowIsolated({code:`import {state} from '@honmaru/workflow-sdk';process.stdout.write('before:');const previous=await state.get();console.log(previous.state.count);`},{stateOperation});
assert.equal(second.status,'succeeded',second.stderr);assert.equal(second.stdout.trim(),'before:1');
const rejected=await runWorkflowIsolated({code:`import {state} from '@honmaru/workflow-sdk';await state.set({bad:true});`},{stateOperation});
assert.equal(rejected.status,'failed');assert.match(rejected.stderr,/Read state before writing/);
const isolation=await runWorkflowIsolated({code:`
const fs=await import('node:fs');const net=await import('node:net');
let writable=false;try{fs.writeFileSync('/honmaru-test','x');writable=true}catch{}
const network=await new Promise(resolve=>{const socket=net.createConnection({host:'1.1.1.1',port:443});socket.on('connect',()=>{socket.destroy();resolve(true)});socket.on('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(false)})});
console.log(JSON.stringify({home:fs.existsSync('/Users/tt'),writable,network}));
`},{stateOperation});
assert.equal(isolation.status,'succeeded',isolation.stderr);assert.deepEqual(JSON.parse(isolation.stdout),{home:false,writable:false,network:false});
const flooding=await runWorkflowIsolated({code:"process.stdout.write('x'.repeat(40000));"},{stateOperation});
assert.equal(flooding.status,'failed');assert.ok(Buffer.byteLength(flooding.stdout)<=32768);
const timeout=await runWorkflowIsolated({code:'while(true){}'},{stateOperation,timeoutMs:3000});
assert.equal(timeout.status,'timed_out');
console.log('Workflow VM smoke passed: top-level TypeScript, SDK read/write/readback, fresh-VM read, write fence and timeout. Storage callback is a local fixture, not production persistence.');

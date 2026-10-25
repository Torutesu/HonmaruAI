import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {runDocumentIsolated} from '../document-runner.mjs';
const image='honmaru-document@sha256:'+'a'.repeat(64);
const payload={text:'# 日本語',inputFormat:'markdown',format:'pdf'};
function mock(out,error){
 const calls=[];let input='';
 const run=(_binary,args,options)=>{
  if(args[0]==='image')return Promise.resolve({stdout:JSON.stringify([{id:'a'.repeat(64)}])});
  calls.push({args,options});
  if(args[0]!=='run')return Promise.resolve({});
  const stdin=new PassThrough();stdin.on('data',c=>input+=c);
  const p=error?Promise.reject(error):Promise.resolve({stdout:out});p.child={stdin};return p;
 };
 return {run,calls,get input(){return input}};
}
test('binary artifact exceeds ordinary stdout cap without truncation and VM stays isolated',async()=>{
 const bytes=Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(40000)]),m=mock(bytes);
 const result=await runDocumentIsolated({...payload,ignored:'never transmit'},{image,run:m.run});
 assert.deepEqual(result.bytes,bytes);assert.equal(result.size,40005);assert.equal(result.sha256.length,64);
 assert.deepEqual(JSON.parse(m.input),payload);
 const args=m.calls[0].args;
 for(const flag of ['--read-only','--no-dns','--cap-drop','--tmpfs'])assert.ok(args.includes(flag));
 assert.equal(args[args.indexOf('--network')+1],'none');
 assert.deepEqual(m.calls.slice(1).map(c=>c.args[0]),['kill','delete']);
});
test('failure and invalid binary always clean up and never return partial artifact',async()=>{
 for(const m of [mock(Buffer.from('bad')),mock(null,Error('deadline'))]){
  await assert.rejects(runDocumentIsolated(payload,{image,run:m.run}));
  assert.deepEqual(m.calls.map(c=>c.args[0]),['run','kill','delete']);
  assert.equal(m.calls[1].options.signal,undefined);
 }
});
test('unpinned image, invalid input and pre-aborted calls never spawn',async()=>{
 const run=()=>assert.fail('must not spawn');
 await assert.rejects(runDocumentIsolated(payload,{image:'honmaru-document:latest',run}),/pinned/);
 await assert.rejects(runDocumentIsolated({...payload,format:'exe'},{image,run}),/Invalid/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(runDocumentIsolated(payload,{image,run,signal:controller.signal}));
});

test('a misleading local digest reference cannot run a different image',async()=>{
 let calls=0;
 await assert.rejects(runDocumentIsolated(payload,{image,run:async(_b,args)=>{calls++;assert.deepEqual(args,['image','inspect',image]);return {stdout:JSON.stringify([{id:'b'.repeat(64)}])};}}),/digest does not match/);
 assert.equal(calls,1);
});

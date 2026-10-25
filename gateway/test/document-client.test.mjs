import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentClient,processDocumentOne} from '../document-client.mjs';
const id='12345678-1234-1234-1234-123456789012',job={id,lease:'lease',payload:{text:'hello'}};
test('document bytes are sent unmodified with credentials outside URL and redirect forbidden',async()=>{
 const bytes=Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(50000)]);
 const call=documentClient('https://example.test','hgw_'+'a'.repeat(72),async(url,options)=>{
  assert.equal(url.href,'https://example.test/gateways/documents/jobs/'+id+'/artifact');assert.equal(options.body,bytes);
  assert.equal(options.redirect,'error');assert.equal(options.headers['x-honmaru-lease'],'lease');assert.equal(options.headers['content-type'],'application/octet-stream');
  return new Response(JSON.stringify({saved:true}));
 });
 assert.deepEqual(await call('jobs/'+id+'/artifact',{lease:'lease',bytes}),{saved:true});
});
test('lost upload response retries the same binary without rerunning conversion',async()=>{
 let runs=0,uploads=0;const bytes=Buffer.from('%PDF-test');
 const call=async(path,body)=>{if(path==='claim')return {job};assert.equal(path,'jobs/'+id+'/artifact');assert.equal(body.bytes,bytes);if(++uploads===1)throw Error('connection lost');return {saved:true};};
 assert.equal(await processDocumentOne(call,{image:'configured',ready:async()=>{},retryMs:[0],run:async()=>{runs++;return {bytes};}}),true);
 assert.equal(runs,1);assert.equal(uploads,2);
});
test('failed conversion reports failure without sending an artifact',async()=>{
 const paths=[];await processDocumentOne(async path=>{paths.push(path);return path==='claim'?{job}:{};},{image:'configured',ready:async()=>{},run:async()=>{throw Error('converter failed');}});
 assert.deepEqual(paths,['claim','jobs/'+id+'/fail']);
});
test('revoked delivery is not retried',async()=>{
 let uploads=0;
 await assert.rejects(processDocumentOne(async path=>{if(path==='claim')return {job};uploads++;throw Object.assign(Error('revoked'),{status:409});},{image:'configured',ready:async()=>{},retryMs:[0],run:async()=>({bytes:Buffer.from('%PDF-test')})}),/revoked/);
 assert.equal(uploads,1);
});

test('unavailable document image prevents claiming user work',async()=>{
 await assert.rejects(processDocumentOne(()=>assert.fail('must not claim'),{image:'configured',ready:async()=>{throw Error('image unavailable');}}),/unavailable/);
});
test('service processes document work when normal queue is empty and keeps normal execution available on document failure',async()=>{
 const {serve}=await import('../client.mjs');let ordinary=0,documents=0,errors=0;
 const call=async path=>{assert.equal(path,'claim');ordinary++;return {job:null};};
 await serve(call,{once:true,document:{image:'configured',call:()=>{}},documentRun:async()=>{documents++;throw Error('image unavailable');},onError:()=>errors++});
 assert.equal(ordinary,1);assert.equal(documents,1);assert.equal(errors,1);
});

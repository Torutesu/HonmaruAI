import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateBroker,validateStateRequest,createWorkflowOutputParser} from '../workflow-bridge.mjs';
test('guest cannot choose activation identity or call arbitrary host operations',()=>{
 for(const request of [{id:1,method:'shell',params:{}},{id:1,method:'state.get',params:{runId:'other'}},{id:1,method:'state.set',params:{state:{},expectedRevision:0,owner:'other'}},{id:65,method:'state.get',params:{}}])assert.throws(()=>validateStateRequest(request));
});
test('broker serializes writes, rejects duplicate IDs and hides host error details',async()=>{
 const observed=[];let revision=0;
 const broker=createStateBroker(async(method,params)=>{observed.push(params.expectedRevision);if(params.expectedRevision!==revision)return {saved:false};await new Promise(resolve=>setTimeout(resolve,5));return {saved:true,revision:++revision};});
 const replies=await Promise.all([broker({id:1,method:'state.set',params:{state:{},expectedRevision:0}}),broker({id:2,method:'state.set',params:{state:{},expectedRevision:0}})]);
 assert.equal(replies[0].value.saved,true);assert.equal(replies[1].value.saved,false);
 assert.throws(()=>broker({id:1,method:'state.get',params:{}}),/Duplicate/);
 const failing=createStateBroker(async()=>{throw Error('/Users/private/token');});
 assert.deepEqual(await failing({id:1,method:'state.get',params:{}}),{id:1,ok:false,error:'State operation failed.'});
});
test('ended activations cannot begin queued operations or return results',async()=>{
 const controller=new AbortController();let calls=0,release;
 const broker=createStateBroker(async()=>{calls++;await new Promise(resolve=>release=resolve);return {};},{signal:controller.signal});
 const first=broker({id:1,method:'state.get',params:{}});
 const second=broker({id:2,method:'state.get',params:{}});
 const rejected=assert.rejects(second,/Activation ended/);
 await new Promise(resolve=>setTimeout(resolve,0));controller.abort();release();
 assert.equal((await first).ok,false);await rejected;assert.equal(calls,1);
});

test('split state markers survive adjacent non-newline output without altering payloads',()=>{
 let output='';const requests=[],prefix='\x1eHONMARU';
 const parser=createWorkflowOutputParser(prefix,{text:value=>output+=value,request:value=>requests.push(value)});
 const input='before'+prefix+JSON.stringify({id:1,method:'state.get',params:{}})+'\n'+'after';
 for(const character of input)parser.push(character);
 parser.end();
 assert.equal(output,'beforeafter');assert.equal(requests[0].method,'state.get');
 const broken=createWorkflowOutputParser(prefix,{text:()=>{},request:()=>{}});
 broken.push(prefix+'{"id":');assert.throws(()=>broken.end(),/Incomplete/);
});

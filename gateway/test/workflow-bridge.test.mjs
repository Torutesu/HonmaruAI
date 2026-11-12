import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateBroker,validateStateRequest,createWorkflowOutputParser} from '../workflow-bridge.mjs';
import {workflowSdkSource,normalizeWorkflowDraft,queryWorkflowTable,normalizeWorkflowInsert,insertWorkflowTableRow} from '../workflow-sdk.mjs';
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

test('the isolated TypeScript SDK exposes ordered bounded parallel work with explicit partial failures',async()=>{
 const sdk=await import('data:text/javascript;base64,'+Buffer.from(workflowSdkSource()).toString('base64'));
 let active=0,peak=0;const misses=[];
 const result=await sdk.parallel([0,1,2,3,4].map(index=>async()=>{
  active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
  if(index===2)throw Error('source item is missing');return index*10;
 }),{concurrency:2,onError:(error,index)=>misses.push({message:error.message,index})});
 assert.deepEqual(result,[0,10,null,30,40]);assert.equal(peak,2);assert.deepEqual(misses,[{message:'source item is missing',index:2}]);
 await assert.rejects(()=>sdk.parallel([()=>1],{concurrency:33}),/concurrency/);
 await assert.rejects(()=>sdk.parallel([()=>{throw Error('x')}],{onError:()=>{throw Error('audit callback failed')}}),/audit callback failed/);
});

test('pipeline bounds each stage, preserves input order and does not process a failed item again',async()=>{
 const {pipeline}=await import('data:text/javascript;base64,'+Buffer.from(workflowSdkSource()).toString('base64'));
 const errors=[],secondStage=[];
 const result=await pipeline([1,2,3,4],async(value)=>{if(value===2)throw Error('bad row');return value*2;},async(value,index)=>{secondStage.push(index);return value+1;},{concurrency:2,onError:(error,index,stage)=>errors.push([error.message,index,stage])});
 assert.deepEqual(result,[3,null,7,9]);assert.deepEqual(secondStage,[0,2,3]);assert.deepEqual(errors,[['bad row',1,0]]);
 await assert.rejects(()=>pipeline([1],async x=>x,{concurrency:0}),/concurrency/);
});

test('sendMessage stages bounded report drafts without posting or accepting arbitrary options',async()=>{
 const drafts=[];globalThis.__honmaruWorkflowTestBridge={stageMessage:async draft=>{drafts.push(draft);return {staged:true,index:drafts.length};}};
 try {
  const sdk=await import('data:text/javascript;base64,'+Buffer.from(workflowSdkSource('globalThis.__honmaruWorkflowTestBridge')).toString('base64'));
  assert.deepEqual(await sdk.sendMessage('The review is ready.',{mention:['mika','toru']}),{staged:true,index:1});
  assert.deepEqual(drafts,[{text:'The review is ready.',mention:['mika','toru']}]);
  assert.deepEqual(normalizeWorkflowDraft(' report ',{}),{text:' report '});
  assert.throws(()=>normalizeWorkflowDraft('  '),/non-empty/);
  assert.throws(()=>normalizeWorkflowDraft('ok',{roomId:'other'}),/options/);
  assert.throws(()=>normalizeWorkflowDraft('ok',{mention:['']}),/mention/);
  assert.throws(()=>normalizeWorkflowDraft('x'.repeat(12001)),/12 KB/);
 } finally { delete globalThis.__honmaruWorkflowTestBridge; }
});

test('table.query follows stable cursors and reports a bounded incomplete result',async()=>{
 const requests=[];const pages=[
  {rows:[{id:'r1'},{id:'r2'}],complete:false,cursor:'cursor-1'},
  {rows:[{id:'r3'}],complete:true,cursor:null},
 ];
 const bridge={tableSource:{appId:'app',entityId:'primary',tableId:'table'},queryTable:async params=>{requests.push(params);return pages.shift()}};
 const result=await queryWorkflowTable({where:{status:['open']},pageSize:2},bridge);
 assert.deepEqual(result,{rows:[{id:'r1'},{id:'r2'},{id:'r3'}],complete:true,cursor:null,pages:2});
 assert.equal(requests[0].cursor,undefined);assert.equal(requests[1].cursor,'cursor-1');
 const capped=await queryWorkflowTable({pageSize:1,maxPages:1},{...bridge,queryTable:async()=>({rows:[{id:'r1'}],complete:false,cursor:'next'})});
 assert.deepEqual(capped,{rows:[{id:'r1'}],complete:false,cursor:'next',pages:1,incompleteReason:'page_limit'});
 await assert.rejects(()=>queryWorkflowTable({pageSize:101},bridge),/pageSize/);
 await assert.rejects(()=>queryWorkflowTable({},{}),/no explicitly authorized/);
});

test('table.query selects only explicitly bound App entities',async()=>{
 const requests=[],bridge={tableSources:[
  {appId:'app',entityId:'primary',tableId:'table-a'},
  {appId:'app',entityId:'details',tableId:'table-b'},
 ],queryTable:async params=>{requests.push(params);return {rows:[],complete:true,cursor:null}}};
 await queryWorkflowTable({entityId:'details',pageSize:5},bridge);
 assert.equal(requests[0].entityId,'details');
 await assert.rejects(()=>queryWorkflowTable({},bridge),/explicitly authorized entityId/);
 await assert.rejects(()=>queryWorkflowTable({entityId:'private'},bridge),/explicitly authorized/);
 await assert.rejects(()=>queryWorkflowTable({entityId:'bad-id!'},bridge),/Invalid App entity/);
});

test('table.insert requires an explicitly writable entity and sends only bounded row values',async()=>{
 const calls=[],bridge={tableSources:[{appId:'app',entityId:'primary',tableId:'table-a',write:true},{appId:'app',entityId:'details',tableId:'table-b'}],insertTable:async value=>{calls.push(value);return {staged:true,index:1}}};
 assert.deepEqual(await insertWorkflowTableRow({entityId:'primary',values:{name:'Alpha'}},bridge),{staged:true,index:1});
 assert.deepEqual(calls,[{entityId:'primary',values:{name:'Alpha'}}]);
 await assert.rejects(()=>insertWorkflowTableRow({entityId:'details',values:{}},bridge),/not enabled/);
 assert.throws(()=>normalizeWorkflowInsert({entityId:'primary',values:{},tableId:'other'}),/Invalid table.insert/);
 assert.throws(()=>validateStateRequest({id:1,method:'table.insert',params:{entityId:'primary',values:{name:'Alpha'},orgId:'other'}}),/Unexpected state parameter/);
 assert.throws(()=>validateStateRequest({id:1,method:'table.insert',params:{entityId:'bad-id!',values:{}}}),/Invalid App entity/);
});

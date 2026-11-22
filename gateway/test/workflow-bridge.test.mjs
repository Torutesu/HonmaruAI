import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateBroker,validateStateRequest,createWorkflowOutputParser} from '../workflow-bridge.mjs';
import {workflowSdkSource,normalizeWorkflowDraft,queryWorkflowTable,normalizeWorkflowInsert,insertWorkflowTableRow,normalizeWorkflowUpdate,normalizeWorkflowDelete,updateWorkflowTableRow,deleteWorkflowTableRow,normalizeWorkflowConnectionRequest,requestWorkflowConnection,stageWorkflowConnectionWrite,paginateWorkflowConnection} from '../workflow-sdk.mjs';
import {validateWorkflowConnectionSources,validateWorkflowConnectionWrite} from '../workflow-runner.mjs';
test('guest cannot choose activation identity or call arbitrary host operations',()=>{
 for(const request of [{id:1,method:'shell',params:{}},{id:1,method:'state.get',params:{runId:'other'}},{id:1,method:'state.set',params:{state:{},expectedRevision:0,owner:'other'}},{id:65,method:'state.get',params:{}}])assert.throws(()=>validateStateRequest(request));
});

test('agent.invoke accepts only the bounded prompt, schema and tier contract',()=>{
 const params={agentId:'agent-main',prompt:'Classify this item',schema:{type:'object',properties:{label:{type:'string',maxLength:40}},required:['label'],additionalProperties:false},tier:'high'};
 assert.deepEqual(validateStateRequest({id:1,method:'agent.invoke',params}),{id:1,method:'agent.invoke',params});
 for(const bad of [
  {...params,extra:true},{...params,prompt:'x'.repeat(12001)},{...params,tier:'ultra'},
  {...params,schema:{type:'object',properties:{},additionalProperties:true}},
  {...params,schema:{type:'object',properties:{label:{type:'string',pattern:'x'}},additionalProperties:false}},
 ]) assert.throws(()=>validateStateRequest({id:1,method:'agent.invoke',params:bad}));
 assert.throws(()=>validateStateRequest({id:1,method:'agent.invoke',params:{...params,prompt:'  '}}));
});

test('connection.request accepts only a named frozen App connection and bounded query data',()=>{
 const params={appId:'app-1',name:'issues',query:{state:'open',label:['bug','urgent']}};
 assert.deepEqual(validateStateRequest({id:1,method:'connection.request',params}),{id:1,method:'connection.request',params});
 for(const bad of [
  {...params,url:'https://evil.example'}, {...params,method:'POST'}, {...params,body:{title:'x'}},
  {...params,query:{access_token:'secret'}}, {...params,query:{q:'x'.repeat(20001)}},
  {...params,query:{filter:{deep:{value:'x'}}}},
  {...params,body:{title:'x'},operationId:'stable-write'}, {...params,operationId:'stable-write'},
 ])assert.throws(()=>validateStateRequest({id:1,method:'connection.request',params:bad}));
 assert.throws(()=>validateStateRequest({id:1,method:'connection.request',params:{...params,appId:''}}));
 const staged={appId:'app-1',name:'issues',body:{title:'x'},operationId:'stable-write'};
 assert.deepEqual(validateStateRequest({id:1,method:'connection.stageWrite',params:staged}),{id:1,method:'connection.stageWrite',params:staged});
 for(const bad of [{...staged,body:[]},{...staged,operationId:'bad id'},{...staged,url:'https://evil.example'}])assert.throws(()=>validateStateRequest({id:1,method:'connection.stageWrite',params:bad}));
});

test('runner accepts only frozen GET or explicitly write-enabled App connection bindings',()=>{
 const get={appId:'app-1',name:'issues',ownerId:'owner-1',version:1,method:'GET'};
 const write={appId:'app-1',name:'create_issue',ownerId:'owner-1',version:2,method:'POST',write:true};
 assert.deepEqual(validateWorkflowConnectionSources([get]),[get]);
 assert.deepEqual(validateWorkflowConnectionSources([write]),[write]);
 for(const invalid of [
  [{...write,write:undefined}],
  [{...get,write:true}],
  [{...write,method:'TRACE'}],
  [get,{...get}],
 ])assert.throws(()=>validateWorkflowConnectionSources(invalid),/Invalid App connection sources context/);
 assert.equal(validateWorkflowConnectionSources(undefined),undefined);
});

test('approved write batches may span frozen App connections owned by the same person only',()=>{
 const sources=[
  {appId:'app-1',name:'create_issue',ownerId:'owner-1',version:2,method:'POST',write:true},
  {appId:'app-2',name:'add_comment',ownerId:'owner-1',version:4,method:'POST',write:true},
  {appId:'app-3',name:'other_owner',ownerId:'owner-2',version:1,method:'PUT',write:true},
 ];
 assert.equal(validateWorkflowConnectionWrite(sources,{appId:'app-1',name:'create_issue'}),sources[0]);
 assert.equal(validateWorkflowConnectionWrite(sources,{appId:'app-2',name:'add_comment'},'owner-1'),sources[1]);
 assert.throws(()=>validateWorkflowConnectionWrite(sources,{appId:'app-3',name:'other_owner'},'owner-1'),/owner/);
 assert.throws(()=>validateWorkflowConnectionWrite(sources,{appId:'missing',name:'none'}),/scope/);
});

test('Workflow SDK keeps App requests read-only and stages writes for per-run approval',async()=>{
 const calls=[],bridge={connectionSources:[{appId:'app-1',name:'issues',method:'GET'}],requestConnection:async input=>{calls.push(input);return {data:[{id:'i-1'}]}}};
 assert.deepEqual(normalizeWorkflowConnectionRequest({appId:'app-1',name:'issues',query:{state:'open'}}),{appId:'app-1',name:'issues',query:{state:'open'}});
 assert.deepEqual(await requestWorkflowConnection({appId:'app-1',name:'issues',query:{state:'open'}},bridge),{data:[{id:'i-1'}]});
 assert.deepEqual(calls,[{appId:'app-1',name:'issues',query:{state:'open'}}]);
 await assert.rejects(()=>requestWorkflowConnection({appId:'app-2',name:'issues'},bridge),/frozen binding/);
 const writeCalls=[],writeBridge={connectionSources:[{appId:'app-1',name:'issues',method:'POST',write:true}],requestConnection:async input=>{writeCalls.push(input);return {data:{id:'created-1'}}},stageConnectionWrite:async input=>{writeCalls.push(input);return {staged:true}}};
 await assert.rejects(()=>requestWorkflowConnection({appId:'app-1',name:'issues',body:{title:'x'},operationId:'create-1'},writeBridge),/stageWrite/);
 assert.deepEqual(await stageWorkflowConnectionWrite({appId:'app-1',name:'issues',body:{title:'x'},operationId:'create-1'},writeBridge),{staged:true});
 assert.deepEqual(writeCalls,[{appId:'app-1',name:'issues',body:{title:'x'},operationId:'create-1'}]);
 globalThis.__workflowConnectionWriteTestBridge=writeBridge;
 try{const sdk=await import('data:text/javascript;base64,'+Buffer.from(workflowSdkSource('globalThis.__workflowConnectionWriteTestBridge')).toString('base64'));assert.deepEqual(await sdk.connection.stageWrite({appId:'app-1',name:'issues',body:{title:'sdk'},operationId:'sdk-write-1'}),{staged:true});await assert.rejects(()=>sdk.connection.request({appId:'app-1',name:'issues',body:{title:'sdk'},operationId:'sdk-write-1'}),/stageWrite/);}
 finally{delete globalThis.__workflowConnectionWriteTestBridge;}
 await assert.rejects(()=>stageWorkflowConnectionWrite({appId:'app-1',name:'issues',body:{title:'x'},operationId:'create-1'},{...bridge,connectionSources:[{appId:'app-1',name:'issues',method:'POST'}],stageConnectionWrite:async()=>({staged:true})}),/write binding/);
 assert.throws(()=>normalizeWorkflowConnectionRequest({appId:'app-1',name:'issues',body:{title:'x'}}),/stable operationId/);
 assert.deepEqual(normalizeWorkflowConnectionRequest({appId:'app-1',name:'issues',body:{title:'x'},operationId:'create-1'}),{appId:'app-1',name:'issues',body:{title:'x'},operationId:'create-1'});
 assert.throws(()=>normalizeWorkflowConnectionRequest({appId:'app-1',name:'issues',url:'https://example.com'}),/Invalid/);
 globalThis.__workflowConnectionTestBridge=bridge;
 try{const sdk=await import('data:text/javascript;base64,'+Buffer.from(workflowSdkSource('globalThis.__workflowConnectionTestBridge')).toString('base64'));assert.deepEqual(await sdk.connection.request({appId:'app-1',name:'issues'}),{data:[{id:'i-1'}]});}
 finally{delete globalThis.__workflowConnectionTestBridge;}
});

test('connection.paginate follows provider cursors through the frozen binding and stops at configured limits',async()=>{
 const calls=[],pages=new Map([
  [null,{data:{issues:[{id:'i-1'}],next:'cursor-1'}}],
  ['cursor-1',{data:{issues:[{id:'i-2'}],next:null}}],
 ]);
 const bridge={connectionSources:[{appId:'app-1',name:'issues',method:'GET'}],requestConnection:async input=>{
  calls.push(input);const cursor=input.query?.cursor??null;const response=pages.get(cursor);if(!response)throw Error('connection access changed');return response;
 }};
 const result=await paginateWorkflowConnection({appId:'app-1',name:'issues',query:{state:'open'},getItems:data=>data.issues,getNextQuery:data=>data.next?{state:'open',cursor:data.next}:null},bridge);
 assert.deepEqual(result,{items:[{id:'i-1'},{id:'i-2'}],complete:true,pages:2,nextQuery:null});
 assert.deepEqual(calls.map(call=>call.query),[{state:'open'},{state:'open',cursor:'cursor-1'}]);
 globalThis.__workflowPaginationBridge=bridge;
 try {
  const sdk=await import('data:text/javascript;base64,'+Buffer.from(workflowSdkSource('globalThis.__workflowPaginationBridge')).toString('base64'));
  assert.equal(typeof sdk.connection.paginate,'function');
  const generated=await sdk.connection.paginate({appId:'app-1',name:'issues',query:{state:'open'},getItems:data=>data.issues,getNextQuery:data=>data.next?{state:'open',cursor:data.next}:null});
  assert.equal(generated.complete,true);assert.equal(generated.items.length,2);
 } finally { delete globalThis.__workflowPaginationBridge; }
 const capped=await paginateWorkflowConnection({appId:'app-1',name:'issues',query:{state:'open'},maxPages:1,getItems:data=>data.issues,getNextQuery:data=>({cursor:data.next})},bridge);
 assert.deepEqual(capped,{items:[{id:'i-1'}],complete:false,pages:1,nextQuery:{cursor:'cursor-1'},incompleteReason:'page_limit'});
 await assert.rejects(()=>paginateWorkflowConnection({appId:'app-1',name:'issues',getItems:data=>data,getNextQuery:()=>null,maxPages:33},bridge),/limits/);
});

test('connection.paginate never retries or hides incomplete and malformed results',async()=>{
 let calls=0;
 const bridge={connectionSources:[{appId:'app-1',name:'issues',method:'GET'}],requestConnection:async()=>{calls++;if(calls===2)throw Error('access revoked');return {data:{issues:[{id:'i-1'}],next:'cursor-1'}}}};
 await assert.rejects(()=>paginateWorkflowConnection({appId:'app-1',name:'issues',getItems:data=>data.issues,getNextQuery:data=>data.next?{cursor:data.next}:null},bridge),/access revoked/);
 assert.equal(calls,2);
 const repeated=await paginateWorkflowConnection({appId:'app-1',name:'issues',getItems:data=>data.issues,getNextQuery:()=>({cursor:'same'})},{...bridge,requestConnection:async()=>({data:{issues:[{id:'i-1'}],next:'same'}})});
 assert.deepEqual(repeated,{items:[{id:'i-1'},{id:'i-1'}],complete:false,pages:2,incompleteReason:'repeated_query'});
 let reorderedCalls=0;
 const reordered=await paginateWorkflowConnection({appId:'app-1',name:'issues',query:{cursor:'same',limit:10},getItems:data=>data.issues,getNextQuery:()=>({limit:10,cursor:'same'})},{connectionSources:[{appId:'app-1',name:'issues',method:'GET'}],requestConnection:async()=>{reorderedCalls++;return {data:{issues:[{id:'i-1'}]}}}});
 assert.deepEqual(reordered,{items:[{id:'i-1'}],complete:false,pages:1,incompleteReason:'repeated_query'});assert.equal(reorderedCalls,1);
 const itemCapped=await paginateWorkflowConnection({appId:'app-1',name:'issues',maxItems:1,getItems:()=>{const item={};item.self=item;return [item,item]},getNextQuery:()=>null},{...bridge,requestConnection:async()=>({data:{issues:[]}})});
 assert.deepEqual(itemCapped,{items:[],complete:false,pages:1,incompleteReason:'page_item_limit'});
 const byteCapped=await paginateWorkflowConnection({appId:'app-1',name:'issues',maxBytes:8,getItems:data=>data.issues,getNextQuery:()=>null},{...bridge,requestConnection:async()=>({data:{issues:[{id:'i-1'}]}})});
 assert.deepEqual(byteCapped,{items:[],complete:false,pages:1,incompleteReason:'page_size_limit'});
 await assert.rejects(()=>paginateWorkflowConnection({appId:'app-1',name:'issues',getItems:()=>({id:'i-1'}),getNextQuery:()=>null},{...bridge,requestConnection:async()=>({data:{}})}),/return an array/);
 let oversizedCalls=0;
 await assert.rejects(()=>paginateWorkflowConnection({appId:'app-1',name:'issues',query:{q:'x'.repeat(20001)},getItems:data=>data,getNextQuery:()=>null},{connectionSources:[{appId:'app-1',name:'issues',method:'GET'}],requestConnection:async()=>{oversizedCalls++;return {data:{}}}}),/Invalid App connection query/);
 assert.equal(oversizedCalls,0);
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
test('broker allows concurrent table reads while checkpoint operations keep their ordered lane',async()=>{
 const started=[],releases=[];
 const broker=createStateBroker(async(method,params)=>{
  started.push([method,params.q||'']);
  await new Promise(resolve=>releases.push(resolve));
  return {read:true};
 });
 const checkpoint=broker({id:1,method:'state.set',params:{state:{},expectedRevision:0}});
 await new Promise(resolve=>setTimeout(resolve,0));
 const first=broker({id:2,method:'table.query',params:{q:'first'}});
 const second=broker({id:3,method:'table.query',params:{q:'second'}});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(started,[['state.set',''],['table.query','first'],['table.query','second']]);
 releases.forEach(release=>release());
 assert.deepEqual((await Promise.all([checkpoint,first,second])).map(reply=>reply.value),[{read:true},{read:true},{read:true}]);
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


test('agent SDK normalizes and dispatches the explicit agent.invoke contract',async()=>{
 const requests=[],bridge={invokeAgent:async params=>{requests.push(params);return {output:{label:'urgent'}}}};
 const {invokeWorkflowAgent,normalizeWorkflowAgentCall}=await import('../workflow-sdk.mjs');
 const schema={type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false};
 assert.deepEqual(await invokeWorkflowAgent('Classify',{agentId:'agent-main',schema,tier:'low'},bridge),{label:'urgent'});
 assert.deepEqual(requests,[{agentId:'agent-main',prompt:'Classify',schema,tier:'low'}]);
 assert.deepEqual(normalizeWorkflowAgentCall('Classify',{agentId:'agent-main',schema}),{agentId:'agent-main',prompt:'Classify',schema,tier:'medium'});
 assert.throws(()=>normalizeWorkflowAgentCall('x'.repeat(12001),{agentId:'agent-main',schema}));
 assert.throws(()=>normalizeWorkflowAgentCall('x',{agentId:'agent-main',schema,tier:'fast'}));
 assert.throws(()=>normalizeWorkflowAgentCall('x',{agentId:'agent-main',schema:{type:'object',properties:{x:{type:'string',format:'email'}},additionalProperties:false}}));
 assert.throws(()=>normalizeWorkflowAgentCall('あ'.repeat(5000),{agentId:'agent-main',schema}));
 assert.throws(()=>normalizeWorkflowAgentCall('x',{agentId:'agent-main',schema:{type:'object',properties:{x:{type:'string',enum:['x'.repeat(16001)]}},additionalProperties:false}}));
 await assert.rejects(()=>invokeWorkflowAgent('x',{agentId:'agent-main',schema},{}),/unavailable/);
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

test('table.query distinguishes the same entity key across explicitly bound Apps',async()=>{
 const requests=[],bridge={tableSources:[
  {appId:'app-a',entityId:'records',tableId:'table-a'},
  {appId:'app-b',entityId:'records',tableId:'table-b'},
 ],queryTable:async params=>{requests.push(params);return {rows:[],complete:true,cursor:null}}};
 await queryWorkflowTable({appId:'app-b',entityId:'records'},bridge);
 assert.deepEqual(requests[0],{appId:'app-b',entityId:'records',where:{},q:'',pageSize:100});
 await assert.rejects(()=>queryWorkflowTable({entityId:'records'},bridge),/Choose an explicitly authorized App and entity/);
 await assert.rejects(()=>queryWorkflowTable({appId:'app-c',entityId:'records'},bridge),/no explicitly authorized App\/Table source/);
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

test('table.update and table.delete require explicit mutation scope and a row version',async()=>{
 const calls=[],bridge={tableSources:[{appId:'app',entityId:'primary',tableId:'table-a',write:true},{appId:'app',entityId:'details',tableId:'table-b',mutate:true}],updateTable:async value=>{calls.push(['update',value]);return {staged:true}},deleteTable:async value=>{calls.push(['delete',value]);return {staged:true}}};
 const target={entityId:'details',rowId:'row-1',expectedUpdatedAt:'2026-01-01T00:00:00.000Z'};
 assert.deepEqual(await updateWorkflowTableRow({...target,values:{status:'done'}},bridge),{staged:true});
 assert.deepEqual(await deleteWorkflowTableRow(target,bridge),{staged:true});
 assert.deepEqual(calls.map(([method])=>method),['update','delete']);
 await assert.rejects(()=>updateWorkflowTableRow({...target,values:{}},{...bridge,tableSources:[{entityId:'primary',write:true}]}),/not enabled/);
 await assert.rejects(()=>deleteWorkflowTableRow({entityId:'details',rowId:'row-1'},bridge),/Invalid table.delete/);
 assert.throws(()=>normalizeWorkflowUpdate({...target,values:{},extra:true}),/Invalid table.update/);
 assert.throws(()=>normalizeWorkflowDelete({...target,expectedUpdatedAt:'today'}),/Invalid table.delete/);
 for(const method of ['table.update','table.delete'])assert.throws(()=>validateStateRequest({id:1,method,params:{...target,values:{},orgId:'other'}}),/Unexpected state parameter/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {WORKFLOW_BOOTSTRAP} from '../workflow-guest.mjs';
import {createWorkflowOutputParser} from '../workflow-bridge.mjs';

test('isolated guest sends sendMessage through the host frame and preserves ordinary output',async()=>{
 const nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce,requests=[],drafts=[];
 const child=spawn(process.execPath,['--input-type=module','--eval',WORKFLOW_BOOTSTRAP],{stdio:['pipe','pipe','pipe'],shell:false});
 let output='',stderr='';
 const parser=createWorkflowOutputParser(prefix,{text:value=>output+=value,request:request=>{
  requests.push(request);
  if(request.method==='message.stage'){
   drafts.push(request.params);
   child.stdin.write(JSON.stringify({id:request.id,ok:true,value:{staged:true,index:drafts.length}})+'\n');
  } else if(request.method==='state.get')child.stdin.write(JSON.stringify({id:request.id,ok:true,value:{found:false,revision:0}})+'\n');
  else if(request.method==='state.set')child.stdin.write(JSON.stringify({id:request.id,ok:true,value:{saved:true,revision:1}})+'\n');
 }});
 child.stdout.on('data',chunk=>parser.push(chunk.toString('utf8')));
 child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',exitCode=>{
  try{parser.end();resolve(exitCode)}catch(error){reject(error)}
 })});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 try {
  child.stdin.write(JSON.stringify({nonce,context:{workspaceId:'workspace'},code:`import {sendMessage,state} from '@honmaru/workflow-sdk';\nconsole.log('before');\nawait state.get();\nawait state.set({complete:true});\nawait sendMessage('Report is ready.',{mention:['mika']});\nconsole.log('after');`})+'\n');
  assert.equal(await completion,0,stderr);
  assert.equal(output,'before\nafter\n');
  assert.deepEqual(requests.map(item=>item.method),['state.get','state.set','message.stage']);
  assert.deepEqual(drafts,[{text:'Report is ready.',mention:['mika']}]);
 } finally {clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});

test('isolated guest table.query uses only the host broker and returns explicit partial status',async()=>{
 const nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce,requests=[];
 const child=spawn(process.execPath,['--input-type=module','--eval',WORKFLOW_BOOTSTRAP],{stdio:['pipe','pipe','pipe'],shell:false});
 let output='',stderr='';
 const parser=createWorkflowOutputParser(prefix,{text:value=>output+=value,request:request=>{
  requests.push(request);
  const value=request.params.cursor?{rows:[{id:'r2'}],complete:true,cursor:null}:{rows:[{id:'r1'}],complete:false,cursor:'cursor-1'};
  child.stdin.write(JSON.stringify({id:request.id,ok:true,value})+'\n');
 }});
 child.stdout.on('data',chunk=>parser.push(chunk.toString('utf8')));child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',exitCode=>{try{parser.end();resolve(exitCode)}catch(error){reject(error)}})});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{
  child.stdin.write(JSON.stringify({nonce,context:{workspaceId:'workspace',tableSource:{appId:'app',entityId:'primary',tableId:'table'}},code:`import {table} from '@honmaru/workflow-sdk';const result=await table.query({pageSize:1});console.log(JSON.stringify(result));`})+'\n');
  assert.equal(await completion,0,stderr);const result=JSON.parse(output.trim());
  assert.deepEqual(result.rows,[{id:'r1'},{id:'r2'}]);assert.equal(result.complete,true);assert.equal(result.pages,2);
  assert.deepEqual(requests.map(request=>request.method),['table.query','table.query']);assert.equal(requests[1].params.cursor,'cursor-1');
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});

test('isolated guest queries a selected entity through the host broker',async()=>{
 const nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce,requests=[];
 const child=spawn(process.execPath,['--input-type=module','--eval',WORKFLOW_BOOTSTRAP],{stdio:['pipe','pipe','pipe'],shell:false});
 let output='',stderr='';
 const parser=createWorkflowOutputParser(prefix,{text:value=>output+=value,request:request=>{
  requests.push(request);child.stdin.write(JSON.stringify({id:request.id,ok:true,value:{rows:[{id:'detail-row'}],complete:true,cursor:null}})+'\n');
 }});
 child.stdout.on('data',chunk=>parser.push(chunk.toString('utf8')));child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',exitCode=>{try{parser.end();resolve(exitCode)}catch(error){reject(error)}})});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{
  child.stdin.write(JSON.stringify({nonce,context:{workspaceId:'workspace',tableSources:[
   {appId:'app',entityId:'primary',tableId:'table-a'},{appId:'app',entityId:'details',tableId:'table-b'}
  ]},code:`import {table} from '@honmaru/workflow-sdk';const result=await table.query({entityId:'details',pageSize:1});console.log(JSON.stringify(result));`})+'\n');
  assert.equal(await completion,0,stderr);assert.deepEqual(JSON.parse(output.trim()).rows,[{id:'detail-row'}]);
  assert.equal(requests[0].params.entityId,'details');assert.equal(requests[0].method,'table.query');
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});

test('isolated guest stages a row only through an explicitly writable entity',async()=>{
 const nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce,requests=[];
 const child=spawn(process.execPath,['--input-type=module','--eval',WORKFLOW_BOOTSTRAP],{stdio:['pipe','pipe','pipe'],shell:false});
 let stderr='';
 const parser=createWorkflowOutputParser(prefix,{text:()=>{},request:request=>{requests.push(request);child.stdin.write(JSON.stringify({id:request.id,ok:true,value:{staged:true,index:1}})+'\n')}});
 child.stdout.on('data',chunk=>parser.push(chunk.toString('utf8')));child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',exitCode=>{try{parser.end();resolve(exitCode)}catch(error){reject(error)}})});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{
  child.stdin.write(JSON.stringify({nonce,context:{workspaceId:'workspace',tableSources:[{appId:'app',entityId:'primary',tableId:'table-a',write:true}]},code:`import {table} from '@honmaru/workflow-sdk';await table.insert({entityId:'primary',values:{name:'Alpha'}});`})+'\n');
  assert.equal(await completion,0,stderr);assert.equal(requests.length,1);assert.equal(requests[0].method,'table.insert');assert.deepEqual(requests[0].params,{entityId:'primary',values:{name:'Alpha'}});
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});

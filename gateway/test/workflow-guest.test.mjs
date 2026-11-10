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

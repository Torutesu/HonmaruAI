import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWorkflowIsolated} from '../workflow-runner.mjs';
import {WORKFLOW_BOOTSTRAP} from '../workflow-guest.mjs';

test('isolated Workflow stages an ordered App write batch for one frozen connection',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'honmaru-workflow-runner-'));
 const binary=join(directory,'fake-container.mjs');
 await writeFile(binary,`#!/usr/bin/env node
import {spawn} from 'node:child_process';
if(process.argv[2]!=='run')process.exit(0);
const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(WORKFLOW_BOOTSTRAP)}],{stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('error',()=>{process.exitCode=1});child.once('close',code=>{process.exitCode=code??1});
`);
 await chmod(binary,0o755);
 const writes=[];
 try{
  const result=await runWorkflowIsolated({code:`import {connection} from '@honmaru/workflow-sdk';
await Promise.all(['First','Second','Third'].map((title,index)=>connection.stageWrite({appId:'app-1',name:'issues',operationId:'issue-'+(index+1),body:{title}})));`,context:{connectionSources:[{appId:'app-1',name:'issues',ownerId:'owner-1',version:2,method:'POST',write:true}]}},{
   binary,
   stateOperation:async(method,params)=>{writes.push({method,params});return {staged:true};},
   timeoutMs:5000,
  });
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.deepEqual(writes.map(({params})=>params.body.title),['First','Second','Third']);
  assert.deepEqual(result.connectionWrites.map(({appId,name,ownerId,version,method,operationId,body})=>({appId,name,ownerId,version,method,operationId,body})),[
   {appId:'app-1',name:'issues',ownerId:'owner-1',version:2,method:'POST',operationId:'issue-1',body:{title:'First'}},
   {appId:'app-1',name:'issues',ownerId:'owner-1',version:2,method:'POST',operationId:'issue-2',body:{title:'Second'}},
   {appId:'app-1',name:'issues',ownerId:'owner-1',version:2,method:'POST',operationId:'issue-3',body:{title:'Third'}},
  ]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

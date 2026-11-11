import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {containerArgs} from './runner.mjs';
import {WORKFLOW_BOOTSTRAP} from './workflow-guest.mjs';
import {createStateBroker,createWorkflowOutputParser} from './workflow-bridge.mjs';
import {normalizeWorkflowDraft} from './workflow-sdk.mjs';

export const WORKFLOW_EXECUTION_TIMEOUT_MS=15*60*1000;
function control(binary,args){return new Promise(resolve=>{const child=spawn(binary,args,{stdio:'ignore',shell:false});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const done=()=>{clearTimeout(timer);resolve()};child.once('error',done);child.once('close',done);});}
// Only trusted orchestration calls this with an activation-bound state callback.
// No API route, general gateway payload or model tool can select this runner yet.
export async function runWorkflowIsolated({code,context={}},{stateOperation,binary=process.env.HONMARU_CONTAINER_BIN||'container',timeoutMs=WORKFLOW_EXECUTION_TIMEOUT_MS,signal}={}){
 if(!context||typeof context!=='object'||Array.isArray(context)||Object.keys(context).some(key=>!['workspaceId','roomId','agentId','timezone','trigger','tableSource','tableSources'].includes(key)))throw Error('Invalid public workflow context.');
 if(context.tableSource!==undefined&&(!context.tableSource||typeof context.tableSource!=='object'||Array.isArray(context.tableSource)||Object.keys(context.tableSource).sort().join(',')!=='appId,entityId,tableId'||Object.values(context.tableSource).some(value=>typeof value!=='string'||!value||value.length>200)))throw Error('Invalid App/Table source context.');
 if(context.tableSources!==undefined&&(!Array.isArray(context.tableSources)||context.tableSources.length<1||context.tableSources.length>20||context.tableSource!==undefined||context.tableSources.some(source=>!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).sort().join(',')!=='appId,entityId,tableId'||Object.values(source).some(value=>typeof value!=='string'||!value||value.length>200)||!/^([a-z][a-z0-9_]{0,39})$/.test(source.entityId))||new Set(context.tableSources.map(source=>`${source.appId}\0${source.entityId}`)).size!==context.tableSources.length||new Set(context.tableSources.map(source=>source.appId)).size!==1))throw Error('Invalid App/Table sources context.');
 if(typeof code!=='string'||!code.trim()||Buffer.byteLength(JSON.stringify({code,context}))>65536)throw Error('Invalid workflow module.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>WORKFLOW_EXECUTION_TIMEOUT_MS)throw Error('Invalid execution timeout.');
 const controller=new AbortController();
 const broker=createStateBroker(stateOperation,{signal:controller.signal});
 if(signal?.aborted)return {status:'failed',stdout:'',stderr:'Execution cancelled.',exitCode:null};
 const name=`honmaru-${randomUUID()}`,nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce;
 const child=spawn(binary,containerArgs(name,WORKFLOW_BOOTSTRAP),{stdio:['pipe','pipe','pipe'],shell:false});
 let closed=false,status=null,killPromise,forceTimer,wireBytes=0,responseBytes=0,logBytes=0;
 const messages=[],requestIds=new Set();let messageBytes=0;
 let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0);
 const decoder=new StringDecoder('utf8');
 const stop=reason=>{
  if(status||closed)return;
  status=reason;controller.abort();
  killPromise=control(binary,['kill','--signal','KILL',name]);
  forceTimer=setTimeout(()=>child.kill('SIGKILL'),6000);
 };
 const log=(target,chunk)=>{
  chunk=Buffer.from(chunk);const remaining=Math.max(0,32768-logBytes);logBytes+=chunk.length;
  if(target==='stdout')stdout=Buffer.concat([stdout,chunk.subarray(0,remaining)]);else stderr=Buffer.concat([stderr,chunk.subarray(0,remaining)]);
  if(logBytes>32768){if(closed)status||='failed';else stop('failed');}
 };
 const parser=createWorkflowOutputParser(prefix,{text:value=>log('stdout',value),request:request=>{
  if(closed||controller.signal.aborted)return;
  if(!request||!Number.isSafeInteger(request.id)||request.id<1||request.id>64||requestIds.has(request.id)){stop('failed');return;}
  requestIds.add(request.id);
  const operation=request.method==='message.stage'?Promise.resolve().then(()=>{
   if(!request.params||typeof request.params!=='object'||Array.isArray(request.params)||Object.keys(request.params).some(key=>!['text','mention'].includes(key)))throw Error('Invalid staged message.');
   const draft=normalizeWorkflowDraft(request.params.text,request.params.mention===undefined?{}:{mention:request.params.mention});
   if(messages.length>=32||messageBytes+Buffer.byteLength(JSON.stringify(draft))>30000)throw Error('Staged message limit exceeded.');
   messageBytes+=Buffer.byteLength(JSON.stringify(draft));messages.push(draft);return {staged:true,index:messages.length};
  }).then(value=>({id:request.id,ok:true,value}),()=>({id:request.id,ok:false,error:'Message draft was rejected.'})):broker(request);
  operation.then(reply=>{
   if(closed||controller.signal.aborted)return;
   const encoded=JSON.stringify(reply)+'\n';responseBytes+=Buffer.byteLength(encoded);
   if(responseBytes>2_000_000){stop('failed');return;}
   child.stdin.write(encoded);
  }).catch(()=>stop('failed'));
 }});
 child.stdout.on('data',chunk=>{
  wireBytes+=chunk.length;
  if(wireBytes>2_000_000){stop('failed');return;}
  try{parser.push(decoder.write(chunk));}catch{stop('failed');}
 });
 child.stderr.on('data',chunk=>log('stderr',chunk));
 child.stdin.on('error',()=>{});
 const abort=()=>stop('failed');signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>stop('timed_out'),timeoutMs);
 try {
  const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  child.stdin.write(JSON.stringify({code,context,nonce})+'\n');
  const exitCode=await completion;closed=true;controller.abort();
  if(killPromise)await killPromise;
  try{parser.push(decoder.end());parser.end();}catch{status||='failed';}
  const result={status:status||(exitCode===0?'succeeded':'failed'),stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),exitCode,messages};
  if(logBytes>32768)result.stderr+='\nOutput limit exceeded.';
  if(signal?.aborted)result.stderr+='\nExecution cancelled.';
  while(Buffer.byteLength(JSON.stringify(result))>65000){result.stdout=result.stdout.slice(0,Math.floor(result.stdout.length/2));result.stderr=result.stderr.slice(0,Math.floor(result.stderr.length/2));}
  return result;
 }finally{
  closed=true;controller.abort();clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',abort);
  await control(binary,['delete','--force',name]);
 }
}

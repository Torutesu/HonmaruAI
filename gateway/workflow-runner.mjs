import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {containerArgs} from './runner.mjs';
import {WORKFLOW_BOOTSTRAP} from './workflow-guest.mjs';
import {createStateBroker,createWorkflowOutputParser} from './workflow-bridge.mjs';

function control(binary,args){return new Promise(resolve=>{const child=spawn(binary,args,{stdio:'ignore',shell:false});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const done=()=>{clearTimeout(timer);resolve()};child.once('error',done);child.once('close',done);});}
// Only trusted orchestration calls this with an activation-bound state callback.
// No API route, general gateway payload or model tool can select this runner yet.
export async function runWorkflowIsolated({code,context={}},{stateOperation,binary=process.env.HONMARU_CONTAINER_BIN||'container',timeoutMs=60000,signal}={}){
 if(!context||typeof context!=='object'||Array.isArray(context)||Object.keys(context).some(key=>!['workspaceId','roomId','agentId','timezone','trigger'].includes(key)))throw Error('Invalid public workflow context.');
 if(typeof code!=='string'||!code.trim()||Buffer.byteLength(JSON.stringify({code,context}))>65536)throw Error('Invalid workflow module.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('Invalid execution timeout.');
 const controller=new AbortController();
 const broker=createStateBroker(stateOperation,{signal:controller.signal});
 if(signal?.aborted)return {status:'failed',stdout:'',stderr:'Execution cancelled.',exitCode:null};
 const name=`honmaru-${randomUUID()}`,nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce;
 const child=spawn(binary,containerArgs(name,WORKFLOW_BOOTSTRAP),{stdio:['pipe','pipe','pipe'],shell:false});
 let closed=false,status=null,killPromise,forceTimer,wireBytes=0,responseBytes=0,logBytes=0;
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
  broker(request).then(reply=>{
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
  const result={status:status||(exitCode===0?'succeeded':'failed'),stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),exitCode};
  if(logBytes>32768)result.stderr+='\nOutput limit exceeded.';
  if(signal?.aborted)result.stderr+='\nExecution cancelled.';
  while(Buffer.byteLength(JSON.stringify(result))>65000){result.stdout=result.stdout.slice(0,Math.floor(result.stdout.length/2));result.stderr=result.stderr.slice(0,Math.floor(result.stderr.length/2));}
  return result;
 }finally{
  closed=true;controller.abort();clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',abort);
  await control(binary,['delete','--force',name]);
 }
}

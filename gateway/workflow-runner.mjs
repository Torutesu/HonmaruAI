import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {containerArgs} from './runner.mjs';
import {WORKFLOW_BOOTSTRAP} from './workflow-guest.mjs';
import {createStateBroker,createWorkflowOutputParser} from './workflow-bridge.mjs';
import {normalizeWorkflowDraft} from './workflow-sdk.mjs';

export const WORKFLOW_EXECUTION_TIMEOUT_MS=15*60*1000;
function control(binary,args){return new Promise(resolve=>{const child=spawn(binary,args,{stdio:'ignore',shell:false});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const done=()=>{clearTimeout(timer);resolve()};child.once('error',done);child.once('close',done);});}
export function validateWorkflowConnectionSources(sources){
 if(sources===undefined)return;
 if(!Array.isArray(sources)||sources.length<1||sources.length>20||sources.some(source=>!source||typeof source!=='object'||Array.isArray(source)
  ||!['appId,method,name,ownerId,version','appId,method,name,ownerId,version,write'].includes(Object.keys(source).sort().join(','))
  ||typeof source.appId!=='string'||!source.appId||source.appId.length>200||!/^([a-z][a-z0-9_]{0,39})$/.test(source.name)
  ||typeof source.ownerId!=='string'||!source.ownerId||source.ownerId.length>200||!Number.isSafeInteger(source.version)||source.version<1
  ||!['GET','POST','PUT','PATCH','DELETE'].includes(source.method)
  ||source.method==='GET'&&source.write!==undefined||source.method!=='GET'&&source.write!==true)
  ||new Set(sources.map(source=>`${source.appId}\0${source.name}`)).size!==sources.length)throw Error('Invalid App connection sources context.');
 return sources;
}
export function validateWorkflowConnectionWrite(sources,params,expectedOwnerId=null){
 const source=Array.isArray(sources)?sources.find(item=>item.appId===params?.appId&&item.name===params?.name):null;
 if(!source||source.method==='GET'||source.write!==true||typeof source.ownerId!=='string'||!source.ownerId
  ||(expectedOwnerId!==null&&source.ownerId!==expectedOwnerId))throw Error('Write scope or connection owner is not enabled.');
 return source;
}
// Only trusted orchestration calls this with an activation-bound state callback.
// No API route, general gateway payload or model tool can select this runner yet.
export async function runWorkflowIsolated({code,context={}},{stateOperation,binary=process.env.HONMARU_CONTAINER_BIN||'container',timeoutMs=WORKFLOW_EXECUTION_TIMEOUT_MS,signal}={}){
 if(!context||typeof context!=='object'||Array.isArray(context)||Object.keys(context).some(key=>!['workspaceId','roomId','agentId','timezone','trigger','tableSource','tableSources','connectionSources'].includes(key)))throw Error('Invalid public workflow context.');
 if(context.tableSource!==undefined&&(!context.tableSource||typeof context.tableSource!=='object'||Array.isArray(context.tableSource)||Object.keys(context.tableSource).sort().join(',')!=='appId,entityId,tableId'||Object.values(context.tableSource).some(value=>typeof value!=='string'||!value||value.length>200)))throw Error('Invalid App/Table source context.');
 if(context.tableSources!==undefined&&(!Array.isArray(context.tableSources)||context.tableSources.length<1||context.tableSources.length>20||context.tableSource!==undefined||context.tableSources.some(source=>!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).some(key=>!['appId','entityId','tableId','write','mutate'].includes(key))||Object.keys(source).filter(key=>!['write','mutate'].includes(key)).sort().join(',')!=='appId,entityId,tableId'||source.write!==undefined&&typeof source.write!=='boolean'||source.mutate!==undefined&&typeof source.mutate!=='boolean'||[source.appId,source.entityId,source.tableId].some(value=>typeof value!=='string'||!value||value.length>200)||!/^([a-z][a-z0-9_]{0,39})$/.test(source.entityId))||new Set(context.tableSources.map(source=>`${source.appId}\0${source.entityId}`)).size!==context.tableSources.length))throw Error('Invalid App/Table sources context.');
 validateWorkflowConnectionSources(context.connectionSources);
 if(typeof code!=='string'||!code.trim()||Buffer.byteLength(JSON.stringify({code,context}))>65536)throw Error('Invalid workflow module.');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>WORKFLOW_EXECUTION_TIMEOUT_MS)throw Error('Invalid execution timeout.');
 const controller=new AbortController();
 const broker=createStateBroker(stateOperation,{signal:controller.signal});
 if(signal?.aborted)return {status:'failed',stdout:'',stderr:'Execution cancelled.',exitCode:null};
 const name=`honmaru-${randomUUID()}`,nonce=randomUUID().replaceAll('-',''),prefix='\x1e'+nonce;
 const child=spawn(binary,containerArgs(name,WORKFLOW_BOOTSTRAP),{stdio:['pipe','pipe','pipe'],shell:false});
 let closed=false,status=null,killPromise,forceTimer,wireBytes=0,responseBytes=0,logBytes=0;
 const messages=[],tableMutations=[],connectionWrites=[],connectionWriteOperationIds=new Set(),mutationTargets=new Set(),requestIds=new Set();let connectionWriteOwnerId=null,connectionWriteSequence=0,messageBytes=0,tableMutationBytes=0;
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
  }).then(value=>({id:request.id,ok:true,value}),()=>({id:request.id,ok:false,error:'Message draft was rejected.'})):request.method==='connection.request'?broker(request):request.method==='connection.stageWrite'?Promise.resolve().then(async()=>{
   if(connectionWriteOperationIds.size>=3)throw Error('At most three external writes may be staged per Workflow run.');
   const source=validateWorkflowConnectionWrite(context.connectionSources,request.params,connectionWriteOwnerId);
   const operationId=request.params.operationId;
   if(connectionWriteOperationIds.has(operationId))throw Error('External write operation IDs must be unique within a run.');
   if(connectionWriteOwnerId!==null&&connectionWriteOwnerId!==source.ownerId)throw Error('All writes in one approval batch must have the same connection owner.');
   connectionWriteOwnerId=source.ownerId;
   const slot=connectionWriteSequence++;
   connectionWriteOperationIds.add(operationId);
   try{
    const value=await broker(request);if(value?.error)throw Error('Write authorization failed.');
    const draft={appId:source.appId,name:source.name,ownerId:source.ownerId,version:source.version,method:source.method,operationId,body:request.params.body};
    if(Buffer.byteLength(JSON.stringify([...connectionWrites,draft]))>20000)throw Error('Staged write limit exceeded.');
    connectionWrites[slot]=draft;return {staged:true};
   }catch(error){throw error;}
  }).then(value=>({id:request.id,ok:true,value}),()=>({id:request.id,ok:false,error:'External write could not be staged.'})):request.method==='table.insert'?Promise.resolve().then(async()=>{
   const value=await broker(request);if(value?.error)throw Error('Write rejected.');
   const matches=(context.tableSources||[]).filter(item=>item.entityId===request.params?.entityId&&(request.params?.appId===undefined||item.appId===request.params.appId)&&item.write===true),source=matches.length===1?matches[0]:null;
   if(!source||tableMutations.length>=4)throw Error('Write scope or limit exceeded.');
   const draft={operation:'insert',appId:source.appId,entityId:source.entityId,values:request.params.values},bytes=Buffer.byteLength(JSON.stringify(draft));
   if(tableMutationBytes+bytes>24000)throw Error('Staged write limit exceeded.');
   tableMutationBytes+=bytes;tableMutations.push(draft);return {staged:true,index:tableMutations.length};
  }).then(value=>({id:request.id,ok:true,value}),()=>({id:request.id,ok:false,error:'Row creation was rejected.'})):['table.update','table.delete'].includes(request.method)?Promise.resolve().then(async()=>{
   const value=await broker(request);if(value?.error)throw Error('Mutation rejected.');
   const matches=(context.tableSources||[]).filter(item=>item.entityId===request.params?.entityId&&(request.params?.appId===undefined||item.appId===request.params.appId)&&item.mutate===true),source=matches.length===1?matches[0]:null;
   if(!source||tableMutations.length>=4)throw Error('Mutation scope or limit exceeded.');
   const operation=request.method==='table.update'?'update':'delete',target=`${source.appId}\0${source.entityId}\0${request.params.rowId}`;
   if(mutationTargets.has(target))throw Error('Duplicate row mutations are not allowed.');
   const draft={operation,appId:source.appId,entityId:source.entityId,rowId:request.params.rowId,expectedUpdatedAt:request.params.expectedUpdatedAt,...(operation==='update'?{values:request.params.values}:{})},bytes=Buffer.byteLength(JSON.stringify(draft));
   if(tableMutationBytes+bytes>24000)throw Error('Staged mutation limit exceeded.');
   tableMutationBytes+=bytes;mutationTargets.add(target);tableMutations.push(draft);return {staged:true,index:tableMutations.length};
  }).then(value=>({id:request.id,ok:true,value}),()=>({id:request.id,ok:false,error:'Row mutation was rejected.'})):broker(request);
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
  const stagedConnectionWrites=connectionWrites.filter(Boolean);
  const result={status:status||(exitCode===0?'succeeded':'failed'),stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),exitCode,messages,...(status===null&&exitCode===0&&tableMutations.length?{tableMutations}:{}),...(status===null&&exitCode===0&&stagedConnectionWrites.length?{connectionWrites:stagedConnectionWrites}:{})};
  if(logBytes>32768)result.stderr+='\nOutput limit exceeded.';
  if(signal?.aborted)result.stderr+='\nExecution cancelled.';
  while(Buffer.byteLength(JSON.stringify(result))>65000){result.stdout=result.stdout.slice(0,Math.floor(result.stdout.length/2));result.stderr=result.stderr.slice(0,Math.floor(result.stderr.length/2));}
  return result;
 }finally{
  closed=true;controller.abort();clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',abort);
  await control(binary,['delete','--force',name]);
 }
}

import { normalizeWorkflowAgentCall } from './workflow-sdk.mjs';

// Internal host broker. The callback must already be bound to an authorized
// activation; the guest never supplies workspace/run/lease credentials.
const METHODS=new Set(['state.get','state.set','table.query','table.insert','table.update','table.delete','agent.invoke','connection.request','connection.stageWrite']);
export function validateStateRequest(request) {
 if(!request||!Number.isSafeInteger(request.id)||request.id<1||request.id>64||!METHODS.has(request.method))throw Error('Invalid state operation.');
 const params=request.params;
 if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid state parameters.');
 let cleanParams=params;
 const keys=request.method==='agent.invoke'?['agentId','prompt','schema','tier']:request.method==='state.get'?['view','includeCurrentRun']:request.method==='state.set'?['state','expectedRevision','schemaVersion','businessDate','validationStatus','validationErrors']:request.method==='table.query'?['appId','where','q','pageSize','cursor','entityId']:request.method==='table.insert'?['appId','entityId','values']:request.method==='table.update'?['appId','entityId','rowId','values','expectedUpdatedAt']:request.method==='connection.request'?['appId','name','query']:request.method==='connection.stageWrite'?['appId','name','body','operationId']:['appId','entityId','rowId','expectedUpdatedAt'];
 if(Object.keys(params).some(key=>!keys.includes(key)))throw Error('Unexpected state parameter.');
 if(request.method==='agent.invoke') {
  const clean=normalizeWorkflowAgentCall(params.prompt,{agentId:params.agentId,schema:params.schema,tier:params.tier});
  if(Object.keys(params).length!==4||params.tier!==clean.tier)throw Error('Invalid agent invocation.');
  cleanParams=clean;
 } else if(request.method==='connection.request') {
  if(typeof params.appId!=='string'||!params.appId.trim()||params.appId.length>200||typeof params.name!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(params.name))throw Error('Invalid App connection binding.');
  if(params.query!==undefined){
   const query=params.query;
   if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).length>100||Buffer.byteLength(JSON.stringify(query))>20000)throw Error('Invalid App connection query.');
   for(const [key,value] of Object.entries(query))if(!key||key.length>100||/(token|auth|secret|password|credential|api[-_]?key)/i.test(key)||!((typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))||Array.isArray(value)&&value.length<=100&&value.every(item=>typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))))throw Error('Invalid App connection query value.');
  }
 } else if(request.method==='connection.stageWrite') {
  if(typeof params.appId!=='string'||!params.appId.trim()||params.appId.length>200||typeof params.name!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(params.name)
   ||!params.body||typeof params.body!=='object'||Array.isArray(params.body)||typeof params.operationId!=='string'||! /^[a-zA-Z0-9_-]{1,32}$/.test(params.operationId)||Buffer.byteLength(JSON.stringify(params.body))>20000)throw Error('Invalid staged App connection write.');
 } else if(request.method==='state.get') {
  if(params.view!==undefined&&!['committed','checkpoint'].includes(params.view))throw Error('Invalid state view.');
  if(params.includeCurrentRun!==undefined&&typeof params.includeCurrentRun!=='boolean')throw Error('Invalid current-run option.');
 } else if(request.method==='state.set') {
  if(!params.state||typeof params.state!=='object'||Array.isArray(params.state)||!Number.isSafeInteger(params.expectedRevision)||params.expectedRevision<0)throw Error('State must be read before writing.');
 } else if(request.method==='table.query') {
  if(params.appId!==undefined&&(typeof params.appId!=='string'||!params.appId.trim()||params.appId.length>200))throw Error('Invalid App source.');
  if(params.where!==undefined&&(!params.where||typeof params.where!=='object'||Array.isArray(params.where)||Object.keys(params.where).length>40))throw Error('Invalid table query filter.');
  if(params.q!==undefined&&(typeof params.q!=='string'||params.q.length>200))throw Error('Invalid table query text.');
  if(params.entityId!==undefined&&(typeof params.entityId!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(params.entityId)))throw Error('Invalid App entity.');
  if(params.pageSize!==undefined&&(!Number.isSafeInteger(params.pageSize)||params.pageSize<1||params.pageSize>100))throw Error('Invalid table query page size.');
  if(params.cursor!==undefined&&(typeof params.cursor!=='string'||params.cursor.length>2048))throw Error('Invalid table query cursor.');
 } else if(request.method==='table.insert'||request.method==='table.update') {
  if(params.appId!==undefined&&(typeof params.appId!=='string'||!params.appId.trim()||params.appId.length>200))throw Error('Invalid App source.');
  if(params.entityId!==undefined&&(typeof params.entityId!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(params.entityId)))throw Error('Invalid App entity.');
  if(!params.values||typeof params.values!=='object'||Array.isArray(params.values)||Object.keys(params.values).length>100||Buffer.byteLength(JSON.stringify(params.values))>24000)throw Error('Invalid row values.');
  if(request.method==='table.update'&&(!validRowTarget(params)))throw Error('Invalid row target.');
 } else if(request.method==='table.delete'&&(!validRowTarget(params)||params.appId!==undefined&&(typeof params.appId!=='string'||!params.appId.trim()||params.appId.length>200)))throw Error('Invalid row target.');
 if(Buffer.byteLength(JSON.stringify(request))>160000)throw Error('State request is too large.');
 return {id:request.id,method:request.method,params:cleanParams};
}
function validRowTarget(params){return typeof params.entityId==='string'&&/^([a-z][a-z0-9_]{0,39})$/.test(params.entityId)&&typeof params.rowId==='string'&&params.rowId.length>0&&params.rowId.length<=200&&typeof params.expectedUpdatedAt==='string'&&params.expectedUpdatedAt.length<=64&&Number.isFinite(Date.parse(params.expectedUpdatedAt));}
export function createStateBroker(operation,{signal}={}) {
 if(typeof operation!=='function')throw Error('An authorized state transport is required.');
 const seen=new Set();let queue=Promise.resolve();
 return request=>{
  const clean=validateStateRequest(request);
  if(seen.has(clean.id))throw Error('Duplicate state request.');
  seen.add(clean.id);
  const run=async()=>{
   if(signal?.aborted)throw Error('Activation ended.');
   try {
    const value=await operation(clean.method,clean.params,{signal});
    if(signal?.aborted)throw Error('Activation ended.');
    const reply={id:clean.id,ok:true,value};
    if(Buffer.byteLength(JSON.stringify(reply))>180000)throw Error('State reply is too large.');
    return reply;
   } catch {return {id:clean.id,ok:false,error:'State operation failed.'};}
  };
  // Table queries are read-only and can use the SDK's bounded concurrency.
  // Keep checkpoint/state and effectful operations in one order-preserving lane.
  if(clean.method==='table.query')return run();
  const result=queue.then(run);
  queue=result.catch(()=>{});return result;
 };
}

// RPC markers may follow ordinary output without a newline. Preserve arbitrary
// output and split markers; never let console output swallow a state request.
export function createWorkflowOutputParser(prefix,{text,request}) {
 let buffer='';
 return {
  push(chunk){
   buffer+=chunk;
   while(buffer){
    const start=buffer.indexOf(prefix);
    if(start<0){
     let keep=Math.min(buffer.length,prefix.length-1);
     while(keep&&!prefix.startsWith(buffer.slice(-keep)))keep--;
     const output=buffer.slice(0,buffer.length-keep);if(output)text(output);
     buffer=keep?buffer.slice(-keep):'';return;
    }
    if(start){text(buffer.slice(0,start));buffer=buffer.slice(start);}
    const end=buffer.indexOf('\n',prefix.length);
    if(end<0){if(Buffer.byteLength(buffer)>180000)throw Error('State frame is too large.');return;}
    const raw=buffer.slice(prefix.length,end);buffer=buffer.slice(end+1);
    if(Buffer.byteLength(raw)>160000)throw Error('State frame is too large.');
    request(JSON.parse(raw));
   }
  },
  end(){if(buffer.startsWith(prefix))throw Error('Incomplete state frame.');if(buffer)text(buffer);buffer='';}
 };
}

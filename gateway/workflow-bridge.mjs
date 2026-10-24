// Internal host broker. The callback must already be bound to an authorized
// activation; the guest never supplies workspace/run/lease credentials.
const METHODS=new Set(['state.get','state.set']);
export function validateStateRequest(request) {
 if(!request||!Number.isSafeInteger(request.id)||request.id<1||request.id>64||!METHODS.has(request.method))throw Error('Invalid state operation.');
 const params=request.params;
 if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid state parameters.');
 const keys=request.method==='state.get'?['view','includeCurrentRun']:['state','expectedRevision','schemaVersion','businessDate','validationStatus','validationErrors'];
 if(Object.keys(params).some(key=>!keys.includes(key)))throw Error('Unexpected state parameter.');
 if(request.method==='state.get') {
  if(params.view!==undefined&&!['committed','checkpoint'].includes(params.view))throw Error('Invalid state view.');
  if(params.includeCurrentRun!==undefined&&typeof params.includeCurrentRun!=='boolean')throw Error('Invalid current-run option.');
 } else {
  if(!params.state||typeof params.state!=='object'||Array.isArray(params.state)||!Number.isSafeInteger(params.expectedRevision)||params.expectedRevision<0)throw Error('State must be read before writing.');
 }
 if(Buffer.byteLength(JSON.stringify(request))>160000)throw Error('State request is too large.');
 return {id:request.id,method:request.method,params};
}
export function createStateBroker(operation,{signal}={}) {
 if(typeof operation!=='function')throw Error('An authorized state transport is required.');
 const seen=new Set();let queue=Promise.resolve();
 return request=>{
  const clean=validateStateRequest(request);
  if(seen.has(clean.id))throw Error('Duplicate state request.');
  seen.add(clean.id);
  const result=queue.then(async()=>{
   if(signal?.aborted)throw Error('Activation ended.');
   try {
    const value=await operation(clean.method,clean.params,{signal});
    if(signal?.aborted)throw Error('Activation ended.');
    const reply={id:clean.id,ok:true,value};
    if(Buffer.byteLength(JSON.stringify(reply))>180000)throw Error('State reply is too large.');
    return reply;
   } catch {return {id:clean.id,ok:false,error:'State operation failed.'};}
  });
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

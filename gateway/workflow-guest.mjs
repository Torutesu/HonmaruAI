// Serialized into the existing Linux VM. Never evaluate workflow code on host.
export const WORKFLOW_BOOTSTRAP=`
(async()=>{
 const {createInterface}=await import('node:readline');
 const {registerHooks,stripTypeScriptTypes}=await import('node:module');
 const lines=createInterface({input:process.stdin});
 const task=await new Promise(resolve=>lines.once('line',line=>resolve(JSON.parse(line))));
 const pending=new Map();let sequence=0,revision;
 const send=process.stdout.write.bind(process.stdout);
 lines.on('line',line=>{
  let reply;try{reply=JSON.parse(line)}catch{return}
  const wait=pending.get(reply.id);if(!wait)return;
  pending.delete(reply.id);reply.ok?wait.resolve(reply.value):wait.reject(Error(reply.error));
 });
 const rpc=(method,params)=>new Promise((resolve,reject)=>{
  if(sequence>=64)return reject(Error('State operation limit exceeded.'));
  const id=++sequence;pending.set(id,{resolve,reject});
  send('\\x1e'+task.nonce+JSON.stringify({id,method,params})+'\\n');
 });
 const state={
  async get(options={}){const result=await rpc('state.get',options);if(Number.isSafeInteger(result.revision))revision=result.revision;return result;},
  async set(value,options={}){
   if(revision===undefined)throw Error('Read state before writing.');
   const result=await rpc('state.set',{...options,state:value,expectedRevision:revision});
   if(result.saved&&Number.isSafeInteger(result.revision))revision=result.revision;
   return result;
  }
 };
 const bridgeKey='__honmaru_'+task.nonce;
 Object.defineProperty(globalThis,bridgeKey,{value:{state,ctx:Object.freeze({...task.context,now:()=>new Date().toISOString()})},configurable:false});
 const sdk='data:text/javascript;base64,'+Buffer.from('const bridge=globalThis['+JSON.stringify(bridgeKey)+'];export const state=bridge.state;export const ctx=bridge.ctx;').toString('base64');
 registerHooks({resolve(specifier,context,next){return specifier==='@honmaru/workflow-sdk'?{url:sdk,shortCircuit:true}:next(specifier,context);}});
 try {
  const source=stripTypeScriptTypes(task.code,{mode:'transform',sourceUrl:'workflow.ts'});
  await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  if(pending.size)throw Error('Unawaited state operations remain.');
 } catch(error){console.error(String(error?.stack||error));process.exitCode=1;}
 finally{lines.close();process.stdin.destroy();}
})().catch(error=>{console.error(String(error));process.exit(1)});
`;

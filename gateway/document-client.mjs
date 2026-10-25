import {setTimeout as sleep} from 'node:timers/promises';
import {runDocumentIsolated,verifyDocumentImage} from './document-runner.mjs';
export function documentClient(baseUrl,token,fetcher=fetch){
 const base=new URL(baseUrl);
 if(base.username||base.password||base.search||base.hash||(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw Error('Use an HTTPS API URL.');
 if(!/^hgw_[A-Za-z0-9-]{64,100}$/.test(token||''))throw Error('A node token is required.');
 return async(path,body={}, {signal}={})=>{
  if(!/^(claim|jobs\/[a-f0-9-]{36}\/(heartbeat|fail|artifact))$/.test(path))throw Error('Invalid document operation.');
  const artifact=path.endsWith('/artifact');
  const headers={authorization:'Bearer '+token,'content-type':artifact?'application/octet-stream':'application/json'};
  if(body.lease)headers['x-honmaru-lease']=body.lease;
  const deadline=AbortSignal.timeout(30000);
  const response=await fetcher(new URL('/gateways/documents/'+path,base),{method:'POST',redirect:'error',headers,body:artifact?body.bytes:JSON.stringify(path==='claim'?body:{}),signal:signal?AbortSignal.any([signal,deadline]):deadline});
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.message||'Document API failed.'),{status:response.status});return result;
 };
}
const transient=e=>!e.status||e.status===408||e.status===429||e.status>=500;
// Opt-in service integration follows image readiness verification. Do not
// advertise document capability from the ordinary gateway client yet.
export async function processDocumentOne(call,{image,signal,run=runDocumentIsolated,ready=verifyDocumentImage,retryMs=[1000,2000,4000,8000]}={}){
 if(!image)throw Error('Document image is required.');
 signal?.throwIfAborted();
 await ready(image,{signal});
 const {job}=await call('claim',{capabilities:['document-conversion-v1']},{signal});if(!job)return false;
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let leaseLost=false,checking=false;
 const heartbeat=setInterval(async()=>{if(checking)return;checking=true;try{await call(`jobs/${job.id}/heartbeat`,{lease:job.lease},{signal:controller.signal});}catch{leaseLost=true;controller.abort();}finally{checking=false;}},10000);
 try{
  let result;
  try{result=await run(job.payload,{image,signal:controller.signal,timeoutMs:150000});}
  catch{if(!leaseLost)await call(`jobs/${job.id}/fail`,{lease:job.lease}).catch(()=>{});return true;}
  if(leaseLost||controller.signal.aborted)return true;
  for(let attempt=0;;attempt++){
   try{await call(`jobs/${job.id}/artifact`,{lease:job.lease,bytes:result.bytes},{signal:controller.signal});return true;}
   catch(e){if(!transient(e)||leaseLost||attempt>=retryMs.length||controller.signal.aborted)throw e;}
   await sleep(retryMs[attempt],undefined,{signal:controller.signal});
  }
 }finally{clearInterval(heartbeat);signal?.removeEventListener('abort',abort);}
}

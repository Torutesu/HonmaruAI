import {processDocumentOne} from './document-client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { runIsolated } from './runner.mjs';
import {runWorkflowIsolated} from './workflow-runner.mjs';
import {runAcp,configuredAcpAgentIds} from './acp.mjs';

export function gatewayClient(baseUrl, token, fetcher = fetch) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) throw new Error('Use an HTTPS API URL (HTTP is only allowed on localhost).');
  if (!/^hgw_[A-Za-z0-9-]{64,100}$/.test(token || '')) throw new Error('A node token is required.');
  return async (path, body = {}, {signal} = {}) => {
    const response = await fetcher(new URL(`/gateways/${path}`, base), { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message || `Node API error ${response.status}`), { status: response.status, code: data.code });
    return data;
  };
}

// How long to wait before each further try at handing in a result whose
// upload failed: about a minute in all, inside the job's deadline.
export const FINISH_RETRY_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000];
// Worth trying again: no answer at all (the network, a timeout), or the
// server saying it could not take it just now.
const transient = (error) => !error.status || error.status === 408 || error.status === 429 || error.status >= 500;

export async function processOne(call, { signal, run = runIsolated, runWorkflow = runWorkflowIsolated, runAcpAgent = runAcp, acpAgents = {}, retryMs = FINISH_RETRY_MS } = {}) {
  const capabilities=['workflow-program-v1'];
  const localAcpAgents=configuredAcpAgentIds(acpAgents);
  if(localAcpAgents.length)capabilities.push('acp-v1');
  const { job } = await call('claim',{capabilities,acpAgents:localAcpAgents});
  if (!job) return false;
  const cancel = new AbortController();
  const abort = () => cancel.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let checking = false, leaseLost = false, refused = false;
  const heartbeat = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await call(`jobs/${job.id}/heartbeat`, { lease: job.lease }); }
    catch (error) { leaseLost = true; refused ||= !transient(error); cancel.abort(); }
    finally { checking = false; }
  }, 10000);
  try {
    let result;
    try {
      // ACP coding agents may need longer than a short isolated script. The
      // Worker still caps their lease at 120 seconds, so leave 10 seconds for
      // reporting the result before that deadline.
      const timeoutCap=job.payload?.acp===true?110000:60000;
      const options={timeoutMs:Math.min(job.timeoutMs||timeoutCap,timeoutCap),signal:cancel.signal};
      result=job.payload?.acp===true
        ? await runAcpAgent(job.payload,{...options,acpAgents})
        : job.workflow===true
          ? await runWorkflow(job.payload,{...options,stateOperation:(operation,params,{signal})=>call(`jobs/${job.id}/state`,{lease:job.lease,operation,params},{signal})})
          : await run(job.payload,options);
    }
    catch { result = { status: 'failed', stdout: '', stderr: 'The local runtime could not start this execution.', exitCode: null }; }
    if (leaseLost) return true;
    // The result is kept until the server has it. A failed upload is tried
    // again, the heartbeat holding the lease meanwhile, rather than the job
    // left to expire as a failure; the code is never run again for it. A
    // refusal (cancelled, revoked, the lease gone) ends it at once, and a
    // reply saying the result is already in counts as delivered.
    for (let attempt = 0; ; attempt += 1) {
      try { await call(`jobs/${job.id}/finish`, { lease: job.lease, ...result }); return true; }
      catch (error) {
        if (error.code === 'already_finished') return true;
        if (!transient(error) || refused || attempt >= retryMs.length || signal?.aborted) throw error;
      }
      try { await sleep(retryMs[attempt], undefined, { signal }); } catch { return true; }
    }
  } finally { clearInterval(heartbeat); signal?.removeEventListener('abort', abort); }
}

export async function serve(call, { signal, once = false, onError = () => {}, beforeClaim = async () => {}, document = null, documentRun = processDocumentOne, acpAgents = {} } = {}) {
  let preferDocument=false;
  while (!signal?.aborted) {
    try {
      await beforeClaim();
      if (!signal?.aborted) {
        const documentAttempt=async()=>{
          if(!document)return false;
          try{return await documentRun(document.call,{image:document.image,signal});}
          catch(error){if([401,403].includes(error.status))throw error;onError(error.status||'document-runtime');return false;}
        };
        if(preferDocument){if(!await documentAttempt()&&!signal?.aborted)await processOne(call,{signal,acpAgents});}
        else if(!await processOne(call,{signal,acpAgents})&&!signal?.aborted)await documentAttempt();
        preferDocument=!preferDocument;
      }
    }
    catch (error) {
      // Authentication revocation is terminal. Never log the token or payload.
      if ([401, 403].includes(error.status)) throw error;
      onError(error.status || 'network');
    }
    if (once) return;
    try { await sleep(5000, undefined, { signal }); } catch { return; }
  }
}

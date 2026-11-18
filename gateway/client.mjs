import {processDocumentOne} from './document-client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { runIsolated } from './runner.mjs';
import {runWorkflowIsolated,WORKFLOW_EXECUTION_TIMEOUT_MS} from './workflow-runner.mjs';
import {runAcp,configuredAcpAgentIds} from './acp.mjs';
import {runBrowserSessionAction,validateBrowserAction} from './browser-session.mjs';
import { requestRemoteMcp } from './remote-mcp-http.mjs';

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

// Remote MCP requests are deliberately handled by this host-side HTTPS client;
// code running in runner.mjs remains isolated with networking disabled.
export async function processRemoteMcpEgressOne(call, { signal, request = requestRemoteMcp, heartbeatIntervalMs = 8000, retryMs = FINISH_RETRY_MS } = {}) {
  const { job } = await call('remote-mcp/claim', {}, { signal });
  if (!job) return false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let heartbeatBusy = false;
  let leaseLost = false;
  let lastHeartbeatAt = Date.now();
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || controller.signal.aborted) return;
    heartbeatBusy = true;
    try {
      await call(`remote-mcp/jobs/${job.id}/heartbeat`, { lease: job.lease });
      lastHeartbeatAt = Date.now();
    } catch (error) {
      if (!transient(error) || Date.now() - lastHeartbeatAt > 25_000) {
        leaseLost = true;
        controller.abort();
      }
    } finally { heartbeatBusy = false; }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();
  let result;
  try {
    try {
      result = await request(job.request, { timeoutMs: Math.max(1000, Math.min(Number(job.timeoutMs) || 30_000, 30_000)), signal: controller.signal });
      if (!result || !Number.isInteger(result.status) || typeof result.body !== 'string') throw new Error('Invalid Gateway response.');
    } catch (error) {
      if (leaseLost || signal?.aborted) return true;
      // Keep local DNS/network details and request data out of Gateway logs and
      // the relay; only a bounded generic failure crosses back to the Worker.
      result = { error: error?.message === 'Remote MCP host resolved to a non-public address.'
        ? 'Remote MCP host resolved to a non-public address.'
        : 'Gateway could not complete the Remote MCP HTTPS request.' };
    }
  } finally { clearInterval(heartbeat); signal?.removeEventListener('abort', abort); }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await call(`remote-mcp/jobs/${job.id}/finish`, { lease: job.lease, result }, { signal });
      return true;
    } catch (error) {
      if (error.code === 'already_finished') return true;
      if (!transient(error) || attempt >= retryMs.length || signal?.aborted) throw error;
      try { await sleep(retryMs[attempt], undefined, { signal }); } catch { return true; }
    }
  }
}

export async function serveRemoteMcpEgress(call, { signal, onError = () => {}, once = false, intervalMs = 1000, ...options } = {}) {
  while (!signal?.aborted) {
    try { await processRemoteMcpEgressOne(call, { signal, ...options }); }
    catch (error) {
      if ([401, 403].includes(error.status)) throw error;
      onError(error.status || 'remote-mcp-egress');
    }
    if (once) return;
    try { await sleep(intervalMs, undefined, { signal }); } catch { return; }
  }
}

export async function processOne(call, { signal, run = runIsolated, runWorkflow = runWorkflowIsolated, runAcpAgent = runAcp, runBrowser = runBrowserSessionAction, acpAgents = {}, retryMs = FINISH_RETRY_MS, heartbeatIntervalMs = 10000, heartbeatGraceMs = 60000, browserControlPollIntervalMs = 6000, browserAuthorizationCheckIntervalMs = 1500 } = {}) {
  const capabilities=['workflow-program-v1'];
  // This is a separate, one-action capability. ACP remains opt-in by the
  // local agent allowlist and does not grant native Harness Agents access.
  capabilities.push('browser-action-v1');
  const localAcpAgents=configuredAcpAgentIds(acpAgents);
  if(localAcpAgents.length)capabilities.push('acp-v1');
  const { job } = await call('claim',{capabilities,acpAgents:localAcpAgents});
  if (!job) return false;
  const cancel = new AbortController();
  const controlStop = new AbortController();
  let controlPump = null;
  let browserTail = Promise.resolve();
  const withBrowser = fn => {
    const pending = browserTail.then(fn, fn);
    browserTail = pending.catch(() => {});
    return pending;
  };
  const browserOptions = { workspaceId: job.payload?.workspaceId, agentId: job.payload?.browserIdentity };
  const abort = () => cancel.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let checking = false, leaseLost = false, refused = false, browserAuthorizationLost = false, lastHeartbeatAt = Date.now();
  const runFencedBrowserAction = async (authorizationPath, action, options, parentSignal = cancel.signal) => {
    const monitorStop = new AbortController();
    const actionStop = new AbortController();
    const monitorSignal = AbortSignal.any([monitorStop.signal, parentSignal]);
    const actionSignal = AbortSignal.any([cancel.signal, parentSignal, actionStop.signal]);
    const monitor = (async () => {
      while (!monitorSignal.aborted) {
        try { await call(authorizationPath, { lease: job.lease }, { signal: monitorSignal }); }
        catch (error) {
          if (monitorStop.signal.aborted || parentSignal?.aborted || cancel.signal.aborted) return;
          if ([401, 403, 409].includes(error?.status)) {
            browserAuthorizationLost = true;
            refused = true;
          }
          actionStop.abort();
          cancel.abort();
          return;
        }
        try { await sleep(browserAuthorizationCheckIntervalMs, undefined, { signal: monitorSignal }); }
        catch { return; }
      }
    })();
    try { return await runBrowser({ ...options, action, signal: actionSignal }); }
    finally { monitorStop.abort(); await monitor.catch(() => {}); }
  };
  const heartbeat = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await call(`jobs/${job.id}/heartbeat`, { lease: job.lease });
      lastHeartbeatAt = Date.now();
    } catch (error) {
      refused ||= !transient(error);
      // Network failures and 5xx responses do not prove that the lease was
      // rejected: the Worker may have renewed it before the response was lost.
      // Keep the ACP job alive through brief outages, but stop before the
      // original 90-second lease can expire if no heartbeat is confirmed.
      if (!transient(error) || Date.now() - lastHeartbeatAt >= heartbeatGraceMs) {
        leaseLost = true;
        cancel.abort();
      }
    }
    finally { checking = false; }
  }, heartbeatIntervalMs);
  try {
    let result;
    try {
      // Workflow programs use the documented fifteen-minute execution cap;
      // the Worker keeps a separate 30-second result-delivery grace period.
      // ACP jobs retain their 110-second cap inside a 120-second lease.
      const timeoutCap=job.workflow===true?WORKFLOW_EXECUTION_TIMEOUT_MS:job.payload?.browserTools===true?270000:job.payload?.nativeBrowserAction===true?60000:job.payload?.acp===true?110000:60000;
      const options={timeoutMs:Math.min(job.timeoutMs||timeoutCap,timeoutCap),signal:cancel.signal};
      if(job.payload?.nativeBrowserAction===true){
        const payload=job.payload;
        if(typeof payload.workspaceId!=='string'||typeof payload.browserIdentity!=='string')throw new Error('Invalid browser action identity.');
        const action=validateBrowserAction(payload.browserAction);
        const browserAction=action.type==='screenshot'?{...action,thumbnail:true}:action;
        const browserResult=await runFencedBrowserAction(`jobs/${job.id}/browser-action`,browserAction,{workspaceId:payload.workspaceId,agentId:payload.browserIdentity});
        let bounded={};
        let screenshotTooLarge=false;
        if(browserResult&&typeof browserResult==='object'&&!Array.isArray(browserResult)){
          if(typeof browserResult.url==='string')bounded.url=browserResult.url.slice(0,2048);
          if(typeof browserResult.text==='string')bounded.text=browserResult.text.slice(0,12000);
          if(typeof browserResult.image==='string'){
            if(action.type==='screenshot'&&browserResult.image.length>48_000)screenshotTooLarge=true;
            else if(browserResult.image.length<=48_000)bounded.image=browserResult.image;
          }
          if(typeof browserResult.title==='string')bounded.title=browserResult.title.slice(0,500);
          if(typeof browserResult.clicked==='boolean')bounded.clicked=browserResult.clicked;
          if(typeof browserResult.scrolled==='boolean')bounded.scrolled=browserResult.scrolled;
        }
        if(screenshotTooLarge){
          result={status:'failed',stdout:'',stderr:'The browser screenshot exceeded the 48 KB transfer limit.',exitCode:1};
        }else{
          const stdout=JSON.stringify(bounded);
          if(Buffer.byteLength(stdout)>65_000)throw new Error('Browser response is too large.');
          result={status:'succeeded',stdout,stderr:'',exitCode:0};
        }
      } else if(job.payload?.acp===true&&job.payload?.browserTools===true){
        const controlSignal=AbortSignal.any([cancel.signal,controlStop.signal]);
        controlPump=(async()=>{
          while(!controlSignal.aborted){
            try{await sleep(browserControlPollIntervalMs,undefined,{signal:controlSignal});}catch{return;}
            try{
              const {controls=[]}=await call(`jobs/${job.id}/browser-frame`,{lease:job.lease,poll:true},{signal:controlSignal});
              for(const action of controls.slice(0,5))await withBrowser(async()=>{
                await runFencedBrowserAction(`jobs/${job.id}/browser`,action,browserOptions,controlSignal);
                const frame=await runFencedBrowserAction(`jobs/${job.id}/browser`,{type:'screenshot'},browserOptions,controlSignal);
                if(typeof frame?.image==='string'&&frame.image.length<=2_800_000)
                  await call(`jobs/${job.id}/browser-frame`,{lease:job.lease,image:frame.image},{signal:controlSignal});
              });
            }catch(error){
              if(controlSignal.aborted)return;
              if(error?.status&&error.status<500&&![408,429].includes(error.status))return;
            }
          }
        })();
      }
      result??=job.payload?.acp===true
        ? await runAcpAgent(job.payload,{...options,acpAgents,
          browserCall: job.payload?.browserTools===true
            ? async (action,{signal}={}) => {
                return withBrowser(async()=>{
                  const parentSignal=signal||cancel.signal;
                  const result=await runFencedBrowserAction(`jobs/${job.id}/browser`,action,browserOptions,parentSignal);
                  const frame=action?.type==='screenshot'&&typeof result?.image==='string'?result:await runFencedBrowserAction(`jobs/${job.id}/browser`,{type:'screenshot'},browserOptions,parentSignal);
                  if(typeof frame?.image==='string'&&frame.image.length<=2_800_000){
                    try{await call(`jobs/${job.id}/browser-frame`,{lease:job.lease,image:frame.image},{signal:signal||cancel.signal});}catch{}
                  }
                  return result;
                });
              }
            : undefined,
          onProgress: progress => call(`jobs/${job.id}/progress`,{lease:job.lease,progress},{signal:cancel.signal}),
          mcpCall: job.payload?.workspaceTools === true
            ? async (method,params) => (await call(`jobs/${job.id}/mcp`,{lease:job.lease,method,params},{signal:cancel.signal})).result
            : undefined,
        })
        : job.workflow===true
          ? await runWorkflow(job.payload,{...options,stateOperation:(operation,params,{signal})=>call(`jobs/${job.id}/state`,{lease:job.lease,operation,params},{signal})})
          : await run(job.payload,{...options,...(job.environment?{environment:job.environment}:{})});
    }
    catch { result = { status: 'failed', stdout: '', stderr: 'The local runtime could not start this execution.', exitCode: null }; }
    controlStop.abort();
    if(controlPump)await controlPump.catch(()=>{});
    if (leaseLost || browserAuthorizationLost) return true;
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

export async function serve(call, { signal, once = false, onError = () => {}, beforeClaim = async () => {}, document = null, documentRun = processDocumentOne, acpAgents = {}, enableRemoteMcpEgress = true } = {}) {
  let preferDocument=false;
  const egressStop = new AbortController();
  const abortEgress = () => egressStop.abort();
  signal?.addEventListener('abort', abortEgress, { once: true });
  const egressPump = enableRemoteMcpEgress && !once ? serveRemoteMcpEgress(call, { signal: egressStop.signal, onError }).catch(error => {
    if (![401, 403].includes(error.status)) onError(error.status || 'remote-mcp-egress');
  }) : Promise.resolve();
  try {
    if (once) { egressStop.abort(); await egressPump; }
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
  } finally {
    egressStop.abort();
    await egressPump;
    signal?.removeEventListener('abort', abortEgress);
  }
}

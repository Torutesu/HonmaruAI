import { setTimeout as sleep } from 'node:timers/promises';
import { runIsolated } from './runner.mjs';

export function gatewayClient(baseUrl, token, fetcher = fetch) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) throw new Error('Use an HTTPS API URL (HTTP is only allowed on localhost).');
  if (!/^hgw_[A-Za-z0-9-]{64,100}$/.test(token || '')) throw new Error('A node token is required.');
  return async (path, body = {}) => {
    const response = await fetcher(new URL(`/gateways/${path}`, base), { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
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

export async function processOne(call, { signal, run = runIsolated, retryMs = FINISH_RETRY_MS } = {}) {
  const { job } = await call('claim');
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
    try { result = await run(job.payload, { timeoutMs: Math.min(job.timeoutMs || 60000, 60000), signal: cancel.signal }); }
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

export async function serve(call, { signal, once = false, onError = () => {}, beforeClaim = async () => {} } = {}) {
  while (!signal?.aborted) {
    try { await beforeClaim(); if (!signal?.aborted) await processOne(call, { signal }); }
    catch (error) {
      // Authentication revocation is terminal. Never log the token or payload.
      if ([401, 403].includes(error.status)) throw error;
      onError(error.status || 'network');
    }
    if (once) return;
    try { await sleep(5000, undefined, { signal }); } catch { return; }
  }
}

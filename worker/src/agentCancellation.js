// Async work started by an AbortSignal listener must be drained before its
// owning assignment settles or the Durable Object request can finish.
const pendingBySignal = new WeakMap();
const CANCELLATION_DRAIN_TIMEOUT_MS = 10000;

export function trackAgentCancellation(signal, operation) {
  if (!signal || !operation) return Promise.resolve();
  let pending = pendingBySignal.get(signal);
  if (!pending) {
    pending = new Set();
    pendingBySignal.set(signal, pending);
  }
  const task = Promise.resolve(operation);
  // Keep a rejection handler attached even if the owner times out before it
  // can drain this task; waitForAgentCancellation still observes the failure.
  task.catch(() => {});
  pending.add(task);
  return task;
}

export async function waitForAgentCancellation(signal) {
  if (!signal) return true;
  // Loop because completing one cancellation can synchronously register
  // another cleanup task for the same signal.
  while (pendingBySignal.get(signal)?.size) {
    const pending = [...pendingBySignal.get(signal)];
    let timer;
    const drained = Promise.allSettled(pending).then(results => results.every(result => result.status === 'fulfilled'));
    const completed = await Promise.race([
      drained.then(ok => ({ ok, tasks: pending })),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), CANCELLATION_DRAIN_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (completed === false) return false;
    for (const task of completed.tasks) pendingBySignal.get(signal)?.delete(task);
    if (!completed.ok) return false;
  }
  return true;
}

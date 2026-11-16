// Async work started by an AbortSignal listener must be drained before its
// owning assignment settles or the Durable Object request can finish.
const pendingBySignal = new WeakMap();
const activeOperationsBySignal = new WeakMap();
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

// Tool operations can ignore AbortSignal. Keep their settlement observable so
// an assignment stop cannot be reported as confirmed while a write may still
// be running. A settled rejection is still settled; unlike cleanup failures,
// it does not make cancellation unconfirmed.
export function trackAgentOperation(signal, operation) {
  if (!signal || !operation) return Promise.resolve();
  let pending = activeOperationsBySignal.get(signal);
  if (!pending) {
    pending = new Set();
    activeOperationsBySignal.set(signal, pending);
  }
  const task = Promise.resolve(operation).then(() => undefined, () => undefined);
  pending.add(task);
  task.then(() => pending.delete(task));
  return task;
}

async function drainOperations(signal) {
  while (activeOperationsBySignal.get(signal)?.size) {
    const pending = [...activeOperationsBySignal.get(signal)];
    let timer;
    const drained = Promise.all(pending).then(() => ({tasks: pending}));
    const completed = await Promise.race([
      drained,
      new Promise(resolve => { timer = setTimeout(() => resolve(false), CANCELLATION_DRAIN_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (completed === false) return false;
    for (const task of completed.tasks) activeOperationsBySignal.get(signal)?.delete(task);
  }
  return true;
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
  return drainOperations(signal);
}

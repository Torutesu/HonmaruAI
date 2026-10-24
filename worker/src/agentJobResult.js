// Run only under a serialized Durable Object alarm. Settlement must be
// idempotent: it may be repeated after either persistence or deletion fails.
export async function runTrackedAgentJob(storage,key,job,execute,{now=Date.now,kind='agent',onSettled=null}={}) {
  const resultKey=`result:${JSON.stringify([job.orgId,kind,job.rowId])}`;
  const previous=await storage.get(resultKey);
  let last=Math.max(Number(job.queuedAt)||0,Number(previous?.at)||0);
  const stamp=()=>last=Math.max(now(),last+1);
  if(previous) {
    const result=previous.status==='running'?{status:'interrupted'}:previous;
    if(onSettled)await onSettled(result,job);
    if(previous.status==='running')await storage.put(resultKey,{...result,at:stamp()});
    await storage.delete(key);
    return;
  }
  await storage.put(resultKey,{status:'running',at:stamp()});
  let result;
  try { result=await execute(); }
  catch { result={status:'failed',answered:0}; }
  // A failed cross-store settlement is not an execution failure. Retain
  // running + queued so recovery repairs ownership without repeating work.
  if(onSettled)await onSettled(result,job);
  await storage.put(resultKey,{...result,at:stamp()});
  await storage.delete(key);
}

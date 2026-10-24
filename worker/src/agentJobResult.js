// Called only by the serialized Durable Object alarm. Keep the queued job
// until its result is durable. A restarted running job has an unknown external
// outcome: record interruption rather than repeat a model or tool operation.
export async function runTrackedAgentJob(storage,key,job,execute,{now=Date.now}={}) {
  const resultKey=`result:${JSON.stringify([job.orgId,'agent',job.rowId])}`;
  const previous=await storage.get(resultKey);
  let last=Math.max(Number(job.queuedAt)||0,Number(previous?.at)||0);
  const stamp=()=>last=Math.max(now(),last+1);
  if(previous) {
    if(previous.status==='running')await storage.put(resultKey,{status:'interrupted',at:stamp()});
    await storage.delete(key);
    return;
  }
  await storage.put(resultKey,{status:'running',at:stamp()});
  let result;
  try { result=await execute(); }
  catch { result={status:'failed',answered:0}; }
  // Storage errors must propagate: do not turn failure to persist a successful
  // external execution into permission to execute it again.
  await storage.put(resultKey,{...result,at:stamp()});
  await storage.delete(key);
}

// Run only under a serialized Durable Object alarm. Settlement must be
// idempotent: it may be repeated after either persistence or deletion fails.
const MAX_RUN_EVENTS = 80;
const RUN_EVENT_TYPES = new Set(['run_started','agent_started','tool_started','tool_finished','tool_failed','tool_interrupted','agent_finished','agent_failed','agent_cancelled','run_finished','run_failed','run_cancelled','run_interrupted']);
function safeRunEvent(input, now) {
  if (!input || !RUN_EVENT_TYPES.has(input.type)) return null;
  const event = {type: input.type, at: Number.isSafeInteger(input.at) && input.at >= 0 ? input.at : now()};
  if (typeof input.agent === 'string' && input.agent.length > 0) event.agent = input.agent.slice(0, 120);
  if (typeof input.tool === 'string' && input.tool.length > 0) event.tool = input.tool.slice(0, 80);
  if (['tool_finished','tool_failed','tool_interrupted'].includes(input.type) && Number.isFinite(input.elapsedMs)) event.elapsedMs = Math.max(0, Math.min(86400000, Math.round(input.elapsedMs)));
  return event;
}

export async function runTrackedAgentJob(storage,key,job,execute,{now=Date.now,kind='agent',onSettled=null}={}) {
  const resultKey=`result:${JSON.stringify([job.orgId,kind,job.rowId])}`;
  const previous=await storage.get(resultKey);
  let last=Math.max(Number(job.queuedAt)||0,Number(previous?.at)||0);
  const stamp=()=>last=Math.max(now(),last+1);
  if(previous) {
    const result=previous.status==='running'?{status:'interrupted'}:previous;
    if(onSettled)await onSettled(result,job);
    if(previous.status==='running') {
      const events=Array.isArray(previous.events)?previous.events.map(event=>safeRunEvent(event,now)).filter(Boolean).slice(-MAX_RUN_EVENTS):[];
      const at=stamp();
      const interrupted=safeRunEvent({type:'run_interrupted',at},now);
      if(events.length<MAX_RUN_EVENTS)events.push(interrupted);
      await storage.put(resultKey,{...result,at,events});
    }
    await storage.delete(key);
    return;
  }
  const events = [];
  let eventWrite = Promise.resolve();
  const record = input => {
    const event = safeRunEvent(input, now);
    if (!event) return eventWrite;
    eventWrite = eventWrite.then(async () => {
      if (events.length >= MAX_RUN_EVENTS) {
        if (!['run_finished','run_failed','run_cancelled','run_interrupted'].includes(event.type)) return;
        const removable = events.findIndex(item => item.type.startsWith('tool_') || item.type.startsWith('agent_'));
        if (removable < 0) return;
        events.splice(removable,1);
      }
      event.at = Math.max(Number(event.at) || 0, Number(events.at(-1)?.at) + 1 || 0);
      events.push(event);
      await storage.put(resultKey, {status: 'running', at: stamp(), events: [...events]});
    }).catch(() => {});
    return eventWrite;
  };
  await storage.put(resultKey,{status:'running',at:stamp(),events});
  await record({type:'run_started'});
  let result;
  try { result=await execute(record); }
  catch { result={status:'failed',answered:0}; }
  await eventWrite;
  // A failed cross-store settlement is not an execution failure. Retain
  // running + queued so recovery repairs ownership without repeating work.
  if(onSettled)await onSettled(result,job);
  const terminalType = result?.status === 'cancelled' ? 'run_cancelled' : result?.status === 'failed' ? 'run_failed' : 'run_finished';
  const terminal=safeRunEvent({type:terminalType,at:stamp()},now);
  if(events.length>=MAX_RUN_EVENTS) {
    const removable=events.findIndex(item=>item.type.startsWith('tool_')||item.type.startsWith('agent_'));
    if(removable>=0)events.splice(removable,1);
  }
  if(events.length<MAX_RUN_EVENTS) {
    terminal.at=Math.max(terminal.at,Number(events.at(-1)?.at)+1||0);
    events.push(terminal);
  }
  await storage.put(resultKey,{...result,at:stamp(),events:[...events]});
  await storage.delete(key);
}

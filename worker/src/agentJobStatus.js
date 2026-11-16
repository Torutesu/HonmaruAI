const statuses = new Set(['running', 'finished', 'failed', 'interrupted', 'cancelled', 'no_agents']);

export function validAgentStatusInput(input) {
  return typeof input?.orgId === 'string' && input.orgId.length > 0 && input.orgId.length <= 200 &&
    Array.isArray(input.rowIds) && input.rowIds.length > 0 && input.rowIds.length <= 20 &&
    input.rowIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100) &&
    new Set(input.rowIds).size === input.rowIds.length;
}

// Receipts survive completed jobs from older releases. Only a real pending
// normal job proves queuing; a receipt alone must never imply active work.
export async function readAgentJobStatuses(storage, {orgId, rowIds}) {
  const pending = await storage.list({prefix: 'job:', limit: 51});
  return Promise.all(rowIds.map(async rowId => {
    const result = await storage.get(`result:${JSON.stringify([orgId, 'agent', rowId])}`);
    if (result) return {
      rowId, status: statuses.has(result.status) ? result.status : 'unknown',
      answered: Number.isSafeInteger(result.answered) && result.answered >= 0 ? result.answered : 0,
      ...(Number.isSafeInteger(result.at) && result.at >= 0 ? {version: result.at} : {}),
      ...(Array.isArray(result.events) ? {events: result.events.filter(event => event && typeof event === 'object' &&
        ['run_started','agent_started','tool_started','tool_finished','tool_failed','tool_interrupted','agent_finished','agent_failed','agent_cancelled','run_finished','run_failed','run_cancelled','run_interrupted'].includes(event.type) &&
        Number.isSafeInteger(event.at) && event.at >= 0).slice(-80).map(event => ({type:event.type,at:event.at,
          ...(typeof event.agent==='string'?{agent:event.agent.slice(0,120)}:{}),
          ...(typeof event.tool==='string'?{tool:event.tool.slice(0,80)}:{}),
          ...(Number.isSafeInteger(event.elapsedMs)?{elapsedMs:Math.max(0,Math.min(86400000,event.elapsedMs))}:{})}))} : {}),
    };
    const queued = [...pending.values()].find(job => job.orgId === orgId && job.rowId === rowId && (job.kind == null || job.kind === 'agent'));
    return {rowId, status: queued ? 'queued' : 'unknown', answered: 0};
  }));
}

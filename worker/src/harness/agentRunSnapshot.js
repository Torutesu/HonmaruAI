import {decorateAssignmentStatuses} from './agentAssignmentStatus.js';
import {decorateAgentRequestStatuses} from '../agentRequestDispatch.js';

// Caller must validate every source against the current reader's canonical
// conversation first. A queue outage does not invalidate independently saved
// assignment ownership or remove the requester's stop control.
export async function agentRunSnapshot(env, orgId, rowIds, viewer) {
  let available = false;
  let results = rowIds.map(rowId => ({rowId, status: 'unknown', answered: 0}));
  if (env.AGENT_RUNNER) {
    try {
      const stub = env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(orgId));
      const response = await stub.fetch('https://agents/agent-status', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({orgId, rowIds}), signal: AbortSignal.timeout(5000)});
      if (response.ok) {
        const body = await response.json();
        const statuses = new Set(['running','finished','failed','interrupted','cancelled','no_agents','queued','unknown']);
        if (Array.isArray(body.results) && body.results.length === rowIds.length && new Set(body.results.map(row => row?.rowId)).size === rowIds.length && body.results.every(row => row && rowIds.includes(row.rowId) && statuses.has(row.status) && Number.isSafeInteger(row.answered) && row.answered >= 0)) {
          results = rowIds.map(rowId => {
            const row = body.results.find(row => row.rowId === rowId);
            return {rowId, status: row.status, answered: row.answered, ...(Number.isSafeInteger(row.version) && row.version >= 0 ? {version: row.version} : {})};
          });
          available = true;
        }
      }
    } catch { /* Still read current D1 metadata; never pretend the queue answered. */ }
  }
  // A D1 failure must propagate, not manufacture current stop rights from a
  // previous response or report the assignment cancelled.
  results = await decorateAgentRequestStatuses(env.DB, orgId, results);
  return {available, results: await decorateAssignmentStatuses(env.DB, orgId, results, viewer)};
}

import {decorateAssignmentStatuses} from './agentAssignmentStatus.js';
import {decorateAgentRequestStatuses} from '../agentRequestDispatch.js';
import {mayAccessAgent} from './agents.js';

async function restrictedRunRows(db,orgId,rowIds,viewer) {
  if(viewer.canManage)return new Set();
  const marks=rowIds.map((_,i)=>`?${i+2}`).join(',');
  const [dispatch,assignments]=await Promise.all([
    db.prepare(`SELECT message_id,agent_ids FROM hx_agent_request_dispatch WHERE org_id=?1 AND message_id IN (${marks})`).bind(orgId,...rowIds).all(),
    db.prepare(`SELECT id,source_message_id,initial_agent_id,current_agent_id FROM hx_agent_assignments
      WHERE org_id=?1 AND source_message_id IN (${marks})`).bind(orgId,...rowIds).all(),
  ]);
  const assignmentIds=assignments.results.map(row=>row.id);
  const hops=assignmentIds.length
    ?await db.prepare(`SELECT h.assignment_id,h.source_agent_id,h.target_agent_id FROM hx_agent_handoffs h
        JOIN hx_agent_assignments a ON a.org_id=h.org_id AND a.id=h.assignment_id
        WHERE h.org_id=?1 AND h.assignment_id IN (${assignmentIds.map((_,i)=>`?${i+2}`).join(',')})`).bind(orgId,...assignmentIds).all()
    :{results:[]};
  const agentsByRow=new Map(rowIds.map(id=>[id,new Set()]));
  const hidden=new Set();
  for(const row of dispatch.results) {
    let ids;
    try { ids=JSON.parse(row.agent_ids); } catch { hidden.add(row.message_id); continue; }
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id)){hidden.add(row.message_id);continue;}
    for(const id of ids)agentsByRow.get(row.message_id)?.add(id);
  }
  const assignmentRows=new Map(assignments.results.map(row=>[row.id,row.source_message_id]));
  for(const row of assignments.results) {
    agentsByRow.get(row.source_message_id)?.add(row.initial_agent_id);
    agentsByRow.get(row.source_message_id)?.add(row.current_agent_id);
  }
  for(const hop of hops.results) {
    const rowId=assignmentRows.get(hop.assignment_id);
    if(rowId) {
      agentsByRow.get(rowId)?.add(hop.source_agent_id);
      agentsByRow.get(rowId)?.add(hop.target_agent_id);
    }
  }
  const agentIds=[...new Set([...agentsByRow.values()].flatMap(set=>[...set]))];
  const agentRows=agentIds.length
    ?await db.prepare(`SELECT id,scope,owner_login FROM custom_agents WHERE org_id=?1 AND id IN (${agentIds.map((_,i)=>`?${i+2}`).join(',')}) AND deleted_at IS NULL`).bind(orgId,...agentIds).all()
    :{results:[]};
  const byId=new Map(agentRows.results.map(agent=>[agent.id,agent]));
  const access=new Map();
  await Promise.all(agentIds.map(async id=>{
    const agent=byId.get(id);
    access.set(id,Boolean(agent&&await mayAccessAgent(db,orgId,{...agent,ownerLogin:agent.owner_login},viewer.login)));
  }));
  for(const [rowId,ids] of agentsByRow) if([...ids].some(id=>!access.get(id)))hidden.add(rowId);
  return hidden;
}

// Caller must validate every source against the current reader's canonical
// conversation first. Restricted agents' status and handoff metadata are
// withheld unless the reader currently has access to every agent in the run.
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
  const hidden=await restrictedRunRows(env.DB,orgId,rowIds,viewer);
  const visible=results.filter(result=>!hidden.has(result.rowId));
  const decorated=await decorateAgentRequestStatuses(env.DB,orgId,visible);
  const visibleWithAssignments=await decorateAssignmentStatuses(env.DB,orgId,decorated,viewer);
  const byId=new Map(visibleWithAssignments.map(result=>[result.rowId,result]));
  return {available,results:rowIds.map(rowId=>byId.get(rowId)||{rowId,status:'unknown',answered:0})};
}

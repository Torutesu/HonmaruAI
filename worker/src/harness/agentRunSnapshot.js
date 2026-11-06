import {decorateAssignmentStatuses} from './agentAssignmentStatus.js';
import {decorateAgentRequestStatuses} from '../agentRequestDispatch.js';

async function restrictedRunRows(db,orgId,rowIds,viewer) {
  const marks=rowIds.map((_,i)=>`?${i+2}`).join(',');
  const [dispatch,assignments]=await Promise.all([
    db.prepare(`SELECT message_id,agent_ids FROM hx_agent_request_dispatch WHERE org_id=?1 AND message_id IN (${marks})`).bind(orgId,...rowIds).all(),
    db.prepare(`SELECT id,source_message_id,initial_agent_id,current_agent_id FROM hx_agent_assignments
      WHERE org_id=?1 AND source_message_id IN (${marks}) ORDER BY created_at,id LIMIT 401`).bind(orgId,...rowIds).all(),
  ]);
  const hidden=new Set();
  if(assignments.results.length>400)for(const id of rowIds)hidden.add(id);
  const assignmentIds=assignments.results.slice(0,400).map(row=>row.id);
  const hops=assignmentIds.length
    ?await db.prepare(`SELECT h.assignment_id,h.source_agent_id,h.target_agent_id FROM hx_agent_handoffs h
        JOIN hx_agent_assignments a ON a.org_id=h.org_id AND a.id=h.assignment_id
        WHERE h.org_id=?1 AND h.assignment_id IN (${assignmentIds.map((_,i)=>`?${i+2}`).join(',')})
        ORDER BY h.source_generation,h.operation_id LIMIT 3201`).bind(orgId,...assignmentIds).all()
    :{results:[]};
  if(hops.results.length>3200)for(const id of rowIds)hidden.add(id);
  const agentsByRow=new Map(rowIds.map(id=>[id,new Set()]));
  for(const row of dispatch.results) {
    let ids;
    try { ids=JSON.parse(row.agent_ids); } catch { hidden.add(row.message_id); continue; }
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id)){hidden.add(row.message_id);continue;}
    for(const id of ids)agentsByRow.get(row.message_id)?.add(id);
  }
  const assignmentRows=new Map(assignments.results.slice(0,400).map(row=>[row.id,row.source_message_id]));
  for(const row of assignments.results.slice(0,400)) {
    agentsByRow.get(row.source_message_id)?.add(row.initial_agent_id);
    agentsByRow.get(row.source_message_id)?.add(row.current_agent_id);
  }
  for(const hop of hops.results.slice(0,3200)) {
    const rowId=assignmentRows.get(hop.assignment_id);
    if(rowId) {
      agentsByRow.get(rowId)?.add(hop.source_agent_id);
      agentsByRow.get(rowId)?.add(hop.target_agent_id);
    }
  }
  const agentIds=[...new Set([...agentsByRow.values()].flatMap(set=>[...set]))];
  const canAccess=new Map();
  for(let offset=0;offset<agentIds.length;offset+=800) {
    const batch=agentIds.slice(offset,offset+800);
    const {results:rows}=await db.prepare(`SELECT a.id,
      CASE
        WHEN a.scope='team' AND EXISTS(
          SELECT 1 FROM hx_agent_members r
          JOIN hx_agent_profiles rp ON rp.org_id=r.org_id AND rp.agent_id=r.agent_id
          JOIN users u ON u.github_id=r.user_id AND u.login=?2
          JOIN memberships m ON m.org_id=r.org_id AND m.user_github_id=r.user_id
            AND m.created_at=r.member_since AND LOWER(COALESCE(m.role,'guest'))!='guest'
          WHERE r.org_id=a.org_id AND r.agent_id=a.id AND a.provider IS NULL
        ) THEN 1
        WHEN a.scope='personal' AND a.owner_login!=?2 THEN 0
        WHEN p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=?2 THEN 1
        WHEN p.access='people' AND EXISTS(SELECT 1 FROM json_each(p.people) WHERE value=?2) THEN 1
        ELSE 0
      END AS can_access
      FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
      WHERE a.org_id=?1 AND a.id IN (${batch.map((_,i)=>`?${i+3}`).join(',')}) AND a.deleted_at IS NULL`).bind(orgId,viewer.login||'',...batch).all();
    for(const row of rows)canAccess.set(row.id,Boolean(row.can_access));
  }
  for(const [rowId,ids] of agentsByRow) if([...ids].some(id=>!canAccess.get(id)))hidden.add(rowId);
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

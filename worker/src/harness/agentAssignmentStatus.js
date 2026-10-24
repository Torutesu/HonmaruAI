import {validAgentStatusInput} from '../agentJobStatus.js';

// Call only after every source message passes the conversation read check.
// No actor/session keys, source fingerprints, briefs or private instructions
// leave this boundary. Keep the caller's result ordering and metadata.
export async function decorateAssignmentStatuses(db,orgId,results,{actorId=null,canManage=false}={}) {
  const rowIds=results.map(result=>result.rowId);
  if(!validAgentStatusInput({orgId,rowIds}))throw new Error('Invalid assignment status scope');
  const marks=rowIds.map((_,i)=>`?${i+2}`).join(',');
  const face=(id,name,handle)=>({id,name:name || '',handle:handle || ''});
  const {results:assignments}=await db.prepare(`SELECT a.id,a.actor_id,a.source_message_id,a.current_agent_id,a.generation,a.status,c.name,c.handle
    FROM hx_agent_assignments a LEFT JOIN custom_agents c ON c.org_id=a.org_id AND c.id=a.current_agent_id
    WHERE a.org_id=?1 AND a.source_message_id IN (${marks}) ORDER BY a.created_at,a.id LIMIT 400`).bind(orgId,...rowIds).all();
  if(!assignments.length)return results;
  const {results:hops}=await db.prepare(`SELECT h.operation_id,h.assignment_id,h.source_agent_id,h.target_agent_id,h.created_at,
    s.name AS source_name,s.handle AS source_handle,t.name AS target_name,t.handle AS target_handle
    FROM hx_agent_handoffs h JOIN hx_agent_assignments a ON a.org_id=h.org_id AND a.id=h.assignment_id
    LEFT JOIN custom_agents s ON s.org_id=h.org_id AND s.id=h.source_agent_id
    LEFT JOIN custom_agents t ON t.org_id=h.org_id AND t.id=h.target_agent_id
    WHERE a.org_id=?1 AND a.source_message_id IN (${marks}) ORDER BY h.source_generation,h.operation_id LIMIT 3200`).bind(orgId,...rowIds).all();
  const chains=new Map();
  for(const h of hops) {
    const chain=chains.get(h.assignment_id)||[];
    if(chain.length<8)chain.push({id:h.operation_id,from:face(h.source_agent_id,h.source_name,h.source_handle),to:face(h.target_agent_id,h.target_name,h.target_handle),at:h.created_at});
    chains.set(h.assignment_id,chain);
  }
  const grouped=new Map();
  for(const a of assignments) {
    const group=grouped.get(a.source_message_id)||[];
    if(group.length<20)group.push({id:a.id,generation:a.generation,status:a.status,canStop:['running','pending'].includes(a.status) && (canManage || a.actor_id===String(actorId)),agent:face(a.current_agent_id,a.name,a.handle),hops:chains.get(a.id)||[]});
    grouped.set(a.source_message_id,group);
  }
  return results.map(result=>grouped.has(result.rowId)?{...result,assignments:grouped.get(result.rowId)}:result);
}

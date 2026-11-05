const EVENT_TYPES = new Set(['started','tool_started','tool_succeeded','tool_failed','handed_off','finished','failed','cancelled','interrupted']);
const TOOL_EVENTS = new Set(['tool_started','tool_succeeded','tool_failed']);
const MAX_EVENTS_PER_ASSIGNMENT = 500;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const toolName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value);

/// Persist only execution metadata. Tool arguments, results, prompts, and
/// provider errors never enter this table or the timeline API.
export async function appendAgentRunEvent(db, {orgId, assignmentId, sourceMessageId, generation, agentId, eventType, tool = null, at = new Date().toISOString()}) {
  if (![orgId,assignmentId,sourceMessageId,agentId].every(id) || !Number.isSafeInteger(generation) || generation < 0 || generation > 8
    || !EVENT_TYPES.has(eventType) || (TOOL_EVENTS.has(eventType) ? !toolName(tool) : tool !== null)
    || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return false;
  const eventId=crypto.randomUUID();
  const event=db.prepare(`INSERT INTO hx_agent_run_events(id,org_id,assignment_id,source_message_id,generation,agent_id,event_type,tool_name,created_at)
    SELECT ?1,a.org_id,a.id,a.source_message_id,?4,?5,?6,?7,?8 FROM hx_agent_assignments a
    WHERE a.org_id=?2 AND a.id=?3 AND a.source_message_id=?9 AND (
      (a.generation=?4 AND a.current_agent_id=?5) OR (a.initial_agent_id=?5 AND ?4=0) OR
      EXISTS(SELECT 1 FROM hx_agent_handoffs h WHERE h.org_id=a.org_id AND h.assignment_id=a.id AND
        ((h.source_generation=?4 AND h.source_agent_id=?5) OR (h.source_generation+1=?4 AND h.target_agent_id=?5)))
    )`).bind(eventId,orgId,assignmentId,generation,agentId,eventType,tool,at,sourceMessageId);
  const trim=db.prepare(`DELETE FROM hx_agent_run_events WHERE org_id=?1 AND assignment_id=?2 AND id IN (
    SELECT id FROM hx_agent_run_events WHERE org_id=?1 AND assignment_id=?2 ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?3
  )`).bind(orgId,assignmentId,MAX_EVENTS_PER_ASSIGNMENT);
  const [saved]=await db.batch([event,trim]);
  return Number(saved?.meta?.changes||0)>0;
}

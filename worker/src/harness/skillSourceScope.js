import { mayRunAgent } from './agents.js';
import { mayUseConversation } from './conversationAccess.js';

// Conversion preserves the source audience, including subsequent revocation.
// Ownership of the resulting skill does not override its source restrictions.
export async function mayReadSkillSource(db, orgId, row, userId) {
  if (!row?.source_agent_id) return true;
  if (!userId) return false;
  const agent = await db.prepare('SELECT id,scope,owner_login FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL')
    .bind(orgId,row.source_agent_id).first();
  if (!agent || !await mayRunAgent(db,orgId,agent,String(userId))) return false;
  return !row.source_channel || await mayUseConversation(db,orgId,String(userId),row.source_channel);
}

export async function visibleSkillRows(db,orgId,rows,userId) {
  const visible=[];
  for (const row of rows || []) if (await mayReadSkillSource(db,orgId,row,userId)) visible.push(row);
  return visible;
}

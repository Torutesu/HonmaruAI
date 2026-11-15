// Personal memory remains owned by its author; this preference controls only
// whether their private entries may follow them outside the source room.
export async function personalMemoryPreference(db, orgId, agentId, userId) {
  if (!orgId || !agentId || !userId) return { enabled: false, error: true };
  try {
    const row = await db.prepare(`SELECT follow_across_conversations FROM hx_agent_memory_preferences
      WHERE org_id=?1 AND agent_id=?2 AND user_github_id=?3`).bind(orgId, agentId, String(userId)).first();
    // Missing rows are legacy users: preserve the previous follow behavior.
    return { enabled: row ? Number(row.follow_across_conversations) === 1 : true, error: false };
  } catch {
    return { enabled: false, error: true };
  }
}

export async function setPersonalMemoryPreference(db, orgId, agentId, userId, enabled) {
  if (!orgId || !agentId || !userId || typeof enabled !== 'boolean') return { error: 'Invalid personal memory preference.', status: 400 };
  const stamp = new Date().toISOString();
  const saved = await db.prepare(`INSERT INTO hx_agent_memory_preferences(org_id,agent_id,user_github_id,follow_across_conversations,updated_at)
    SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (
      SELECT 1 FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL
    )
    ON CONFLICT(org_id,agent_id,user_github_id) DO UPDATE SET follow_across_conversations=excluded.follow_across_conversations,updated_at=excluded.updated_at`)
    .bind(orgId, agentId, String(userId), enabled ? 1 : 0, stamp).run();
  if (!saved.meta?.changes) return { error: 'No such Agent.', status: 404 };
  return { enabled, updatedAt: stamp };
}

// When follow is disabled, the author can still use a private memory in the
// exact source room where it was created. Unattributed memories fail closed.
export async function personalMemoryUsable(db, orgId, agentId, userId, channel, sourceChannel) {
  const preference = await personalMemoryPreference(db, orgId, agentId, userId);
  if (preference.error) return false;
  return preference.enabled || Boolean(channel && sourceChannel && channel === sourceChannel);
}

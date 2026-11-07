import { validAgentStatusInput } from "../agentJobStatus.js";
import { clientAgentAvatarUrl } from "../agentAvatarAccess.js";
import { mediaEnv } from "../mediaToken.js";

export async function decorateAssignmentStatuses(db, orgId, results, { actorId = null, canManage = false, login = null, env = null } = {}) {
  if (!results.length) return results;
  const rowIds = results.map(result => result.rowId);
  if (!validAgentStatusInput({ orgId, rowIds })) throw new Error("Invalid assignment status scope");
  const marks = rowIds.map((_, i) => "?" + (i + 2)).join(",");
  const avatarCache = new Map();
  const avatarFor = (id, avatarUrl, scope, ownerLogin) => {
    const key = String(id || "");
    if (!avatarCache.has(key)) avatarCache.set(key, clientAgentAvatarUrl(env || mediaEnv() || { DB: db }, orgId,
      { id, avatarUrl: avatarUrl || null, scope: scope || "team", ownerLogin: ownerLogin || null }, login));
    return avatarCache.get(key);
  };
  const face = async (id, name, handle, emoji, avatarUrl, scope, ownerLogin) => ({
    id,
    name: name || "",
    handle: handle || "",
    emoji: emoji || null,
    avatarUrl: await avatarFor(id, avatarUrl, scope, ownerLogin),
  });
  const { results: assignments } = await db.prepare("SELECT a.id,a.actor_id,a.source_message_id,a.current_agent_id,a.generation,a.status,a.created_at,a.updated_at,a.remote_stop_status,c.name,c.handle,c.emoji,c.avatar_url,c.scope,c.owner_login FROM hx_agent_assignments a LEFT JOIN custom_agents c ON c.org_id=a.org_id AND c.id=a.current_agent_id WHERE a.org_id=?1 AND a.source_message_id IN (" + marks + ") ORDER BY a.created_at,a.id LIMIT 400").bind(orgId, ...rowIds).all();
  if (!assignments.length) return results;
  const { results: hops } = await db.prepare("SELECT h.operation_id,h.assignment_id,h.source_agent_id,h.target_agent_id,h.created_at,s.name AS source_name,s.handle AS source_handle,s.emoji AS source_emoji,s.avatar_url AS source_avatar_url,s.scope AS source_scope,s.owner_login AS source_owner_login,t.name AS target_name,t.handle AS target_handle,t.emoji AS target_emoji,t.avatar_url AS target_avatar_url,t.scope AS target_scope,t.owner_login AS target_owner_login FROM hx_agent_handoffs h JOIN hx_agent_assignments a ON a.org_id=h.org_id AND a.id=h.assignment_id LEFT JOIN custom_agents s ON s.org_id=h.org_id AND s.id=h.source_agent_id LEFT JOIN custom_agents t ON t.org_id=h.org_id AND t.id=h.target_agent_id WHERE a.org_id=?1 AND a.source_message_id IN (" + marks + ") ORDER BY h.source_generation,h.operation_id LIMIT 3200").bind(orgId, ...rowIds).all();
  const chains = new Map();
  for (const h of hops) {
    const chain = chains.get(h.assignment_id) || [];
    if (chain.length < 8) chain.push({
      id: h.operation_id,
      from: await face(h.source_agent_id, h.source_name, h.source_handle, h.source_emoji, h.source_avatar_url, h.source_scope, h.source_owner_login),
      to: await face(h.target_agent_id, h.target_name, h.target_handle, h.target_emoji, h.target_avatar_url, h.target_scope, h.target_owner_login),
      at: h.created_at,
    });
    chains.set(h.assignment_id, chain);
  }
  const grouped = new Map();
  for (const a of assignments) {
    const group = grouped.get(a.source_message_id) || [];
    if (group.length < 20) group.push({
      id: a.id,
      generation: a.generation,
      status: a.status,
      startedAt: a.created_at,
      updatedAt: a.updated_at,
      ...(a.remote_stop_status ? { providerStopStatus: a.remote_stop_status } : {}),
      canStop: ["running", "pending"].includes(a.status) && (canManage || a.actor_id === String(actorId)),
      agent: await face(a.current_agent_id, a.name, a.handle, a.emoji, a.avatar_url, a.scope, a.owner_login),
      hops: chains.get(a.id) || [],
    });
    grouped.set(a.source_message_id, group);
  }
  return results.map(result => grouped.has(result.rowId) ? { ...result, assignments: grouped.get(result.rowId) } : result);
}

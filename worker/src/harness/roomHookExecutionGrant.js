import { can } from '../permissions.js';

// Resolve only stored event receipts, never caller-supplied routing or identity.
// This is an execution-time grant; it contains no login session or hook secret.
export async function roomHookExecutionGrant(db, orgId, messageId) {
  const row = await db.prepare(`SELECT e.hook_id,h.creator_id,u.login,u.name,u.locale,m.role,
    e.channel,e.message_id,msg.body,msg.created_at
    FROM hx_room_hook_events e
    JOIN hx_room_hooks h ON h.id=e.hook_id AND h.org_id=e.org_id AND h.channel=e.channel
    JOIN users u ON u.github_id=h.creator_id
    JOIN memberships m ON m.org_id=e.org_id AND m.user_github_id=h.creator_id
    JOIN conversation_members c ON c.org_id=e.org_id AND c.channel=e.channel AND c.login=u.login
    JOIN businesses b ON b.org_id=e.org_id AND 'b:'||b.slug=e.channel
    JOIN hx_room_access a ON a.org_id=e.org_id AND a.channel=e.channel
    JOIN channel_messages msg ON msg.id=e.message_id AND msg.org_id=e.org_id AND msg.channel=e.channel
    WHERE e.org_id=?1 AND e.message_id=?2 AND h.revoked_at IS NULL
      AND b.archived_at IS NULL AND a.deleted_at IS NULL AND msg.deleted_at IS NULL
      AND msg.author_login='webhook:'||h.id AND msg.parent_id IS NULL AND msg.kind='message'
      AND m.created_at||'/'||c.added_at=h.member_since`)
    .bind(orgId, messageId).first();
  if (!row || !can(row.role, 'harness.build')) return null;
  return {
    orgId, hookId: row.hook_id, creatorId: String(row.creator_id), channel: row.channel,
    user: { github_id: String(row.creator_id), login: row.login, name: row.name, locale: row.locale },
    row: { id: row.message_id, channel: row.channel, body: row.body, created_at: row.created_at,
      author_login: `webhook:${row.hook_id}`, kind: 'message', parent_id: null },
  };
}


// postMessage binds ?2=workspace, ?3=channel, ?4=author and ?9=parent. Keep the
// webhook authority check in the same SQLite statement as reply insertion.
export const roomHookReplyGuard = `EXISTS (
 SELECT 1 FROM hx_room_hook_events e
 JOIN hx_room_hooks h ON h.id=e.hook_id AND h.org_id=e.org_id AND h.channel=e.channel
 JOIN users u ON u.github_id=h.creator_id
 JOIN memberships m ON m.org_id=e.org_id AND m.user_github_id=h.creator_id
 JOIN conversation_members c ON c.org_id=e.org_id AND c.channel=e.channel AND c.login=u.login
 JOIN businesses b ON b.org_id=e.org_id AND 'b:'||b.slug=e.channel
 JOIN hx_room_access a ON a.org_id=e.org_id AND a.channel=e.channel
 JOIN channel_messages root ON root.id=e.message_id AND root.org_id=e.org_id AND root.channel=e.channel
 JOIN custom_agents agent ON agent.org_id=e.org_id AND 'agent:'||agent.id=?4 AND agent.deleted_at IS NULL
 LEFT JOIN hx_agent_profiles profile ON profile.org_id=agent.org_id AND profile.agent_id=agent.id
 WHERE e.org_id=?2 AND e.channel=?3 AND e.message_id=?9
 AND h.revoked_at IS NULL AND b.archived_at IS NULL AND a.deleted_at IS NULL
 AND LOWER(COALESCE(m.role,'guest'))!='guest' AND m.created_at||'/'||c.added_at=h.member_since
 AND root.deleted_at IS NULL AND root.parent_id IS NULL AND root.kind='message' AND root.author_login='webhook:'||h.id
 AND (
   (profile.agent_id IS NULL AND EXISTS(SELECT 1 FROM channel_agents placed
     WHERE placed.org_id=e.org_id AND placed.channel=e.channel AND placed.agent_id=agent.id))
   OR ((agent.scope!='personal' OR agent.owner_login=u.login) AND (
     profile.agent_id IS NULL OR profile.access='everyone' OR agent.owner_login=u.login
     OR (profile.access='people' AND EXISTS(SELECT 1 FROM json_each(
       CASE WHEN json_valid(profile.people) THEN profile.people ELSE '[]' END) person WHERE person.value=u.login))
   ))
   OR (agent.scope='team' AND agent.provider IS NULL AND profile.agent_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM hx_agent_members role WHERE role.org_id=e.org_id AND role.agent_id=agent.id
       AND role.user_id=h.creator_id AND role.member_since=m.created_at))
 )
)`;

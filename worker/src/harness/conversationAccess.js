import { listMembers } from '../team.js';
import { resolveChannel, viewOf } from '../channels.js';

// Deferred work checks the current membership, not the grant at scheduling time.
export async function mayUseConversation(db, orgId, userId, channel) {
  if (!channel) return false;
  const user = await db.prepare(`SELECT u.* FROM users u JOIN memberships m ON m.user_github_id = u.github_id
    WHERE m.org_id = ?1 AND u.github_id = ?2 AND m.role != 'guest'`).bind(orgId, String(userId)).first();
  if (!user) return false;
  const members = await listMembers(db, orgId, user.github_id);
  const view = viewOf(channel, user.login, members);
  if (!view) return false;
  const room = await resolveChannel(db, orgId, user, view, members);
  if (!room || room.key !== channel) return false;
  if (room.kind === 'business') {
    return Boolean(await db.prepare('SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2').bind(orgId, room.slug).first());
  }
  return true;
}

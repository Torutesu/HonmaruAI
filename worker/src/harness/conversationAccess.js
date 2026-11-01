import { listMembers } from '../team.js';
import { resolveChannel, viewOf } from '../channels.js';

async function conversationFor(db, orgId, userId, channel, { aliases, requireStoredBusiness }) {
  if (typeof channel !== 'string' || !channel) return null;
  const user = await db.prepare(`SELECT u.* FROM users u JOIN memberships m ON m.user_github_id = u.github_id
    WHERE m.org_id = ?1 AND u.github_id = ?2 AND m.role != 'guest'`).bind(orgId, String(userId)).first();
  if (!user) return null;
  const members = await listMembers(db, orgId, user.github_id);
  const storedView = viewOf(channel, user.login, members);
  if (!aliases && !storedView) return null;
  // Stored app links carry canonical DM/agent keys; request inputs may carry
  // viewer-facing aliases accepted by resolveChannel.
  const view = storedView || channel;
  const room = await resolveChannel(db, orgId, user, view, members);
  if (!room) return null;
  if ((!aliases || channel.startsWith('b:') || channel.startsWith('g:')) && room.key !== channel) return null;
  if (requireStoredBusiness && room.kind === 'business') {
    // resolveChannel accepts legacy virtual public rooms. Resource links need
    // a persisted room so an orphaned private-room key cannot become public.
    if (!await db.prepare('SELECT 1 FROM businesses WHERE org_id = ?1 AND slug = ?2').bind(orgId, room.slug).first()) return null;
  }
  return room;
}

// App links must resolve to a stored room, so deleted private room names do
// not become visible as legacy virtual public rooms.
export async function readableConversation(db, orgId, userId, channel) {
  return conversationFor(db, orgId, userId, channel, { aliases: true, requireStoredBusiness: true });
}

// Deferred work checks the current membership, not the grant at scheduling time.
export async function mayUseConversation(db, orgId, userId, channel) {
  // Preserve the historical contract for current memberships and persisted
  // business rooms; deferred work must not retain access to a deleted room.
  return Boolean(await conversationFor(db, orgId, userId, channel, { aliases: false, requireStoredBusiness: true }));
}

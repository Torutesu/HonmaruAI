import { getMessage, present, resolveChannel } from '../channels.js';
import { listMembers } from '../team.js';
import { announceTo } from '../announce.js';
import { custom } from '../agui/events.js';

export async function broadcastRoomHookMessage(env, orgId, channel, messageId) {
  const room = await env.DB.prepare("SELECT 1 FROM businesses WHERE org_id=?1 AND 'b:'||slug=?2 AND archived_at IS NULL")
    .bind(orgId,channel).first();
  if (!room) return {announced:0};
  const row = await getMessage(env.DB,orgId,messageId);
  if (!row || row.deleted_at || row.channel !== channel) return {announced:0};
  const members = await listMembers(env.DB,orgId);
  const deliveries = [];
  for (const member of members) {
    if (!await resolveChannel(env.DB,orgId,member,channel,members)) continue;
    const [message] = await present(env.DB,orgId,[row],member.login,channel,members);
    deliveries.push({to:member.login,event:custom('channel_message',{message})});
  }
  return announceTo(env,orgId,deliveries);
}

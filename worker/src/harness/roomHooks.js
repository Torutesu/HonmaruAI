import { roomRoleState } from './roomRoles.js';
import { createRoomWebhookSecret, verifyRoomWebhookSecret, roomWebhookEventIdentity } from './roomWebhookIdentity.js';

const fail = (error, status) => ({ error, status });
const currentMembership = `EXISTS(SELECT 1 FROM businesses b
 JOIN hx_room_access a ON a.org_id=b.org_id AND a.channel=?2 AND a.deleted_at IS NULL
 JOIN conversation_members c ON c.org_id=b.org_id AND c.channel=?2
 JOIN users u ON u.login=c.login
 JOIN memberships m ON m.org_id=b.org_id AND m.user_github_id=u.github_id
 WHERE b.org_id=?1 AND 'b:'||b.slug=?2 AND b.archived_at IS NULL
 AND u.github_id=?3 AND LOWER(COALESCE(m.role,'member'))!='guest' AND m.created_at||'/'||c.added_at=?4)`;

async function actorInRoom(db, orgId, channel, actorId) {
  const room = await roomRoleState(db, orgId, channel);
  if (!room?.managed) return fail('No such active managed room.', 404);
  const actor = room.members.find(member => member.kind === 'person' && member.id === String(actorId) && member.eligible);
  return actor ? { actor } : fail('Join this room to manage its webhooks.', 403);
}

export async function createRoomHook(db, orgId, channel, actorId, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) return fail('A webhook name of 1–120 characters is required.', 400);
  const current = await actorInRoom(db, orgId, channel, actorId);
  if (current.error) return current;
  const id = crypto.randomUUID(), at = new Date().toISOString();
  const { secret, secretHash } = await createRoomWebhookSecret();
  const result = await db.prepare(`INSERT INTO hx_room_hooks(id,org_id,channel,name,creator_id,member_since,secret_hash,created_at,updated_at)
    SELECT ?5,?1,?2,?6,?3,?4,?7,?8,?8 WHERE ${currentMembership}`)
    .bind(orgId, channel, String(actorId), current.actor.membership, id, name.trim(), secretHash, at).run();
  return result.meta?.changes ? { hook: { id, name: name.trim(), version: 1, createdAt: at }, secret }
    : fail('Room membership changed. Reload before creating a webhook.', 409);
}

export async function listRoomHooks(db, orgId, channel, actorId) {
  const current = await actorInRoom(db, orgId, channel, actorId);
  if (current.error) return current;
  const { results } = await db.prepare('SELECT id,name,version,revoked_at AS revokedAt,created_at AS createdAt FROM hx_room_hooks WHERE org_id=?1 AND channel=?2 ORDER BY created_at,id')
    .bind(orgId, channel).all();
  const {results:events} = await db.prepare(`SELECT e.message_id AS messageId,e.hook_id AS hookId,e.created_at AS createdAt,d.status AS dispatchStatus,
    (SELECT COUNT(*) FROM ai_teammate_runs r WHERE r.org_id=e.org_id AND r.room_hook_source=e.message_id AND r.channel=e.channel) AS externalRuns,
    (SELECT COUNT(*) FROM ai_teammate_runs r WHERE r.org_id=e.org_id AND r.room_hook_source=e.message_id AND r.channel=e.channel AND r.status='running') AS externalRunning,
    (SELECT COUNT(*) FROM ai_teammate_runs r WHERE r.org_id=e.org_id AND r.room_hook_source=e.message_id AND r.channel=e.channel AND r.status IN ('failed','budget')) AS externalFailed
    FROM hx_room_hook_events e LEFT JOIN hx_room_hook_dispatch d ON d.message_id=e.message_id AND d.org_id=e.org_id
    JOIN channel_messages msg ON msg.id=e.message_id AND msg.org_id=e.org_id AND msg.deleted_at IS NULL
    WHERE e.org_id=?1 AND e.channel=?2 ORDER BY e.created_at DESC,e.message_id DESC LIMIT 20`).bind(orgId,channel).all();
  return { hooks: results, events };

}

// Rotation and revocation are versioned. Only the creator's original grant
// can rotate a secret; a current room member may revoke a stranded hook.
export async function changeRoomHook(db, orgId, channel, actorId, id, version, action) {
  if (!Number.isSafeInteger(version) || version < 1 || !['rotate', 'revoke'].includes(action)) return fail('A current webhook version and action are required.', 400);
  const current = await actorInRoom(db, orgId, channel, actorId);
  if (current.error) return current;
  const next = action === 'rotate' ? await createRoomWebhookSecret() : null;
  const at = new Date().toISOString();
  const result = await db.prepare(`UPDATE hx_room_hooks SET version=version+1,updated_at=?7,
    secret_hash=CASE WHEN ?8='rotate' THEN ?9 ELSE secret_hash END,
    revoked_at=CASE WHEN ?8='revoke' THEN ?7 ELSE revoked_at END
    WHERE org_id=?1 AND channel=?2 AND id=?5 AND version=?6 AND revoked_at IS NULL
    AND (?8='revoke' OR (creator_id=?3 AND member_since=?4)) AND ${currentMembership}`)
    .bind(orgId, channel, String(actorId), current.actor.membership, id, version, at, action, next?.secretHash || '').run();
  return result.meta?.changes ? { version: version + 1, ...(next ? { secret: next.secret } : {}) }
    : fail('Webhook or membership changed. Reload before saving.', 409);
}

export async function authenticateRoomHook(db, id, secret) {
  const hook = await db.prepare('SELECT * FROM hx_room_hooks WHERE id=?1 AND revoked_at IS NULL').bind(id).first();
  if (!hook || !await verifyRoomWebhookSecret(secret, hook.secret_hash)) return null;
  const active = await db.prepare(`SELECT 1 AS active WHERE ${currentMembership}`)
    .bind(hook.org_id, hook.channel, hook.creator_id, hook.member_since).first();
  if (!active) return null;
  return { id: hook.id, orgId: hook.org_id, channel: hook.channel, creatorId: hook.creator_id, memberSince: hook.member_since, version: hook.version };
}

// A receipt and its root message commit together. The authenticated grant is
// checked again inside the write, not merely before reading the request body.
export async function receiveRoomHookEvent(db, hook, { eventId, body }) {
  if (!hook || typeof eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)
    || typeof body !== 'string' || !body.trim() || body.length > 4000) return fail('A validated event is required.', 400);
  const identity = await roomWebhookEventIdentity(hook.orgId, hook.id, eventId, body);
  const messageId = crypto.randomUUID(), at = new Date().toISOString();
  const grant = `EXISTS(SELECT 1 FROM hx_room_hooks WHERE org_id=?1 AND channel=?2 AND id=?5
    AND creator_id=?3 AND member_since=?4 AND version=?6 AND revoked_at IS NULL) AND ${currentMembership}`;
  const values = [hook.orgId, hook.channel, hook.creatorId, hook.memberSince, hook.id, hook.version];
  const result = await db.batch([
    db.prepare(`INSERT INTO hx_room_hook_events(event_key,hook_id,org_id,channel,payload_hash,message_id,created_at)
      SELECT ?7,?5,?1,?2,?8,?9,?10 WHERE ${grant} ON CONFLICT(event_key) DO NOTHING`)
      .bind(...values, identity.eventKey, identity.payloadHash, messageId, at),
    db.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at,client_id)
      SELECT ?9,?1,?2,'webhook:'||?5,'message',?11,?10,?12 WHERE ${grant}
      AND EXISTS(SELECT 1 FROM hx_room_hook_events WHERE event_key=?7 AND payload_hash=?8 AND message_id=?9)`)
      .bind(...values, identity.eventKey, identity.payloadHash, messageId, at, body, identity.clientId),
    db.prepare(`INSERT INTO hx_room_hook_dispatch(message_id,org_id,updated_at)
      SELECT ?9,?1,?10 WHERE ${grant}
      AND EXISTS(SELECT 1 FROM hx_room_hook_events WHERE event_key=?7 AND payload_hash=?8 AND message_id=?9)
      AND EXISTS(SELECT 1 FROM channel_messages WHERE id=?9 AND org_id=?1 AND channel=?2)
      ON CONFLICT(message_id) DO NOTHING`)
      .bind(...values, identity.eventKey, identity.payloadHash, messageId, at),
    db.prepare(`SELECT e.message_id,e.payload_hash FROM hx_room_hook_events e
      WHERE e.event_key=?7 AND e.org_id=?1 AND e.channel=?2 AND ${grant}`)
      .bind(...values, identity.eventKey),
  ]);
  const receipt = result[3].results?.[0];
  if (!receipt) return fail('Webhook or room access changed.', 403);
  if (receipt.payload_hash !== identity.payloadHash) return fail('This eventId was already used with different content.', 409);
  return { messageId: receipt.message_id, replay: !result[0].meta?.changes };
}

const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));

// Only the digest is persisted. The bearer value is returned once at creation
// or rotation; it must not be embedded in URLs, room messages or audit records.
export async function createRoomWebhookSecret() {
  const secret = 'rh_' + hex(crypto.getRandomValues(new Uint8Array(32)));
  return { secret, secretHash: await digest(secret) };
}

export async function verifyRoomWebhookSecret(secret, secretHash) {
  if (typeof secret !== 'string' || !/^rh_[0-9a-f]{64}$/.test(secret)
    || typeof secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(secretHash)) return false;
  const actual = await digest(secret);
  let different = 0;
  for (let i = 0; i < actual.length; i++) different |= actual.charCodeAt(i) ^ secretHash.charCodeAt(i);
  return different === 0;
}

// Namespace by organization AND hook: two providers may reuse the same ID.
// Keep the ID stable across secret rotation so retried events stay deduplicated.
export async function roomWebhookEventIdentity(orgId, hookId, eventId, body) {
  if (![orgId, hookId, eventId, body].every(value => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('A webhook scope, event identity and body are required.');
  }
  const eventKey = await digest(JSON.stringify(['room-event-v1', orgId, hookId, eventId]));
  return {
    eventKey,
    clientId: `tmp-${eventKey}`,
    payloadHash: await digest(JSON.stringify(['room-body-v1', body])),
  };
}

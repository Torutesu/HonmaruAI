const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const equal = (left, right) => {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i += 1) different |= a[i] ^ b[i];
  return different === 0;
};

export const WORKFLOW_WEBHOOK_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKFLOW_WEBHOOK_CLOCK_SKEW_SECONDS = 5 * 60;

export async function workflowWebhookBodyHash(body) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))));
}

export async function signWorkflowWebhook(secret, timestamp, eventId, body) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${eventId}.${body}`));
  return `v1=${hex(new Uint8Array(signature))}`;
}

export async function verifyWorkflowWebhook({ secret, timestamp, eventId, signature, body, nowMs = Date.now() }) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{48}$/i.test(secret)
    || typeof timestamp !== 'string' || !/^\d{10}(?:\d{3})?$/.test(timestamp)
    || typeof eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(eventId)
    || typeof signature !== 'string' || !/^v1=[0-9a-f]{64}$/i.test(signature)
    || typeof body !== 'string') return { valid: false, reason: 'malformed' };

  const numericTimestamp = Number(timestamp);
  const timestampMs = timestamp.length === 13 ? numericTimestamp : numericTimestamp * 1000;
  if (!Number.isSafeInteger(numericTimestamp)
    || Math.abs(nowMs - timestampMs) > WORKFLOW_WEBHOOK_CLOCK_SKEW_SECONDS * 1000) {
    return { valid: false, reason: 'expired' };
  }

  const expected = await signWorkflowWebhook(secret, timestamp, eventId, body);
  if (!equal(signature.toLowerCase(), expected)) return { valid: false, reason: 'signature' };
  return { valid: true, payloadHash: await workflowWebhookBodyHash(body) };
}

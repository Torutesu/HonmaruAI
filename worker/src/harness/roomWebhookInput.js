import { MAX_MESSAGE_CHARS } from '../channels.js';

const MAX_BYTES = 32 * 1024;
const fail = (error, status = 400) => ({ error, status });

// Read only bounded JSON. Event identity is required so a provider retry can
// resolve to the same room thread rather than creating another conversation.
export async function readRoomWebhookInput(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return fail('Send an application/json event.', 415);
  }
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return fail('The event is too large.', 413);
  if (!request.body) return fail('An event body is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return fail('The event is too large.', 413);
      }
      chunks.push(value);
    }
  } catch {
    return fail('The event body could not be read.');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('Send valid UTF-8 JSON.'); }
  if (!input || Array.isArray(input) || typeof input !== 'object') return fail('Send an event object.');
  if (typeof input.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.eventId)) {
    return fail('An eventId of 1–128 letters, digits, dots, underscores, colons or hyphens is required.');
  }
  if (typeof input.body !== 'string') return fail('A text body is required.');
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!body || body.length > MAX_MESSAGE_CHARS) return fail(`The body must contain 1–${MAX_MESSAGE_CHARS} characters.`);
  // Routing and author identity belong to the authenticated hook, never input.
  return { eventId: input.eventId, body };
}

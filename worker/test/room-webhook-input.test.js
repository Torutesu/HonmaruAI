import { expect, test } from 'vitest';
import { readRoomWebhookInput } from '../src/harness/roomWebhookInput.js';

const request = input => new Request('https://example.test/hook', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
});
test('normalizes event text and never accepts caller-controlled routing or authorship', async () => {
  expect(await readRoomWebhookInput(request({ eventId: 'deploy:42', body: ' Done\r\nNext ', orgId: 'other', channel: 'b:private', author: 'owner' })))
    .toEqual({ eventId: 'deploy:42', body: 'Done\nNext' });
});
test('rejects missing identity, invalid JSON, active bodies and oversized text', async () => {
  for (const input of [null, [], {body:'hi'}, {eventId:'../a',body:'hi'}, {eventId:'a',body:{}}, {eventId:'a',body:' '}, {eventId:'a',body:'x'.repeat(4001)}]) {
    expect((await readRoomWebhookInput(request(input))).status).toBe(400);
  }
  expect((await readRoomWebhookInput(new Request('https://example.test', {method:'POST',body:'{}'}))).status).toBe(415);
});
test('caps streamed bytes even when no content length is supplied', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32769)); controller.close(); } });
  expect((await readRoomWebhookInput(new Request('https://example.test', {method:'POST',headers:{'content-type':'application/json'},body}))).status).toBe(413);
});

test('rejects invalid UTF-8 and interrupted streams without exposing their errors', async () => {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  expect((await readRoomWebhookInput(new Request('https://example.test', {
    method: 'POST', headers, body: new Uint8Array([0xff, 0xfe]),
  }))).status).toBe(400);
  const body = new ReadableStream({ start(controller) { controller.error(new Error('private transport detail')); } });
  expect(await readRoomWebhookInput(new Request('https://example.test', { method: 'POST', headers, body })))
    .toEqual({ error: 'The event body could not be read.', status: 400 });
});

test('accepts boundary text and IDs, rejecting oversized identity independently of body', async () => {
  const eventId = 'e'.repeat(128), body = 'x'.repeat(4000);
  expect(await readRoomWebhookInput(request({ eventId, body }))).toEqual({ eventId, body });
  expect((await readRoomWebhookInput(request({ eventId: eventId + 'x', body }))).status).toBe(400);
});

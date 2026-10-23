import { expect, test } from 'vitest';
import { clientIdOk } from '../src/channels.js';
import { createRoomWebhookSecret, verifyRoomWebhookSecret, roomWebhookEventIdentity } from '../src/harness/roomWebhookIdentity.js';

test('secrets are random and only the matching digest authenticates them', async () => {
  const first = await createRoomWebhookSecret(), next = await createRoomWebhookSecret();
  expect(first.secret).not.toBe(next.secret);
  expect(first.secretHash).not.toContain(first.secret);
  expect(await verifyRoomWebhookSecret(first.secret, first.secretHash)).toBe(true);
  expect(await verifyRoomWebhookSecret(first.secret, next.secretHash)).toBe(false);
  expect(await verifyRoomWebhookSecret(next.secret, first.secretHash)).toBe(false);
  for (const value of [null, '', 'rh_invalid', {}, 'x'.repeat(1000)]) expect(await verifyRoomWebhookSecret(value, first.secretHash)).toBe(false);
});

test('event retries are stable and scoped, with changed payloads detectable', async () => {
  const first = await roomWebhookEventIdentity('org', 'hook', 'event', 'body');
  expect(await roomWebhookEventIdentity('org', 'hook', 'event', 'body')).toEqual(first);
  expect(clientIdOk(first.clientId)).toBe(true);
  for (const scope of [['other', 'hook', 'event'], ['org', 'other', 'event'], ['org', 'hook', 'other']]) {
    expect((await roomWebhookEventIdentity(...scope, 'body')).eventKey).not.toBe(first.eventKey);
  }
  const changed = await roomWebhookEventIdentity('org', 'hook', 'event', 'changed');
  expect(changed.eventKey).toBe(first.eventKey);
  expect(changed.payloadHash).not.toBe(first.payloadHash);
});

test('scope encoding cannot collide through delimiters', async () => {
  expect((await roomWebhookEventIdentity('a:b', 'c', 'event', 'body')).eventKey)
    .not.toBe((await roomWebhookEventIdentity('a', 'b:c', 'event', 'body')).eventKey);
  await expect(roomWebhookEventIdentity('', 'hook', 'event', 'body')).rejects.toThrow();
});

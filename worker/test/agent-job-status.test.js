import {expect, test} from 'vitest';
import {readAgentJobStatuses, validAgentStatusInput} from '../src/agentJobStatus.js';

test('only real pending normal jobs are queued; receipts and other job types are not', async () => {
  const data = new Map([
    ['accepted:["org","agent","old",null]', {acceptedAt: 1}],
    ['job:1', {orgId: 'org', rowId: 'pending'}],
    ['job:2', {orgId: 'org', rowId: 'proxy', kind: 'proxy'}],
    ['job:3', {orgId: 'org', rowId: 'hook', kind: 'room_hook'}],
    ['job:4', {orgId: 'other', rowId: 'foreign', kind: 'agent'}],
    ['job:5', {orgId: 'org', rowId: 'done', kind: 'agent'}],
    ['result:["org","agent","done"]', {status: 'finished', answered: 2, at: 42, token: 'secret', body: 'private'}],
  ]);
  const storage = {get: async k => data.get(k), list: async ({prefix}) => new Map([...data].filter(([k]) => k.startsWith(prefix)))};
  const result = await readAgentJobStatuses(storage, {orgId: 'org', rowIds: ['old', 'pending', 'proxy', 'hook', 'foreign', 'done']});
  expect(result.map(r => r.status)).toEqual(['unknown', 'queued', 'unknown', 'unknown', 'unknown', 'finished']);
  expect(result[5]).toEqual({rowId: 'done', status: 'finished', answered: 2, version: 42});
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
});

test('batch reads reject empty, duplicate, oversized or malformed identifiers', () => {
  expect(validAgentStatusInput({orgId: 'org', rowIds: ['one', 'two']})).toBe(true);
  for (const rowIds of [[], ['one', 'one'], [''], [null], ['x'.repeat(101)], Array.from({length: 21}, (_, i) => String(i))]) {
    expect(validAgentStatusInput({orgId: 'org', rowIds})).toBe(false);
  }
  expect(validAgentStatusInput(null)).toBe(false);
});

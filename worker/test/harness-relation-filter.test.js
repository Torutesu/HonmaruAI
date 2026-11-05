import { expect, test } from 'vitest';
import { computeView } from '../src/harness/apps.js';

test('excluding one linked record keeps empty relations and omits rows that contain it', () => {
  const columns = [{ id: 'watchers', name: 'Watchers', type: 'relation', multiple: true }];
  const rows = [
    { id: 'contains', values: { watchers: ['customer_1', 'customer_2'] } },
    { id: 'other', values: { watchers: ['customer_2'] } },
    { id: 'empty', values: { watchers: [] } },
    { id: 'unset', values: {} },
  ];

  const result = computeView({ type: 'table', filters: [{ column: 'watchers', op: 'neq', value: 'customer_1' }] }, { columns }, rows);

  expect(result.rows.map(row => row.id)).toEqual(['other', 'empty', 'unset']);
});

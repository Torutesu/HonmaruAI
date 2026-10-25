import { expect, test } from 'vitest';
import { generateMigration } from '../src/harness/appDatabase.js';

const current = { entities: [{ key: 'primary', table: { name: 'Tasks', columns: [{ id: 'name', name: 'タスク名', type: 'text' }] } }] };

test('database migrations use member references for assignees, without changing unrelated free-text fields', async () => {
  const result = await generateMigration('担当者はワークスペースメンバーから選択し、メモは自由記述で管理', current, async () => JSON.stringify({ operations: [
    { op: 'add_columns', entity: 'primary', columns: [{ name: '担当者', type: 'text' }, { name: 'メモ', type: 'text' }] },
  ] }));
  expect(result.operations[0].columns.map(({ name, type }) => [name, type])).toEqual([['担当者', 'person'], ['メモ', 'text']]);
});

test('an explicitly free-text owner remains text in a generated migration', async () => {
  const result = await generateMigration('Add an Owner as free text for an external contact name', current, async () => JSON.stringify({ operations: [
    { op: 'add_columns', entity: 'primary', columns: [{ name: 'Owner', type: 'person' }] },
  ] }));
  expect(result.operations[0].columns[0].type).toBe('text');
});

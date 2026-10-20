const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrateColumns } = require('./migrate-columns.cjs');
const internal = { status: 1, stderr: 'internal error; reference = e_test [code: 7500]' };
async function run(results, statements = ['ALTER TABLE x ADD COLUMN y TEXT;']) {
  const calls = [], waits = [];
  const code = await migrateColumns({ statements, execute: sql => { calls.push(sql); return results.shift(); }, wait: async ms => waits.push(ms), log: () => {} });
  return { code, calls, waits };
}
test('internal API failure retries the same statement and accepts success', async () => {
  const r = await run([internal, { status: 0 }]); assert.equal(r.code, 0); assert.equal(r.calls.length, 2); assert.equal(r.calls[0], r.calls[1]); assert.deepEqual(r.waits, [2000]);
});
test('successful ALTER whose response was lost accepts duplicate on retry', async () => {
  const r = await run([internal, { status: 1, stderr: 'duplicate column name: y: SQLITE_ERROR [code: 7500]' }]); assert.equal(r.code, 0); assert.equal(r.calls.length, 2);
});
test('persistent internal errors stop after three attempts', async () => {
  const r = await run([internal, internal, internal]); assert.equal(r.code, 1); assert.equal(r.calls.length, 3); assert.deepEqual(r.waits, [2000, 4000]);
});
test('SQL, authorization and process errors fail without retry and do not hide failures', async () => {
  for (const failure of [{status:1,stderr:'syntax error [code: 7500]'}, {status:1,stderr:'Authentication error [code: 10000]'}, {status:null,stderr:''}]) {
    const r = await run([failure, {status:0}], ['ALTER TABLE x ADD COLUMN y TEXT;', 'CREATE INDEX IF NOT EXISTS z ON x(y);']);
    assert.equal(r.code, 1); assert.equal(r.calls.length, 2); assert.deepEqual(r.waits, []);
  }
});

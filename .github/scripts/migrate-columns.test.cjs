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

const snapshot = rows => ({status:0,stdout:JSON.stringify([{success:true,results:rows.map(row=>({name:row.column_name}))}])});
test('inspection skips only existing columns and still runs missing columns and indexes in order',async()=>{
 const calls=[];
 const statements=['ALTER TABLE users ADD COLUMN email TEXT;','ALTER TABLE users ADD COLUMN alias TEXT;','CREATE INDEX IF NOT EXISTS email_idx ON users(email);'];
 const code=await migrateColumns({statements,inspect:()=>snapshot([{table_name:'users',column_name:'email'}]),execute:sql=>{calls.push(sql);return {status:0}},log:()=>{}});
 assert.equal(code,0);assert.deepEqual(calls,statements.slice(1));
});
test('failed, malformed or partial inspection never skips an unproven migration',async()=>{
 const statement='ALTER TABLE x ADD COLUMN y TEXT;';
 for(const result of [{status:1}, {status:0,stdout:'not JSON'}, snapshot([{table_name:'x'}]), {status:0,stdout:JSON.stringify([{success:false,results:[{table_name:'x',column_name:'y'}]}])},snapshot([])]) {
  const calls=[];
  const code=await migrateColumns({statements:[statement],inspect:()=>result,execute:sql=>{calls.push(sql);return {status:1,stderr:'permission denied'}},log:()=>{}});
  assert.equal(code,1);assert.deepEqual(calls,[statement]);
 }
});
test('inspection errors preserve duplicate handling and ambiguous SQL is executed rather than skipped',async()=>{
 let calls=0;
 const code=await migrateColumns({statements:['ALTER TABLE x ADD COLUMN y TEXT;'],inspect:()=>{throw Error('offline')},execute:()=>{calls++;return {status:1,stderr:'duplicate column name: y'}},log:()=>{}});
 assert.equal(code,0);assert.equal(calls,1);
 const sql='ALTER TABLE x ADD COLUMN y TEXT; ALTER TABLE x ADD COLUMN z TEXT;';
 await migrateColumns({statements:[sql],inspect:()=>snapshot([{table_name:'x',column_name:'y'}]),execute:value=>{assert.equal(value,sql);calls++;return {status:0}},log:()=>{}});
 assert.equal(calls,2);
});

test('batched PRAGMA results align with their requested tables and missing results fall back',()=>{
 const {columnInspection,existingColumns}=require('./migrate-columns.cjs');
 const plan=columnInspection(['ALTER TABLE users ADD COLUMN email TEXT;','ALTER TABLE rooms ADD COLUMN name TEXT;','ALTER TABLE users ADD COLUMN alias TEXT;']);
 assert.deepEqual(plan.tables,['users','rooms']);
 assert.equal(plan.sql,'PRAGMA table_info("users"); PRAGMA table_info("rooms");');
 const result={status:0,stdout:JSON.stringify([{success:true,results:[{name:'email'}]},{success:true,results:[{name:'name'}]}])};
 assert.deepEqual([...existingColumns(result,plan.tables)],['users.email','rooms.name']);
 assert.equal(existingColumns(snapshot([{column_name:'email'}]),plan.tables),null);
});

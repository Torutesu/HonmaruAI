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

test('ordered schema statement runs batch around individually applied ALTERs', async () => {
  const statements = [
    'ALTER TABLE users ADD COLUMN email TEXT;',
    'CREATE INDEX IF NOT EXISTS email_idx ON users(email);',
    'CREATE INDEX IF NOT EXISTS alias_idx ON users(alias);',
    'ALTER TABLE users ADD COLUMN alias TEXT;',
    'CREATE TABLE IF NOT EXISTS next_table (id TEXT PRIMARY KEY);',
    'CREATE INDEX IF NOT EXISTS next_table_id ON next_table(id);',
  ];
  const batches = [], singles = [];
  const code = await migrateColumns({
    statements,
    inspect: () => snapshot([{ table_name: 'users', column_name: 'email' }]),
    executeBatch: sql => { batches.push(sql); return { status: 0 }; },
    execute: sql => { singles.push(sql); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(batches, [
    statements.slice(1, 3).join('\n'),
    statements.slice(4).join('\n'),
  ]);
  assert.deepEqual(singles, [statements[3]]);
});

test('failed D1 import falls back to idempotent statements before continuing with ALTERs', async () => {
  const statements = [
    'CREATE INDEX IF NOT EXISTS first_idx ON users(first);',
    'CREATE INDEX IF NOT EXISTS second_idx ON users(second);',
    'ALTER TABLE users ADD COLUMN alias TEXT;',
  ];
  const batches = [], singles = [];
  const code = await migrateColumns({
    statements,
    inspect: () => snapshot([]),
    executeBatch: sql => { batches.push(sql); return { status: 1, stderr: 'import failed' }; },
    execute: sql => {
      singles.push(sql);
      return sql.startsWith('ALTER TABLE')
        ? { status: 1, stderr: 'duplicate column name: alias' }
        : { status: 0 };
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(batches, [statements.slice(0, 2).join('\n')]);
  assert.deepEqual(singles, statements);
});

test('batch executor uses one temporary SQL file and removes it afterward', () => {
  const fs = require('node:fs');
  const migration = require('./migrate-columns.cjs');
  const calls = [];
  const execute = migration.createBatchExecutor({
    database: 'honmaru-test',
    flags: ['--env', 'staging'],
    spawnSync: (binary, args, options) => {
      calls.push({ binary, args, options });
      const file = args[args.indexOf('--file') + 1];
      assert.equal(fs.readFileSync(file, 'utf8'), `CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY);\n`);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(execute('CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY);').status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, 'npx');
  assert.deepEqual(calls[0].args.slice(0, 7), ['-y', 'wrangler@4', 'd1', 'execute', 'honmaru-test', '--env', 'staging']);
  const path = calls[0].args[calls[0].args.indexOf('--file') + 1];
  assert.equal(fs.existsSync(path), false);
});

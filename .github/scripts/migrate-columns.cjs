const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

// Inspect names, never user data. Unsupported/failed inspection falls back to
// the original per-statement migration; only proven existing columns are skipped.
function columnInspection(statements) {
  const tables = [...new Set(statements.map(addedColumn).filter(Boolean).map(key => key.split('.')[0]))];
  return { tables, sql: tables.map(table => `PRAGMA table_info("${table}");`).join(' ') };
}
function existingColumns(result, tables) {
  if (result?.status !== 0) return null;
  try {
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data) || data.length !== tables.length) return null;
    const columns = new Set();
    for (let i = 0; i < tables.length; i++) {
      if (data[i].success !== true || !Array.isArray(data[i].results)) return null;
      for (const row of data[i].results) {
        if (typeof row.name !== 'string') return null;
        columns.add(`${tables[i]}.${row.name.toLowerCase()}`);
      }
    }
    return columns;
  } catch { return null; }
}
function addedColumn(statement) {
  const match = /^ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([a-z_][a-z0-9_]*)\s+[^;]+;\s*$/i.exec(statement);
  return match ? `${match[1].toLowerCase()}.${match[2].toLowerCase()}` : null;
}

// A lost response may follow a successful ALTER; its next duplicate-column
// response is the existing already-applied signal. Other failures stay fatal.
async function migrateColumns({ statements, execute, inspect, wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log }) {
  let columns = null;
  if (inspect) {
    try { const plan = columnInspection(statements); columns = plan.tables.length ? existingColumns(await inspect(plan.sql), plan.tables) : new Set(); } catch { /* Use the existing migration path. */ }
    log(columns ? `Inspected ${columns.size} existing columns.` : 'Column inspection unavailable; using individual migration checks.');
  }
  let failed = false;
  for (const statement of statements) {
    const column = addedColumn(statement);
    if (column && columns?.has(column)) { log(`Already present: ${column}`); continue; }
    log(`-> ${statement}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = execute(statement);
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      log(output);
      if (result.status === 0) break;
      if (/duplicate column name/i.test(output)) { log('   already applied'); break; }
      const transient = /internal error; reference\s*=/i.test(output) && /\[code:\s*7500\]/i.test(output);
      if (!transient || attempt === 3) { failed = true; break; }
      log(`Transient D1 internal error; retry ${attempt + 1}/3.`);
      await wait(attempt * 2000);
    }
  }
  return failed ? 1 : 0;
}
module.exports = { migrateColumns, existingColumns, columnInspection };
if (require.main === module) {
  const [database, ...flags] = process.argv.slice(2);
  if (!database || !(flags.length === 0 || flags.length === 2 && flags[0] === '--env' && flags[1] === 'staging')) {
    console.error('Usage: node migrate-columns.cjs <database> [--env staging]'); process.exitCode = 1;
  } else {
    const statements = readFileSync('migrations.sql', 'utf8').split(/\r?\n/).filter(line => /^(ALTER TABLE|CREATE )/.test(line));
    migrateColumns({ statements, inspect: statement => spawnSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', database, ...flags, '--remote', '--command', statement, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), execute: statement => spawnSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', database, ...flags, '--remote', '--command', statement, '--yes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })
      .then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

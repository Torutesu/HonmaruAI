const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

// A lost response may follow a successful ALTER; its next duplicate-column
// response is the existing already-applied signal. Other failures stay fatal.
async function migrateColumns({ statements, execute, wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log }) {
  let failed = false;
  for (const statement of statements) {
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
module.exports = { migrateColumns };
if (require.main === module) {
  const [database, ...flags] = process.argv.slice(2);
  if (!database || !(flags.length === 0 || flags.length === 2 && flags[0] === '--env' && flags[1] === 'staging')) {
    console.error('Usage: node migrate-columns.cjs <database> [--env staging]'); process.exitCode = 1;
  } else {
    const statements = readFileSync('migrations.sql', 'utf8').split(/\r?\n/).filter(line => /^(ALTER TABLE|CREATE )/.test(line));
    migrateColumns({ statements, execute: statement => spawnSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', database, ...flags, '--remote', '--command', statement, '--yes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })
      .then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

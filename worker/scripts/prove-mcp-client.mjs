import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const worker = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'honmaru-mcp-sdk-'));
let tests;
function run(args, cwd) {
  const result = spawnSync('pnpm', args, { cwd, stdio: 'inherit', env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || join(scratch, 'wrangler.log') } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm exited with ${result.status ?? result.signal}`);
}
try {
  let sdk = process.env.MCP_SDK_DIR && resolve(process.env.MCP_SDK_DIR);
  if (!sdk) {
    await writeFile(join(scratch, 'package.json'), JSON.stringify({ private: true }));
    run(['add', '--save-exact', '@modelcontextprotocol/sdk@1.32.2'], scratch);
    sdk = join(scratch, 'node_modules', '@modelcontextprotocol', 'sdk');
  }
  await access(join(sdk, 'dist/esm/client/index.js'));
  tests = await mkdtemp(join(worker, 'test', 'mcp-sdk-proof-'));
  for (const name of ['mcp-sdk-proof.test.js', 'mcp-sdk-oauth-proof.test.js']) {
    const source = await readFile(join(worker, 'scripts', 'mcp-sdk', `${name}.template`), 'utf8');
    const prepared = source.replace(/'__SDK_ESM__([^']+)'/g, (_, suffix) => JSON.stringify(join(sdk, 'dist', 'esm') + suffix)).replaceAll("'../src/", "'../../src/");
    await writeFile(join(tests, name), prepared);
  }
  run(['exec', 'vitest', 'run', tests], worker);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (tests) await rm(tests, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}

// Add or remove an explicitly trusted local ACP command in the installed
// gateway service configuration, then snapshot and restart its LaunchAgent.
// Usage:
//   node gateway/acp-config.mjs add <key> <absolute-command> <absolute-cwd> [--arg=value ...]
//   node gateway/acp-config.mjs remove <key>
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAcpAgents } from './acp.mjs';

const [action, key, command, cwd, ...flags] = process.argv.slice(2);
const configPath = join(homedir(), '.local/share/honmaru/gateway/service.json');
if (!['add', 'remove'].includes(action) || !key || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key)) {
  throw new Error('Usage: node gateway/acp-config.mjs add <key> <absolute-command> <absolute-cwd> [--arg=value ...] | remove <key>');
}
const info = await stat(configPath);
if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('Installed gateway config must be owned by this user and private (0600).');
const raw = await readFile(configPath, 'utf8');
const config = JSON.parse(raw);
const acpAgents = { ...(config.acpAgents || {}) };
if (action === 'add') {
  if (!command || !cwd || !isAbsolute(command) || !isAbsolute(cwd)) throw new Error('Command and working directory must be absolute paths.');
  const args = [];
  for (const flag of flags) {
    if (!flag.startsWith('--arg=')) throw new Error('Only --arg=value options are supported.');
    args.push(flag.slice('--arg='.length));
  }
  if (args.length > 40 || args.some(arg => arg.length > 1024)) throw new Error('Use at most 40 arguments, each no longer than 1024 characters.');
  await access(command, constants.X_OK);
  if (!(await stat(cwd)).isDirectory()) throw new Error('The working directory must be an existing directory.');
  acpAgents[key] = { command, args, cwd };
  validateAcpAgents(acpAgents);
} else {
  if (!Object.hasOwn(acpAgents, key)) throw new Error('No such local ACP agent key.');
  delete acpAgents[key];
}
validateAcpAgents(acpAgents);
config.acpAgents = acpAgents;
const temp = `${configPath}.${process.pid}.tmp`;
await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
await rename(temp, configPath);
try {
  execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'install-service.mjs'), configPath], { stdio: 'inherit' });
} catch {
  throw new Error('The local config was saved, but the service could not be reinstalled. Check the gateway service status before enabling this ACP agent.');
}
console.log(action === 'add' ? `Local ACP agent ${key} registered on this Mac.` : `Local ACP agent ${key} removed from this Mac.`);

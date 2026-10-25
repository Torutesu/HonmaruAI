// Usage: node gateway/install-service.mjs /absolute/path/to/config.json
// Config contains paths and API origin only. tokenFile must already exist.
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { servicePlist, SERVICE_LABEL } from './launchd.mjs';
import { installExecutable } from './install-executable.mjs';
import { copyServiceRuntime } from './install-runtime.mjs';
if (process.platform !== 'darwin') throw new Error('This installer requires macOS.');
const sourceConfig = resolve(process.argv[2] || '');
const config = JSON.parse(await readFile(sourceConfig, 'utf8'));
for (const field of ['tokenFile', 'containerBinary', 'containerInstallRoot', 'containerAppRoot']) {
  if (typeof config[field] !== 'string' || !config[field].startsWith('/')) throw new Error(`Missing absolute ${field}.`);
}
const tokenInfo = await stat(config.tokenFile);
if ((tokenInfo.mode & 0o077) || tokenInfo.uid !== process.getuid()) throw new Error('Token file permissions must be owner-only.');
const home = homedir(), directory = join(home, '.local/share/honmaru/gateway');
const runtime = join(directory, 'runtime');
await mkdir(runtime, { recursive: true, mode: 0o700 });
const configPath = join(directory, 'service.json');
const plistPath = join(home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
await mkdir(dirname(plistPath), { recursive: true });
// Stop the existing service before replacing its immutable runtime snapshot.
try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`], { stdio: 'ignore' }); } catch {}
const source = dirname(fileURLToPath(import.meta.url));
await copyServiceRuntime(source, runtime);
const node = join(runtime, 'node');
await installExecutable(process.execPath,node,async candidate=>{
  execFileSync('/usr/bin/codesign',['--verify','--strict',candidate],{stdio:'pipe'});
  execFileSync(candidate,['--version'],{stdio:'pipe',timeout:10000});
});
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
await writeFile(plistPath, servicePlist({ node, service: join(runtime, 'service.mjs'), config: configPath, directory, home }), { mode: 0o600 });
execFileSync('/usr/bin/plutil', ['-lint', plistPath], { stdio: 'inherit' });
execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'inherit' });
console.log('Honmaru node installed for automatic connection after user login.');

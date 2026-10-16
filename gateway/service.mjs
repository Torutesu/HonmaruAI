import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gatewayClient, serve } from './client.mjs';
const exec = promisify(execFile);
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const tokenStat = await stat(config.tokenFile);
if ((tokenStat.mode & 0o077) !== 0 || tokenStat.uid !== process.getuid()) throw new Error('Node token must be readable by its owner only.');
const token = (await readFile(config.tokenFile, 'utf8')).trim();
process.env.HONMARU_CONTAINER_BIN = config.containerBinary;
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
let checked = 0;
const ensureRuntime = async () => {
  if (Date.now() - checked < 30000) return;
  try { await exec(config.containerBinary, ['system', 'status'], { timeout: 10000 }); }
  catch {
    await exec(config.containerBinary, ['system', 'start', '--install-root', config.containerInstallRoot, '--app-root', config.containerAppRoot], { timeout: 30000 });
  }
  checked = Date.now();
};
console.log('Honmaru node service started. No inbound port.');
try {
  await serve(gatewayClient(config.apiUrl, token), { signal: stop.signal, beforeClaim: ensureRuntime,
    onError: status => console.error(`Node temporarily unavailable (${status}); reconnecting.`) });
} catch (error) {
  if ([401, 403].includes(error.status)) console.error('Node authorization ended. Re-register before restarting this service.');
  else { console.error('Node service failed.'); process.exitCode = 1; }
}

import {documentClient} from './document-client.mjs';
import { readFile, stat } from 'node:fs/promises';
import { ensureRuntime } from './runtime.mjs';
import { gatewayClient, serve } from './client.mjs';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const tokenStat = await stat(config.tokenFile);
if ((tokenStat.mode & 0o077) !== 0 || tokenStat.uid !== process.getuid()) throw new Error('Node token must be readable by its owner only.');
const token = (await readFile(config.tokenFile, 'utf8')).trim();
process.env.HONMARU_CONTAINER_BIN = config.containerBinary;
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
let checked = 0;
const beforeClaim = async () => {
  if (Date.now() - checked < 30000) return;
  await ensureRuntime(config);
  checked = Date.now();
};
console.log('Honmaru node service started. No inbound port.');
try {
  await serve(gatewayClient(config.apiUrl, token), { signal: stop.signal, beforeClaim,
    document: config.documentImage ? {image:config.documentImage,call:documentClient(config.apiUrl,token)} : null,
    acpAgents: config.acpAgents || {},
    onError: status => console.error(`Node temporarily unavailable (${status}); reconnecting.`) });
} catch (error) {
  if ([401, 403].includes(error.status)) console.error('Node authorization ended. Re-register before restarting this service.');
  else { console.error('Node service failed.'); process.exitCode = 1; }
}

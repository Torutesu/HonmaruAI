import {copyFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// All service dependencies must ship even when document conversion is disabled:
// client.mjs imports the optional document processor at module load time.
export const serviceModules = Object.freeze([
  'service.mjs', 'client.mjs', 'runner.mjs', 'runtime.mjs', 'acp.mjs', 'acp-mcp-bridge.mjs',
  'browser-session.mjs', 'browser-proxy.mjs',
  'workflow-runner.mjs', 'workflow-guest.mjs', 'workflow-bridge.mjs', 'workflow-sdk.mjs',
  'document-client.mjs', 'document-runner.mjs', 'document-converter.mjs',
]);
export async function copyServiceRuntime(source, destination) {
  for (const file of serviceModules) await copyFile(join(source,file),join(destination,file));
  const browserSource=join(source,'browser-image'),browserDestination=join(destination,'browser-image');
  await mkdir(browserDestination,{recursive:true,mode:0o700});
  for(const file of ['Dockerfile','package.json','package-lock.json','browser-entrypoint.sh','browser-proxy-server.mjs','browser-guest.mjs','browser-command.mjs'])
    await copyFile(join(browserSource,file),join(browserDestination,file));
}

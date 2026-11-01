import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';

// All service dependencies must ship even when document conversion is disabled:
// client.mjs imports the optional document processor at module load time.
export const serviceModules = Object.freeze([
  'service.mjs', 'client.mjs', 'runner.mjs', 'runtime.mjs', 'acp.mjs',
  'workflow-runner.mjs', 'workflow-guest.mjs', 'workflow-bridge.mjs',
  'document-client.mjs', 'document-runner.mjs', 'document-converter.mjs',
]);
export async function copyServiceRuntime(source, destination) {
  for (const file of serviceModules) await copyFile(join(source,file),join(destination,file));
}

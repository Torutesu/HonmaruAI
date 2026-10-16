import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function ensureRuntime(config, run = exec) {
  let running = false;
  try {
    const { stdout } = await run(config.containerBinary, ['system', 'status'], { timeout: 10000 });
    // Apple container returns exit 0 even when its API server is stopped.
    running = /^status\s+running\s*$/m.test(stdout);
  } catch {}
  if (!running) await run(config.containerBinary, ['system', 'start', '--install-root', config.containerInstallRoot, '--app-root', config.containerAppRoot], { timeout: 30000 });
}

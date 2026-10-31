import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const gatewayEntry = fileURLToPath(new URL("../../../gateway/cli.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function runGatewayForeground({ env = process.env, spawnProcess = spawn, executable = process.execPath } = {}) {
  if (!String(env.HONMARU_API_URL || "").trim()) throw new Error("Set HONMARU_API_URL to your Honmaru API origin.");
  if (!String(env.HONMARU_GATEWAY_TOKEN || "").trim()) throw new Error("Set HONMARU_GATEWAY_TOKEN to the node token created for this machine.");

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, [gatewayEntry], {
        cwd: repositoryRoot,
        env,
        stdio: "inherit",
      });
    } catch {
      reject(new Error("Could not start the local gateway process."));
      return;
    }

    child.once("error", () => reject(new Error("Could not start the local gateway process.")));
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

const gatewayEntry = fileURLToPath(new URL("../../../gateway/cli.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SERVICE_LABEL = "com.honmaru.gateway";

function launchctlPrint(args) {
  return new Promise((resolve, reject) => {
    execFile("/bin/launchctl", args, { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function getGatewayStatus({
  platform = process.platform,
  uid = process.getuid?.(),
  home = homedir(),
  accessPath = access,
  printLaunchctl = launchctlPrint,
} = {}) {
  if (platform !== "darwin" || !Number.isInteger(uid)) {
    return { supported: false, installed: false, loaded: false, state: "unsupported" };
  }

  const plist = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  let installed = true;
  try { await accessPath(plist); }
  catch { installed = false; }
  if (!installed) return { supported: true, installed: false, loaded: false, state: "not-installed" };

  let output;
  try { output = await printLaunchctl(["print", `gui/${uid}/${SERVICE_LABEL}`]); }
  catch { return { supported: true, installed: true, loaded: false, state: "stopped" }; }

  const state = output.match(/^\s*state\s*=\s*([^\r\n]+)/m)?.[1]?.trim() || "loaded";
  const pid = Number(output.match(/^\s*pid\s*=\s*(\d+)/m)?.[1] || 0);
  const runs = Number(output.match(/^\s*runs\s*=\s*(\d+)/m)?.[1] || 0);
  const lastExitCode = output.match(/^\s*last exit code\s*=\s*(-?\d+)/m)?.[1];
  return {
    supported: true,
    installed: true,
    loaded: true,
    state,
    running: state === "running" && pid > 0,
    pid: pid || null,
    runs,
    ...(lastExitCode === undefined ? {} : { lastExitCode: Number(lastExitCode) }),
  };
}

export function formatGatewayStatus(status, { json = false } = {}) {
  if (json) return JSON.stringify(status, null, 2);
  if (!status.supported) return "Gateway service status is available only on macOS.";
  if (!status.installed) return "Honmaru gateway LaunchAgent is not installed.";
  if (!status.loaded) return "Honmaru gateway LaunchAgent is installed but not loaded.";
  const processState = status.running ? `running (PID ${status.pid})` : status.state;
  const exit = status.lastExitCode === undefined ? "" : `; last exit ${status.lastExitCode}`;
  return `Honmaru gateway LaunchAgent: ${processState}; ${status.runs} starts${exit}.`;
}

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

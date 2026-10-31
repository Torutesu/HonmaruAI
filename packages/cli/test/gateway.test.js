import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { formatGatewayStatus, getGatewayStatus, runGatewayForeground } from "../src/gateway.js";

const token = `hgw_${"a".repeat(72)}`;

test("foreground gateway starts the existing local poller without putting its token in argv", async () => {
  const child = new EventEmitter();
  let observed;
  const result = runGatewayForeground({
    env: { HONMARU_API_URL: "https://api.example.com", HONMARU_GATEWAY_TOKEN: token },
    executable: "/usr/bin/node",
    spawnProcess: (executable, args, options) => {
      observed = { executable, args, options };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.equal(await result, 0);
  assert.equal(observed.executable, "/usr/bin/node");
  assert.equal(observed.args.length, 1);
  assert.match(observed.args[0], /\/gateway\/cli\.mjs$/);
  assert.equal(observed.args.includes(token), false);
  assert.equal(observed.options.env.HONMARU_GATEWAY_TOKEN, token);
  assert.equal(observed.options.stdio, "inherit");
});

test("foreground gateway requires its own node token and API origin", async () => {
  let spawns = 0;
  const spawnProcess = () => { spawns += 1; throw new Error("must not start"); };
  assert.throws(() => runGatewayForeground({ env: {}, spawnProcess }), /HONMARU_API_URL/);
  assert.throws(() => runGatewayForeground({ env: { HONMARU_API_URL: "https://api.example.com" }, spawnProcess }), /HONMARU_GATEWAY_TOKEN/);
  assert.equal(spawns, 0);
});

test("foreground gateway reports Ctrl+C as a conventional interrupted exit", async () => {
  const child = new EventEmitter();
  const result = runGatewayForeground({
    env: { HONMARU_API_URL: "https://api.example.com", HONMARU_GATEWAY_TOKEN: token },
    spawnProcess: () => { queueMicrotask(() => child.emit("close", null, "SIGINT")); return child; },
  });
  assert.equal(await result, 130);
});

test("gateway status reports an installed running LaunchAgent without exposing config or credentials", async () => {
  let inspectedPath;
  let launchctlArgs;
  const status = await getGatewayStatus({
    platform: "darwin",
    uid: 501,
    home: "/Users/alice",
    accessPath: async (path) => { inspectedPath = path; },
    printLaunchctl: async (args) => {
      launchctlArgs = args;
      return "state = running\npid = 9234\nruns = 3\nlast exit code = 0\n";
    },
  });
  assert.equal(inspectedPath, "/Users/alice/Library/LaunchAgents/com.honmaru.gateway.plist");
  assert.deepEqual(launchctlArgs, ["print", "gui/501/com.honmaru.gateway"]);
  assert.deepEqual(status, { supported: true, installed: true, loaded: true, state: "running", running: true, pid: 9234, runs: 3, lastExitCode: 0 });
  assert.equal(formatGatewayStatus(status), "Honmaru gateway LaunchAgent: running (PID 9234); 3 starts; last exit 0.");
  assert.equal(formatGatewayStatus(status, { json: true }).includes(token), false);
});

test("gateway status distinguishes unsupported, absent and stopped LaunchAgents", async () => {
  let launches = 0;
  const shared = { uid: 501, home: "/Users/alice", printLaunchctl: async () => { launches += 1; throw new Error("sensitive launchctl output"); } };
  assert.deepEqual(await getGatewayStatus({ ...shared, platform: "linux" }), { supported: false, installed: false, loaded: false, state: "unsupported" });
  assert.deepEqual(await getGatewayStatus({ ...shared, platform: "darwin", accessPath: async () => { throw new Error("missing"); } }), { supported: true, installed: false, loaded: false, state: "not-installed" });
  assert.deepEqual(await getGatewayStatus({ ...shared, platform: "darwin", accessPath: async () => {} }), { supported: true, installed: true, loaded: false, state: "stopped" });
  assert.equal(launches, 1);
  assert.equal(formatGatewayStatus({ supported: true, installed: false, loaded: false, state: "not-installed" }), "Honmaru gateway LaunchAgent is not installed.");
  const retrying = await getGatewayStatus({
    platform: "darwin", uid: 501, home: "/Users/alice", accessPath: async () => {},
    printLaunchctl: async () => "state = spawn scheduled\npid = 0\nruns = 72\n",
  });
  assert.equal(retrying.state, "spawn scheduled");
  assert.equal(retrying.running, false);
  assert.equal(formatGatewayStatus(retrying), "Honmaru gateway LaunchAgent: spawn scheduled; 72 starts.");
});

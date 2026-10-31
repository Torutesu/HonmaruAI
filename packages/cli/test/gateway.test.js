import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runGatewayForeground } from "../src/gateway.js";

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

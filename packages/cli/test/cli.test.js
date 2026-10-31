import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";

function output() {
  let text = "";
  return { stream: { write: (value) => { text += value; } }, read: () => text };
}

const token = `hm_${"b".repeat(64)}`;

test("workspace tools prints JSON for automation and readable names for people", async () => {
  const tools = [{ name: "list_apps", title: "Apps visible to this token" }];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const code = await runCli(["workspace", "tools", "--json"], {
    env: { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token },
    fetcher, stdout: stdout.stream, stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), { tools });
  assert.equal(stderr.read(), "");
});

test("workspace call sends JSON arguments and returns the MCP result", async () => {
  let body;
  const fetcher = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { cardId: "card_1" } } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const code = await runCli(["workspace", "call", "request_decision", "--args", "{\"title\":\"Ship?\"}"], {
    env: { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token },
    fetcher, stdout: stdout.stream, stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.deepEqual(body.params, { name: "request_decision", arguments: { title: "Ship?" } });
  assert.deepEqual(JSON.parse(stdout.read()), { structuredContent: { cardId: "card_1" } });
  assert.equal(stderr.read(), "");
});

test("the command fails closed on malformed args and unknown flags", async () => {
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  assert.equal(await runCli(["workspace", "call", "request_decision", "--args", "[]"], { env, stdout: stdout.stream, stderr: stderr.stream }), 1);
  assert.match(stderr.read(), /arguments must be a JSON object/);
  assert.equal(await runCli(["workspace", "tools", "--force"], { env, stdout: stdout.stream, stderr: stderr.stream }), 1);
  assert.match(stderr.read(), /Unknown option/);
});

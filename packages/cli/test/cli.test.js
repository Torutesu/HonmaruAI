import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";

function output() {
  let text = "";
  return { stream: { write: (value) => { text += value; } }, read: () => text, clear: () => { text = ""; } };
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

test("gateway status supports JSON without requiring workspace credentials", async () => {
  const stdout = output();
  const stderr = output();
  const status = { supported: true, installed: true, loaded: true, state: "running", running: true, pid: 12, runs: 1 };
  const code = await runCli(["gateway", "status", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    gatewayStatusReader: async () => status,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), status);
  assert.equal(stderr.read(), "");
});

test("gateway status rejects unsupported flags", async () => {
  const stdout = output();
  const stderr = output();
  const code = await runCli(["gateway", "status", "--force"], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(code, 2);
  assert.match(stderr.read(), /honmaru gateway status/);
});

test("execution aliases list nodes, queue isolated JavaScript, read results, and cancel jobs", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    const structuredContent = req.params.name === "list_execution_nodes"
      ? { gateways: [{ id: "gw_1", name: "Mac mini", lastSeenAt: "2026-10-31T00:00:00.000Z" }] }
      : { job: { id: "job_1", status: req.params.name === "cancel_execution" ? "cancelled" : "queued" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "execution", "node", "list"]), 0);
  assert.match(stdout.read(), /^gw_1\tMac mini/);
  stdout.clear();
  assert.equal(await run(["workspace", "execution", "run", "--gateway-id", "gw_1", "--request-id", "run-1", "--code", "return input.value + 1;", "--input", "{\"value\":41}"]), 0);
  assert.match(stdout.read(), /Execution job_1: queued/);
  stdout.clear();
  assert.equal(await run(["workspace", "execution", "read", "job_1", "--json"]), 0);
  assert.deepEqual(JSON.parse(stdout.read()), { job: { id: "job_1", status: "queued" } });
  stdout.clear();
  assert.equal(await run(["workspace", "execution", "cancel", "job_1"]), 0);
  assert.match(stdout.read(), /Execution job_1: cancelled/);
  assert.deepEqual(calls, [
    { name: "list_execution_nodes", arguments: {} },
    { name: "run_javascript", arguments: { gatewayId: "gw_1", requestId: "run-1", code: "return input.value + 1;", input: { value: 41 } } },
    { name: "get_execution", arguments: { jobId: "job_1" } },
    { name: "cancel_execution", arguments: { jobId: "job_1" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("execution run validates its idempotency key and JSON before making a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("must not call the server"); };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  const base = ["workspace", "execution", "run", "--gateway-id", "gw_1", "--request-id", "bad/id", "--code", "return 1;", "--input", "null"];
  assert.equal(await run(base), 1);
  assert.match(stderr.read(), /request-id/);
  assert.equal(await run([...base.slice(0, 6), "valid-id", ...base.slice(7, 10), "not-json"]), 1);
  assert.match(stderr.read(), /valid JSON/);
  assert.equal(requests, 0);
});

test("app action aliases list published actions, run a pinned version, and read its scoped result", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    const structuredContent = req.params.name === "list_app_actions"
      ? { apps: [{ id: "app_1", name: "Invoices", actions: [{ name: "recalculate", publishedVersion: 4 }] }] }
      : req.params.name === "run_app_action"
        ? { job: { id: "job_2", status: "queued" } }
        : { job: { id: "job_2", status: "succeeded", result: { total: 42 } } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "app", "action", "list", "app_1"]), 0);
  assert.equal(stdout.read(), "app_1\tInvoices\trecalculate\tv4\n");
  stdout.clear();
  assert.equal(await run(["workspace", "app", "action", "run", "app_1", "recalculate", "--version", "4", "--gateway-id", "gw_1", "--request-id", "app-run-1", "--input", "{\"invoiceId\":\"inv_9\"}"]), 0);
  assert.match(stdout.read(), /App action job_2: queued/);
  assert.match(stdout.read(), /app action read app_1 job_2/);
  stdout.clear();
  assert.equal(await run(["workspace", "app", "action", "read", "app_1", "job_2", "--json"]), 0);
  assert.deepEqual(JSON.parse(stdout.read()), { job: { id: "job_2", status: "succeeded", result: { total: 42 } } });
  assert.deepEqual(calls, [
    { name: "list_app_actions", arguments: { appId: "app_1" } },
    { name: "run_app_action", arguments: { appId: "app_1", name: "recalculate", version: 4, gatewayId: "gw_1", requestId: "app-run-1", input: { invoiceId: "inv_9" } } },
    { name: "get_app_execution", arguments: { appId: "app_1", jobId: "job_2" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("resource aliases map to the scoped app and database tools", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    let structuredContent;
    if (req.params.name === "list_apps") structuredContent = { apps: [{ id: "app_1", name: "Pipeline", tableId: "table_1" }] };
    else if (req.params.name === "list_tables") structuredContent = { tables: [{ id: "table_1", name: "Pipeline", columns: [{ name: "Status" }] }] };
    else structuredContent = { rows: [{ id: "row_1", Status: "Open" }], total: 1 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  assert.equal(await runCli(["workspace", "app", "list"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stdout.read(), "app_1\tPipeline\ttable_1\n");
  assert.equal(await runCli(["workspace", "table", "list"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(await runCli(["workspace", "row", "list", "table_1", "--where", "{\"Status\":\"Open\"}", "--limit", "25", "--offset", "50"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(await runCli(["workspace", "row", "create", "table_1", "--values", "{\"Status\":\"Open\"}"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.deepEqual(calls, [
    { name: "list_apps", arguments: {} },
    { name: "list_tables", arguments: {} },
    { name: "query_rows", arguments: { tableId: "table_1", where: { Status: "Open" }, limit: 25, offset: 50 } },
    { name: "add_row", arguments: { tableId: "table_1", values: { Status: "Open" } } },
  ]);
  assert.equal(stderr.read(), "");
});

test("resource aliases preserve row compare-and-set inputs and file version scope", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { ok: true } } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  assert.equal(await runCli(["workspace", "row", "update", "table_1", "row_1", "--values", "{\"Status\":\"Done\"}", "--expected-updated-at", "2026-10-31T00:00:00.000Z"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(await runCli(["workspace", "file", "read", "file_1", "--version", "3"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.deepEqual(calls, [
    { name: "update_row", arguments: { tableId: "table_1", rowId: "row_1", values: { Status: "Done" }, expectedUpdatedAt: "2026-10-31T00:00:00.000Z" } },
    { name: "read_file_text", arguments: { fileId: "file_1", version: 3 } },
  ]);
  assert.equal(stderr.read(), "");
});

test("workflow, follow-up, and file aliases keep explicit scopes and typed values", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { ok: true } } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "run", "wf_1", "--text", "Check the release"]), 0);
  assert.equal(await run(["workspace", "followup", "list", "--room", "b:ops"]), 0);
  assert.equal(await run(["workspace", "followup", "schedule", "--room", "b:ops", "--instruction", "Check deployment", "--minutes", "1.5"]), 0);
  assert.equal(await run(["workspace", "file", "list", "--scope", "all", "--query", "release notes", "--origin", "agent", "--limit", "10"]), 0);
  assert.deepEqual(calls, [
    { name: "run_workflow", arguments: { workflowId: "wf_1", text: "Check the release" } },
    { name: "list_followups", arguments: { channel: "b:ops" } },
    { name: "schedule_followup", arguments: { channel: "b:ops", instruction: "Check deployment", minutes: 1.5 } },
    { name: "list_workspace_files", arguments: { scope: "all", query: "release notes", origin: "agent", limit: 10 } },
  ]);
  assert.equal(stderr.read(), "");
});

test("resource aliases reject malformed JSON and unsupported command flags before making a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  assert.equal(await runCli(["workspace", "row", "create", "table_1", "--values", "[]"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 1);
  assert.match(stderr.read(), /--values must be a JSON object/);
  assert.equal(await runCli(["workspace", "app", "list", "--force"], { env, fetcher, stdout: stdout.stream, stderr: stderr.stream }), 1);
  assert.match(stderr.read(), /Unknown option/);
  assert.equal(requests, 0);
});

test("simple workspace aliases expose members, playbook, and scoped decision tools", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    const structuredContent = req.params.name === "list_members"
      ? { members: [{ name: "Aiko", title: "Owner" }] }
      : req.params.name === "get_playbook"
        ? { rules: ["Ask before publishing."] }
        : req.params.name === "list_pending"
          ? { decisions: [{ cardId: "card_1", status: "pending", title: "Ship release?" }] }
          : { cardId: "card_2", status: "pending", title: "Approve deploy?" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(await run(["workspace", "member", "list"]), 0);
  assert.equal(stdout.read(), "Aiko\tOwner\n");
  assert.equal(await run(["workspace", "playbook", "read"]), 0);
  assert.match(stdout.read(), /Ask before publishing/);
  assert.equal(await run(["workspace", "decision", "pending", "--direction", "sent"]), 0);
  assert.match(stdout.read(), /card_1\tpending\tShip release\?/);
  assert.equal(await run(["workspace", "decision", "read", "card_2"]), 0);
  assert.equal(await run(["workspace", "decision", "search", "release launch"]), 0);
  assert.equal(await run(["workspace", "decision", "request", "--title", "Approve deploy?", "--to", "Aiko", "--priority", "high", "--summary", "The checks passed."]), 0);
  assert.deepEqual(calls, [
    { name: "list_members", arguments: {} },
    { name: "get_playbook", arguments: {} },
    { name: "list_pending", arguments: { direction: "sent" } },
    { name: "get_decision", arguments: { cardId: "card_2" } },
    { name: "search_decisions", arguments: { query: "release launch" } },
    { name: "request_decision", arguments: { title: "Approve deploy?", to: "Aiko", summary: "The checks passed.", priority: "high" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("decision aliases reject invalid or oversized input before making a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(await run(["workspace", "decision", "pending", "--direction", "other"]), 1);
  assert.match(stderr.read(), /--direction must be mine or sent/);
  assert.equal(await run(["workspace", "decision", "request", "--priority", "high"]), 1);
  assert.match(stderr.read(), /--title is required/);
  assert.equal(await run(["workspace", "decision", "request", "--title", "x".repeat(121)]), 1);
  assert.match(stderr.read(), /120 characters or fewer/);
  assert.equal(await run(["workspace", "decision", "request", "--title", "Ship?", "--priority", "whenever"]), 1);
  assert.match(stderr.read(), /--priority must be/);
  assert.equal(requests, 0);
});

test("gateway run delegates to the installed execution node runtime and exposes help", async () => {
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_GATEWAY_TOKEN: "hgw_node_secret" };
  let received;
  const gatewayRunner = async (options) => { received = options; return 130; };

  assert.equal(await runCli(["gateway", "run"], { env, stdout: stdout.stream, stderr: stderr.stream, gatewayRunner }), 130);
  assert.deepEqual(received, { env });
  assert.equal(stderr.read(), "");
  assert.equal(await runCli(["gateway", "run", "--force"], { env, stdout: stdout.stream, stderr: stderr.stream, gatewayRunner }), 2);
  assert.match(stderr.read(), /Usage: honmaru gateway run/);
  assert.equal(await runCli(["gateway", "run", "--help"], { env, stdout: stdout.stream, stderr: stderr.stream, gatewayRunner }), 0);
  assert.match(stdout.read(), /HONMARU_GATEWAY_TOKEN/);
});

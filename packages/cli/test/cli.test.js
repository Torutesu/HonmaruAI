import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

test("file lifecycle aliases expose folders, versions, version-fenced writes, delete and restore", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    const name = req.params.name;
    const structuredContent = name === "list_workspace_folders"
      ? { folders: [{ name: "reports", path: "reports/" }], next: null }
      : name === "list_file_versions"
        ? { versions: [{ version: 2, contentType: "text/markdown", size: 18, createdAt: "2026-11-10T00:00:00.000Z", isCurrent: true, purged: false }] }
        : name === "read_file_text"
          ? { fileId: "file_1", version: 2, contentType: "text/markdown", size: 18, text: "# Current", untrustedContent: true }
      : name === "delete_file"
        ? { fileId: "file_1", version: 3, deleted: true }
        : name === "restore_file_version"
          ? { fileId: "file_1", version: 4, restoredFrom: 2, saved: true }
          : name === "create_file_text"
            ? { fileId: req.params.arguments.requestId, version: 1, saved: true }
            : { fileId: "file_1", version: 3, saved: true };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "folders", "list", "--scope", "b:ops", "--directory", "reports"]), 0);
  assert.equal(stdout.read(), "reports/\n"); stdout.clear();
  assert.equal(await run(["workspace", "file", "versions", "file_1", "--before", "4", "--limit", "10"]), 0);
  assert.match(stdout.read(), /^v2\tcurrent\ttext\/markdown\t18 bytes/); stdout.clear();
  assert.equal(await run(["workspace", "file", "read", "file_1", "--version", "2"]), 0);
  assert.equal(stdout.read(), "# Current\n"); stdout.clear();
  assert.equal(await run(["workspace", "file", "create", "--scope", "b:ops", "--path", "notes/today.md", "--request-id", "file-123e4567-e89b-12d3-a456-426614174000", "--text", "# Daily", "--content-type", "text/markdown"]), 0);
  assert.match(stdout.read(), /Created file file-123e4567-e89b-12d3-a456-426614174000 as version 1/); stdout.clear();
  assert.equal(await run(["workspace", "file", "update", "file_1", "--expected-version", "2", "--text", "# Revised"]), 0);
  assert.match(stdout.read(), /Saved file file_1 as version 3/);
  stdout.clear();
  assert.equal(await run(["workspace", "file", "delete", "file_1", "--expected-version", "2"]), 0);
  assert.match(stdout.read(), /Deleted file file_1 as version 3/); stdout.clear();
  assert.equal(await run(["workspace", "file", "revert", "file_1", "--version", "2", "--expected-version", "3"]), 0);
  assert.match(stdout.read(), /Restored file file_1 from version 2 as version 4/);
  assert.equal(await run(["workspace", "file", "revert", "file_1", "--version", "4", "--expected-version", "3"]), 1);
  assert.match(stderr.read(), /--version must not be newer/); stderr.clear();
  assert.deepEqual(calls, [
    { name: "list_workspace_folders", arguments: { scope: "b:ops", directory: "reports" } },
    { name: "list_file_versions", arguments: { fileId: "file_1", before: 4, limit: 10 } },
    { name: "read_file_text", arguments: { fileId: "file_1", version: 2 } },
    { name: "create_file_text", arguments: { scope: "b:ops", path: "notes/today.md", requestId: "file-123e4567-e89b-12d3-a456-426614174000", text: "# Daily", contentType: "text/markdown" } },
    { name: "update_file_text", arguments: { fileId: "file_1", expectedVersion: 2, text: "# Revised" } },
    { name: "delete_file", arguments: { fileId: "file_1", expectedVersion: 2 } },
    { name: "restore_file_version", arguments: { fileId: "file_1", version: 2, expectedVersion: 3 } },
  ]);
  assert.equal(stderr.read(), "");
});

test("room, message and thread aliases use scoped MCP tools with explicit paging and idempotency", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    const name = req.params.name;
    const structuredContent = name === "list_conversations"
      ? { conversations: [{ id: "b:ops", name: "Operations", type: "channel", private: false }], nextCursor: null }
      : name === "create_conversation"
        ? { conversation: { id: "b:launch", name: "Launch", type: "channel", private: true }, created: true }
        : name === "send_message"
          ? { message: { id: "msg_1", body: "Deploy complete" }, replayed: false }
          : name === "search_messages"
            ? { messages: [{ id: "msg_1", body: "Deploy complete" }], nextCursor: null }
            : name === "get_message"
              ? { message: { id: "msg_1", body: "Deploy complete" } }
              : name === "edit_message"
                ? { conversationId: "b:ops", message: { id: "msg_1", body: "Updated text", contentVersion: 4 } }
                : name === "delete_message"
                  ? { conversationId: "b:ops", message: { id: "msg_2", contentVersion: 2 }, deletedReplyIds: ["msg_3"] }
              : name === "read_channel"
                ? { messages: [{ id: "msg_1", body: "Deploy complete" }], nextCursor: null }
                : { parent: { id: "root_1" }, replies: [{ id: "msg_2" }], nextCursor: null };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "list", "--query", "ops", "--type", "channel", "--limit", "20"]), 0);
  assert.equal(stdout.read(), "b:ops\tchannel\tOperations\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "create", "--name", "Launch", "--scope", "private", "--request-id", "create-launch-01", "--members", "user_a,user_b,user_a"]), 0);
  assert.match(stdout.read(), /Created channel b:launch \(Launch\)/); stdout.clear();
  assert.equal(await run(["workspace", "room", "read", "b:ops", "--limit", "15", "--cursor", "opaque-cursor"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "message", "search", "deploy status", "--limit", "10"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "message", "get", "msg_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "message", "edit", "b:ops", "msg_1", "--body", "Updated text", "--version", "3", "--acknowledge-dlp"]), 0);
  assert.match(stdout.read(), /Edited message msg_1 \(version 4\)/); stdout.clear();
  assert.equal(await run(["workspace", "message", "delete", "b:ops", "msg_2", "--version", "1", "--with-replies"]), 0);
  assert.match(stdout.read(), /Deleted message msg_2 and 1 thread replies/); stdout.clear();
  assert.equal(await run(["workspace", "message", "send", "--room", "b:ops", "--text", "Deploy complete", "--request-id", "send-deploy-01", "--reply-to", "msg_0", "--file-ids", "file_1,file_2,file_1"]), 0);
  assert.equal(stdout.read(), "Sent message msg_1.\n"); stdout.clear();
  assert.equal(await run(["workspace", "thread", "get", "b:ops", "root_1", "--limit", "25"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "thread", "msg", "b:ops", "root_1", "--text", "Follow-up", "--request-id", "thread-reply-01"]), 0);
  assert.equal(await run(["workspace", "thread", "rename", "b:ops", "root_1", "--title", "Roadmap", "--version", "2"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "thread", "mute", "b:ops", "root_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "thread", "pin", "b:ops", "root_1"]), 0);
  assert.deepEqual(calls, [
    { name: "list_conversations", arguments: { query: "ops", type: "channel", limit: 20 } },
    { name: "create_conversation", arguments: { type: "channel", name: "Launch", private: true, memberRefs: ["user_a", "user_b"], requestId: "create-launch-01" } },
    { name: "read_channel", arguments: { conversationId: "b:ops", limit: 15, cursor: "opaque-cursor" } },
    { name: "search_messages", arguments: { query: "deploy status", limit: 10 } },
    { name: "get_message", arguments: { messageId: "msg_1" } },
    { name: "edit_message", arguments: { conversationId: "b:ops", messageId: "msg_1", expectedContentVersion: 3, body: "Updated text", acknowledgeDlp: true } },
    { name: "delete_message", arguments: { conversationId: "b:ops", messageId: "msg_2", expectedContentVersion: 1, withThread: true } },
    { name: "send_message", arguments: { conversationId: "b:ops", body: "Deploy complete", requestId: "send-deploy-01", replyToMessageId: "msg_0", fileIds: ["file_1", "file_2"] } },
    { name: "read_thread", arguments: { conversationId: "b:ops", threadId: "root_1", limit: 25 } },
    { name: "send_message", arguments: { conversationId: "b:ops", threadId: "root_1", body: "Follow-up", requestId: "thread-reply-01" } },
    { name: "rename_thread", arguments: { conversationId: "b:ops", threadId: "root_1", title: "Roadmap", version: 2 } },
    { name: "set_thread_muted", arguments: { conversationId: "b:ops", threadId: "root_1", muted: true } },
    { name: "set_thread_pin", arguments: { conversationId: "b:ops", threadId: "root_1", pinned: true } },
  ]);
  assert.equal(stderr.read(), "");
});

test("room/message aliases reject malformed writes and page limits before making requests", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "create", "--name", "Secret", "--scope", "private", "--request-id", "short"]), 1);
  assert.match(stderr.read(), /request-id must be 8 to 100/); stderr.clear();
  assert.equal(await run(["workspace", "room", "create", "--name", "Secret", "--scope", "hidden", "--request-id", "valid-request"]), 1);
  assert.match(stderr.read(), /scope must be public or private/); stderr.clear();
  assert.equal(await run(["workspace", "message", "send", "--room", "b:ops", "--text", "hi", "--request-id", "bad/id"]), 1);
  assert.match(stderr.read(), /request-id must be 8 to 100/); stderr.clear();
  assert.equal(await run(["workspace", "thread", "get", "b:ops", "root_1", "--limit", "51"]), 1);
  assert.match(stderr.read(), /must be an integer from 1 to 50/);
  assert.equal(requests, 0);
});

test("message lifecycle aliases require version fences and explicit thread deletion choice", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "message", "edit", "b:ops", "msg_1", "--body", "updated"]), 1);
  assert.match(stderr.read(), /--version is required/); stderr.clear();
  assert.equal(await run(["workspace", "message", "delete", "b:ops", "msg_1"]), 1);
  assert.match(stderr.read(), /--version is required/);
  assert.equal(requests, 0);
});

test("Room notification and sidebar order aliases send personal settings", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { muted: true, reordered: ["b:ops", "b:general"] } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "mute", "b:ops"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "room", "unmute", "b:ops"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "room", "reorder", "--rooms", "b:ops,b:general"]), 0);
  assert.deepEqual(calls, [
    { name: "set_room_muted", arguments: { conversationId: "b:ops", muted: true } },
    { name: "set_room_muted", arguments: { conversationId: "b:ops", muted: false } },
    { name: "reorder_rooms", arguments: { conversationIds: ["b:ops", "b:general"] } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room member aliases preserve opaque member refs and requested relations", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { members: [] } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "member", "list", "b:ops"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "room", "member", "add", "b:ops", "--members", "ref_a,ref_b", "--relation", "admin"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "room", "member", "remove", "b:ops", "--members", "ref_a"]), 0);
  assert.deepEqual(calls, [
    { name: "list_room_members", arguments: { conversationId: "b:ops" } },
    { name: "add_room_members", arguments: { conversationId: "b:ops", memberRefs: ["ref_a", "ref_b"], relation: "admin" } },
    { name: "remove_room_members", arguments: { conversationId: "b:ops", memberRefs: ["ref_a"] } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room member aliases reject duplicate refs and invalid relations before a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "member", "add", "b:ops", "--members", "ref_a,ref_a"]), 1);
  assert.match(stderr.read(), /duplicate references/); stderr.clear();
  assert.equal(await run(["workspace", "room", "member", "add", "b:ops", "--members", "ref_a", "--relation", "owner"]), 1);
  assert.match(stderr.read(), /relation must be admin or member/);
  assert.equal(requests, 0);
});

test("Room Agent aliases keep assignment separate from explicit Agent access grants", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { added: true, removed: true } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "agent", "add", "b:ops", "helper"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "room", "agent", "add", "b:ops", "helper", "--grant-access"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "room", "agent", "remove", "b:ops", "helper"]), 0);
  assert.deepEqual(calls, [
    { name: "add_room_agent", arguments: { conversationId: "b:ops", agentId: "helper" } },
    { name: "add_room_agent", arguments: { conversationId: "b:ops", agentId: "helper", grantAccess: true } },
    { name: "remove_room_agent", arguments: { conversationId: "b:ops", agentId: "helper" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room discovery and membership aliases pass bounded filters and explicit membership mutations", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    const structuredContent = req.params.name === "discover_public_rooms"
      ? { rooms: [{ channel: "b:planning", name: "Planning", joined: true, memberCount: 3 }], total: 1, limit: 10, offset: 20 }
      : req.params.name === "join_public_room" ? { joined: true, conversationId: "b:planning" } : { left: true, conversationId: "b:planning" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "discover", "--query", "plan", "--limit", "10", "--offset", "20", "--joined"]), 0);
  assert.equal(stdout.read(), "b:planning\tPlanning\tjoined\t3 members\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "join", "b:planning"]), 0);
  assert.equal(stdout.read(), "Joined public Room b:planning.\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "leave", "b:planning"]), 0);
  assert.equal(stdout.read(), "Left public Room b:planning.\n"); stdout.clear();
  assert.deepEqual(calls, [
    { name: "discover_public_rooms", arguments: { query: "plan", limit: 10, offset: 20, joined: true } },
    { name: "join_public_room", arguments: { conversationId: "b:planning" } },
    { name: "leave_public_room", arguments: { conversationId: "b:planning" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room rename, archive, restore and archived listing aliases map to scoped tools", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    const structuredContent = req.params.name === "rename_room" ? { conversationId: "b:ops", name: "Operations", version: 2 }
      : req.params.name === "archive_room" ? { conversationId: "b:ops", archived: true, version: 3 }
        : req.params.name === "unarchive_room" ? { conversationId: "b:ops", archived: false, version: 4 }
          : { rooms: [{ channel: "b:ops", name: "Operations", private: false, archivedAt: "2026-11-01T00:00:00.000Z" }], total: 1, limit: 10 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "rename", "b:ops", "--name", "Operations"]), 0);
  assert.equal(stdout.read(), "Renamed Room b:ops to Operations.\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "archive", "b:ops"]), 0);
  assert.equal(stdout.read(), "Archived Room b:ops.\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "unarchive", "b:ops"]), 0);
  assert.equal(stdout.read(), "Restored Room b:ops.\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "list", "--archived", "--query", "ops", "--limit", "10"]), 0);
  assert.equal(stdout.read(), "b:ops\tOperations\tarchived 2026-11-01T00:00:00.000Z\n");
  assert.deepEqual(calls, [
    { name: "rename_room", arguments: { conversationId: "b:ops", name: "Operations" } },
    { name: "archive_room", arguments: { conversationId: "b:ops" } },
    { name: "unarchive_room", arguments: { conversationId: "b:ops" } },
    { name: "list_archived_rooms", arguments: { query: "ops", limit: 10 } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room get/update aliases read managed settings and pass only requested fields", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    const structuredContent = req.params.name === "get_room_settings"
      ? { conversationId: "b:ops", settings: { name: "Operations", color: "teal", mentionedOnly: false, version: 2, responseVersion: 1 }, availableAgents: [] }
      : { conversationId: "b:ops", settings: { name: "Ops 2", color: "lake", mentionedOnly: true, defaultAgentId: null, version: 3, responseVersion: 2 } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "get", "b:ops"]), 0);
  assert.match(stdout.read(), /\"responseVersion\": 1/); stdout.clear();
  assert.equal(await run(["workspace", "room", "update", "b:ops", "--name", "Ops 2", "--mentioned-only", "true", "--main-agent", "auto", "--icon-color", "cyan"]), 0);
  assert.match(stdout.read(), /Updated Room b:ops settings \(version 3\)/);
  assert.deepEqual(calls, [
    { name: "get_room_settings", arguments: { conversationId: "b:ops" } },
    { name: "update_room_settings", arguments: { conversationId: "b:ops", name: "Ops 2", mentionedOnly: true, defaultAgentId: null, color: "lake" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room visibility alias uses explicit Harness scope and current version", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    const structuredContent = { conversationId: "b:ops", scope: req.params.arguments.scope, version: 4 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "visibility", "set", "b:ops", "--scope", "private", "--version", "3"]), 0);
  assert.deepEqual(calls, [{ name: "set_room_privacy", arguments: { conversationId: "b:ops", scope: "private", version: 3 } }]);
  assert.equal(stderr.read(), "");
});

test("Room visibility alias rejects invalid scope or missing version before MCP", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "visibility", "set", "b:ops", "--scope", "team", "--version", "3"]), 1);
  assert.match(stderr.read(), /--scope must be public or private/); stderr.clear();
  assert.equal(await run(["workspace", "room", "visibility", "set", "b:ops", "--scope", "public"]), 1);
  assert.match(stderr.read(), /--version is required/);
  assert.equal(requests, 0);
});

test("Room Agent access aliases inspect missing grants and grant only selected members", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    const structuredContent = req.params.name === "get_room_agent_access"
      ? { conversationId: "b:ops", agentId: "agent_1", canGrantAccess: true, missingAccessMembers: [{ memberRef: "member_1", name: "Ari" }, { memberRef: "member_2", name: "Bea" }] }
      : { conversationId: "b:ops", agentId: "agent_1", added: true, granted: 1, version: 5 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "agent", "access", "b:ops", "agent_1"]), 0);
  assert.equal(stdout.read(), "member_1\tAri\nmember_2\tBea\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "agent", "add", "b:ops", "agent_1", "--grant-access-members", "member_2", "--acknowledge-external-processing"]), 0);
  assert.match(stdout.read(), /selected Room members were granted Agent access/);
  assert.deepEqual(calls, [
    { name: "get_room_agent_access", arguments: { conversationId: "b:ops", agentId: "agent_1" } },
    { name: "add_room_agent", arguments: { conversationId: "b:ops", agentId: "agent_1", grantAccessMemberRefs: ["member_2"], acknowledgeExternalProcessing: true } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room Agent CLI rejects ambiguous or duplicated grants before MCP", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "agent", "add", "b:ops", "agent_1", "--grant-access", "--grant-access-members", "member_1"]), 1);
  assert.match(stderr.read(), /Choose either --grant-access or --grant-access-members/); stderr.clear();
  assert.equal(await run(["workspace", "room", "agent", "add", "b:ops", "agent_1", "--grant-access-members", "member_1,member_1"]), 1);
  assert.match(stderr.read(), /cannot contain duplicate references/);
  assert.equal(requests, 0);
});

test("Room guideline aliases read and update with explicit versioned text", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    const structuredContent = req.params.name === "get_room_guidelines"
      ? { conversationId: "b:ops", guidelines: { body: "", version: 0, updatedAt: null } }
      : { conversationId: "b:ops", guidelines: { body: req.params.arguments.body, version: 1, updatedAt: "2026-11-13T00:00:00.000Z" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "guidelines", "get", "b:ops"]), 0);
  assert.equal(stdout.read(), "\n"); stdout.clear();
  assert.equal(await run(["workspace", "room", "guidelines", "set", "b:ops", "--body", "Follow approval policy.\nKeep the source link.", "--version", "0"]), 0);
  assert.match(stdout.read(), /Updated Room b:ops guidelines \(version 1\)/);
  assert.deepEqual(calls, [
    { name: "get_room_guidelines", arguments: { conversationId: "b:ops" } },
    { name: "update_room_guidelines", arguments: { conversationId: "b:ops", body: "Follow approval policy.\nKeep the source link.", version: 0 } },
  ]);
  assert.equal(stderr.read(), "");
});

test("Room guideline update validates required version and body before calling MCP", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "guidelines", "set", "b:ops", "--body", "Rules"]), 1);
  assert.match(stderr.read(), /--version is required/); stderr.clear();
  assert.equal(await run(["workspace", "room", "guidelines", "set", "b:ops", "--version", "0"]), 1);
  assert.match(stderr.read(), /--body is required/);
  assert.equal(requests, 0);
});

test("Room update rejects empty settings and malformed flags before calling MCP", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "room", "update", "b:ops"]), 1);
  assert.match(stderr.read(), /at least one Room setting/); stderr.clear();
  assert.equal(await run(["workspace", "room", "update", "b:ops", "--mentioned-only", "sometimes"]), 1);
  assert.match(stderr.read(), /must be true or false/); stderr.clear();
  assert.equal(await run(["workspace", "room", "update", "b:ops", "--icon-color", "chartreuse"]), 1);
  assert.match(stderr.read(), /icon-color must be one of/);
  assert.equal(requests, 0);
});

test("reaction aliases use idempotent add and remove tools without toggling semantics", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { messageId: "msg_1", reactions: [] } } }), { status: 200 });
  };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "reaction", "get", "msg_1"]), 0);
  assert.equal(await run(["workspace", "reaction", "add", "msg_1", "--emoji", "✅"]), 0);
  assert.equal(await run(["workspace", "reaction", "remove", "msg_1", "--emoji", "✅"]), 0);
  assert.deepEqual(calls, [
    { name: "get_reactions", arguments: { messageId: "msg_1" } },
    { name: "add_reaction", arguments: { messageId: "msg_1", emoji: "✅" } },
    { name: "remove_reaction", arguments: { messageId: "msg_1", emoji: "✅" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("file lifecycle aliases reject unsafe or unsupported requests before calling the server", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output();
  const stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = (argv) => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "file", "create", "--scope", "b:ops", "--path", "x.bin", "--request-id", "bad", "--text", "x", "--content-type", "application/octet-stream"]), 1);
  assert.match(stderr.read(), /request-id must be file- followed by a UUID/); stderr.clear();
  assert.equal(await run(["workspace", "file", "update", "file_1", "--expected-version", "0", "--text", "x"]), 1);
  assert.match(stderr.read(), /must be an integer from 1/); stderr.clear();
  assert.equal(await run(["workspace", "folders", "list", "--scope", "all"]), 1);
  assert.match(stderr.read(), /choose one accessible Room/); stderr.clear();
  assert.equal(await run(["workspace", "file", "download", "file_1", "--output", "a", "--dir", "b"]), 1);
  assert.match(stderr.read(), /either --output or --dir/);
  assert.equal(requests, 0);
});

test("binary file upload streams bytes after a hash-bound reservation and download refuses overwrite by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honmaru-cli-files-"));
  try {
    const source = join(dir, "image.png"), target = join(dir, "download.png");
    const bytes = Buffer.from([0, 255, 13, 10, 42, 128]);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(source, bytes));
    const calls = [];
    const fetcher = async (url, init) => {
      if (url.pathname === "/mcp") {
        const req = JSON.parse(init.body); calls.push(req.params);
        const result = req.params.name === "create_file_upload"
          ? { structuredContent: { fileId: "file-123e4567-e89b-12d3-a456-426614174000", uploadId: "123e4567-e89b-12d3-a456-426614174001", uploadUrl: "/mcp/workspace-uploads/123e4567-e89b-12d3-a456-426614174001", method: "PUT", contentType: "image/png", size: bytes.length } }
          : req.params.name === "get_workspace_file"
            ? { structuredContent: { file: { id: "file_1", path: "assets/image.png", version: 3 } } }
            : { structuredContent: { versions: [{ version: 3, kind: "content", size: bytes.length, purged: false }, { version: 2, kind: "content", size: bytes.length, purged: false }] } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
      }
      calls.push({ transfer: url.pathname, method: init.method, headers: init.headers, ...(init.body ? { bytes: Buffer.from(init.body) } : {}) });
      if (init.method === "PUT") return new Response(JSON.stringify({ fileId: "file-123e4567-e89b-12d3-a456-426614174000", version: 1, saved: true }), { status: 200 });
      return new Response(bytes, { status: 200 });
    };
    const stdout = output(), stderr = output();
    const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
    const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
    assert.equal(await run(["workspace", "file", "upload", "--scope", "workspace", "--path", "assets/image.png", "--source", source, "--request-id", "file-123e4567-e89b-12d3-a456-426614174000"]), 0);
    assert.deepEqual(calls[0], { name: "create_file_upload", arguments: {
      scope: "workspace", path: "assets/image.png", requestId: "file-123e4567-e89b-12d3-a456-426614174000", contentType: "image/png",
      size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    } });
    assert.equal(calls[1].transfer, "/mcp/workspace-uploads/123e4567-e89b-12d3-a456-426614174001");
    assert.equal(calls[1].headers.authorization, `Bearer ${token}`);
    assert.deepEqual(calls[1].bytes, bytes);

    const firstDownload = await run(["workspace", "file", "download", "file_1", "--output", target]);
    assert.equal(firstDownload, 0, stderr.read());
    assert.deepEqual(await readFile(target), bytes);
    assert.equal(await run(["workspace", "file", "download", "file_1", "--output", target]), 1);
    assert.match(stderr.read(), /already exists/);
    assert.equal(await run(["workspace", "file", "download", "file_1", "--output", target, "--force", "--version", "2"]), 0);
    assert.equal(calls.at(-1).transfer, "/mcp/workspace-files/file_1/versions/2/content");
    assert.equal(stderr.read().includes("invalid"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("file copy preserves an exact readable binary version into a destination scope", async () => {
  const calls = [];
  const bytes = Buffer.from([0, 255, 13, 10, 42, 128]);
  const fetcher = async (url, init) => {
    if (url.pathname === "/mcp") {
      const req = JSON.parse(init.body); calls.push(req.params);
      const name = req.params.name;
      const structuredContent = name === "get_workspace_file"
        ? { file: { id: "file_source", path: "reports/source.bin", version: 3 } }
        : name === "list_file_versions"
          ? { versions: [{ version: 3, kind: "content", contentType: "application/octet-stream", size: bytes.length, purged: false }, { version: 2, kind: "content", contentType: "application/octet-stream", size: 4, purged: false }] }
          : { fileId: "file-123e4567-e89b-12d3-a456-426614174000", uploadId: "123e4567-e89b-12d3-a456-426614174001", uploadUrl: "/mcp/workspace-uploads/123e4567-e89b-12d3-a456-426614174001", method: "PUT", contentType: "application/octet-stream", size: bytes.length };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
    }
    if (url.pathname === "/mcp/workspace-files/file_source/versions/2/content") return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 });
    if (url.pathname === "/mcp/workspace-files/file_source/versions/3/content") return new Response(bytes, { status: 200 });
    calls.push({ transfer: url.pathname, method: init.method, contentType: init.headers["content-type"], bytes: Buffer.from(init.body) });
    return new Response(JSON.stringify({ fileId: "file-123e4567-e89b-12d3-a456-426614174000", version: 1, saved: true }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  const result = await run(["workspace", "file", "copy", "file_source", "--scope", "b:archive", "--path", "backup/source.bin", "--request-id", "file-123e4567-e89b-12d3-a456-426614174000"]);
  assert.equal(result, 0, stderr.read());
  assert.deepEqual(calls.slice(0, 3), [
    { name: "get_workspace_file", arguments: { fileId: "file_source" } },
    { name: "list_file_versions", arguments: { fileId: "file_source", limit: 100 } },
    { name: "create_file_upload", arguments: { scope: "b:archive", path: "backup/source.bin", requestId: "file-123e4567-e89b-12d3-a456-426614174000", contentType: "application/octet-stream", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } },
  ]);
  assert.equal(calls[3].transfer, "/mcp/workspace-uploads/123e4567-e89b-12d3-a456-426614174001");
  assert.equal(calls[3].contentType, "application/octet-stream");
  assert.deepEqual(calls[3].bytes, bytes);
  assert.deepEqual(JSON.parse(stdout.read()), { sourceFileId: "file_source", sourceVersion: 3, fileId: "file-123e4567-e89b-12d3-a456-426614174000", version: 1, saved: true });
  assert.equal(stderr.read(), "");
});

test("file copy refuses invalid requests and purged or oversized source versions", async () => {
  let requests = 0;
  const fetcher = async (_url, init) => {
    requests += 1;
    const req = JSON.parse(init.body), name = req.params.name;
    const structuredContent = name === "get_workspace_file"
      ? { file: { id: req.params.arguments.fileId, path: "reports/source.bin", version: 3 } }
      : { versions: [{ version: 3, kind: "content", contentType: "application/octet-stream", size: 25 * 1024 * 1024 + 1, purged: req.params.arguments.fileId === "file_oversized" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "file", "copy", "file_source", "--scope", "b:archive", "--path", "backup.bin", "--request-id", "bad"]), 1);
  assert.match(stderr.read(), /request-id must be file-/); stderr.clear();
  assert.equal(await run(["workspace", "file", "copy", "file_source", "--scope", "b:archive", "--path", "backup.bin", "--request-id", "file-123e4567-e89b-12d3-a456-426614174000"]), 1);
  assert.match(stderr.read(), /cannot be copied by the CLI/);
  assert.equal(await run(["workspace", "file", "copy", "file_oversized", "--scope", "b:archive", "--path", "backup.bin", "--request-id", "file-123e4567-e89b-12d3-a456-426614174001"]), 1);
  assert.match(stderr.read(), /unavailable or purged/);
  assert.equal(requests, 4);
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

test("workflow lifecycle aliases map details, history, cancellation, held events, and webhook rotation", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { ok: true } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token, HONMARU_EXPECTED_HOOK_SECRET: "a".repeat(48) };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "show", "wf_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "runs", "wf_1", "--limit", "10"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "run-detail", "wf_1", "run_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "cancel", "wf_1", "run_1", "--expected-started-at", "2026-11-11T00:00:00Z"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "held-events", "wf_1", "--offset", "25"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "held-event", "wf_1", "held_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "discard-held", "wf_1", "--event-ids", "held_1,held_2"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "replay-held", "wf_1", "--event-ids", "held_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "webhook-rotate", "wf_1", "--expected-secret-env", "HONMARU_EXPECTED_HOOK_SECRET", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 0);
  assert.deepEqual(calls, [
    { name: "get_workflow", arguments: { workflowId: "wf_1" } },
    { name: "list_workflow_runs", arguments: { workflowId: "wf_1", limit: 10 } },
    { name: "get_workflow_run", arguments: { workflowId: "wf_1", runId: "run_1" } },
    { name: "cancel_workflow_run", arguments: { workflowId: "wf_1", runId: "run_1", expectedStartedAt: "2026-11-11T00:00:00Z" } },
    { name: "list_held_workflow_events", arguments: { workflowId: "wf_1", offset: 25 } },
    { name: "get_held_workflow_event", arguments: { workflowId: "wf_1", eventId: "held_1" } },
    { name: "discard_held_workflow_events", arguments: { workflowId: "wf_1", eventIds: ["held_1", "held_2"] } },
    { name: "replay_held_workflow_events", arguments: { workflowId: "wf_1", eventIds: ["held_1"] } },
    { name: "rotate_workflow_webhook", arguments: { workflowId: "wf_1", expectedSecret: "a".repeat(48), expectedUpdatedAt: "2026-11-11T00:00:00Z" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("workflow aliases only create paused drafts, edit with a version fence, and pause future triggers", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req.params);
    const name = req.params.name;
    const structuredContent = name === "create_workflow"
      ? { workflow: { id: "wf_new", enabled: false } }
      : name === "update_workflow"
        ? { workflow: { id: "wf_1", enabled: false }, revision: 3 }
        : { workflowId: "wf_1", enabled: false, activeRunsContinue: true };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "create", "--name", "Daily summary", "--trigger", "{\"type\":\"manual\"}", "--steps", "[{\"type\":\"post\",\"channel\":\"b:ops\",\"text\":\"Summarize\"}]", "--draft"]), 0);
  stdout.clear();
  assert.equal(await run(["workspace", "workflow", "update", "wf_1", "--expected-updated-at", "2026-11-12T00:00:00Z", "--name", "Weekly summary"]), 0);
  stdout.clear();
  assert.equal(await run(["workspace", "workflow", "pause", "wf_1", "--expected-updated-at", "2026-11-12T00:00:00Z"]), 0);
  assert.deepEqual(calls, [
    { name: "create_workflow", arguments: { name: "Daily summary", trigger: { type: "manual" }, steps: [{ type: "post", channel: "b:ops", text: "Summarize" }] } },
    { name: "update_workflow", arguments: { workflowId: "wf_1", expectedUpdatedAt: "2026-11-12T00:00:00Z", name: "Weekly summary" } },
    { name: "pause_workflow", arguments: { workflowId: "wf_1", expectedUpdatedAt: "2026-11-12T00:00:00Z" } },
  ]);
  assert.equal(stderr.read(), "");
});

test("workflow create/update/pause reject unsafe or stale inputs before making a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("must not call the server"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "create", "--name", "Unsafe", "--trigger", "{\"type\":\"manual\"}", "--steps", "[{\"type\":\"post\"}]"]), 1);
  assert.match(stderr.read(), /--draft is required/);
  assert.equal(await run(["workspace", "workflow", "create", "--name", "Unsafe", "--trigger", "[]", "--steps", "[]", "--draft"]), 1);
  assert.match(stderr.read(), /JSON object/);
  assert.equal(await run(["workspace", "workflow", "update", "wf_1", "--name", "No fence"]), 1);
  assert.match(stderr.read(), /expected-updated-at/);
  assert.equal(await run(["workspace", "workflow", "pause", "wf_1"]), 1);
  assert.match(stderr.read(), /expected-updated-at/);
  assert.equal(requests, 0);
});

test("webhook secret aliases resolve secrets from environment and allow inactive hooks without argv secrets", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { ok: true } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token, HOOK_SECRET: "b".repeat(48) };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "webhook-revoke", "wf_1", "--expected-secret-env", "HOOK_SECRET", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "webhook-revoke", "wf_2", "--expected-secret", "none", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 0);
  assert.deepEqual(calls.map(call => call.arguments.expectedSecret), ["b".repeat(48), null]);
  // The secret cannot be read back, so a rotation needs only the revision.
  assert.equal(await run(["workspace", "workflow", "webhook-rotate", "wf_3", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 0);
  assert.deepEqual(calls.at(-1).arguments, { workflowId: "wf_3", expectedUpdatedAt: "2026-11-11T00:00:00Z" });
  assert.equal(stderr.read(), "");
});

test("workflow recovery aliases require explicit compare-and-set and no-replay inputs", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { ok: true } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "revisions", "wf_1", "--before", "3"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "restore", "wf_1", "--revision", "2", "--expected-updated-at", "2026-11-11T00:00:00Z", "--confirm-auto-paused"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "resume", "wf_1", "--generation", "gen_1"]), 0); stdout.clear();
  assert.equal(await run(["workspace", "workflow", "recover", "wf_1", "run_1", "--expected-started-at", "2026-11-11T00:00:00Z", "--confirm-no-replay"]), 0);
  assert.deepEqual(calls, [
    { name: "list_workflow_revisions", arguments: { workflowId: "wf_1", before: 3 } },
    { name: "restore_workflow_revision", arguments: { workflowId: "wf_1", revision: 2, expectedUpdatedAt: "2026-11-11T00:00:00Z", confirmAutoPaused: true } },
    { name: "resume_workflow_safety", arguments: { workflowId: "wf_1", generation: "gen_1" } },
    { name: "recover_stalled_workflow_run", arguments: { workflowId: "wf_1", runId: "run_1", expectedStartedAt: "2026-11-11T00:00:00Z", confirmNoReplay: true } },
  ]);
  assert.equal(stderr.read(), "");
});

test("workflow recovery aliases reject omitted safety confirmations before a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "recover", "wf_1", "run_1", "--expected-started-at", "2026-11-11T00:00:00Z"]), 1);
  assert.match(stderr.read(), /confirm-no-replay/); stderr.clear();
  assert.equal(await run(["workspace", "workflow", "restore", "wf_1", "--revision", "0", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 1);
  assert.match(stderr.read(), /revision must be an integer/);
  assert.equal(requests, 0);
});

test("workflow lifecycle aliases reject unsafe or stale inputs before making a request", async () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; throw new Error("unexpected request"); };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(await run(["workspace", "workflow", "cancel", "wf_1", "run_1"]), 1);
  assert.match(stderr.read(), /expected-started-at/); stderr.clear();
  assert.equal(await run(["workspace", "workflow", "replay-held", "wf_1", "--event-ids", "held_1,held_1"]), 1);
  assert.match(stderr.read(), /distinct event IDs/); stderr.clear();
  assert.equal(await run(["workspace", "workflow", "webhook-revoke", "wf_1", "--expected-secret", "not-a-secret", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 1);
  assert.match(stderr.read(), /keeps it out of shell history/); stderr.clear();
  assert.equal(await run(["workspace", "workflow", "webhook-revoke", "wf_1", "--expected-secret-env", "MISSING_HOOK_SECRET", "--expected-updated-at", "2026-11-11T00:00:00Z"]), 1);
  assert.match(stderr.read(), /environment variable must contain/);
  assert.equal(requests, 0);
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

test("file share CLI requests approval without exposing an approval or purge command", async () => {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { structuredContent: { status: "pending", requestId: "fshare_req_1" } } }), { status: 200 });
  };
  const stdout = output(), stderr = output();
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token };
  const run = argv => runCli(argv, { env, fetcher, stdout: stdout.stream, stderr: stderr.stream });
  const requestId = "share-123e4567-e89b-12d3-a456-426614174000";
  assert.equal(await run(["workspace", "file", "share", "request", "file_1", "--version", "3", "--request-id", requestId, "--expires-in", "2592000", "--allow-download"]), 0);
  assert.equal(await run(["workspace", "file", "share", "requests", "--file-id", "file_1"]), 0);
  assert.deepEqual(calls, [
    { name: "request_public_file_share", arguments: { fileId: "file_1", version: 3, requestKey: requestId, expiresIn: 2592000, allowDownload: true } },
    { name: "list_file_share_requests", arguments: { fileId: "file_1" } },
  ]);
  assert.equal(await run(["workspace", "file", "share", "request", "file_1", "--version", "3", "--request-id", "bad"]), 1);
  assert.match(stderr.read(), /request-id must be share-/);
  assert.equal(calls.length, 2);
});


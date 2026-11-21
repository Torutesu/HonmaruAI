import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { generateTableSdk, generateTableSdkFromContract } from "../src/sdk.js";

const token = `hm_${"c".repeat(64)}`;
const table = { id: "table_1", name: "Pipeline", columns: [
  { id: "col_status", name: "Status", type: "select" },
  { id: "col_count", name: "Count", type: "number" },
  { id: "col_enabled", name: "Enabled", type: "checkbox" },
] };

test("table SDK generator derives nullable column-ID types and typed row operations", () => {
  const source = generateTableSdk(table);
  assert.match(source, /"col_status": string \| null/);
  assert.match(source, /"col_count": number \| null/);
  assert.match(source, /"col_enabled": boolean \| null/);
  assert.match(source, /"x-session-token": sessionToken/);
  assert.match(source, /validation: "strict"/);
  assert.match(source, /expectedUpdatedAt: string/);
  assert.match(source, /"PATCH"/);
  assert.match(source, /"DELETE"/);
  assert.doesNotMatch(source, /query_rows|add_row|update_row/);
  assert.match(source, /TABLE_ID = "table_1"/);
  assert.throws(() => generateTableSdk({ id: "table_2", columns: [] }), /no columns/);
});

test("pinned OpenAPI contract generates a version-labeled SDK", () => {
  const contractVersion = "a".repeat(64);
  const contract = { openapi: "3.1.0", "x-honmaru-table": table, paths: {
    "/tables/table_1": { get: {} }, "/tables/table_1/rows": { post: {} },
    "/tables/table_1/rows/{rowId}": { patch: {}, delete: {} },
  } };
  const source = generateTableSdkFromContract(contract, contractVersion);
  assert.match(source, new RegExp(`CONTRACT_VERSION = "${contractVersion}"`));
  assert.match(source, /"col_status": string \| null/);
  assert.throws(() => generateTableSdkFromContract({ openapi: "3.0.3" }, contractVersion), /invalid/);
  assert.throws(() => generateTableSdkFromContract({ ...contract, paths: {} }, contractVersion), /required strict row operations/);
  assert.throws(() => generateTableSdk(table, { contractVersion: "not-a-hash" }), /invalid/);
});

test("workspace sdk generate fetches the accessible contract and writes a TypeScript client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honmaru-sdk-"));
  try {
    const path = join(dir, "pipeline.ts");
    const stdout = { text: "", write(chunk) { this.text += chunk; } };
    const stderr = { text: "", write(chunk) { this.text += chunk; } };
    let request;
    const fetcher = async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { tables: [table] } } }), { status: 200 });
    };
    const code = await runCli(["workspace", "sdk", "generate", "table_1", "--out", path], {
      env: { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token, HONMARU_SESSION_TOKEN: "signed-in-session", HONMARU_ORG_ID: "workspace" }, fetcher, stdout, stderr,
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(request.params.name, "list_tables");
    assert.match(stdout.text, /Generated typed client/);
    assert.match(await readFile(path, "utf8"), /export function createHonmaruClient/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace sdk generation refuses to produce a client without its workspace session context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honmaru-sdk-context-"));
  try {
    const path = join(dir, "pipeline.ts");
    const stderr = { text: "", write(chunk) { this.text += chunk; } };
    const code = await runCli(["workspace", "sdk", "generate", "table_1", "--out", path], {
      env: { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token },
      fetcher: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { tables: [table] } } }), { status: 200 }),
      stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /HONMARU_ORG_ID/);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace sdk generate fetches a hash-pinned contract with the signed-in session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honmaru-sdk-pinned-"));
  try {
    const path = join(dir, "pipeline.ts");
    const stdout = { text: "", write(chunk) { this.text += chunk; } };
    const stderr = { text: "", write(chunk) { this.text += chunk; } };
    const contractVersion = "b".repeat(64);
    const requests = [];
    const fetcher = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/mcp")) {
        const request = JSON.parse(init.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { tables: [table] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ contractVersion, contract: { openapi: "3.1.0", "x-honmaru-table": table, paths: {
        "/tables/table_1": { get: {} }, "/tables/table_1/rows": { post: {} },
        "/tables/table_1/rows/{rowId}": { patch: {}, delete: {} },
      } } }), { status: 200 });
    };
    const code = await runCli(["workspace", "sdk", "generate", "table_1", "--contract-version", contractVersion, "--org-id", "workspace", "--out", path], {
      env: { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token, HONMARU_SESSION_TOKEN: "signed-in-session" }, fetcher, stdout, stderr,
    });
    assert.equal(code, 0, stderr.text);
    const pinnedRequest = requests.find(request => request.init.method === "GET");
    assert.match(pinnedRequest.url, /\/tables\/table_1\/contracts\/b{64}\?orgId=workspace$/);
    assert.equal(pinnedRequest.init.headers["x-session-token"], "signed-in-session");
    const source = await readFile(path, "utf8");
    assert.match(source, new RegExp(`CONTRACT_VERSION = "${contractVersion}"`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace table contract commands publish with schema CAS and list immutable versions", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(init.method === "POST"
      ? { contractVersion: "c".repeat(64), created: true }
      : { versions: [{ contractVersion: "c".repeat(64), createdAt: "2026-11-18T00:00:00.000Z" }] }), { status: init.method === "POST" ? 201 : 200 });
  };
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  const env = { HONMARU_API_URL: "https://api.example.com", HONMARU_SESSION_TOKEN: "signed-in-session", HONMARU_ORG_ID: "workspace" };

  const published = await runCli(["workspace", "table", "contract", "publish", "table_1", "--expected-updated-at", "2026-11-18T00:00:00.000Z"], { env, fetcher, stdout, stderr });
  assert.equal(published, 0, stderr.text);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { orgId: "workspace", expectedUpdatedAt: "2026-11-18T00:00:00.000Z" });
  assert.equal(calls[0].init.headers["x-session-token"], "signed-in-session");

  const listed = await runCli(["workspace", "table", "contract", "list", "table_1"], { env, fetcher, stdout, stderr });
  assert.equal(listed, 0, stderr.text);
  assert.equal(calls[1].init.method, "GET");
  assert.match(calls[1].url, /orgId=workspace$/);
  assert.match(stdout.text, /contractVersion/);
});

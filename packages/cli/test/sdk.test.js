import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { generateTableSdk } from "../src/sdk.js";

const token = `hm_${"c".repeat(64)}`;
const table = { id: "table_1", name: "Pipeline", columns: [
  { id: "col_status", name: "Status", type: "select" },
  { id: "col_count", name: "Count", type: "number" },
  { id: "col_enabled", name: "Enabled", type: "checkbox" },
] };

test("table SDK generator derives column-ID types and typed row operations", () => {
  const source = generateTableSdk(table);
  assert.match(source, /"col_status": string/);
  assert.match(source, /"col_count": number/);
  assert.match(source, /"col_enabled": boolean/);
  assert.match(source, /query_rows/);
  assert.match(source, /add_row/);
  assert.match(source, /update_row/);
  assert.match(source, /TABLE_ID = "table_1"/);
  assert.throws(() => generateTableSdk({ id: "table_2", columns: [] }), /no columns/);
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
      env: { HONMARU_API_URL: "https://api.example.com", HONMARU_API_TOKEN: token }, fetcher, stdout, stderr,
    });
    assert.equal(code, 0, stderr.text);
    assert.equal(request.params.name, "list_tables");
    assert.match(stdout.text, /Generated typed client/);
    assert.match(await readFile(path, "utf8"), /export function createHonmaruClient/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

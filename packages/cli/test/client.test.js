import assert from "node:assert/strict";
import test from "node:test";
import { createMcpClient, mcpEndpoint } from "../src/client.js";

const token = `hm_${"a".repeat(64)}`;

test("MCP endpoint accepts HTTPS origins and local development", () => {
  assert.equal(mcpEndpoint("https://api.example.com").href, "https://api.example.com/mcp");
  assert.equal(mcpEndpoint("http://localhost:8787").href, "http://localhost:8787/mcp");
  assert.throws(() => mcpEndpoint("http://api.example.com"), /HTTPS origin/);
  assert.throws(() => mcpEndpoint("https://user:pass@example.com"), /HTTPS origin/);
  assert.throws(() => mcpEndpoint("https://example.com/path"), /HTTPS origin/);
  assert.throws(() => mcpEndpoint("https://example.com/?token=secret"), /HTTPS origin/);
});

test("MCP client lists and calls tools with the token's existing scope", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const request = JSON.parse(init.body);
    const result = request.method === "tools/list"
      ? { tools: [{ name: "list_apps", inputSchema: { type: "object" } }] }
      : { structuredContent: { rows: [] } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
  };
  const client = createMcpClient({ apiUrl: "https://api.example.com", token, fetcher });

  assert.deepEqual(await client.listTools(), [{ name: "list_apps", inputSchema: { type: "object" } }]);
  assert.deepEqual(await client.callTool("query_rows", { tableId: "tbl_1", limit: 10 }), { structuredContent: { rows: [] } });
  assert.equal(calls[0].url, "https://api.example.com/mcp");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(JSON.parse(calls[1].init.body).params.arguments.tableId, "tbl_1");
});

test("invalid response and unauthorized errors do not expose the token", async () => {
  const client = createMcpClient({
    apiUrl: "https://api.example.com",
    token,
    fetcher: async () => new Response(token, { status: 401 }),
  });
  await assert.rejects(client.listTools(), (error) => {
    assert.match(error.message, /invalid, expired, revoked/);
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
});

test("the client refuses missing or malformed credentials before making a request", () => {
  let requests = 0;
  const fetcher = async () => { requests += 1; };
  assert.throws(() => createMcpClient({ apiUrl: "https://api.example.com", token: "bad", fetcher }), /HONMARU_API_TOKEN/);
  assert.equal(requests, 0);
});

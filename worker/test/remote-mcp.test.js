import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import worker from "../src/index.js";
import { cleanHeaders, cleanTools, safeEndpoint, toolName } from "../src/harness/remoteMcp.js";

const ORG = "personal:remote-mcp";
let session;
const call = (path, init) => worker.fetch(new Request(`https://example.com${path}`, init), env);
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
let seq = 0;
const rpc = (token, method, params = {}) => call("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
});
const mint = async (scopes) => (await (await call("/tokens", {
  method: "POST", headers: headers(session), body: JSON.stringify({ orgId: ORG, name: "Remote MCP agent", scopes }),
})).json()).token;

beforeEach(async () => {
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9551", login: "remote-admin", name: "Remote Admin" });
  await upsertMembership(env.DB, ORG, "9551", "admin");
  session = await createSession(env.DB, "9551", "gho_remote_admin");
});

test("Remote MCP endpoint validation rejects local, insecure, redirected-looking and query-secret URLs", () => {
  expect(safeEndpoint("https://mcp.example.com/mcp")).toBe("https://mcp.example.com/mcp");
  for (const endpoint of [
    "http://mcp.example.com/mcp",
    "https://localhost/mcp",
    "https://api.local/mcp",
    "https://mcp.home.arpa/mcp",
    "https://mcp.lan/mcp",
    "https://127.0.0.1/mcp",
    "https://2130706433/mcp",
    "https://[::1]/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://user:pass@mcp.example.com/mcp",
    "https://mcp.example.com/mcp?token=secret",
  ]) expect(safeEndpoint(endpoint)).toBeNull();
});

test("Remote MCP headers and tool schemas are bounded and reject reserved or duplicate headers", () => {
  expect(cleanHeaders([{ name: "Authorization", value: "Bearer token" }, { name: "X-Workspace-Key", value: "secret" }])).toHaveLength(2);
  expect(cleanHeaders([{ name: "Host", value: "internal" }])).toBeNull();
  expect(cleanHeaders([{ name: "X-Key", value: "one" }, { name: "x-key", value: "two" }])).toBeNull();
  expect(cleanHeaders([{ name: "X-Key", value: "one\r\nHost: internal" }])).toBeNull();
  expect(cleanTools([
    { name: "valid", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "no-schema", inputSchema: null },
    { name: "wrong-root", inputSchema: { type: "array" } },
  ])).toMatchObject([{ name: "valid" }]);
  expect(toolName("0f1e2d3c-4b5a", "find files")).toBe(toolName("0f1e2d3c-4b5a", "find files"));
});

test("Remote MCP is Harness-only and does not save credentials without encryption", async () => {
  const simple = await call(`/remote-mcp?orgId=${encodeURIComponent(ORG)}`, { headers: headers(session) });
  expect(simple.status).toBe(404);
  await call("/orgs/mode", { method: "PUT", headers: headers(session), body: JSON.stringify({ orgId: ORG, mode: "harness" }) });
  const rejected = await call("/remote-mcp", {
    method: "POST", headers: headers(session),
    body: JSON.stringify({ orgId: ORG, name: "Private MCP", endpoint: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer do-not-store" }] }),
  });
  expect(rejected.status).toBe(503);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_remote_mcp_servers").first()).toMatchObject({ n: 0 });
});

test("an admin discovers a Remote MCP tool, allows it, and only execute-scoped agents can call it", async () => {
  await call("/orgs/mode", { method: "PUT", headers: headers(session), body: JSON.stringify({ orgId: ORG, mode: "harness" }) });
  const addedResponse = await call("/remote-mcp", {
    method: "POST", headers: headers(session),
    body: JSON.stringify({ orgId: ORG, name: "Public MCP", endpoint: "https://mcp.example.com/mcp", headers: [] }),
  });
  expect(addedResponse.status).toBe(201);
  const { server } = await addedResponse.json();
  const origin = "https://mcp.example.com";
  const endpoint = fetchMock.get(origin);
  const mcpMessage = (opts) => JSON.parse(opts.body);
  endpoint.intercept({ path: "/mcp", method: "POST", body: (body) => JSON.parse(body).method === "initialize" })
    .reply((opts) => ({ statusCode: 200, data: { jsonrpc: "2.0", id: mcpMessage(opts).id, result: { protocolVersion: "2025-06-18" } }, responseOptions: { headers: { "mcp-session-id": "session-test" } } })).times(2);
  endpoint.intercept({ path: "/mcp", method: "POST", body: (body) => JSON.parse(body).method === "notifications/initialized" })
    .reply(202, null).times(2);
  endpoint.intercept({ path: "/mcp", method: "POST", body: (body) => JSON.parse(body).method === "tools/list" })
    .reply((opts) => ({ statusCode: 200, data: { jsonrpc: "2.0", id: mcpMessage(opts).id, result: { tools: [{ name: "find_records", title: "Find records", description: "Search the approved knowledge base.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] } } }));
  endpoint.intercept({ path: "/mcp", method: "POST", body: (body) => JSON.parse(body).method === "tools/call" })
    .reply((opts) => ({ statusCode: 200, data: { jsonrpc: "2.0", id: mcpMessage(opts).id, result: { content: [{ type: "text", text: "approved result" }] } } }));

  fetchMock.activate();
  try {
    const discovered = await call(`/remote-mcp/${server.id}/discover`, {
      method: "POST", headers: headers(session), body: JSON.stringify({ orgId: ORG }),
    });
    expect(discovered.status).toBe(200);
    expect((await discovered.json()).server.tools).toMatchObject([{ name: "find_records" }]);
    const allowed = await call(`/remote-mcp/${server.id}/tools`, {
      method: "PUT", headers: headers(session), body: JSON.stringify({ orgId: ORG, allowedTools: ["find_records"] }),
    });
    expect((await allowed.json()).server.allowedTools).toEqual(["find_records"]);

    const reader = await mint(["read"]);
    const executor = await mint(["read", "execute"]);
    const readerList = await (await rpc(reader, "tools/list")).json();
    expect(readerList.result.tools.some((tool) => tool.title === "Public MCP: Find records")).toBe(false);
    const executorList = await (await rpc(executor, "tools/list")).json();
    const exposed = executorList.result.tools.find((tool) => tool.title === "Public MCP: Find records");
    expect(exposed).toMatchObject({ inputSchema: { type: "object" } });
    const result = await (await rpc(executor, "tools/call", { name: exposed.name, arguments: { query: "releases" } })).json();
    expect(result.result.content).toEqual([{ type: "text", text: "approved result" }]);
    expect((await call(`/remote-mcp/${server.id}?orgId=${encodeURIComponent(ORG)}`, { method: "DELETE", headers: headers(session) })).status).toBe(200);
  } finally {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.deactivate();
  }
});

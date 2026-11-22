import { expect, test } from "vitest";
import { cleanRemoteMcpEgressRequest, cleanRemoteMcpEgressResponse } from "../src/harness/remoteMcpEgress.js";

test("Remote MCP egress requests allow only bounded public HTTPS GET and POST requests", () => {
  expect(cleanRemoteMcpEgressRequest({
    url: "https://mcp.example.org/tools",
    method: "post",
    headers: [{ name: "Authorization", value: "Bearer secret" }, { name: "content-type", value: "application/json" }],
    body: "{}",
  })).toMatchObject({ url: "https://mcp.example.org/tools", method: "POST", body: "{}" });
  for (const url of [
    "http://mcp.example.org/tools",
    "https://127.0.0.1/tools",
    "https://[::1]/tools",
    "https://mcp.example.org:8443/tools",
    "https://user:secret@mcp.example.org/tools",
    "https://mcp.example.org/tools#fragment",
  ]) {
    expect(() => cleanRemoteMcpEgressRequest({ url, method: "POST", headers: [], body: "{}" })).toThrow();
  }
  expect(() => cleanRemoteMcpEgressRequest({ url: "https://mcp.example.org/tools", method: "DELETE", headers: [] })).toThrow();
});

test("Remote MCP egress request headers and request data stay bounded", () => {
  const base = { url: "https://mcp.example.org/tools", method: "POST", headers: [] };
  expect(() => cleanRemoteMcpEgressRequest({ ...base, headers: [{ name: "Host", value: "localhost" }] })).toThrow();
  expect(() => cleanRemoteMcpEgressRequest({ ...base, headers: [{ name: "X-Key", value: "one" }, { name: "x-key", value: "two" }] })).toThrow();
  expect(() => cleanRemoteMcpEgressRequest({ ...base, body: "x".repeat(128 * 1024 + 1) })).toThrow(/too large/i);
});

test("Remote MCP egress Agent authorization is an exact bounded non-secret scope", () => {
  expect(cleanRemoteMcpEgressRequest({
    url: "https://mcp.example.org/tools", method: "POST", headers: [], body: "{}",
    authorization: { agentId: "agent-1", toolName: "search" },
  })).toMatchObject({ authorization: { agentId: "agent-1", toolName: "search" } });
  expect(() => cleanRemoteMcpEgressRequest({
    url: "https://mcp.example.org/tools", method: "POST", headers: [],
    authorization: { agentId: "agent-1", toolName: "search", unexpected: "value" },
  })).toThrow();
  expect(() => cleanRemoteMcpEgressRequest({
    url: "https://mcp.example.org/tools", method: "POST", headers: [],
    authorization: { kind: "agent", agentId: "agent-1" },
  })).toThrow(/exact Agent and tool/i);
});

test("Remote MCP egress App grants are bound to one viewer, App, tool, and grant generation", () => {
  const authorization = { kind: "app", appId: "app-1", viewerId: "42", toolName: "lookup", grantId: "grant-generation-1" };
  expect(cleanRemoteMcpEgressRequest({
    url: "https://mcp.example.org/tools", method: "POST", headers: [], body: "{}", authorization,
  })).toMatchObject({ authorization });
  expect(() => cleanRemoteMcpEgressRequest({
    url: "https://mcp.example.org/tools", method: "POST", headers: [],
    authorization: { kind: "app", appId: "app-1", viewerId: "42", grantId: "grant-generation-1" },
  })).toThrow(/exact App, viewer, and tool/i);
});

test("Remote MCP egress responses keep only bounded protocol headers and body", () => {
  expect(cleanRemoteMcpEgressResponse({
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
    body: "{}",
  })).toEqual({ status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" }, body: "{}" });
  expect(() => cleanRemoteMcpEgressResponse({ status: 302, headers: { location: "http://127.0.0.1/" }, body: "" })).toThrow();
  expect(() => cleanRemoteMcpEgressResponse({ status: 200, headers: { authorization: "Bearer secret" }, body: "" })).toThrow();
  expect(() => cleanRemoteMcpEgressResponse({ status: 200, body: "x".repeat(1_000_001) })).toThrow(/too large/i);
  expect(cleanRemoteMcpEgressResponse({ error: "The remote host did not answer." })).toEqual({ error: "The remote host did not answer." });
  expect(() => cleanRemoteMcpEgressResponse({ error: "x".repeat(301) })).toThrow();
});

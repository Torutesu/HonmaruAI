import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// The harness over MCP (docs/kylon-gap-plan.md): an outside agent reads and
// writes the workspace's apps and tables, runs its workflows and schedules
// follow-ups — in a harness workspace only, and writing only with "write".

const ORG = "personal:hxmcp";
let toru;
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), env);
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
let seq = 0;
const rpc = (bearer, method, params) => call("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params ? { params } : {}) }),
});
const tool = async (bearer, name, args = {}) => (await (await rpc(bearer, "tools/call", { name, arguments: args })).json());
const mint = async (scopes) => (await (await call("/tokens", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: "Claude Code", scopes }) })).json()).token;
const names = async (token) => (await (await rpc(token, "tools/list")).json()).result.tools.map((t) => t.name);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9401", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9401", "admin");
  toru = await createSession(env.DB, "9401", "gho_toru");
});

test("a simple workspace's agents see the tools they always did", async () => {
  const token = await mint(["read", "write"]);
  expect(await names(token)).toEqual(["request_decision", "get_decision", "list_pending", "search_decisions", "list_members", "get_playbook"]);
  expect((await tool(token, "list_apps")).error.message).toContain("Unknown tool");
});

test("in a harness workspace an agent reads an app's numbers, adds a row, and needs write to change anything", async () => {
  await call("/orgs/mode", { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: "harness" }) });
  const { app } = await (await call("/apps", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, template: "crm" }) })).json();
  const writer = await mint(["read", "write"]);
  const reader = await mint(["read"]);
  expect(await names(writer)).toEqual(expect.arrayContaining(["list_apps", "read_app", "query_rows", "add_row", "run_workflow", "schedule_followup"]));
  expect(await names(reader)).not.toContain("add_row");

  const listed = (await tool(reader, "list_apps")).result.structuredContent;
  expect(listed.apps).toEqual([expect.objectContaining({ id: app.id, name: "Sales CRM" })]);
  const read = (await tool(reader, "read_app", { appId: app.id })).result.structuredContent;
  expect(read.views.find((v) => v.name === "Forecast").metrics).toEqual(expect.arrayContaining([{ label: "Open pipeline", value: 42000 }]));

  expect((await tool(reader, "add_row", { tableId: app.tableId, values: { Company: "Hooli" } })).result.isError).toBe(true);
  const added = (await tool(writer, "add_row", { tableId: app.tableId, values: { Company: "Hooli", Stage: "Lead", Value: "9,000" } })).result.structuredContent;
  expect(added.row).toMatchObject({ company: "Hooli", stage: "Lead", value: 9000 });
  const found = (await tool(reader, "query_rows", { tableId: app.tableId, where: { Stage: "Lead" } })).result.structuredContent;
  expect(found.rows.map((r) => r.company).sort()).toEqual(["Hooli", "Initech"]);
});

test('node execution requires execute scope, preserves ownership and leaves Simple unchanged', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { gateway, token: nodeToken } = await (await call('/gateways', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: 'Mac mini' }) })).json();
  const writer = await mint(['read', 'write']), executor = await mint(['read', 'execute']);
  expect(await names(writer)).not.toContain('run_javascript');
  expect(await names(executor)).toContain('run_javascript');
  const args = { gatewayId: gateway.id, requestId: 'agent-op-1', code: 'return input * 2', input: 21 };
  expect((await tool(writer, 'run_javascript', args)).result.isError).toBe(true);
  const queued = (await tool(executor, 'run_javascript', args)).result.structuredContent.job;
  expect(queued.status).toBe('queued');
  expect((await tool(executor, 'run_javascript', args)).result.structuredContent.job.id).toBe(queued.id);
  expect((await tool(executor, 'run_javascript', { ...args, code: 'return 0' })).result.isError).toBe(true);
  const nodeCall = async (path, body) => (await call('/gateways/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nodeToken}` }, body: JSON.stringify(body) })).json();
  const { job } = await nodeCall('claim', {});
  expect(job.id).toBe(queued.id);
  await nodeCall(`jobs/${job.id}/finish`, { lease: job.lease, status: 'succeeded', stdout: '42', exitCode: 0 });
  expect((await tool(executor, 'get_execution', { jobId: job.id })).result.structuredContent.job).toMatchObject({ status: 'succeeded', result: { stdout: '42' } });
  const { upsertUser, upsertMembership } = await import('../src/db.js');
  const { callExecutionTool, executionAgentTools } = await import('../src/harness/executionTools.js');
  await upsertUser(env.DB, { githubId: '9402', login: 'other', name: 'Other' });
  await upsertMembership(env.DB, ORG, '9402', 'admin');
  const other = { orgId: ORG, githubId: '9402' };
  expect((await callExecutionTool(env, other, 'get_execution', { jobId: job.id })).isError).toBe(true);
  expect((await callExecutionTool(env, other, 'cancel_execution', { jobId: job.id })).isError).toBe(true);
  const context = { orgId: ORG, session: { github_id: '9401' }, personal: true, ownAgentsOnly: true };
  expect(Object.keys(await executionAgentTools(env, context))).toContain('run_javascript');
  expect(await executionAgentTools(env, { ...context, personal: false })).toEqual({});
  expect(await executionAgentTools(env, { ...context, ownAgentsOnly: false })).toEqual({});
  const next = (await tool(executor, 'run_javascript', { ...args, requestId: 'cancel-me' })).result.structuredContent.job;
  expect((await tool(executor, 'cancel_execution', { jobId: next.id })).result.structuredContent.job.status).toBe('cancelled');
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  expect(await names(executor)).not.toContain('run_javascript');
  expect(await executionAgentTools(env, context)).toEqual({});
});

test('MCP reports an overlapping workflow trigger as skipped without dereferencing a nonexistent run', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { createWorkflow } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Approval gate', enabled: true, trigger: { type: 'manual' },
    steps: [{ type: 'approval', to: 'toru', title: 'Proceed?' }],
  }, '9401');
  const token = await mint(['read', 'write']);
  const first = await tool(token, 'run_workflow', { workflowId: workflow.id });
  expect(JSON.parse(first.result.content[0].text).run.status).toBe('waiting');
  const second = await tool(token, 'run_workflow', { workflowId: workflow.id });
  expect(second.result.isError).not.toBe(true);
  expect(JSON.parse(second.result.content[0].text)).toEqual({ status: 'skipped', reason: 'already_running' });
});

import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { joined, until } from "./helpers.js";
import { render, runDueWorkflows, normalizeSteps, normalizeTrigger, onRowChange, onRowDelete, startRun } from "../src/harness/workflows.js";
import { signWorkflowWebhook } from "../src/harness/workflowWebhookSignature.js";
import { runDueFollowups, followupRequest } from "../src/harness/followups.js";

// Workflows, follow-ups and approvals (docs/kylon-gap-plan.md): a trigger,
// steps, every run kept; an approval is a card whose swipe carries the run
// on; a follow-up is an agent coming back to a thread at a set time.

const ORG = "personal:hxflows";
let toru, mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const call = async (path, init, over = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, init), { ...env, OPENAI_API_KEY: undefined, ...over }, ctx);
  await settle();
  return res;
};
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const send = (method, path, token, body) => call(path, { method, headers: headers(token), body: JSON.stringify(body) });
const get = (path, token) => call(path, { headers: headers(token) });
const q = (o) => new URLSearchParams(o).toString();
const messages = async (token) => (await (await get(`/channels/messages?${q({ orgId: ORG, channel: "b:ops" })}`, token)).json()).messages || [];
let webhookNumber = 0;
const signedWebhook = async (hookUrl, secret, body = '{}', eventId = `evt-${++webhookNumber}`, { timestamp = String(Math.floor(Date.now() / 1000)), signature } = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const url = new URL(hookUrl);
  url.searchParams.set('secret', secret);
  const signed = signature ?? await signWorkflowWebhook(secret, timestamp, eventId, text);
  return call(url.pathname + url.search, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-timestamp': timestamp, 'x-webhook-event-id': eventId, 'x-webhook-signature': signed },
    body: text,
  });
};

async function addWorkflowRemoteMcpServer(tools, allowedTools) {
  const response = await send('POST', '/remote-mcp', toru, {
    orgId: ORG, name: 'Workflow knowledge', endpoint: 'https://workflow-mcp.example.com/mcp', headers: [],
  });
  expect(response.status).toBe(201);
  const { server } = await response.json();
  await env.DB.prepare(`UPDATE hx_remote_mcp_servers SET tools_json=?1, allowed_tools=?2, connected_at=?3
    WHERE org_id=?4 AND id=?5`)
    .bind(JSON.stringify(tools), JSON.stringify(allowedTools), new Date().toISOString(), ORG, server.id).run();
  return server;
}

function interceptWorkflowRemoteMcp(onCall = null) {
  const endpoint = fetchMock.get('https://workflow-mcp.example.com');
  const message = opts => JSON.parse(opts.body);
  endpoint.intercept({ path: '/mcp', method: 'POST', body: body => JSON.parse(body).method === 'initialize' })
    .reply(opts => ({
      statusCode: 200,
      data: { jsonrpc: '2.0', id: message(opts).id, result: { protocolVersion: '2025-06-18' } },
      responseOptions: { headers: { 'mcp-session-id': 'workflow-session' } },
    }));
  endpoint.intercept({ path: '/mcp', method: 'POST', body: body => JSON.parse(body).method === 'notifications/initialized' })
    .reply(202, null);
  endpoint.intercept({ path: '/mcp', method: 'POST', body: body => JSON.parse(body).method === 'tools/call' })
    .reply(async opts => {
      await onCall?.(message(opts));
      return {
        statusCode: 200,
        data: { jsonrpc: '2.0', id: message(opts).id, result: { content: [{ type: 'text', text: 'Workspace policy: keep all keys private.' }] } },
      };
    });
}

let invoices, invoicesAppId;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9301", "toru", "Toru", "admin"], ["9302", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Ops", createdBy: "9301" });
  toru = await createSession(env.DB, "9301", "gho_t");
  mika = await createSession(env.DB, "9302", "gho_m");
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "harness" });
  const app = (await (await send("POST", "/apps", mika, { orgId: ORG, template: "invoices", sample: false })).json()).app;
  invoices = app.tableId; invoicesAppId = app.id;
});

const overdueFlow = () => ({
  orgId: ORG, name: "Chase overdue invoices",
  trigger: { type: "row", tableId: invoices, on: "changed", where: { Status: "Overdue" } },
  steps: [
    { type: "post", channel: "b:ops", text: "{{row.Client}} is overdue on {{row.Invoice #}} ({{row.Amount}})." },
    { type: "approval", to: "toru", title: "Send {{row.Client}} a reminder?", summary: "{{row.Amount}} overdue" },
    { type: "post", channel: "b:ops", text: "Reminder to {{row.Client}} approved: {{steps.2.output}}" },
  ],
});

test("a row turning overdue runs the workflow: it posts, waits on a person's approval, and goes on when approved", async () => {
  const made = await send("POST", "/workflows", mika, overdueFlow());
  expect(made.status).toBe(201);
  const { workflow } = await made.json();

  const row = (await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Acme", "Invoice #": "INV-7", Amount: 4800, Status: "Sent" } })).json()).row;
  // Added as "Sent": not overdue, nothing runs.
  expect((await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs).toEqual([]);

  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Status: "Overdue" } });
  const { runs } = await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ trigger: "row", status: "waiting", nextStep: 2 });
  expect(runs[0].log.map((l) => [l.type, l.status])).toEqual([["post", "ok"], ["approval", "waiting"]]);
  expect((await messages(mika)).map((m) => m.body)).toContain("Acme is overdue on INV-7 (4800).");

  // Toru sees it among what agents and workflows wait on him for.
  const approvals = await (await get(`/approvals?${q({ orgId: ORG })}`, toru)).json();
  expect(approvals.toDecide).toEqual([expect.objectContaining({ title: "Send Acme a reminder?", kind: "workflow" })]);
  expect((await (await get(`/approvals?${q({ orgId: ORG })}`, mika)).json()).waitingOnOthers).toHaveLength(1);

  // A further change while it already reads "Overdue" is not news.
  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Amount: 4900 } });
  expect((await (await get(`/workflows/${workflow.id}/runs?${q({ orgId: ORG })}`, mika)).json()).runs).toHaveLength(1);

  const { ws } = await joined(ORG, toru);
  ws.send(JSON.stringify({ type: "tool_result", payload: { toolCallId: "tc-wf", content: { cardId: runs[0].cardId, action: "approve", decidedAt: new Date().toISOString() } } }));
  const done = await until(async () => {
    const r = (await (await get(`/workflows/${workflow.id}/runs/${runs[0].id}?${q({ orgId: ORG })}`, mika)).json()).run;
    return r.status === "done" ? r : null;
  });
  expect(done.log.map((l) => [l.type, l.status])).toEqual([["post", "ok"], ["approval", "ok"], ["post", "ok"]]);
  expect((await messages(mika)).map((m) => m.body)).toContain("Reminder to Acme approved: Approved by Toru");
});

test.each(['row', 'app_record_change'])('a %s event updates its actual record when a user ID column points to another row', async triggerType => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Identity collision', columns: [
    { name: 'Name', type: 'text' }, { name: 'ID', type: 'text' }, { name: 'Status', type: 'select', options: ['Ready', 'Triggered', 'Done'] },
  ] })).json();
  const path = `/tables/${app.tableId}/rows`;
  const other = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Other', Status: 'Ready' } })).json()).row;
  const source = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Source', ID: other.id, Status: 'Ready' } })).json()).row;
  const trigger = triggerType === 'row' ? { type: 'row', tableId: app.tableId, on: 'changed' }
    : { type: 'app_record_change', appId: app.id, entityId: 'primary', events: ['update'] };
  const identity = triggerType === 'row' ? '{{input.recordId}}' : '{{input.records.0.recordId}}';
  const made = await send('POST', '/workflows', mika, { orgId: ORG, name: `Collision ${triggerType}`, trigger, steps: [
    { type: 'post', channel: 'b:ops', text: `Field {{row.id}}, record ${identity}` },
    { type: 'update_row', values: { Status: 'Done' } },
  ] });
  expect(made.status).toBe(201);
  const { workflow } = await made.json();
  expect((await send('PATCH', `${path}/${source.id}`, mika, { orgId: ORG, values: { Status: 'Triggered' } })).status).toBe(200);
  const runs = (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs;
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe('done');
  expect(runs[0].log[1].rowId).toBe(source.id);
  if (triggerType === 'row') expect(runs[0].input).toMatchObject({ recordId: source.id, row: { id: other.id } });
  else expect(runs[0].input.records[0].recordId).toBe(source.id);
  expect((await messages(mika)).map(message => message.body)).toContain(`Field ${other.id}, record ${source.id}`);
  const rows = (await (await get(`/tables/${app.tableId}?${q({ orgId: ORG })}`, mika)).json()).rows;
  expect(rows.find(row => row.id === source.id).values.status).toBe('Done');
  expect(rows.find(row => row.id === other.id).values.status).toBe('Ready');
});

test.each(['row', 'app_record_change'])('a %s event rejects an ambiguous row.id update while permitting an explicit field target', async triggerType => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Explicit target', columns: [
    { name: 'Name', type: 'text' }, { name: 'ID', type: 'text' }, { name: 'Status', type: 'text' },
  ] })).json();
  const path = `/tables/${app.tableId}/rows`;
  const other = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Other', Status: 'Ready' } })).json()).row;
  const source = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Source', ID: other.id, Status: 'Ready' } })).json()).row;
  const trigger = triggerType === 'row' ? { type: 'row', tableId: app.tableId, on: 'changed' }
    : { type: 'app_record_change', appId: app.id, entityId: 'primary', events: ['update'] };
  const field = triggerType === 'row' ? '{{input.rowFields.id}}' : '{{input.records.0.data.id}}';
  const create = async (name, rowId) => (await (await send('POST', '/workflows', mika, { orgId: ORG, name, trigger, steps: [
    { type: 'post', channel: 'b:ops', text: 'User ID {{row.id}}' },
    { type: 'update_row', rowId, values: { Status: 'Done' } },
  ] })).json()).workflow;
  const ambiguous = await create('Ambiguous', '{{ row.ID }}');
  const nested = triggerType === 'row' ? await create('Nested ambiguous', '{{ Input.Row.ID }}') : null;
  const explicit = await create('Field target', field);
  await send('PATCH', `${path}/${source.id}`, mika, { orgId: ORG, values: { Status: 'Triggered' } });
  const getRun = async workflow => (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs.find(run => (run.input.recordId || run.input.records?.[0]?.recordId) === source.id);
  const failed = await getRun(ambiguous);
  expect(failed.status).toBe('failed');
  expect(failed.log[1].error).toContain('row.id update target is ambiguous');
  if (nested) expect(await getRun(nested)).toMatchObject({ status: 'failed', log: [{ status: 'ok' }, { error: expect.stringContaining('row.id update target is ambiguous') }] });
  expect((await getRun(explicit))).toMatchObject({ status: 'done', log: [{ status: 'ok' }, { rowId: other.id }] });
  expect((await messages(mika)).map(message => message.body)).toContain(`User ID ${other.id}`);
  const rows = (await (await get(`/tables/${app.tableId}?${q({ orgId: ORG })}`, mika)).json()).rows;
  expect(rows.find(row => row.id === source.id).values.status).toBe('Triggered');
  expect(rows.find(row => row.id === other.id).values.status).toBe('Done');
});

test.each([['row', '{{row.id}}'], ['row', '{{input.row.id}}'], ['app_record_change', '{{row.id}}']])('an unambiguous %s %s update keeps working', async (triggerType, rowId) => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'No collision', columns: [
    { name: 'Name', type: 'text' }, { name: 'Status', type: 'text' },
  ] })).json();
  const path = `/tables/${app.tableId}/rows`;
  const source = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Source', Status: 'Ready' } })).json()).row;
  const trigger = triggerType === 'row' ? { type: 'row', tableId: app.tableId, on: 'changed' }
    : { type: 'app_record_change', appId: app.id, entityId: 'primary', events: ['update'] };
  const { workflow } = await (await send('POST', '/workflows', mika, { orgId: ORG, name: 'Unambiguous', trigger, steps: [
    { type: 'update_row', rowId, values: { Status: 'Done' } },
  ] })).json();
  await send('PATCH', `${path}/${source.id}`, mika, { orgId: ORG, values: { Status: 'Triggered' } });
  const run = (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs[0];
  expect(run).toMatchObject({ status: 'done', log: [{ rowId: source.id }] });
});

test('a column renamed to ID remains explicitly addressable by its stable column ID', async () => {
  const { table } = await (await send('POST', '/tables', mika, { orgId: ORG, name: 'Renamed ID', columns: [
    { name: 'Code', type: 'text' }, { name: 'Status', type: 'text' },
  ] })).json();
  const renamed = await send('PUT', `/tables/${table.id}`, mika, { orgId: ORG, columns: table.columns.map(c => c.id === 'code' ? { ...c, name: 'ID' } : c) });
  expect(renamed.status).toBe(200);
  const path = `/tables/${table.id}/rows`;
  const other = (await (await send('POST', path, mika, { orgId: ORG, values: { Status: 'Ready' } })).json()).row;
  const source = (await (await send('POST', path, mika, { orgId: ORG, values: { ID: other.id, Status: 'Ready' } })).json()).row;
  const { workflow } = await (await send('POST', '/workflows', mika, { orgId: ORG, name: 'Renamed field', trigger: { type: 'row', tableId: table.id, on: 'changed' }, steps: [
    { type: 'update_row', rowId: '{{input.rowFields.code}}', values: { Status: 'Done' } },
  ] })).json();
  await send('PATCH', `${path}/${source.id}`, mika, { orgId: ORG, values: { Status: 'Triggered' } });
  const run = (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs.find(item => item.input.recordId === source.id);
  expect(run).toMatchObject({ status: 'done', input: { rowFields: { code: other.id } }, log: [{ rowId: other.id }] });
});

test('manual runs retain their supplied row context', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Manual row', columns: [
    { name: 'Name', type: 'text' }, { name: 'Status', type: 'text' },
  ] })).json();
  const path = `/tables/${app.tableId}/rows`;
  const row = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Target', Status: 'Ready' } })).json()).row;
  const { workflow } = await (await send('POST', '/workflows', mika, { orgId: ORG, name: 'Manual target', trigger: { type: 'manual' }, steps: [
    { type: 'update_row', values: { Status: 'Done' } },
  ] })).json();
  const response = await send('POST', `/workflows/${workflow.id}/run`, mika, { orgId: ORG, input: { tableId: app.tableId, row: { id: row.id } } });
  expect((await response.json()).run).toMatchObject({ status: 'done', log: [{ rowId: row.id }] });
  const rows = (await (await get(`/tables/${app.tableId}?${q({ orgId: ORG })}`, mika)).json()).rows;
  expect(rows.find(item => item.id === row.id).values.status).toBe('Done');
});

test.each([[false, undefined], [true, undefined], [true, '{{row.id}}'], [true, '{{input.row.id}}']])('approval resume safely handles old records (legacy: %s, rowId: %s)', async (legacy, explicitRowId) => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Legacy identity', columns: [
    { name: 'Name', type: 'text' }, { name: 'ID', type: 'text' }, { name: 'Status', type: 'text' },
  ] })).json();
  const path = `/tables/${app.tableId}/rows`;
  const other = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Other', Status: 'Ready' } })).json()).row;
  const source = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Source', ID: other.id, Status: 'Ready' } })).json()).row;
  const { workflow } = await (await send('POST', '/workflows', mika, { orgId: ORG, name: 'Legacy approval', trigger: { type: 'row', tableId: app.tableId, on: 'changed' }, steps: [
    { type: 'approval', to: 'toru', title: 'Update the record?' }, { type: 'update_row', ...(explicitRowId ? { rowId: explicitRowId } : {}), values: { Status: 'Done' } },
  ] })).json();
  await send('PATCH', `${path}/${source.id}`, mika, { orgId: ORG, values: { Status: 'Triggered' } });
  const waiting = (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs[0];
  expect(waiting.status).toBe('waiting');
  expect(waiting.input.recordId).toBe(source.id);
  // Old runs stored only the flattened row scope, where a field could replace id.
  if (legacy) await env.DB.prepare("UPDATE hx_workflow_runs SET input=json_remove(input,'$.recordId') WHERE id=? AND org_id=?").bind(waiting.id, ORG).run();
  const { ws } = await joined(ORG, toru);
  ws.send(JSON.stringify({ type: 'tool_result', payload: { toolCallId: 'legacy-identity', content: { cardId: waiting.cardId, action: 'approve', decidedAt: new Date().toISOString() } } }));
  const finished = await until(async () => {
    const run = (await (await get(`/workflows/${workflow.id}/runs/${waiting.id}?${q({ orgId: ORG })}`, mika)).json()).run;
    return run.status === (legacy ? 'failed' : 'done') ? run : null;
  });
  if (legacy) expect(finished.log[1].error).toContain(explicitRowId ? 'row.id update target is ambiguous' : 'source record ID was not preserved');
  else expect(finished.log[1].rowId).toBe(source.id);
  const rows = (await (await get(`/tables/${app.tableId}?${q({ orgId: ORG })}`, mika)).json()).rows;
  expect(rows.find(row => row.id === source.id).values.status).toBe(legacy ? 'Triggered' : 'Done');
  expect(rows.find(row => row.id === other.id).values.status).toBe('Ready');
});

test.each([false, true])('explicit user ID survives approval; old inputs without it fail closed (legacy: %s)', async legacy => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Explicit approval', columns: [
    { name: 'Name', type: 'text' }, { name: 'ID', type: 'text' }, { name: 'Status', type: 'text' },
  ] })).json();
  const path = `/tables/${app.tableId}/rows`;
  const other = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Other', Status: 'Ready' } })).json()).row;
  const source = (await (await send('POST', path, mika, { orgId: ORG, values: { Name: 'Source', ID: other.id, Status: 'Ready' } })).json()).row;
  const { workflow } = await (await send('POST', '/workflows', mika, { orgId: ORG, name: 'Explicit field approval', trigger: { type: 'row', tableId: app.tableId, on: 'changed' }, steps: [
    { type: 'approval', to: 'toru', title: 'Update?' }, { type: 'update_row', rowId: '{{input.rowFields.id}}', values: { Status: 'Done' } },
  ] })).json();
  await send('PATCH', `${path}/${source.id}`, mika, { orgId: ORG, values: { Status: 'Triggered' } });
  const waiting = (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs[0];
  expect(waiting.input.rowFields).toEqual({ id: other.id });
  if (legacy) await env.DB.prepare("UPDATE hx_workflow_runs SET input=json_remove(input,'$.rowFields') WHERE id=? AND org_id=?").bind(waiting.id, ORG).run();
  const { ws } = await joined(ORG, toru);
  ws.send(JSON.stringify({ type: 'tool_result', payload: { toolCallId: 'explicit-field', content: { cardId: waiting.cardId, action: 'approve', decidedAt: new Date().toISOString() } } }));
  const finished = await until(async () => {
    const run = (await (await get(`/workflows/${workflow.id}/runs/${waiting.id}?${q({ orgId: ORG })}`, mika)).json()).run;
    return run.status === (legacy ? 'failed' : 'done') ? run : null;
  });
  if (legacy) expect(finished.log[1].error).toBe('No row to change.');
  else expect(finished.log[1].rowId).toBe(other.id);
  const rows = (await (await get(`/tables/${app.tableId}?${q({ orgId: ORG })}`, mika)).json()).rows;
  expect(rows.find(row => row.id === source.id).values.status).toBe('Triggered');
  expect(rows.find(row => row.id === other.id).values.status).toBe(legacy ? 'Ready' : 'Done');
});

test("a row delete trigger runs once and carries only the deleted row id", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Record removed",
    trigger: { type: "row", tableId: invoices, on: "deleted" },
    steps: [{ type: "post", channel: "b:ops", text: "Record {{row.id}} was removed." }],
  })).json();
  const added = await (await send("POST", `/tables/${invoices}/rows`, mika, {
    orgId: ORG, values: { Client: "Private Customer", "Invoice #": "INV-DEL", Amount: 1200, Status: "Draft" },
  })).json();
  const response = await send("DELETE", `/tables/${invoices}/rows/${added.row.id}?${q({ orgId: ORG, expectedUpdatedAt: added.row.updatedAt })}`, mika);
  expect(response.status).toBe(200);
  const { runs } = await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ trigger: "row", status: "done", input: { tableId: invoices, event: "deleted", row: { id: added.row.id } } });
  expect(JSON.stringify(runs[0].input)).not.toContain("Private Customer");
  expect((await messages(mika)).map(message => message.body)).toContain(`Record ${added.row.id} was removed.`);

  const deleted = { id: added.row.id, values: added.row.values, updatedAt: added.row.updatedAt };
  expect(await onRowDelete(env, { orgId: ORG, table: { id: invoices }, row: deleted, by: "9302" })).toBe(0);
  expect((await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs).toHaveLength(1);
});

test("delete events bypass field-data filters, and delete-only triggers reject them", async () => {
  expect(normalizeTrigger({ type: "row", tableId: invoices, on: "deleted", where: { Status: "Draft" } }).error).toContain("no field data");
  expect(normalizeTrigger({ type: "row", tableId: invoices, on: "deleted", column: "Status" }).error).toContain("no field data");
  const filtered = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Filtered any event", trigger: { type: "row", tableId: invoices, on: "any", where: { Status: "Draft" } },
    steps: [{ type: "post", channel: "b:ops", text: "This filter has no delete payload." }],
  })).json();
  const legacyAny = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Existing any event", trigger: { type: "row", tableId: invoices, on: "any" },
    steps: [{ type: "post", channel: "b:ops", text: "Existing any means add or change." }],
  })).json();
  const added = await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Acme", "Invoice #": "INV-FILTER", Amount: 100, Status: "Draft" } })).json();
  expect(await onRowDelete(env, { orgId: ORG, table: { id: invoices }, row: added.row, by: "9302" })).toBe(0);
  const { runs } = await (await get(`/workflows/${filtered.workflow.id}?${q({ orgId: ORG })}`, mika)).json();
  expect(runs).toHaveLength(1); // The matching add is retained; deletion did not start another run.
  expect(runs[0].input.event).toBeUndefined();
  expect((await (await get(`/workflows/${legacyAny.workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs).toHaveLength(1);
});

test('app record triggers scope to an app entity, filter insert/update data, and omit deleted fields', async () => {
  const invalid=await send('POST','/workflows',mika,{orgId:ORG,name:'Invalid app entity',trigger:{type:'app_record_change',appId:invoicesAppId,entityId:'missing-entity',events:['update']},steps:[{type:'post',channel:'b:ops',text:'No run'}]});
  expect(invalid.status).toBe(400);
  const invalidField=await send('POST','/workflows',mika,{orgId:ORG,name:'Invalid app field',trigger:{type:'app_record_change',appId:invoicesAppId,entityId:'primary',events:['update'],when:{where:{no_such_field:'x'}}},steps:[{type:'post',channel:'b:ops',text:'No run'}]});
  expect(invalidField.status).toBe(400);
  const updated = await send('POST','/workflows',mika,{orgId:ORG,name:'App status changes',trigger:{type:'app_record_change',appId:invoicesAppId,entityId:'primary',events:['update'],when:{where:{Status:'Overdue'}}},steps:[{type:'post',channel:'b:ops',text:'Overdue {{row.Client}}'}]});
  expect(updated.status).toBe(201);
  const {workflow}=await updated.json();
  const added=await (await send('POST',`/tables/${invoices}/rows`,mika,{orgId:ORG,values:{Client:'Acme',Status:'Draft'}})).json();
  expect((await (await get(`/workflows/${workflow.id}?${q({orgId:ORG})}`,mika)).json()).runs).toHaveLength(0);
  await send('PATCH',`/tables/${invoices}/rows/${added.row.id}`,mika,{orgId:ORG,values:{Status:'Overdue'}});
  const runs=(await (await get(`/workflows/${workflow.id}?${q({orgId:ORG})}`,mika)).json()).runs;
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({trigger:'app_record_change',input:{totalCount:1,truncated:false,records:[{event:'update',appId:invoicesAppId,entityId:'primary',recordId:added.row.id,data:expect.objectContaining({status:'Overdue'})}]}});
  expect((await messages(mika)).map(message=>message.body)).toContain('Overdue Acme');

  const deletion=await send('POST','/workflows',mika,{orgId:ORG,name:'App record deleted',trigger:{type:'app_record_change',appId:invoicesAppId,entityId:'primary',events:['delete']},steps:[{type:'post',channel:'b:ops',text:'Removed {{input.records.0.recordId}}'}]});
  expect(deletion.status).toBe(201);
  const {workflow:deleteFlow}=await deletion.json();
  const privateRow=(await (await send('POST',`/tables/${invoices}/rows`,mika,{orgId:ORG,values:{Client:'Private Customer',Status:'Draft'}})).json()).row;
  await send('DELETE',`/tables/${invoices}/rows/${privateRow.id}?${q({orgId:ORG,expectedUpdatedAt:privateRow.updatedAt})}`,mika);
  const deleteRuns=(await (await get(`/workflows/${deleteFlow.id}?${q({orgId:ORG})}`,mika)).json()).runs;
  expect(deleteRuns).toHaveLength(1);
  expect(deleteRuns[0].input.records[0]).toEqual({event:'delete',appId:invoicesAppId,entityId:'primary',recordId:privateRow.id});
  expect(JSON.stringify(deleteRuns[0].input)).not.toContain('Private Customer');
});

test('admin editors cannot redirect a workflow to an app they cannot access',async()=>{
  const {workflow}=await (await send('POST','/workflows',mika,{orgId:ORG,name:'Private app workflow',trigger:{type:'manual'},steps:[{type:'approval',to:'toru',title:'Review'}]})).json();
  await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,?2,'private',1)").bind(ORG,invoicesAppId).run();
  const response=await send('PUT',`/workflows/${workflow.id}`,toru,{orgId:ORG,trigger:{type:'app_record_change',appId:invoicesAppId,entityId:'primary',events:['update']}});
  expect(response.status).toBe(400);
  expect((await response.json()).message).toMatch(/app and entity you can access/);
  expect((await (await get(`/workflows/${workflow.id}?${q({orgId:ORG})}`,mika)).json()).workflow.trigger.type).toBe('manual');
});

test("row event filters use strict scalar types, treat missing separately from null, and ignore duplicate delivery", async () => {
  const make = async (name, where) => {
    const result = await send("POST", "/workflows", mika, {
      orgId: ORG, name,
      trigger: { type: "row", tableId: invoices, on: "changed", ...(where === undefined ? {} : { where }) },
      steps: [{ type: "post", channel: "b:ops", text: name }],
    });
    expect(result.status).toBe(201);
    return (await result.json()).workflow;
  };
  const numeric = await make("Numeric match", { Amount: 5 });
  const string = await make("String does not match", { Amount: "5" });
  const membership = await make("Numeric membership", { Amount: [4, 5] });
  const wrongMembership = await make("String membership does not match", { Amount: ["5"] });
  const missing = await make("Missing field does not match", { Absent: null });
  const nullMatch = await make("Explicit null match", { Amount: null });
  const any = await make("Any actual change");
  const { getTable } = await import("../src/harness/tables.js");
  const table = await getTable(env.DB, ORG, invoices);

  const before = { id: "row-filter-1", values: { amount: 1, status: "Sent" }, updatedAt: "2026-01-01T00:00:00.000Z" };
  const after = { id: before.id, values: { amount: 5, status: "Overdue" }, updatedAt: "2026-01-01T00:00:01.000Z" };
  expect(await onRowChange(env, { orgId: ORG, table, before, row: after, by: "9302" })).toBe(3);
  // Replaying the exact same source event has one durable receipt per workflow.
  expect(await onRowChange(env, { orgId: ORG, table, before, row: after, by: "9302" })).toBe(0);

  const nullBefore = { id: "row-filter-2", values: { amount: 1 }, updatedAt: "2026-01-01T00:00:02.000Z" };
  const nullAfter = { id: nullBefore.id, values: { amount: null }, updatedAt: "2026-01-01T00:00:03.000Z" };
  expect(await onRowChange(env, { orgId: ORG, table, before: nullBefore, row: nullAfter, by: "9302" })).toBe(2);

  const missingAfter = { id: "row-filter-3", values: {}, updatedAt: "2026-01-01T00:00:04.000Z" };
  const missingBefore = { id: missingAfter.id, values: { amount: 1 }, updatedAt: "2026-01-01T00:00:05.000Z" };
  expect(await onRowChange(env, { orgId: ORG, table, before: missingBefore, row: missingAfter, by: "9302" })).toBe(1);

  const noOpBefore = { id: "row-filter-4", values: { amount: 5 }, updatedAt: "2026-01-01T00:00:06.000Z" };
  const noOpAfter = { id: noOpBefore.id, values: { amount: 5 }, updatedAt: "2026-01-01T00:00:07.000Z" };
  expect(await onRowChange(env, { orgId: ORG, table, before: noOpBefore, row: noOpAfter, by: "9302" })).toBe(0);

  const runs = async (workflow) => (await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json()).runs;
  expect(await runs(numeric)).toHaveLength(1);
  expect(await runs(string)).toHaveLength(0);
  expect(await runs(membership)).toHaveLength(1);
  expect(await runs(wrongMembership)).toHaveLength(0);
  expect(await runs(missing)).toHaveLength(0);
  expect(await runs(nullMatch)).toHaveLength(1);
  expect(await runs(any)).toHaveLength(3);
});

test("row filters reject nested values and non-flat filter objects", () => {
  expect(normalizeTrigger({ type: "row", tableId: invoices, where: ["Overdue"] }).error).toBeTruthy();
  expect(normalizeTrigger({ type: "row", tableId: invoices, where: { Amount: { gt: 5 } } }).error).toBeTruthy();
  expect(normalizeTrigger({ type: "row", tableId: invoices, where: { Amount: [5, { value: 6 }] } }).error).toBeTruthy();
  expect(normalizeTrigger({ type: "row", tableId: invoices, where: { Amount: [5, null, "5"] } }).trigger.where).toEqual({ Amount: [5, null, "5"] });
});

test('app record triggers validate Kylon event names and flat strict predicates',()=>{
  expect(normalizeTrigger({type:'app_record_change',appId:'app',entityId:'primary',events:['update','insert'],when:{where:{status:['open','blocked'],priority:2}}}).trigger)
    .toEqual({type:'app_record_change',appId:'app',entityId:'primary',events:['insert','update'],when:{where:{status:['open','blocked'],priority:2}}});
  for(const invalid of [
    {type:'app_record_change',appId:'app',entityId:'primary',events:[]},
    {type:'app_record_change',appId:'app',entityId:'primary',events:['remove']},
    {type:'app_record_change',appId:'app',entityId:'primary',events:['insert','insert']},
    {type:'app_record_change',appId:'app',entityId:'primary',events:['update'],when:{where:{status:{eq:'open'}}}},
    {type:'app_record_change',appId:'app',entityId:'primary',events:['update'],when:{all:[]}},
  ])expect(normalizeTrigger(invalid).error).toBeTruthy();
});

test("declined, a run ends where it stood", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, overdueFlow())).json();
  const row = (await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Globex", Status: "Sent" } })).json()).row;
  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Status: "Overdue" } });
  const [run] = (await (await get(`/workflows/${workflow.id}/runs?${q({ orgId: ORG })}`, mika)).json()).runs;
  const { ws } = await joined(ORG, toru);
  ws.send(JSON.stringify({ type: "tool_result", payload: { toolCallId: "tc-wf2", content: { cardId: run.cardId, action: "decline", decidedAt: new Date().toISOString() } } }));
  const ended = await until(async () => {
    const r = (await (await get(`/workflows/${workflow.id}/runs/${run.id}?${q({ orgId: ORG })}`, mika)).json()).run;
    return r.status === "declined" ? r : null;
  });
  expect(ended.log).toHaveLength(2);
  expect((await messages(mika)).some((m) => m.body.startsWith("Reminder to Globex"))).toBe(false);
});

test("a webhook starts a run with what was posted, and only with its secret", async () => {
  const made = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "New invoice from billing",
    trigger: { type: "webhook" },
    steps: [{ type: "add_row", tableId: invoices, values: { Client: "{{input.client}}", Amount: "{{input.amount}}", Status: "Draft" } }],
  })).json();
  expect(made.hookUrl).toMatch(/\/hooks\/workflows\/wf_[0-9a-f]+\?secret=[0-9a-f]{48}$/);
  expect(made.workflow.webhookSignatureRequired).toBe(true);
  expect((await signedWebhook(made.hookUrl, "wrong", { client: "X" })).status).toBe(404);
  expect((await signedWebhook(made.hookUrl, made.workflow.hookSecret, { client: "Initech", amount: "1,500" })).status).toBe(202);
  const { rows } = await (await get(`/tables/${invoices}?${q({ orgId: ORG })}`, mika)).json();
  expect(rows.map((r) => r.values)).toEqual([expect.objectContaining({ client: "Initech", amount: 1500, status: "Draft" })]);
  // Someone who may not change it never sees the secret.
  const seen = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(seen.canEdit).toBe(true);
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9303", login: "kai", name: "Kai", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9303", "member");
  const kai = await createSession(env.DB, "9303", "gho_kai");
  const kaiSees = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, kai)).json();
  expect(kaiSees.workflow.hookSecret).toBeUndefined();
  expect((await send("PUT", `/workflows/${made.workflow.id}`, kai, { orgId: ORG, enabled: false })).status).toBe(403);
});

test('signed webhook verifies freshness and atomically deduplicates event IDs', async () => {
  const made = await (await send('POST', '/workflows', mika, {
    orgId: ORG, name: 'Signed deliveries', trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: '{{input.client}}', Status: 'Draft' } }],
  })).json();
  const url = new URL(made.hookUrl);
  const raw = JSON.stringify({ client: 'Once' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventId = 'billing-order-123';
  const unsigned = await call(url.pathname + url.search, { method: 'POST', body: raw });
  expect(unsigned.status).toBe(401);

  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  expect((await signedWebhook(made.hookUrl, made.workflow.hookSecret, raw, 'stale-event', { timestamp: staleTimestamp })).status).toBe(401);
  const tamperEventId = 'tampered-body';
  const validSignature = await signWorkflowWebhook(made.workflow.hookSecret, timestamp, tamperEventId, raw);
  expect((await signedWebhook(made.hookUrl, made.workflow.hookSecret, { client: 'Tampered' }, tamperEventId, { timestamp, signature: validSignature })).status).toBe(401);

  const first = await signedWebhook(made.hookUrl, made.workflow.hookSecret, raw, eventId, { timestamp });
  expect(first.status).toBe(202);
  const firstBody = await first.json();
  const retry = await signedWebhook(made.hookUrl, made.workflow.hookSecret, raw, eventId, { timestamp });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ status: 'duplicate', runId: firstBody.runId });

  const changed = await signedWebhook(made.hookUrl, made.workflow.hookSecret, { client: 'Changed' }, eventId, { timestamp });
  expect(changed.status).toBe(409);
  const { rows } = await (await get(`/tables/${invoices}?${q({ orgId: ORG })}`, mika)).json();
  expect(rows.map(row => row.values.client)).toEqual(['Once']);
  expect(await env.DB.prepare('SELECT status,run_id FROM hx_workflow_webhook_receipts WHERE org_id=?1 AND workflow_id=?2 AND event_id=?3').bind(ORG,made.workflow.id,eventId).first())
    .toMatchObject({ status: 'accepted', run_id: firstBody.runId });
});

test('grandfathered URL-only webhooks continue to work until the credential is rotated', async () => {
  const made = await (await send('POST', '/workflows', mika, {
    orgId: ORG, name: 'Legacy sender', trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: '{{input.client}}', Status: 'Draft' } }],
  })).json();
  await env.DB.prepare('UPDATE hx_workflows SET webhook_signature_required=0 WHERE org_id=?1 AND id=?2').bind(ORG,made.workflow.id).run();
  const url = new URL(made.hookUrl);
  const response = await call(url.pathname + url.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 'Existing integration' }) });
  expect(response.status).toBe(202);
  expect((await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, mika)).status).toBe(200);
  await send('POST', `/workflows/${made.workflow.id}/webhook`, mika, { orgId: ORG, action: 'rotate', expectedSecret: made.workflow.hookSecret });
  const current = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, mika)).json();
  expect(current.workflow.webhookSignatureRequired).toBe(true);
  const fresh = new URL(current.workflow.hookUrl);
  const unsigned = await call(fresh.pathname + fresh.search, { method: 'POST', body: '{}' });
  expect(unsigned.status).toBe(401);
});

test("changing away from webhook revokes its URL permanently while pause preserves it", async () => {
  const made = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Webhook lifecycle", trigger: { type: "webhook" },
    steps: [{ type: "add_row", tableId: invoices, values: { Client: "Lifecycle", Status: "Draft" } }],
  })).json();
  const id = made.workflow.id;
  const edit = async patch => {
    const res = await send("PUT", `/workflows/${id}`, mika, { orgId: ORG, ...patch });
    expect(res.status).toBe(200);
    return (await res.json()).workflow;
  };
  const fire = url => signedWebhook(url, new URL(url).searchParams.get('secret'), '{}');
  expect((await edit({ enabled: false })).hookSecret).toBe(made.workflow.hookSecret);
  expect((await fire(made.hookUrl)).status).toBe(202);
  expect((await edit({ enabled: true, name: "Renamed" })).hookSecret).toBe(made.workflow.hookSecret);
  expect((await edit({ trigger: { type: "manual" } })).hookSecret).toBeUndefined();
  expect((await fire(made.hookUrl)).status).toBe(404);
  const restored = await edit({ trigger: { type: "webhook" } });
  expect(restored.hookSecret).toMatch(/^[0-9a-f]{48}$/);
  expect(restored.hookSecret).not.toBe(made.workflow.hookSecret);
  expect((await fire(made.hookUrl)).status).toBe(404);
  const fresh = new URL(made.hookUrl); fresh.searchParams.set('secret', restored.hookSecret);
  expect((await fire(fresh.href)).status).toBe(202);
});

test("webhook rotation and revocation require an editor and reject stale concurrent changes", async () => {
  const made = await (await send("POST", "/workflows", toru, {
    orgId: ORG, name: "Managed webhook", trigger: { type: "webhook" },
    steps: [{ type: "add_row", tableId: invoices, values: { Client: "Managed", Status: "Draft" } }],
  })).json();
  const endpoint = `/workflows/${made.workflow.id}/webhook`;
  const mutate = (token, action, expectedSecret) => send('POST', endpoint, token, { orgId: ORG, action, expectedSecret });
  const fire = secret => signedWebhook(made.hookUrl, secret, '{}');
  expect((await mutate(mika, 'rotate', made.workflow.hookSecret)).status).toBe(403);
  expect((await mutate(toru, 'rotate', undefined)).status).toBe(400);
  expect((await mutate(toru, 'invalid', made.workflow.hookSecret)).status).toBe(400);
  const attempts = await Promise.all([mutate(toru, 'rotate', made.workflow.hookSecret), mutate(toru, 'rotate', made.workflow.hookSecret)]);
  expect(attempts.map(r => r.status).sort()).toEqual([200, 409]);
  const rotated = (await attempts.find(r => r.status === 200).json()).workflow;
  expect(rotated.hookSecret).not.toBe(made.workflow.hookSecret);
  expect((await fire(made.workflow.hookSecret)).status).toBe(404);
  expect((await fire(rotated.hookSecret)).status).toBe(202);
  expect((await mutate(toru, 'revoke', made.workflow.hookSecret)).status).toBe(409);
  const revoked = await (await mutate(toru, 'revoke', rotated.hookSecret)).json();
  expect(revoked.workflow.hookUrl).toBeUndefined();
  expect(revoked.workflow.hookSecret).toBeUndefined();
  await send('PUT', `/workflows/${made.workflow.id}`, toru, { orgId: ORG, name: 'Still revoked', enabled: true });
  const current = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(current.workflow.hookSecret).toBeUndefined();
  expect((await fire(rotated.hookSecret)).status).toBe(404);
  const resumed = await (await mutate(toru, 'rotate', null)).json();
  expect((await fire(resumed.workflow.hookSecret)).status).toBe(202);
});

test("paused webhook deliveries are held and explicit replay cannot dispatch the same event twice", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Paused input', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: '{{input.client}}', Status: 'Draft' } }],
  })).json();
  const id = made.workflow.id;
  const detail = async () => (await get(`/workflows/${id}?${q({ orgId: ORG })}`, toru)).json();
  const fire = (client, eventId) => signedWebhook(made.hookUrl, made.workflow.hookSecret, { client }, eventId);
  const firstResponse = await fire('First', 'paused-delivery-1');
  const first = await firstResponse.json();
  const duplicate = await fire('First', 'paused-delivery-1');
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ status: 'duplicate', eventId: first.eventId });
  expect((await fire('Changed', 'paused-delivery-1')).status).toBe(409);
  const second = await (await fire('Second', 'paused-delivery-2')).json();
  expect(first.status).toBe('held');
  expect((await detail()).runs).toHaveLength(0);
  expect((await detail()).held.count).toBe(2);
  expect((await env.DB.prepare("SELECT status FROM hx_workflow_webhook_receipts WHERE org_id=?1 AND workflow_id=?2 AND event_id='paused-delivery-1'").bind(ORG,id).first()).status).toBe('held');
  const replay = (token, ids) => send('POST', `/workflows/${id}/webhook/replay`, token, { orgId: ORG, eventIds: ids });
  expect((await replay(toru, [first.eventId])).status).toBe(409);
  expect((await replay(mika, [first.eventId])).status).toBe(403);
  await send('PUT', `/workflows/${id}`, toru, { orgId: ORG, enabled: true });
  expect((await detail()).runs).toHaveLength(0);
  const attempts = await Promise.all([replay(toru, [first.eventId]), replay(toru, [first.eventId])]);
  const results = await Promise.all(attempts.map(r => r.json()));
  expect(results.reduce((n,r) => n + r.runs.length, 0)).toBe(1);
  expect(await env.DB.prepare("SELECT status,run_id FROM hx_workflow_webhook_receipts WHERE org_id=?1 AND workflow_id=?2 AND event_id='paused-delivery-1'").bind(ORG,id).first())
    .toMatchObject({ status: 'replayed' });
  expect((await detail()).held.count).toBe(1);
  expect((await (await replay(toru, [first.eventId])).json()).runs).toHaveLength(0);
  expect((await (await replay(toru, [second.eventId])).json()).runs).toHaveLength(1);
  const { rows } = await (await get(`/tables/${invoices}?${q({ orgId: ORG })}`, toru)).json();
  expect(rows.map(r => r.values.client).sort()).toEqual(['First', 'Second']);
});

test("paused webhook queue has a hard cap and expires stored payloads", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Bounded input', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Bounded', Status: 'Draft' } }],
  })).json();
  const future = new Date(Date.now() + 86400000).toISOString();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at)
    SELECT 'test_held_'||x,?1,?2,'{}',?3,?3 FROM n`).bind(ORG, made.workflow.id, future).run();
  const fire = () => signedWebhook(made.hookUrl, made.workflow.hookSecret, '{}');
  expect((await fire()).status).toBe(429);
  await env.DB.prepare("UPDATE hx_workflow_held_events SET expires_at='2000-01-01T00:00:00.000Z'").run();
  expect((await fire()).status).toBe(202);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_held_events').first()).n).toBe(1);
  await runDueWorkflows(env, { now: new Date(Date.now() + 8 * 86400000) });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_held_events').first()).n).toBe(0);
});

test("a webhook checked before credential revocation cannot create a run afterward", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'In flight delivery', trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Must not execute', Status: 'Draft' } }],
  })).json();
  await send('POST', `/workflows/${made.workflow.id}/webhook`, toru, { orgId: ORG, action: 'revoke', expectedSecret: made.workflow.hookSecret });
  const run = await startRun(env, { orgId: ORG, workflow: made.workflow, trigger: 'webhook', input: {}, incomingHookSecret: made.workflow.hookSecret });
  expect(run).toBeNull();
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs WHERE workflow_id=?1').bind(made.workflow.id).first()).n).toBe(0);
});

test("held payload preview is scoped to the editor and exact workflow and never starts a run", async () => {
  const make = async name => (await (await send('POST', '/workflows', toru, {
    orgId: ORG, name, enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'No preview effects', Status: 'Draft' } }],
  })).json());
  const a = await make('Payload preview'), b = await make('Other preview');
  const input = { note: '<script>untrusted()</script>', amount: 12, items: ['one', 'two'] };
  const held = await (await signedWebhook(a.hookUrl, a.workflow.hookSecret, input)).json();
  const path = `/workflows/${a.workflow.id}/webhook/events/${held.eventId}?${q({ orgId: ORG })}`;
  expect((await get(path, mika)).status).toBe(403);
  expect((await (await get(path, toru)).json()).event.input).toEqual(input);
  expect((await get(path.replace(a.workflow.id,b.workflow.id),toru)).status).toBe(404);
  const summary = await (await get(`/workflows/${a.workflow.id}?${q({orgId:ORG})}`,toru)).json();
  expect(summary.held.events[0].input).toBeUndefined();
  expect(summary.runs).toHaveLength(0);
  await env.DB.prepare("UPDATE hx_workflow_held_events SET expires_at='2000-01-01T00:00:00Z' WHERE id=?1 AND org_id=?2").bind(held.eventId,ORG).run();
  expect((await get(path,toru)).status).toBe(404);
});

test("scheduled expiry cleanup removes old payloads across workspaces and preserves unexpired events", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Expiry sweep', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'No run', Status: 'Draft' } }],
  })).json();
  await env.DB.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at)
    SELECT 'wf_other_expiry','other:expiry',name,enabled,trigger,steps,created_by,created_at,updated_at FROM hx_workflows WHERE id=?1 AND org_id=?2`)
    .bind(made.workflow.id, ORG).run();
  const at = new Date().toISOString(), future = new Date(Date.now()+86400000).toISOString();
  for (const [id,org,wf,expires] of [['expired_here',ORG,made.workflow.id,'2000-01-01T00:00:00Z'],['expired_elsewhere','other:expiry','wf_other_expiry','2000-01-01T00:00:00Z'],['future_elsewhere','other:expiry','wf_other_expiry',future]]) {
    await env.DB.prepare('INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)')
      .bind(id,org,wf,'{}',at,expires).run();
  }
  expect(await runDueWorkflows(env)).toBe(0);
  expect((await env.DB.prepare('SELECT id FROM hx_workflow_held_events ORDER BY id').all()).results).toEqual([{id:'future_elsewhere'}]);
});

test("discard removes only reviewed pending events in the authorized workflow", async () => {
  const make = async name => (await (await send('POST', '/workflows', toru, {
    orgId: ORG, name, enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Not executed', Status: 'Draft' } }],
  })).json()).workflow;
  const a = await make('Discard target'), b = await make('Other workflow');
  const at = new Date().toISOString(), expires = new Date(Date.now()+86400000).toISOString();
  for (const [id,wf,runId] of [['reviewed',a,null],['new_arrival',a,null],['already_dispatched',a,'existing_run'],['other_workflow',b,null]]) {
    await env.DB.prepare('INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at,run_id) VALUES(?1,?2,?3,?4,?5,?6,?7)')
      .bind(id,ORG,wf.id,'{}',at,expires,runId).run();
  }
  const discard = (token, eventIds) => send('POST', `/workflows/${a.id}/webhook/discard`, token, { orgId: ORG, eventIds });
  expect((await discard(mika, ['reviewed'])).status).toBe(403);
  expect((await discard(toru, [])).status).toBe(400);
  expect((await discard(toru, ['reviewed','reviewed'])).status).toBe(400);
  expect(await (await discard(toru, ['reviewed','already_dispatched','other_workflow'])).json()).toEqual({ discarded: 1 });
  const { results } = await env.DB.prepare('SELECT id FROM hx_workflow_held_events ORDER BY id').all();
  expect(results.map(x=>x.id)).toEqual(['already_dispatched','new_arrival','other_workflow']);
  expect(await (await discard(toru, ['reviewed'])).json()).toEqual({ discarded: 0 });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs').first()).n).toBe(0);
});

test("a paused workflow can run manually without resuming its schedule", async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Explicit trial while paused', enabled: false,
    trigger: { type: 'schedule', cadence: 'daily', hour: 9, timezone: 'UTC' },
    steps: [{ type: 'add_row', tableId: invoices, values: { Client: 'Manual trial', Status: 'Draft' } }],
  })).json();
  const response = await send('POST', `/workflows/${made.workflow.id}/run`, toru, { orgId: ORG, text: 'Run once' });
  expect(response.status).toBe(201);
  expect((await response.json()).run).toMatchObject({ trigger: 'manual', status: 'done' });
  const detail = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(detail.workflow.enabled).toBe(false);
  expect(detail.workflow.nextRunAt).toBeNull();
  expect(await runDueWorkflows(env, { now: new Date(Date.now() + 86400000) })).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs WHERE workflow_id=?1').bind(made.workflow.id).first()).n).toBe(1);
});

test("a scheduled workflow runs when its time comes, once, and a manual one when asked", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Monday nudge",
    trigger: { type: "schedule", cadence: "weekly", weekday: 1, hour: 9, timezone: "UTC" },
    steps: [{ type: "post", channel: "b:ops", text: "Weekly: check the invoice tracker." }],
  })).json();
  expect(Date.parse(workflow.nextRunAt)).toBeGreaterThan(Date.now());
  const after = new Date(Date.parse(workflow.nextRunAt) + 60000);
  expect(await runDueWorkflows(env, { now: after })).toBe(1);
  expect(await runDueWorkflows(env, { now: after })).toBe(0);
  expect((await messages(mika)).filter((m) => m.body === "Weekly: check the invoice tracker.")).toHaveLength(1);

  const run = (await (await send("POST", `/workflows/${workflow.id}/run`, mika, { orgId: ORG, text: "now please" })).json()).run;
  expect(run).toMatchObject({ trigger: "manual", status: "done", input: { text: "now please" } });
});

test("a follow-up is listed where it was made, may be cancelled, and posts when due", async () => {
  const made = await (await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Check whether Acme paid", minutes: 60 })).json();
  const other = await (await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Never mind this one", minutes: 60 })).json();
  expect((await (await get(`/followups?${q({ orgId: ORG, channel: "b:ops" })}`, toru)).json()).followups).toHaveLength(2);
  expect((await call(`/followups/${other.followup.id}?${q({ orgId: ORG })}`, { method: "DELETE", headers: headers(toru) })).status).toBe(200);
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 2 * 3600000) })).toBe(1);
  expect((await messages(mika)).map((m) => m.body)).toContain("⏰ Follow-up: Check whether Acme paid");
  expect((await (await get(`/followups?${q({ orgId: ORG, status: "done" })}`, toru)).json()).followups.map((f) => f.id)).toEqual([made.followup.id]);
  expect((await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "past", dueAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
});

test("a follow-up made by an account from SSO or the directory is answered by the AI, on its maker's allowance", async () => {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  const { scheduleFollowup } = await import("../src/harness/followups.js");
  const makers = ["sso:personal:hxflows:aaaa", "scim:personal:hxflows:bbbb"];
  for (const [i, id] of makers.entries()) {
    await upsertUser(env.DB, { githubId: id, login: `u:maker${i}@corp.example`, name: `Maker ${i}`, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member", i ? "scim" : "sso");
    const made = await scheduleFollowup(env.DB, { orgId: ORG, channel: "b:ops", instruction: `Say the test phrase ${i}`, dueAt: new Date(Date.now() + 60_000).toISOString(), by: id });
    expect(made.followup).toBeTruthy();
  }
  // Nobody's account: a synthetic maker gets the reminder and spends nothing.
  await env.DB.prepare(`INSERT INTO hx_followups (id, org_id, channel, instruction, due_at, status, created_by, created_at)
    VALUES ('fu_synthetic', ?1, 'b:ops', 'Synthetic', ?2, 'scheduled', 'workflow:wf_1', ?2)`).bind(ORG, new Date(Date.now() + 60_000).toISOString()).run();
  fetchMock.activate();
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: "FOLLOWUP COMPLETE" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }).times(2);
  try {
    await runDueFollowups({ ...env, OPENAI_API_KEY: "sk-test" }, { now: new Date(Date.now() + 2 * 60_000) });
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
  const { results } = await env.DB.prepare("SELECT created_by, status, result FROM hx_followups WHERE org_id = ?1 ORDER BY created_by").bind(ORG).all();
  const byMaker = Object.fromEntries(results.map((r) => [r.created_by, r]));
  for (const id of makers) expect(byMaker[id]).toMatchObject({ status: "done", result: "FOLLOWUP COMPLETE" });
  expect(byMaker["workflow:wf_1"].result).not.toBe("FOLLOWUP COMPLETE");
});

test("asked in the chat, an agent schedules its own follow-up in the thread", async () => {
  const agent = (await (await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Billy", handle: "billy", instructions: "You chase invoices.", scope: "team" })).json()).agent;
  const sent = await (await send("POST", "/channels/messages", mika, { orgId: ORG, channel: "b:ops", body: "@billy follow up in 2 days: check whether Acme paid" })).json();
  const { followups } = await (await get(`/followups?${q({ orgId: ORG, channel: "b:ops" })}`, mika)).json();
  expect(followups).toEqual([expect.objectContaining({ agentId: agent.id, instruction: "check whether Acme paid", threadId: sent.message.id })]);
  expect(Date.parse(followups[0].dueAt) - Date.now()).toBeGreaterThan(47 * 3600000);
});

test("templates, steps and follow-up sentences are read strictly", () => {
  expect(render("{{row.Client}} owes {{row.amount}}{{row.missing}}", { row: { client: "Acme", amount: 5 } })).toBe("Acme owes 5");
  expect(render("{{steps.1.output}}", { steps: { 1: { output: "ok" } } })).toBe("ok");
  expect(normalizeSteps([{ type: "rm -rf" }]).error).toBeTruthy();
  expect(normalizeSteps([]).error).toBeTruthy();
  expect(followupRequest("follow up in 3 days: chase Acme")).toEqual({ minutes: 4320, text: "chase Acme" });
  expect(followupRequest("2時間後にフォローして: 見積の返事")).toEqual({ minutes: 120, text: "見積の返事" });
  expect(followupRequest("follow up later")).toBeNull();
});

test("the harness's home answers in one call: what waits on me, the apps' numbers, the agents' roles, how each workflow last ran", async () => {
  const { workflow } = await (await send("POST", "/workflows", mika, overdueFlow())).json();
  const row = (await (await send("POST", `/tables/${invoices}/rows`, mika, { orgId: ORG, values: { Client: "Acme", Amount: 4800, Status: "Sent" } })).json()).row;
  await send("PATCH", `/tables/${invoices}/rows/${row.id}`, mika, { orgId: ORG, values: { Status: "Overdue" } });
  const agent = (await (await send("POST", "/channels/agents", mika, { orgId: ORG, name: "Billy", handle: "billy", instructions: "You chase invoices.", scope: "team" })).json()).agent;
  expect((await (await get(`/harness/home?${q({ orgId: ORG })}`, toru)).json()).agents).toEqual([]);
  await send("PUT", "/channels/agents", mika, { orgId: ORG, id: agent.id, scope: "team" });
  await send("PUT", `/hx/agents/${agent.id}/profile`, mika, { orgId: ORG, specialty: "Accounts receivable" });
  await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Check Acme", minutes: 60 });

  const home = await (await get(`/harness/home?${q({ orgId: ORG })}`, toru)).json();
  expect(home.mode).toBe("harness");
  expect(home.approvals.toDecide).toEqual([expect.objectContaining({ title: "Send Acme a reminder?", kind: "workflow" })]);
  expect(home.approvals.pendingDecisions).toBe(1);
  expect(home.apps).toEqual([expect.objectContaining({ name: "Invoice tracker", rows: 1, headline: { label: "Open invoices", value: 1 } })]);
  expect(home.agents).toEqual([expect.objectContaining({ handle: "billy", specialty: "Accounts receivable", tier: "standard" })]);
  expect(home.workflows).toEqual([expect.objectContaining({ id: workflow.id, trigger: "row", lastRun: expect.objectContaining({ status: "waiting" }) })]);
  expect(home.followups.map((f) => f.instruction)).toEqual(["Check Acme"]);
});

test("approval resumes the frozen definition even after its workflow is edited", async () => {
  const { createWorkflow, startRun, updateWorkflow, settleWorkflowApproval } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Frozen', trigger: { type: 'manual' }, steps: [
      { type: 'approval', to: 'toru', title: 'Approve original?' },
      { type: 'post', channel: 'b:ops', text: 'Original approved action' },
    ],
  }, '9302');
  const run = await startRun(env, { orgId: ORG, workflow, trigger: 'manual', startedBy: '9302' });
  expect(run.status).toBe('waiting');
  await updateWorkflow(env.DB, ORG, workflow.id, { steps: [{ type: 'post', channel: 'b:ops', text: 'Replacement' }] });
  const done = await settleWorkflowApproval(env, ORG, {
    id: run.cardId, workflowApproval: { runId: run.id }, recipientUserID: 'toru',
    decision: { action: 'approve', actorUserID: 'toru' },
  });
  expect(done.status).toBe('done');
  expect((await messages(mika)).map(m => m.body)).toContain('Original approved action');
  expect((await messages(mika)).map(m => m.body)).not.toContain('Replacement');
});

test("deferred posts cannot enter a room after the owner loses access", async () => {
  const { createWorkflow, startRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Access recheck', trigger: { type: 'manual' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Forbidden' }],
  }, '9302');
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  const run = await startRun(env, { orgId: ORG, workflow, trigger: 'manual' });
  expect(run.status).toBe('failed');
  expect(run.log[0].error).toBe('Conversation access required.');
});

test('private follow-ups are hidden in lists and home and cannot be cancelled by outsiders', async () => {
  const made = await send('POST', '/followups', mika, { orgId: ORG, channel: 'b:ops', instruction: 'Confidential', minutes: 60 });
  expect(made.status).toBe(201);
  const { followup } = await made.json();
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members (org_id, channel, login, added_by, added_at) VALUES (?1, 'b:ops', 'mika', 'mika', ?2)").bind(ORG, new Date().toISOString()).run();
  expect((await (await get(`/followups?${q({ orgId: ORG })}`, toru)).json()).followups).toEqual([]);
  expect((await (await get(`/harness/home?${q({ orgId: ORG })}`, toru)).json()).followups).toEqual([]);
  expect((await call(`/followups/${followup.id}?${q({ orgId: ORG })}`, { method: 'DELETE', headers: headers(toru) })).status).toBe(404);
  expect((await (await get(`/followups?${q({ orgId: ORG })}`, mika)).json()).followups).toHaveLength(1);
});

test('run history retains its original room restrictions after the workflow is edited', async () => {
  const { createWorkflow, startRun, updateWorkflow, getRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, { name: 'Private output', trigger: { type: 'manual' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Private result' }] }, '9302');
  const run = await startRun(env, { orgId: ORG, workflow, trigger: 'manual' });
  await env.DB.prepare("UPDATE businesses SET private = 1 WHERE org_id = ?1 AND slug = 'ops'").bind(ORG).run();
  expect((await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, toru)).status).toBe(404);
  await updateWorkflow(env.DB, ORG, workflow.id, { steps: [{ type: 'approval', to: 'toru', title: 'Public' }] });
  expect(await getRun(env.DB, ORG, run.id, { viewerId: '9301' })).toBeNull();
});

test('natural language generation refuses unavailable AI instead of silently making a substitute', async () => {
  const response = await send('POST', '/workflows/generate', mika, { orgId: ORG, prompt: 'Every day post a reminder', channel: 'b:ops', useModel: false });
  expect(response.status).toBe(503);
  expect((await (await get(`/workflows?${q({ orgId: ORG })}`, mika)).json()).workflows).toEqual([]);
});

test('generated workflows are paused and reject inaccessible resources and unsupported steps', async () => {
  const { workflowFromPrompt } = await import('../src/harness/workflowGeneration.js');
  const spec = { name: 'Daily reminder', trigger: { type: 'schedule', cadence: 'daily', hour: 9, minute: 15, timezone: 'Asia/Tokyo' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Check tasks' }], enabled: true };
  const made = await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'Every day at 9:15 remind us', complete: async () => JSON.stringify(spec) });
  expect(made.workflow.enabled).toBe(false);
  const saved = (await (await send('POST', '/workflows', mika, { orgId: ORG, ...made.workflow })).json()).workflow;
  expect(saved.enabled).toBe(false);
  expect(saved.nextRunAt).toBeNull();
  expect(saved.steps[0].text).toBe('Check tasks');
  expect((await messages(mika)).some(message => message.body === 'Check tasks')).toBe(false);
  expect((await send('POST', `/workflows/${saved.id}/run`, mika, { orgId: ORG })).status).toBe(201);
  expect((await messages(mika)).some(message => message.body === 'Check tasks')).toBe(true);
  expect((await (await get(`/workflows/${saved.id}?${q({ orgId: ORG })}`, mika)).json()).workflow.enabled).toBe(false);
  spec.steps[0].channel = 'b:nonexistent';
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'Post', complete: async () => JSON.stringify(spec) })).status).toBe(403);
  spec.steps = [{ type: 'shell', command: 'echo unsafe' }];
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'Run', complete: async () => JSON.stringify(spec) })).error).toBeTruthy();
});

test('generation validates malformed output, invalid schedules and foreign rooms', async () => {
  const { workflowFromPrompt } = await import('../src/harness/workflowGeneration.js');
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'do something', complete: async () => 'not json' })).error).toBeTruthy();
  expect((await workflowFromPrompt(env.DB, ORG, '9302', { prompt: 'daily', complete: async () => JSON.stringify({ name: 'bad', trigger: { type: 'schedule', cadence: 'daily', hour: 99 }, steps: [{ type: 'post', channel: 'b:ops', text: 'hello' }] }) })).error).toBeTruthy();
  expect((await send('POST', '/workflows/generate', mika, { orgId: ORG, prompt: 'Post', channel: 'b:foreign', useModel: false })).status).toBe(403);
  expect((await send('POST', '/apps/generate', mika, { orgId: ORG, prompt: 'Tracker', channel: 'b:foreign', useModel: false })).status).toBe(403);
});

test('natural-language workflow generation receives the current room guidelines', async () => {
  const { workflowFromPrompt } = await import('../src/harness/workflowGeneration.js');
  const rule = 'Send only the agreed operations summary.';
  await env.DB.prepare('INSERT INTO hx_room_guidelines(org_id,channel,body,version,updated_by,updated_at) VALUES(?,?,?,1,?,?)')
    .bind(ORG, 'b:ops', rule, '9301', new Date().toISOString()).run();
  let requestText = '';
  const spec = { name: 'Guided reminder', trigger: { type: 'manual' }, steps: [{ type: 'post', channel: 'b:ops', text: 'Daily summary' }] };
  const result = await workflowFromPrompt(env.DB, ORG, '9302', {
    prompt: 'Post the daily summary', channel: 'b:ops',
    complete: async (_system, request) => { requestText = request; return JSON.stringify(spec); },
  });
  expect(result.workflow.name).toBe('Guided reminder');
  expect(requestText).toContain('Current room guidelines (revision 1)');
  expect(requestText).toContain(rule);
});

test('an app generated in an agent DM resolves the room and remains private', async () => {
  const { agent } = await (await send('POST', '/channels/agents', mika, { orgId: ORG, name: 'Builder', handle: 'builder', instructions: 'Build apps.', scope: 'personal' })).json();
  const room = `ag:${agent.id}`;
  const response = await send('POST', '/apps/generate', mika, { orgId: ORG, prompt: 'Task tracker', channel: room, useModel: false });
  expect(response.status).toBe(201);
  const { app } = await response.json();
  const listed = await (await get(`/apps?${q({ orgId: ORG, channel: room })}`, mika)).json();
  expect(listed.apps.map(a => a.id)).toContain(app.id);
  expect(listed.apps.find(a => a.id === app.id).channels).toEqual([`${room}|mika`]);
  expect((await get(`/apps/${app.id}?${q({ orgId: ORG })}`, toru)).status).toBe(404);

  const direct = await send('POST', '/apps', mika, { orgId: ORG, name: 'Direct agent app', channel: room, columns: [{ name: 'Title', type: 'text' }] });
  expect(direct.status).toBe(201);
  const { app: directApp } = await direct.json();
  expect(await env.DB.prepare('SELECT channel FROM hx_app_links WHERE org_id=?1 AND app_id=?2').bind(ORG, directApp.id).first()).toEqual({ channel: `${room}|mika` });
  expect(await env.DB.prepare('SELECT visibility FROM hx_app_access WHERE org_id=?1 AND app_id=?2').bind(ORG, directApp.id).first()).toEqual({ visibility: 'private' });

  const unlinked = await send('POST', '/apps', mika, { orgId: ORG, name: 'Agent chat link', columns: [{ name: 'Title', type: 'text' }] });
  const { app: unlinkedApp } = await unlinked.json();
  expect((await send('POST', `/apps/${unlinkedApp.id}/links`, mika, { orgId: ORG, channel: room })).status).toBe(200);
  expect(await env.DB.prepare('SELECT channel FROM hx_app_links WHERE org_id=?1 AND app_id=?2').bind(ORG, unlinkedApp.id).first()).toEqual({ channel: `${room}|mika` });
});

test("an approval goes only to someone in this workspace, checked when saved and again when it runs", async () => {
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  // Zed has an account, in another workspace; Kai is here until removed.
  await upsertUser(env.DB, { githubId: "9304", login: "zed", name: "Zed", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, "personal:elsewhere", "9304", "admin");
  await upsertUser(env.DB, { githubId: "9303", login: "kai", name: "Kai", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9303", "member");
  const flow = (to) => ({ orgId: ORG, name: `Ask ${to}`, trigger: { type: "manual" }, steps: [{ type: "approval", to, title: "Secret plan", summary: "Only for us" }] });

  const refused = await send("POST", "/workflows", mika, flow("zed"));
  expect(refused.status).toBe(400);
  expect((await refused.json()).message).toMatch(/zed/);
  const { workflow: viaTemplate } = await (await send("POST", "/workflows", mika, flow("{{input.who}}"))).json();
  expect((await send("PUT", `/workflows/${viaTemplate.id}`, mika, { orgId: ORG, steps: flow("@zed").steps })).status).toBe(400);
  const { workflow: toKai } = await (await send("POST", "/workflows", mika, flow("kai"))).json();

  const outsider = (await (await send("POST", `/workflows/${viaTemplate.id}/run`, mika, { orgId: ORG, input: { who: "zed" } })).json()).run;
  expect(outsider).toMatchObject({ status: "failed", cardId: null });
  expect(outsider.log[0]).toMatchObject({ status: "failed", error: "Nobody by that name here." });
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9303'").bind(ORG).run();
  const removed = (await (await send("POST", `/workflows/${toKai.id}/run`, mika, { orgId: ORG })).json()).run;
  expect(removed.status).toBe("failed");
  // Nothing was saved or queued for either of them.
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE org_id = ?1").bind(ORG).first()).n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_jobs").first()).n).toBe(0);

  // A member named through the template still gets the approval.
  const member = (await (await send("POST", `/workflows/${viaTemplate.id}/run`, mika, { orgId: ORG, input: { who: "toru" } })).json()).run;
  expect(member.status).toBe("waiting");
  expect((await (await get(`/approvals?${q({ orgId: ORG })}`, toru)).json()).toDecide).toEqual([expect.objectContaining({ title: "Secret plan", kind: "workflow" })]);
});

test("a decision on a run's first approval, replayed, does not answer its second", async () => {
  const { createWorkflow, startRun, settleWorkflowApproval, getRun } = await import("../src/harness/workflows.js");
  const { getCard } = await import("../src/db.js");
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: "Two gates", trigger: { type: "manual" }, steps: [
      { type: "approval", to: "toru", title: "Approve A?" },
      { type: "approval", to: "toru", title: "Approve B?" },
      { type: "post", channel: "b:ops", text: "Reached the final step" },
    ],
  }, "9302");
  const run = await startRun(env, { orgId: ORG, workflow, trigger: "manual", startedBy: "9302" });
  const decided = (card) => ({ ...card, status: "approved", decision: { action: "approve", actorUserID: "toru", decidedAt: new Date().toISOString() } });
  const first = await getCard(env.DB, ORG, run.cardId);
  const atSecond = await settleWorkflowApproval(env, ORG, decided(first));
  expect(atSecond).toMatchObject({ status: "waiting", nextStep: 2 });
  expect(atSecond.cardId).not.toBe(first.id);
  // The first card is kept as it was, beside the second.
  expect((await getCard(env.DB, ORG, first.id)).title).toBe("Approve A?");
  expect((await getCard(env.DB, ORG, atSecond.cardId)).title).toBe("Approve B?");

  expect(await settleWorkflowApproval(env, ORG, decided(first))).toBeNull();
  expect(await getRun(env.DB, ORG, run.id)).toMatchObject({ status: "waiting", nextStep: 2, cardId: atSecond.cardId });
  expect((await messages(mika)).map((m) => m.body)).not.toContain("Reached the final step");

  const done = await settleWorkflowApproval(env, ORG, decided(await getCard(env.DB, ORG, atSecond.cardId)));
  expect(done.status).toBe("done");
  expect((await messages(mika)).map((m) => m.body)).toContain("Reached the final step");
});

test("a workflow's approval card has a priority every client reads, and old ones are repaired", async () => {
  const { createWorkflow, startRun } = await import("../src/harness/workflows.js");
  const { getCard, saveCard } = await import("../src/db.js");
  const { PRIORITIES } = await import("../src/agui/validate.js");
  const { workflow } = await createWorkflow(env.DB, ORG, { name: "Gate", trigger: { type: "manual" }, steps: [{ type: "approval", to: "toru", title: "Go?" }] }, "9302");
  const run = await startRun(env, { orgId: ORG, workflow, trigger: "manual", startedBy: "9302" });
  expect(PRIORITIES.has((await getCard(env.DB, ORG, run.cardId)).priority)).toBe(true);

  await saveCard(env.DB, ORG, { id: "wf-run_old", recipientUserID: "toru", senderUserID: "toru", type: "approval", title: "Old", summary: "", status: "pending", priority: "normal", createdAt: new Date().toISOString(), workflowApproval: { runId: "run_old" } });
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  expect((await getCard(env.DB, ORG, "wf-run_old")).priority).toBe("medium");
  expect((await env.DB.prepare("SELECT priority FROM cards WHERE card_id = 'wf-run_old'").first()).priority).toBe("medium");
});

test("a workflow's follow-up is scheduled with its maker's access, and checked again when due", async () => {
  const { createWorkflow, startRun } = await import("../src/harness/workflows.js");
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: "Chase later", trigger: { type: "manual" }, steps: [{ type: "followup", channel: "b:ops", text: "Did {{input.text}} pay?", minutes: 60 }],
  }, "9302");
  const run = await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { text: "Acme" }, startedBy: "9302" });
  expect(run.status).toBe("done");
  const { followups } = await (await get(`/followups?${q({ orgId: ORG, channel: "b:ops" })}`, mika)).json();
  expect(followups).toEqual([expect.objectContaining({ id: run.log[0].output, instruction: "Did Acme pay?", createdBy: "9302" })]);
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 2 * 3600000) })).toBe(1);
  expect((await messages(mika)).map((m) => m.body)).toContain("⏰ Follow-up: Did Acme pay?");

  // Its maker gone from the workspace, the next one is never posted.
  const again = await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { text: "Globex" }, startedBy: "9302" });
  expect(again.status).toBe("done");
  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = '9302'").bind(ORG).run();
  expect(await runDueFollowups(env, { now: new Date(Date.now() + 2 * 3600000) })).toBe(0);
  expect((await messages(toru)).map((m) => m.body)).not.toContain("⏰ Follow-up: Did Globex pay?");
  expect((await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { text: "Initech" } })).status).toBe("failed");
});

test("what starts a run is kept whole: a large webhook body still renders, and one too large to keep fails before any step", async () => {
  const { createWorkflow, startRun, continueRun, getRun, MAX_INPUT } = await import("../src/harness/workflows.js");
  const made = await (await send("POST", "/workflows", mika, {
    orgId: ORG, name: "Customer hook", trigger: { type: "webhook" },
    steps: [{ type: "post", channel: "b:ops", text: "Customer: {{input.customer}}" }],
  })).json();
  const body = JSON.stringify({ customer: "Acme \"東京\"", padding: "x".repeat(25000) });
  const hooked = await (await signedWebhook(made.hookUrl, made.workflow.hookSecret, body)).json();
  expect(hooked.status).toBe("done");
  expect((await messages(mika)).map((m) => m.body)).toContain("Customer: Acme \"東京\"");
  expect((await getRun(env.DB, ORG, hooked.runId)).input.customer).toBe("Acme \"東京\"");

  const { workflow } = await createWorkflow(env.DB, ORG, { name: "Big", trigger: { type: "manual" }, steps: [{ type: "post", channel: "b:ops", text: "Got {{input.customer}}" }] }, "9302");
  const huge = await startRun(env, { orgId: ORG, workflow, trigger: "manual", input: { customer: "Initech", padding: "x".repeat(MAX_INPUT) } });
  expect(huge).toMatchObject({ status: "failed", input: null });
  expect(huge.log).toEqual([expect.objectContaining({ step: 1, status: "failed", error: expect.stringMatching(/over/) })]);
  expect((await messages(mika)).map((m) => m.body)).not.toContain("Got Initech");

  // A run whose stored input no longer reads as JSON fails rather than
  // going on as though nothing had started it.
  await env.DB.prepare(`INSERT INTO hx_workflow_runs (id, org_id, workflow_id, trigger, status, input, log, next_step, started_at)
    VALUES ('run_cut', ?1, ?2, 'webhook', 'running', '{"customer":"Globex","padding":"xx', '[]', 0, ?3)`).bind(ORG, workflow.id, new Date().toISOString()).run();
  const cut = await continueRun(env, { orgId: ORG, runId: "run_cut", workflow });
  expect(cut.status).toBe("failed");
  expect(cut.log[0]).toMatchObject({ status: "failed", error: "What started this run can no longer be read." });
  expect((await messages(mika)).some((m) => m.body.startsWith("Got "))).toBe(false);
});

test.each(['workflow', 'followup'])('%s reads an installed skill through its execution entry and records both model rounds', async kind => {
  const agent = (await (await send('POST','/channels/agents',mika,{orgId:ORG,name:'Procedure helper',handle:'procedure',instructions:'Follow the installed procedure.',scope:'team'})).json()).agent;
  const skill = (await (await send('POST','/skills',mika,{orgId:ORG,name:'Release procedure',description:'Review a release',body:'CHECK THE FINAL RELEASE RESULT',visibility:'workspace'})).json()).skill;
  expect((await send('POST',`/hx/agents/${agent.id}/skills`,mika,{orgId:ORG,skillId:skill.id})).status).toBe(200);
  const bodies=[];
  fetchMock.activate();
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/chat/completions',method:'POST'}).reply(200,opts=>{
    bodies.push(JSON.parse(opts.body));
    return {choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'read-procedure',type:'function',function:{name:'read_installed_skill',arguments:JSON.stringify({skill_id:skill.id})}}]}}],usage:{prompt_tokens:10,completion_tokens:4}};
  });
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/chat/completions',method:'POST'}).reply(200,opts=>{
    bodies.push(JSON.parse(opts.body));
    return {choices:[{message:{content:'PROCEDURE VERIFIED'}}],usage:{prompt_tokens:20,completion_tokens:6}};
  });
  try {
    const modelEnv={...env,OPENAI_API_KEY:'sk-test'};
    if(kind==='workflow') {
      const {createWorkflow,startRun}=await import('../src/harness/workflows.js');
      const {workflow}=await createWorkflow(env.DB,ORG,{name:'Review release',trigger:{type:'manual'},steps:[{type:'agent',agentId:agent.id,channel:'b:ops',prompt:'Review the release'}]},'9302');
      const result=await startRun(modelEnv,{orgId:ORG,workflow,trigger:'manual',startedBy:'9302'});
      expect(result.status).toBe('done');
      expect(result.log[0].output).toBe('PROCEDURE VERIFIED');
      expect(result.usage).toMatchObject({calls:2,inputTokens:30,outputTokens:10,unknownCalls:0,steps:[{stepNumber:1,calls:2,inputTokens:30,outputTokens:10}]});
    } else {
      const {scheduleFollowup}=await import('../src/harness/followups.js');
      const {followup}=await scheduleFollowup(env.DB,{orgId:ORG,channel:'b:ops',agentId:agent.id,instruction:'Review the release',dueAt:new Date(Date.now()+60000).toISOString(),by:'9302'});
      await runDueFollowups(modelEnv,{now:new Date(Date.now()+120000)});
      expect(await env.DB.prepare('SELECT status,result FROM hx_followups WHERE id=?').bind(followup.id).first()).toMatchObject({status:'done',result:'PROCEDURE VERIFIED'});
    }
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
  expect(bodies[0].messages[0].content).toContain(skill.id);
  expect(bodies[0].messages[0].content).not.toContain('CHECK THE FINAL RELEASE RESULT');
  expect(bodies[1].messages.find(m=>m.role==='tool').content).toContain('CHECK THE FINAL RELEASE RESULT');
  const {results:calls}=await env.DB.prepare('SELECT purpose,input_tokens,output_tokens,user_github_id FROM ai_calls WHERE org_id=? ORDER BY id').bind(ORG).all();
  expect(calls).toEqual([
    {purpose:kind==='workflow'?'workflow_agent':'followup',input_tokens:10,output_tokens:4,user_github_id:'9302'},
    {purpose:kind==='workflow'?'workflow_agent':'followup',input_tokens:20,output_tokens:6,user_github_id:'9302'},
  ]);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_reservations').first()).n).toBe(0);
});

test('a Workflow Agent uses only workspace-approved read-only Remote MCP tools and discards access revoked in flight', async () => {
  const { agent } = await (await send('POST', '/channels/agents', mika, {
    orgId: ORG, name: 'Policy reviewer', handle: 'policy-reviewer', instructions: 'Review workspace policy.', scope: 'team',
  })).json();
  const server = await addWorkflowRemoteMcpServer([
    { name: 'search_policy', title: 'Search policy', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'delete_record', title: 'Delete record', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { destructiveHint: true } },
    { name: 'read_unapproved', title: 'Read unapproved', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  ], ['search_policy', 'delete_record']);
  const { createWorkflow, startRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Check policy source', trigger: { type: 'manual' },
    steps: [{ type: 'agent', agentId: agent.id, channel: 'b:ops', prompt: 'Find the key policy and summarize it.' }],
  }, '9302');
  const requests = [];
  const remote = fetchMock.get('https://workflow-mcp.example.com');
  const message = opts => JSON.parse(opts.body);
  let remoteToolName = null;
  let requestAborted = false;
  fetchMock.activate();
  remote.intercept({ path: '/mcp', method: 'POST', body: body => JSON.parse(body).method === 'initialize' })
    .reply(opts => ({ statusCode: 200, data: { jsonrpc: '2.0', id: message(opts).id, result: { protocolVersion: '2025-06-18' } }, responseOptions: { headers: { 'mcp-session-id': 'workflow-session' } } }));
  remote.intercept({ path: '/mcp', method: 'POST', body: body => JSON.parse(body).method === 'notifications/initialized' }).reply(202, null);
  remote.intercept({ path: '/mcp', method: 'POST', body: body => JSON.parse(body).method === 'tools/call' })
    .reply(opts => ({ statusCode: 200, data: { jsonrpc: '2.0', id: message(opts).id, result: { content: [{ type: 'text', text: 'Workspace policy: keep all keys private.' }] } } }));
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, opts => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    if (requests.length === 1) {
      const names = (body.tools || []).map(tool => tool.function.name);
      remoteToolName = names.find(name => name.startsWith('mcp_'));
      return {
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'policy-search', type: 'function', function: { name: remoteToolName, arguments: JSON.stringify({ query: 'API keys' }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      };
    }
    return { choices: [{ message: { content: 'The policy says never share keys.' } }], usage: { prompt_tokens: 20, completion_tokens: 6 } };
  }).times(2);
  try {
    const result = await startRun({ ...env, OPENAI_API_KEY: 'sk-test' }, { orgId: ORG, workflow, trigger: 'manual', startedBy: '9302' });
    expect(result.status).toBe('done');
    expect(result.log[0].output).toBe('The policy says never share keys.');
    const offered = requests[0].tools.map(tool => tool.function.name);
    expect(offered).toEqual([remoteToolName]);
    expect(requests[1].messages.find(message => message.role === 'tool').content).toContain('Workspace policy: keep all keys private.');
    expect(requests[1].messages.find(message => message.role === 'tool').content).not.toContain('delete_record');
    expect(requests[1].messages.find(message => message.role === 'tool').content).not.toContain('read_unapproved');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_agent_remote_mcp_grants WHERE org_id=?1').bind(ORG).first()).n).toBe(0);
    expect((await messages(mika)).map(message => message.body)).toContain('The policy says never share keys.');
    expect(result.usage).toMatchObject({ calls: 2, inputTokens: 30, outputTokens: 10, unknownCalls: 0 });
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }

  // A changed workspace allowlist during the next provider round invalidates
  // the private MCP context and aborts that request before it can be posted.
  await env.DB.prepare('UPDATE hx_remote_mcp_servers SET allowed_tools=?1 WHERE org_id=?2 AND id=?3')
    .bind(JSON.stringify(['search_policy', 'delete_record']), ORG, server.id).run();
  const { workflow: secondWorkflow } = await createWorkflow(env.DB, ORG, {
    name: 'Check policy source again', trigger: { type: 'manual' },
    steps: [{ type: 'agent', agentId: agent.id, channel: 'b:ops', prompt: 'Find the key policy and summarize it.' }],
  }, '9302');
  const priorMessages = await messages(mika);
  let abortedFetch = false;
  const secondRequests = [];
  fetchMock.activate();
  interceptWorkflowRemoteMcp();
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(async opts => {
    const body = JSON.parse(opts.body);
    secondRequests.push(body);
    if (secondRequests.length === 1) {
      const name = body.tools.find(tool => tool.function.name.startsWith('mcp_')).function.name;
      return { statusCode: 200, data: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'policy-search-again', type: 'function', function: { name, arguments: JSON.stringify({ query: 'API keys' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4 } } };
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Workflow model request was not aborted after the Remote MCP allowlist changed.')), 10_000);
      opts.signal.addEventListener('abort', () => { abortedFetch = true; clearTimeout(timeout); reject(new Error('Workflow model request aborted after the Remote MCP allowlist changed.')); }, { once: true });
      setTimeout(() => env.DB.prepare('UPDATE hx_remote_mcp_servers SET allowed_tools=?1 WHERE org_id=?2 AND id=?3')
        .bind('[]', ORG, server.id).run().catch(error => { clearTimeout(timeout); reject(error); }), 10);
    });
  }).times(2);
  try {
    const result = await startRun({ ...env, OPENAI_API_KEY: 'sk-test' }, { orgId: ORG, workflow: secondWorkflow, trigger: 'manual', startedBy: '9302' });
    expect(result.status).toBe('failed');
    expect(result.log[0].error).toBe('The workflow, source, agent, or conversation access changed while this step was running.');
    expect(abortedFetch).toBe(true);
    expect(await messages(mika)).toHaveLength(priorMessages.length);
    expect(result.usage).toMatchObject({ calls: 2, unknownCalls: 1, unpricedCalls: 1 });
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
});

test('Workflow Agent steps do not receive Remote MCP tools in Simple mode', async () => {
  const { agent } = await (await send('POST', '/channels/agents', mika, {
    orgId: ORG, name: 'Simple reviewer', handle: 'simple-reviewer', instructions: 'Review the prompt.', scope: 'team',
  })).json();
  await addWorkflowRemoteMcpServer([
    { name: 'search_policy', title: 'Search policy', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ], ['search_policy']);
  const { createWorkflow, startRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Simple mode check', trigger: { type: 'manual' },
    steps: [{ type: 'agent', agentId: agent.id, prompt: 'Review the release.' }],
  }, '9302');
  await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode: 'simple' });
  let requestBody;
  fetchMock.activate();
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, opts => {
    requestBody = JSON.parse(opts.body);
    return { choices: [{ message: { content: 'Simple stays simple.' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
  });
  try {
    const result = await startRun({ ...env, OPENAI_API_KEY: 'sk-test' }, { orgId: ORG, workflow, trigger: 'manual', startedBy: '9302' });
    expect(result.status).toBe('done');
    expect(requestBody.tools || []).toEqual([]);
    expect(result.log[0].output).toBe('Simple stays simple.');
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
});

test('an app record workflow stops its Agent after its maker loses app access during the model turn', async () => {
  const sourceApp = (await (await send('POST', '/apps', toru, {
    orgId: ORG, template: 'invoices', sample: false,
  })).json()).app;
  const { agent } = await (await send('POST', '/channels/agents', mika, {
    orgId: ORG, name: 'App reviewer', handle: 'app-reviewer', instructions: 'Review the record.', scope: 'team',
  })).json();
  const { createWorkflow, startRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Review app record',
    trigger: { type: 'app_record_change', appId: sourceApp.id, entityId: 'primary', events: ['update'] },
    steps: [{ type: 'agent', agentId: agent.id, channel: 'b:ops', prompt: 'Review the changed record.' }],
  }, '9302');
  let requestBody;
  let requestAborted = false;
  fetchMock.activate();
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(async opts => {
    requestBody = JSON.parse(opts.body);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Provider request was not aborted after source access was removed.')), 10000);
      opts.signal.addEventListener('abort', () => {
        requestAborted = true;
        clearTimeout(timeout);
        reject(new Error('Provider request aborted after source access was removed.'));
      }, { once: true });
      setTimeout(() => {
        env.DB.prepare(`INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES(?1,?2,'private',1)
          ON CONFLICT(org_id,app_id) DO UPDATE SET visibility='private',version=version+1`).bind(ORG, sourceApp.id).run().catch(error => {
            clearTimeout(timeout);
            reject(error);
          });
      }, 10);
    });
  });
  try {
    const result = await startRun({ ...env, OPENAI_API_KEY: 'sk-test' }, {
      orgId: ORG,
      workflow,
      trigger: 'app_record_change',
      input: { tableId: sourceApp.tableId, records: [{ event: 'update', appId: sourceApp.id, entityId: 'primary', recordId: 'private-row', data: { status: 'review' } }] },
      startedBy: '9302',
    });
    expect(result.status).toBe('failed');
    expect(result.log[0].error).toBe('The workflow, source, agent, or conversation access changed while this step was running.');
    expect((await messages(mika)).map(message => message.body)).not.toContain('This private app reply must not be published.');
    expect(requestAborted).toBe(true);
    expect(result.usage).toMatchObject({ calls: 1, unknownCalls: 1, unpricedCalls: 1 });
    expect(requestBody.messages.some(message => message.content?.includes('Review the changed record.'))).toBe(true);
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
});

test('a workflow Agent grant revoked during its model turn prevents publishing the reply', async () => {
  await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode: 'simple' });
  const { agent } = await (await send('POST', '/channels/agents', toru, {
    orgId: ORG, name: 'Restricted reviewer', handle: 'restricted-reviewer', instructions: 'Review the release.', scope: 'team',
  })).json();
  await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode: 'harness' });
  await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at)
    VALUES (?1,?2,'people','["mika"]','now')
    ON CONFLICT(org_id,agent_id) DO UPDATE SET access='people',people='["mika"]'`).bind(ORG, agent.id).run();
  const { createWorkflow, startRun } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Restricted review', trigger: { type: 'manual' },
    steps: [{ type: 'agent', agentId: agent.id, channel: 'b:ops', prompt: 'Review the release' }],
  }, '9302');
  let requestBody;
  fetchMock.activate();
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, async opts => {
    requestBody = JSON.parse(opts.body);
    await env.DB.prepare("UPDATE hx_agent_profiles SET people='[\"toru\"]' WHERE org_id=?1 AND agent_id=?2").bind(ORG, agent.id).run();
    return { choices: [{ message: { content: 'This reply must not be published.' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } };
  });
  try {
    const result = await startRun({ ...env, OPENAI_API_KEY: 'sk-test' }, {
      orgId: ORG, workflow, trigger: 'manual', startedBy: '9302',
    });
    expect(result.status).toBe('failed');
    expect(result.log[0].error).toBe('The workflow, source, agent, or conversation access changed while this step was running.');
    expect((await messages(mika)).map(message => message.body)).not.toContain('This reply must not be published.');
    expect(requestBody.messages.some(message => message.content?.includes('Review the release'))).toBe(true);
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
});

test('a personal-agent follow-up reads connected sources before reporting and never exposes write tools', async () => {
  const agent = (await (await send('POST', '/channels/agents', mika, { orgId: ORG, name: 'Invoice checker', handle: 'invoice-checker', instructions: 'Check the invoice status.', scope: 'personal' })).json()).agent;
  const channel = `ag:${agent.id}|mika`;
  await env.DB.prepare(`INSERT INTO org_apps (org_id,server,name,description,verified,allow_writes,added_by,added_at)
    VALUES (?1,'linear','Linear','Issue tracker',1,1,'9301',?2)`).bind(ORG, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO app_connections (id,org_id,user_github_id,server,status,created_at,updated_at)
    VALUES ('connection-mika',?1,'9302','linear','connected',?2,?2)`).bind(ORG, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO hx_agent_app_grants (org_id,agent_id,user_github_id,server,created_at)
    VALUES (?1,?2,'9302','linear',?3)`).bind(ORG, agent.id, new Date().toISOString()).run();
  const { followup } = await (await import('../src/harness/followups.js')).scheduleFollowup(env.DB, {
    orgId: ORG, channel, agentId: agent.id, instruction: 'Check whether invoice INV-7 is paid',
    dueAt: new Date(Date.now() + 60_000).toISOString(), by: '9302',
  });
  expect(followup).toBeTruthy();
  const bodies = [];
  fetchMock.activate();
  fetchMock.get('https://api.smithery.ai').intercept({ path: '/tokens', method: 'POST' })
    .reply(200, { token: 'short-lived-test-token' });
  fetchMock.get('https://api.smithery.ai').intercept({ path: '/connect/honmaru-test/connection-mika/.tools', method: 'GET' })
    .reply(200, { tools: [
      { name: 'search_issues', description: 'Search issues', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    ] });
  fetchMock.get('https://api.smithery.ai').intercept({ path: '/connect/honmaru-test/connection-mika/.tools/search_issues', method: 'POST' })
    .reply(200, { content: [{ type: 'text', text: 'INV-7 status: paid; https://linear.app/acme/issue/INV-7' }] });
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, opts => {
    const body = JSON.parse(opts.body); bodies.push(body);
    expect(body.tool_choice).toBe('required');
    expect(body.tools.map(tool => tool.function.name)).toContain('app1_search_issues');
    expect(body.tools.map(tool => tool.function.name)).not.toContain('app1_create_issue');
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'search-invoice', type: 'function', function: { name: 'app1_search_issues', arguments: JSON.stringify({ query: 'INV-7' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
  });
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, opts => {
    bodies.push(JSON.parse(opts.body));
    return { choices: [{ message: { content: 'Invoice INV-7 is paid (Linear issue INV-7: https://linear.app/acme/issue/INV-7).' } }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
  });
  try {
    const modelEnv = { ...env, OPENAI_API_KEY: 'sk-test', SMITHERY_API_KEY: 'sk-smithery-test', SMITHERY_NAMESPACE: 'honmaru-test' };
    await runDueFollowups(modelEnv, { now: new Date(Date.now() + 120_000) });
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
  expect(bodies).toHaveLength(2);
  expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('INV-7 status: paid') });
  expect(await env.DB.prepare('SELECT status,result FROM hx_followups WHERE id=?').bind(followup.id).first())
    .toMatchObject({ status: 'done', result: expect.stringContaining('https://linear.app/acme/issue/INV-7') });
});

test('a personal-agent follow-up drops native-source results if its grant is revoked before the model responds', async () => {
  const agent = (await (await send('POST', '/channels/agents', mika, { orgId: ORG, name: 'Payroll checker', handle: 'payroll-checker', instructions: 'Check the policy.', scope: 'personal' })).json()).agent;
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO connector_sync_state (user_github_id,synced_at,org_id) VALUES ('9302',?1,?2)").bind(at, ORG).run();
  await env.DB.prepare("INSERT INTO connector_config (user_github_id,connector,config,updated_at) VALUES ('9302','notion',?1,?2)")
    .bind(JSON.stringify({ connected: true }), at).run();
  const grant = await call(`/hx/agents/${agent.id}/apps`, {
    method: 'POST', headers: headers(mika), body: JSON.stringify({ orgId: ORG, source: 'notion' }),
  }, { COMPOSIO_API_KEY: 'ck-test' });
  expect(grant.status).toBe(200);

  const followupId = 'fu_native_grant_revoke';
  await env.DB.prepare(`INSERT INTO hx_followups (id,org_id,channel,agent_id,instruction,due_at,status,created_by,created_at)
    VALUES (?1,?2,?3,?4,'Check the payroll policy',?5,'scheduled','9302',?6)`)
    .bind(followupId, ORG, `ag:${agent.id}|mika`, agent.id, new Date(Date.now() + 60_000).toISOString(), at).run();

  fetchMock.activate();
  fetchMock.get('https://backend.composio.dev').intercept({ path: '/api/v3/tools/execute/NOTION_SEARCH_NOTION_PAGE', method: 'POST' })
    .reply(200, { results: [{ response: { data: { results: [{
      properties: { Title: { type: 'title', title: [{ plain_text: 'Private payroll policy' }] }, Notes: { type: 'rich_text', rich_text: [{ plain_text: 'Confidential details.' }] } },
      url: 'https://notion.so/private-payroll-policy',
    }] } } }] });
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'private-search', type: 'function', function: { name: 'search_notion', arguments: JSON.stringify({ query: 'payroll policy' }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  });
  fetchMock.get('https://api.openai.com').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, async () => {
    await env.DB.prepare("DELETE FROM hx_agent_source_grants WHERE org_id=?1 AND agent_id=?2 AND user_github_id='9302' AND source='notion'").bind(ORG, agent.id).run();
    return { choices: [{ message: { content: 'Private payroll policy: confidential details.' } }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
  });
  try {
    const ran = await runDueFollowups({ ...env, OPENAI_API_KEY: 'sk-test', COMPOSIO_API_KEY: 'ck-test' }, { now: new Date(Date.now() + 120_000) });
    expect(ran).toBe(0);
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
  expect(await env.DB.prepare('SELECT status,result FROM hx_followups WHERE id=?1').bind(followupId).first())
    .toMatchObject({ status: 'failed', result: 'The follow-up did not receive a result. No completion was posted.' });
  expect((await messages(mika)).some(message => /Private payroll policy|confidential details/i.test(message.body))).toBe(false);
});

test("a follow-up with no model result fails instead of posting its instruction as a completed answer", async () => {
  const made = await (await send("POST", "/followups", mika, { orgId: ORG, channel: "b:ops", instruction: "Verify the invoice payment", minutes: 1 })).json();
  fetchMock.activate();
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(503, "Unavailable");
  try {
    expect(await runDueFollowups({ ...env, OPENAI_API_KEY: "sk-test" }, { now: new Date(Date.now() + 120000) })).toBe(0);
    fetchMock.assertNoPendingInterceptors();
  } finally { fetchMock.deactivate(); }
  const result = await env.DB.prepare("SELECT status, result FROM hx_followups WHERE org_id = ?1 AND id = ?2").bind(ORG, made.followup.id).first();
  expect(result.status).toBe("failed");
  expect(result.result).toContain("did not receive a result");
  expect((await messages(mika)).some(m => m.body.includes("Verify the invoice payment"))).toBe(false);
});

test("follow-up agent filtering happens before the workspace limit and preserves conversation access", async () => {
  const at = "2026-10-01T00:00:00Z";
  const insert = env.DB.prepare("INSERT INTO hx_followups (id,org_id,channel,agent_id,instruction,due_at,status,created_by,created_at) VALUES (?1,?2,?3,?4,'history',?5,'failed','maker',?5)");
  await env.DB.batch(Array.from({ length: 201 }, (_, i) => insert.bind(`other_${i}`, ORG, 'b:ops', 'other-agent', at)));
  await env.DB.batch([
    insert.bind('target_visible', ORG, 'b:ops', 'target-agent', '2026-10-02T00:00:00Z'),
    insert.bind('target_hidden', ORG, 'b:not-accessible', 'target-agent', '2026-10-02T00:00:00Z'),
  ]);
  const response = await get(`/followups?${q({ orgId: ORG, status: 'failed', agentId: 'target-agent' })}`, mika);
  expect(response.status).toBe(200);
  expect((await response.json()).followups.map(f => f.id)).toEqual(['target_visible']);
});

test("follow-up history pages use visible records and stable tied-date ordering", async () => {
  const insert = env.DB.prepare("INSERT INTO hx_followups (id,org_id,channel,agent_id,instruction,due_at,status,created_by,created_at) VALUES (?1,?2,?3,'paged-agent','history','2026-10-01T00:00:00Z','failed','maker','2026-10-01T00:00:00Z')");
  await env.DB.batch(Array.from({length:55},(_,i)=>insert.bind(`visible_${String(i).padStart(3,'0')}`,ORG,'b:ops')));
  await env.DB.batch(Array.from({length:201},(_,i)=>insert.bind(`hidden_${i}`,ORG,'b:not-accessible')));
  const query={orgId:ORG,status:'failed',agentId:'paged-agent',paged:'1'};
  const first=await (await get(`/followups?${q(query)}`,mika)).json();
  expect(first.followups).toHaveLength(50);
  expect(first.nextCursor).not.toContain('hidden_');
  const { followupHistory } = await import('../src/harness/followups.js');
  expect(await followupHistory(null, 'another-workspace', { agentId: 'paged-agent', status: 'failed', viewerId: 'maker', cursor: first.nextCursor })).toMatchObject({ status: 400 });
  const second=await (await get(`/followups?${q({...query,cursor:first.nextCursor})}`,mika)).json();
  expect(second.followups).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.followups,...second.followups].map(x=>x.id)).size).toBe(55);
  expect((await get(`/followups?${q({...query,status:'done',cursor:first.nextCursor})}`,mika)).status).toBe(400);
  expect((await get(`/followups?${q({...query,cursor:'not-json'})}`,mika)).status).toBe(400);
});

test('all follow-up statuses retain agent, workspace and conversation scope', async () => {
  const statuses = ['scheduled', 'running', 'done', 'failed', 'cancelled'];
  const insert = env.DB.prepare("INSERT INTO hx_followups (id,org_id,channel,agent_id,instruction,due_at,status,created_by,created_at) VALUES (?1,?2,?3,?4,'all history','2026-10-01T00:00:00Z',?5,'maker','2026-10-01T00:00:00Z')");
  await env.DB.batch([
    ...statuses.map((status,i)=>insert.bind(`all_${i}`,ORG,'b:ops','all-agent',status)),
    insert.bind('all_hidden',ORG,'b:not-accessible','all-agent','done'),
    insert.bind('all_other_agent',ORG,'b:ops','other-agent','done'),
    insert.bind('all_other_workspace','other-org','b:ops','all-agent','done'),
  ]);
  for (const paged of [undefined, '1']) {
    const response = await get(`/followups?${q({orgId:ORG,status:'all',agentId:'all-agent',...(paged?{paged}:{})})}`,mika);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.followups.map(f=>f.status)).toEqual(statuses);
    expect(body.followups.map(f=>f.id)).toEqual(statuses.map((_,i)=>`all_${i}`));
  }
  const defaults = await (await get(`/followups?${q({orgId:ORG,agentId:'all-agent'})}`,mika)).json();
  expect(defaults.followups.map(f=>f.status)).toEqual(['scheduled']);
});

test('follow-ups reject invalid thread destinations and fail if their root is deleted before delivery', async () => {
  const { postMessage } = await import('../src/channels.js');
  const root = await postMessage(env.DB, {orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Follow-up source'});
  const reply = await postMessage(env.DB, {orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Reply',parentId:root.row.id});
  const other = await postMessage(env.DB, {orgId:ORG,key:'b:other',authorLogin:'mika',body:'Other conversation'});
  for (const threadId of ['missing-root', reply.row.id, other.row.id]) {
    const res = await send('POST','/followups',mika,{orgId:ORG,channel:'b:ops',threadId,instruction:'Do not deliver',minutes:60});
    expect(res.status).toBe(404);
  }
  const made = await (await send('POST','/followups',mika,{orgId:ORG,channel:'b:ops',threadId:root.row.id,instruction:'Check delivery',minutes:60})).json();
  expect(made.followup.threadId).toBe(root.row.id);
  await env.DB.prepare('UPDATE channel_messages SET deleted_at = ?1 WHERE org_id = ?2 AND id = ?3').bind(new Date().toISOString(),ORG,root.row.id).run();
  expect(await runDueFollowups(env,{now:new Date(Date.now()+120*60000)})).toBe(0);
  const stored = await env.DB.prepare('SELECT status,result FROM hx_followups WHERE org_id = ?1 AND id = ?2').bind(ORG,made.followup.id).first();
  expect(stored.status).toBe('failed');
  expect(stored.result).toContain('thread is unavailable');
});

test('continuation does not advance waiting or terminal workflow runs',async()=>{
 const {continueRun}=await import('../src/harness/workflows.js');
 const workflow={id:'protected-flow',name:'Protected',createdBy:'9301',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Must not be posted'}]};
 for(const status of ['waiting','done','failed','declined']) {
  const id=`protected-${status}`;
  await env.DB.prepare('INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,next_step,started_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)').bind(id,ORG,workflow.id,'manual',status,'[]',new Date().toISOString()).run();
  const result=await continueRun(env,{orgId:ORG,runId:id,workflow});expect(result.status).toBe(status);expect(result.log).toEqual([]);expect(result.nextStep).toBe(0);
 }
 expect((await messages(toru)).map(m=>m.body)).not.toContain('Must not be posted');
});

test('concurrent triggers admit one run, approval waits hold admission, and terminal runs release it', async () => {
  const { createWorkflow } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Single active execution', trigger: { type: 'manual' },
    steps: [{ type: 'post', channel: 'b:ops', text: 'Only once' }, { type: 'approval', to: 'toru', title: 'Continue?' }],
  }, '9302');
  const results = await Promise.all(Array.from({ length: 4 }, () => startRun(env, { orgId: ORG, workflow, trigger: 'manual', startedBy: '9302' })));
  const admitted = results.filter(r => r.id);
  expect(admitted).toHaveLength(1);
  expect(admitted[0].status).toBe('waiting');
  expect(results.filter(r => r.status === 'skipped')).toHaveLength(3);
  expect((await messages(mika)).filter(m => m.body === 'Only once')).toHaveLength(1);
  const manual = await send('POST', `/workflows/${workflow.id}/run`, mika, { orgId: ORG });
  expect(manual.status).toBe(409);
  expect(await manual.json()).toMatchObject({ reason: 'already_running' });
  const count = await env.DB.prepare('SELECT count(*) AS n FROM hx_workflow_run_definitions WHERE org_id=?1').bind(ORG).first();
  expect(count.n).toBe(1);
  // Simulate terminal settlement: only running/waiting executions hold admission.
  await env.DB.prepare("UPDATE hx_workflow_runs SET status='failed' WHERE id=?1 AND org_id=?2").bind(admitted[0].id, ORG).run();
  expect((await startRun(env, { orgId: ORG, workflow, trigger: 'manual', startedBy: '9302' })).status).toBe('waiting');
});

test('busy webhook deliveries are acknowledged as skipped without duplicate approval or retry instruction', async () => {
  const made = await send('POST', '/workflows', mika, {
    orgId: ORG, name: 'One hook at a time', enabled: true, trigger: { type: 'webhook' },
    steps: [{ type: 'approval', to: 'toru', title: 'Review hook?' }],
  });
  const { hookUrl, workflow } = await made.json();
  const deliver = () => signedWebhook(hookUrl, workflow.hookSecret, '{}');
  expect((await (await deliver()).json()).status).toBe('waiting');
  const second = await deliver();
  expect(second.status).toBe(202);
  expect(await second.json()).toEqual({ status: 'skipped', reason: 'already_running' });
  const detail = await (await get(`/workflows/${workflow.id}?${q({ orgId: ORG })}`, mika)).json();
  expect(detail.runs).toHaveLength(1);
});

test('replay leaves held events unconsumed when an earlier replay waits for approval', async () => {
  const made = await (await send('POST', '/workflows', toru, {
    orgId: ORG, name: 'Held approval', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'approval', to: 'toru', title: 'Review delivery?' }],
  })).json();
  const ids = [];
  for (let n = 0; n < 2; n++) ids.push((await (await signedWebhook(made.hookUrl, made.workflow.hookSecret, '{}')).json()).eventId);
  await send('PUT', `/workflows/${made.workflow.id}`, toru, { orgId: ORG, enabled: true });
  const result = await (await send('POST', `/workflows/${made.workflow.id}/webhook/replay`, toru, { orgId: ORG, eventIds: ids })).json();
  expect(result.runs).toHaveLength(1);
  expect(result.skipped).toBe(1);
  const detail = await (await get(`/workflows/${made.workflow.id}?${q({ orgId: ORG })}`, toru)).json();
  expect(detail.runs).toHaveLength(1);
  expect(detail.held.count).toBe(1);
});

test('three real failures pause execution, keep webhook input, and require authorized generation-aware resume',async()=>{
 const {agent}=await(await send('POST','/channels/agents',mika,{orgId:ORG,name:'No model',handle:'no-model',instructions:'Run',scope:'team'})).json();
 const made=await(await send('POST','/workflows',mika,{orgId:ORG,name:'Failing automation',enabled:true,trigger:{type:'webhook'},steps:[{type:'agent',agentId:agent.id,prompt:'Run'}]})).json();
 const id=made.workflow.id;
 const {postMessage}=await import('../src/channels.js');
 const root=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Created here'});
 expect((await send('POST',`/workflows/${id}/source`,mika,{orgId:ORG,messageId:root.row.id})).status).toBe(200);
 for(let n=0;n<3;n++){
  const result=await send('POST',`/workflows/${id}/run`,mika,{orgId:ORG});
  expect(result.status).toBe(201);expect((await result.json()).run.status).toBe('failed');
 }
 const detail=await(await get(`/workflows/${id}?${q({orgId:ORG})}`,mika)).json();
 const replies=await env.DB.prepare('SELECT body FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(ORG,root.row.id).all();
 expect(replies.results).toHaveLength(1);expect(replies.results[0].body).toContain('three consecutive failures');
 expect(detail.workflow.enabled).toBe(true);
 expect(detail.workflow.safety).toMatchObject({failure_streak:3,pause_reason:'consecutive_failures'});
 expect((await send('POST',`/workflows/${id}/run`,mika,{orgId:ORG})).status).toBe(409);
 expect((await(await signedWebhook(made.hookUrl,made.workflow.hookSecret,'{}')).json()).status).toBe('held');
 const generation=detail.workflow.safety.generation;
 expect((await send('POST',`/workflows/${id}/resume`,mika,{orgId:ORG,generation:'stale'})).status).toBe(409);
 const resumed=await send('POST',`/workflows/${id}/resume`,mika,{orgId:ORG,generation});
 expect(resumed.status).toBe(200);
 expect((await resumed.json()).safety).toMatchObject({failure_streak:0,paused_at:null});
 expect((await send('POST',`/workflows/${id}/resume`,mika,{orgId:ORG,generation})).status).toBe(409);
 expect((await send('POST',`/workflows/${id}/run`,mika,{orgId:ORG})).status).toBe(201);
 const after=await(await get(`/workflows/${id}?${q({orgId:ORG})}`,mika)).json();
 expect(after.runs).toHaveLength(4);expect(after.held.count).toBe(1);
});

test('operational pause is visible in the list but only maker/admin can resume it',async()=>{
 const {workflow}=await(await send('POST','/workflows',toru,{orgId:ORG,name:'Admin automation',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Hello'}]})).json();
 const {ensureWorkflowSafety}=await import('../src/harness/workflowSafety.js');
 const safety=await ensureWorkflowSafety(env.DB,ORG,workflow.id);
 await env.DB.prepare("UPDATE hx_workflow_safety SET failure_streak=3,paused_at='now',pause_reason='consecutive_failures' WHERE org_id=?1 AND workflow_id=?2").bind(ORG,workflow.id).run();
 const list=await(await get(`/workflows?${q({orgId:ORG})}`,mika)).json();
 expect(list.workflows.find(w=>w.id===workflow.id).safety.paused_at).toBe('now');
 expect((await send('POST',`/workflows/${workflow.id}/resume`,mika,{orgId:ORG,generation:safety.generation})).status).toBe(403);
 expect((await send('POST',`/workflows/${workflow.id}/resume`,toru,{orgId:ORG,generation:safety.generation})).status).toBe(200);
});

test('safety notices are creator-scoped, require current workflow access, and read acknowledgement is idempotent',async()=>{
 const {workflow}=await(await send('POST','/workflows',mika,{orgId:ORG,name:'Notice target',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Hello'}]})).json();
 await env.DB.prepare("INSERT INTO hx_workflow_safety_notices(org_id,workflow_id,generation,run_id,recipient_id,created_at) VALUES(?1,?2,'g','r','9302','now')").bind(ORG,workflow.id).run();
 const list=async(token)=>(await(await get(`/workflows/notices?${q({orgId:ORG})}`,token)).json()).items;
 expect(await list(toru)).toEqual([]);
 expect(await list(mika)).toEqual([expect.objectContaining({workflowId:workflow.id,name:'Notice target',readAt:null})]);
 const body={orgId:ORG,workflowId:workflow.id,generation:'g'};
 expect((await send('POST','/workflows/notices',toru,body)).status).toBe(404);
 expect((await send('POST','/workflows/notices',mika,body)).status).toBe(200);
 const readAt=(await list(mika))[0].readAt;
 expect(typeof readAt).toBe('string');
 await send('POST','/workflows/notices',mika,body);
 expect((await list(mika))[0].readAt).toBe(readAt);
 // Current resource ACL, not past recipient identity, controls disclosure.
 await env.DB.prepare("UPDATE hx_workflows SET steps=?1 WHERE org_id=?2 AND id=?3").bind(JSON.stringify([{type:'agent',agentId:'deleted-private-agent',prompt:'Hidden'}]),ORG,workflow.id).run();
 expect(await list(mika)).toEqual([]);
 expect((await send('POST','/workflows/notices',mika,body)).status).toBe(404);
});

test('workflow source is explicit, creator-bound, immutable and never exposes another workspace thread',async()=>{
 const {postMessage}=await import('../src/channels.js');
 const {workflow}=await(await send('POST','/workflows',mika,{orgId:ORG,name:'Threaded automation',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Done'}]})).json();
 const root=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Create this automation'});
 const other=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'mika',body:'A different thread'});
 const reply=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Reply',parentId:root.row.id});
 const source=(token,messageId)=>send('POST',`/workflows/${workflow.id}/source`,token,{orgId:ORG,messageId});
 const candidates=await(await get(`/workflows/${workflow.id}/source?${q({orgId:ORG,candidates:'1'})}`,mika)).json();
 expect(candidates.canBind).toBe(true);expect(candidates.candidates.map(r=>r.id)).toContain(root.row.id);expect(candidates.candidates.map(r=>r.id)).not.toContain(reply.row.id);
 const otherViewer=await(await get(`/workflows/${workflow.id}/source?${q({orgId:ORG,candidates:'1'})}`,toru)).json();
 expect(otherViewer).toMatchObject({canBind:false,candidates:[]});
 const foreign=await postMessage(env.DB,{orgId:'other-workspace',key:'b:ops',authorLogin:'mika',body:'Foreign thread'});
 expect((await source(mika,foreign.row.id)).status).toBe(404);
 expect((await source(toru,root.row.id)).status).toBe(403);
 expect((await source(mika,reply.row.id)).status).toBe(404);
 expect((await source(mika,root.row.id)).status).toBe(200);
 expect((await source(mika,root.row.id)).status).toBe(200);
 expect((await source(mika,other.row.id)).status).toBe(409);
 const read=await(await get(`/workflows/${workflow.id}/source?${q({orgId:ORG})}`,mika)).json();
 expect(read.source.threadId).toBe(root.row.id);
 await env.DB.prepare('UPDATE channel_messages SET deleted_at=?1 WHERE org_id=?2 AND id=?3').bind('now',ORG,root.row.id).run();
 expect((await get(`/workflows/${workflow.id}/source?${q({orgId:ORG})}`,mika)).status).toBe(404);
});

test('pause delivery posts once to the bound thread despite concurrent retries and a lost delivery acknowledgement',async()=>{
 const {postMessage}=await import('../src/channels.js');
 const {ensureWorkflowSafety}=await import('../src/harness/workflowSafety.js');
 const {deliverWorkflowNotices}=await import('../src/harness/workflowNoticeDelivery.js');
 const {workflow}=await(await send('POST','/workflows',mika,{orgId:ORG,name:'Thread notice',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Done'}]})).json();
 const root=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Automation source'});
 await send('POST',`/workflows/${workflow.id}/source`,mika,{orgId:ORG,messageId:root.row.id});
 const {generation}=await ensureWorkflowSafety(env.DB,ORG,workflow.id);
 await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at='now',failure_streak=3 WHERE org_id=?1 AND workflow_id=?2").bind(ORG,workflow.id).run();
 await env.DB.prepare("INSERT INTO hx_workflow_safety_notices(org_id,workflow_id,generation,run_id,recipient_id,created_at) VALUES(?1,?2,?3,'failed-run','9302','now')").bind(ORG,workflow.id,generation).run();
 await Promise.all([deliverWorkflowNotices(env,ORG,workflow.id),deliverWorkflowNotices(env,ORG,workflow.id)]);
 await env.DB.prepare('UPDATE hx_workflow_safety_notices SET delivered_at=NULL WHERE org_id=?1 AND workflow_id=?2').bind(ORG,workflow.id).run();
 const {retryWorkflowNotices}=await import('../src/harness/workflowNoticeDelivery.js');
 expect(await retryWorkflowNotices(env)).toBe(1);
 const replies=await env.DB.prepare('SELECT body,kind FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(ORG,root.row.id).all();
 expect(replies.results).toHaveLength(1);expect(replies.results[0].kind).toBe('ai');expect(replies.results[0].body).toContain('three consecutive failures');
 await env.DB.prepare('UPDATE hx_workflow_safety_notices SET delivered_at=NULL WHERE org_id=?1 AND workflow_id=?2').bind(ORG,workflow.id).run();
 const guarded=()=>postMessage(env.DB,{orgId:ORG,key:'b:ops',parentId:root.row.id,authorLogin:'__workflow',kind:'ai',body:'No stale notice',clientId:'tmp-stale-notice',workflowNotice:{workflowId:workflow.id,generation,recipientId:'9302'}});
 await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at=NULL WHERE org_id=?1 AND workflow_id=?2").bind(ORG,workflow.id).run();
 expect((await guarded()).code).toBe('notice_changed');
 await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at='now' WHERE org_id=?1 AND workflow_id=?2").bind(ORG,workflow.id).run();
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=?1 AND slug='ops'").bind(ORG).run();
 await env.DB.prepare("DELETE FROM conversation_members WHERE org_id=?1 AND channel='b:ops' AND login='mika'").bind(ORG).run();
 expect((await guarded()).code).toBe('notice_changed');
 await env.DB.prepare("DELETE FROM memberships WHERE org_id=?1 AND user_github_id='9302'").bind(ORG).run();
 expect((await guarded()).code).toBe('notice_changed');
 expect(await deliverWorkflowNotices(env,ORG,workflow.id)).toBe(0);
});

test('warning-mode AI budget posts a price-estimate notice once to the bound source thread',async()=>{
 const {postMessage}=await import('../src/channels.js');
 const {ensureWorkflowSafety,saveWorkflowBudget,workflowSettlementStatements}=await import('../src/harness/workflowSafety.js');
 const {deliverWorkflowAiBudgetNotices}=await import('../src/harness/workflowNoticeDelivery.js');
 const {workflow}=await(await send('POST','/workflows',mika,{orgId:ORG,name:'AI budget warning',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Review'}]})).json();
 const root=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'mika',body:'Budget warning source'});
 await send('POST',`/workflows/${workflow.id}/source`,mika,{orgId:ORG,messageId:root.row.id});
 const {generation}=await ensureWorkflowSafety(env.DB,ORG,workflow.id);
 await saveWorkflowBudget(env.DB,ORG,workflow.id,{revision:0,dailyLimit:0,weeklyLimit:0,monthlyLimit:0,dailyAiLimitUsd:.1,weeklyAiLimitUsd:0,monthlyAiLimitUsd:0,aiBudgetAction:'warn'});
 const runId='ai-budget-warning-run',now=new Date().toISOString();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,log,started_at,finished_at) VALUES(?1,?2,?3,'manual','done','[]',?4,?4)").bind(runId,ORG,workflow.id,now),
  env.DB.prepare("INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES(?1,?2,?3,?4)").bind(runId,ORG,JSON.stringify({safetyGeneration:generation}),now),
  env.DB.prepare("INSERT INTO hx_workflow_usage(id,org_id,workflow_id,run_id,step_number,provider,model,input_tokens,output_tokens,byok,created_at,estimated_micros) VALUES('ai-budget-warning-usage',?1,?2,?3,1,'OpenAI','gpt-4o-mini',1000000,0,0,?4,150000)").bind(ORG,workflow.id,runId,now),
 ]);
 await env.DB.batch(workflowSettlementStatements(env.DB,ORG,runId));
 expect(await deliverWorkflowAiBudgetNotices(env,ORG,workflow.id)).toBe(1);
 expect(await deliverWorkflowAiBudgetNotices(env,ORG,workflow.id)).toBe(0);
 const replies=await env.DB.prepare('SELECT body,kind FROM channel_messages WHERE org_id=?1 AND parent_id=?2').bind(ORG,root.row.id).all();
 expect(replies.results).toHaveLength(1);
 expect(replies.results[0].kind).toBe('ai');
 expect(replies.results[0].body).toContain('rolling 24 hours');
 expect(replies.results[0].body).toContain('not an invoice');
 expect(await env.DB.prepare('SELECT delivered_at FROM hx_workflow_ai_budget_notices WHERE org_id=?1 AND workflow_id=?2').bind(ORG,workflow.id).first()).toMatchObject({delivered_at:expect.any(String)});
});

test('conditional steps save their decision, skip unmatched effects and retain step numbering',async()=>{
 const when={path:['input','amount'],op:'gt',value:100};
 const response=await send('POST','/workflows',mika,{orgId:ORG,name:'Conditional invoice',trigger:{type:'manual'},steps:[
  {type:'post',channel:'b:ops',text:'Large invoice',when},
  {type:'post',channel:'b:ops',text:'Small invoice',when:{not:when}},
 ]});
 expect(response.status).toBe(201);
 const {workflow}=await response.json();expect(workflow.steps[0].when).toEqual(when);
 const run=await startRun(env,{orgId:ORG,workflow,trigger:'manual',input:{amount:150},startedBy:'9302'});
 expect(run.status).toBe('done');expect(run.log.map(entry=>[entry.step,entry.status])).toEqual([[1,'ok'],[2,'skipped']]);
 const bodies=(await messages(mika)).map(message=>message.body);
 expect(bodies).toContain('Large invoice');expect(bodies).not.toContain('Small invoice');
 const checkpoints=await env.DB.prepare('SELECT node_id,status,result FROM hx_workflow_node_checkpoints WHERE org_id=?1 AND run_id=?2 ORDER BY node_id').bind(ORG,run.id).all();
 expect(checkpoints.results.map(row=>[row.node_id,row.status,JSON.parse(row.result).matches])).toEqual([['condition:1','done',true],['condition:2','done',false]]);
 expect(normalizeSteps([{type:'post',channel:'b:ops',text:'bad',when:{path:['input','__proto__'],op:'exists',value:true}}]).error).toBeTruthy();
});

test('conditions reject forward, self and malformed step references even inside groups',()=>{
 const step={type:'post',channel:'b:ops',text:'Review'};
 for(const index of ['0','1','2','3','01','-1','1.5','output']) {
  const when={all:[{not:{path:['steps',index,'status'],op:'eq',value:'done'}}]};
  const result=normalizeSteps([{...step,when}]);
  expect(result.error).toContain('earlier steps');
 }
 const when={any:[{path:['steps','1','status'],op:'eq',value:'done'},{path:['input','override'],op:'eq',value:true}]};
 expect(normalizeSteps([step,{...step,when}]).steps[1].when).toEqual(when);
 expect(normalizeSteps([step,{...step,when:{path:['steps','2','output'],op:'exists',value:false}}]).error).toContain('earlier steps');
});

test('workflow edits reject stale observed updates without overwriting the winning definition',async()=>{
 const {createWorkflow,updateWorkflow,getWorkflow}=await import('../src/harness/workflows.js');
 const made=await createWorkflow(env.DB,ORG,{name:'Original',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Before'}]},'9302');
 const first=made.workflow;
 const result=await updateWorkflow(env.DB,ORG,first.id,{name:'Winner',expectedUpdatedAt:first.updatedAt});
 expect(result.workflow.name).toBe('Winner');
 expect(result.workflow.updatedAt).not.toBe(first.updatedAt);
 expect(await updateWorkflow(env.DB,ORG,first.id,{name:'Stale',expectedUpdatedAt:first.updatedAt})).toMatchObject({status:409});
 expect((await getWorkflow(env.DB,ORG,first.id)).name).toBe('Winner');
});


test('editing content preserves the scheduled cursor, while disabling and schedule changes recalculate it',async()=>{
 const {createWorkflow,updateWorkflow,getWorkflow}=await import('../src/harness/workflows.js');
 const {workflow}=await createWorkflow(env.DB,ORG,{name:'Schedule',trigger:{type:'schedule',cadence:'daily',hour:9,timezone:'UTC'},steps:[{type:'post',channel:'b:ops',text:'Before'}]},'9302');
 const due='2026-01-01T09:00:00.000Z';
 await env.DB.prepare('UPDATE hx_workflows SET next_run_at=?1 WHERE id=?2').bind(due,workflow.id).run();
 const edited=await updateWorkflow(env.DB,ORG,workflow.id,{name:'Renamed',trigger:workflow.trigger,steps:workflow.steps,expectedUpdatedAt:workflow.updatedAt});
 expect(edited.workflow.nextRunAt).toBe(due);
 const paused=await updateWorkflow(env.DB,ORG,workflow.id,{enabled:false});
 expect(paused.workflow.nextRunAt).toBeNull();
 const resumed=await updateWorkflow(env.DB,ORG,workflow.id,{enabled:true});
 expect(Date.parse(resumed.workflow.nextRunAt)).toBeGreaterThan(Date.now());
 const changed=await updateWorkflow(env.DB,ORG,workflow.id,{trigger:{...workflow.trigger,hour:10}});
 expect(changed.workflow.nextRunAt).not.toBe(resumed.workflow.nextRunAt);
 expect((await getWorkflow(env.DB,ORG,workflow.id)).name).toBe('Renamed');
});


test('schedule definitions reject invalid values rather than silently shifting execution time',async()=>{
 const {normalizeTrigger}=await import('../src/harness/workflows.js');
 const schedule={type:'schedule',cadence:'weekly',hour:9,minute:30,weekday:0,timezone:'Asia/Tokyo'};
 for(const patch of [{hour:24},{hour:-1},{minute:60},{minute:null},{weekday:7},{weekday:1.5},{timezone:'Not/AZone'},{timezone:''},{cadence:'monthly',monthday:0},{cadence:'monthly',monthday:32}])expect(normalizeTrigger({...schedule,...patch}).error).toBeTruthy();
 expect(normalizeTrigger(schedule).trigger).toEqual(schedule);
 expect(normalizeTrigger({type:'schedule',cadence:'daily'}).trigger).toMatchObject({hour:9,minute:0,timezone:'UTC'});
 expect(normalizeTrigger({type:'schedule',kind:'cron',expr:'0 9 * * 1-5',timezone:'Asia/Tokyo'}).trigger).toEqual({type:'schedule',kind:'cron',expr:'0 9 * * 1-5',timezone:'Asia/Tokyo'});
 expect(normalizeTrigger({type:'schedule',kind:'every',everyMs:600000}).trigger).toEqual({type:'schedule',kind:'every',everyMs:600000});
 expect(normalizeTrigger({type:'schedule',kind:'at',at:'2026-10-26T09:00:00+09:00'}).trigger.at).toBe('2026-10-26T00:00:00.000Z');
 for(const invalid of [
  {type:'schedule',kind:'cron',expr:'* * * * *',timezone:'UTC'},
  {type:'schedule',kind:'cron',expr:'0 9 * * *',timezone:'Not/AZone'},
  {type:'schedule',kind:'every',everyMs:599999},
  {type:'schedule',kind:'every',everyMs:8640000000000001},
  {type:'schedule',kind:'at',at:'2026-02-30T09:00:00Z'},
  {type:'schedule',kind:'unknown'},
 ]) expect(normalizeTrigger(invalid).error).toBeTruthy();
});

test('workflow revision HTTP route returns accessible history and rejects invalid cursors',async()=>{
 const created=await send('POST','/workflows',mika,{orgId:ORG,name:'History original',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'History'}]});
 const {workflow}=await created.json();
 await send('PUT',`/workflows/${workflow.id}`,mika,{orgId:ORG,name:'History edited',expectedUpdatedAt:workflow.updatedAt});
 const result=await get(`/workflows/${workflow.id}/revisions?orgId=${encodeURIComponent(ORG)}`,mika);
 expect(result.status).toBe(200);
 const data=await result.json();expect(data.items.map(item=>item.definition.name)).toEqual(['History edited','History original']);
 expect((await get(`/workflows/${workflow.id}/revisions?orgId=${encodeURIComponent(ORG)}&before=-1`,mika)).status).toBe(400);
});

test('workflow rollback is maker/admin-only, compare-and-swap protected, and audited',async()=>{
 const created=await send('POST','/workflows',toru,{orgId:ORG,name:'Rollback original',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Original'}]});
 const {workflow}=await created.json();
 const edited=await send('PUT',`/workflows/${workflow.id}`,toru,{orgId:ORG,name:'Rollback current',expectedUpdatedAt:workflow.updatedAt});
 const current=(await edited.json()).workflow;
 expect((await send('POST',`/workflows/${workflow.id}/rollback`,mika,{orgId:ORG,revision:1,expectedUpdatedAt:current.updatedAt})).status).toBe(403);
 expect((await send('POST',`/workflows/${workflow.id}/rollback`,toru,{orgId:ORG,revision:1,expectedUpdatedAt:workflow.updatedAt})).status).toBe(409);
 const restored=await send('POST',`/workflows/${workflow.id}/rollback`,toru,{orgId:ORG,revision:1,expectedUpdatedAt:current.updatedAt});
 expect(restored.status).toBe(200);
 expect(await restored.json()).toMatchObject({restoredRevision:1,revision:3,workflow:{name:'Rollback original'}});
 expect((await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action='workflow.revision_restored'").bind(ORG).all()).results).toHaveLength(1);
});

test('legacy workflow runs show only an exact revision that existed when their snapshot started',async()=>{
 const {createWorkflow,listRuns,getRun}=await import('../src/harness/workflows.js');
 const {workflow}=await createWorkflow(env.DB,ORG,{name:'Legacy history',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Stable'}]},'9302');
 const definition={name:workflow.name,enabled:workflow.enabled,trigger:workflow.trigger,steps:workflow.steps,createdBy:workflow.createdBy};
 await env.DB.prepare('DELETE FROM hx_workflow_revisions WHERE org_id=?1 AND workflow_id=?2').bind(ORG,workflow.id).run();
 for(const [revision,recordedAt] of [[1,'2026-10-28T00:00:00.000Z'],[2,'2026-10-30T00:00:00.000Z']]){
  await env.DB.prepare('INSERT INTO hx_workflow_revisions(org_id,workflow_id,revision,definition,recorded_at) VALUES(?1,?2,?3,?4,?5)')
   .bind(ORG,workflow.id,revision,JSON.stringify(definition),recordedAt).run();
 }
 const addRun=async(id,startedAt,snapshot)=>{
  await env.DB.prepare("INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,input,log,next_step,started_by,started_at,finished_at) VALUES(?1,?2,?3,'manual','done',NULL,'[]',0,'9302',?4,?4)")
   .bind(id,ORG,workflow.id,startedAt).run();
  if(snapshot!==undefined)await env.DB.prepare('INSERT INTO hx_workflow_run_definitions(run_id,org_id,definition,created_at) VALUES(?1,?2,?3,?4)')
   .bind(id,ORG,JSON.stringify(snapshot),'2026-10-30T00:00:00.000Z').run();
 };
 const frozen={...definition,id:workflow.id,safetyGeneration:'legacy'};
 await addRun('run-before-revision','2026-10-27T00:00:00.000Z',frozen);
 await addRun('run-matched-as-of','2026-10-29T00:00:00.000Z',frozen);
 await addRun('run-unmatched-snapshot','2026-10-29T00:00:00.000Z',{...frozen,name:'Unrecorded edit'});
 await addRun('run-without-snapshot','2026-10-29T00:00:00.000Z');
 const runs=await listRuns(env.DB,ORG,workflow.id);
 const byId=Object.fromEntries(runs.map(run=>[run.id,run]));
 expect(byId['run-matched-as-of']).toMatchObject({definitionRevision:1,definitionSnapshotAvailable:true});
 expect(byId['run-before-revision']).toMatchObject({definitionRevision:null,definitionSnapshotAvailable:true});
 expect(byId['run-unmatched-snapshot']).toMatchObject({definitionRevision:null,definitionSnapshotAvailable:true});
 expect(byId['run-without-snapshot']).toMatchObject({definitionRevision:null,definitionSnapshotAvailable:false});
 expect(await getRun(env.DB,ORG,'run-matched-as-of')).toMatchObject({definitionRevision:1,definitionSnapshotAvailable:true});
});

test('workflow run budgets enforce limits, reject stale editors, and resume after usage rolls into a new window',async()=>{
 const created=await send('POST','/workflows',mika,{orgId:ORG,name:'Budgeted workflow',trigger:{type:'manual'},steps:[{type:'post',channel:'b:ops',text:'Budgeted run'}]});
 expect(created.status).toBe(201);
 const {workflow}=await created.json();
 const budgetResponse=await send('PUT',`/workflows/${workflow.id}/budget`,mika,{orgId:ORG,revision:0,dailyLimit:1,weeklyLimit:0,monthlyLimit:0});
 expect(budgetResponse.status).toBe(200);
 const saved=await budgetResponse.json();expect(saved.budget).toMatchObject({revision:1,daily:{limit:1,used:0,exhausted:false}});
 const first=await send('POST',`/workflows/${workflow.id}/run`,mika,{orgId:ORG,text:''});
 expect(first.status).toBe(201);
 const {run:firstRun}=await first.json();expect(firstRun.status).toBe('done');
 const detail=await(await get(`/workflows/${workflow.id}?orgId=${encodeURIComponent(ORG)}`,mika)).json();
 expect(detail.workflow.safety).toMatchObject({pause_reason:'budget_daily',budget:{daily:{limit:1,used:1,exhausted:true}}});
 const blocked=await send('POST',`/workflows/${workflow.id}/run`,mika,{orgId:ORG,text:''});
 expect(blocked.status).toBe(409);expect((await blocked.json()).reason).toBe('budget_daily');
 const stale=await send('PUT',`/workflows/${workflow.id}/budget`,mika,{orgId:ORG,revision:0,dailyLimit:2,weeklyLimit:0,monthlyLimit:0});
 expect(stale.status).toBe(409);
 const raised=await send('PUT',`/workflows/${workflow.id}/budget`,mika,{orgId:ORG,revision:1,dailyLimit:2,weeklyLimit:0,monthlyLimit:0});
 expect(raised.status).toBe(200);expect((await raised.json()).safety.paused_at).toBeNull();
 const second=await send('POST',`/workflows/${workflow.id}/run`,mika,{orgId:ORG,text:''});
 expect(second.status).toBe(201);expect((await second.json()).run.status).toBe('done');
 expect((await(await get(`/workflows/${workflow.id}?orgId=${encodeURIComponent(ORG)}`,mika)).json()).workflow.safety.pause_reason).toBe('budget_daily');
 await env.DB.prepare("UPDATE hx_workflow_runs SET started_at='2000-01-01T00:00:00.000Z' WHERE org_id=?1 AND workflow_id=?2").bind(ORG,workflow.id).run();
 const afterReset=await send('POST',`/workflows/${workflow.id}/run`,mika,{orgId:ORG,text:''});
 const afterResetBody=await afterReset.json();expect(afterReset.status,JSON.stringify(afterResetBody)).toBe(201);expect(afterResetBody.run.status).toBe('done');
});

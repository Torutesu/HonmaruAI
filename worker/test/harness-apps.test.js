import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { computeView, normalizeDefinition, specFromPrompt } from "../src/harness/apps.js";
import { coerce, normalizeColumns } from "../src/harness/tables.js";

// The harness (docs/kylon-gap-plan.md): a workspace's mode, its Tables, and
// the Apps built on them. Simple stays the default; the harness routes answer
// in either mode.

const ORG = "personal:harness";
let toru, mika, guest, outsider;
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), { ...env });
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
const get = (path, token) => call(path, { headers: headers(token) });
const send = (method, path, token, body) => call(path, { method, headers: headers(token), body: JSON.stringify(body) });

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9101", login: "toru", name: "Toru", avatarUrl: null, locale: "ja" });
  await upsertUser(env.DB, { githubId: "9102", login: "mika", name: "Mika", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9103", login: "gina", name: "Gina", avatarUrl: null, locale: "en" });
  await upsertUser(env.DB, { githubId: "9104", login: "nobody", name: "Nobody", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9101", "admin");
  await upsertMembership(env.DB, ORG, "9102", "member");
  await upsertMembership(env.DB, ORG, "9103", "guest");
  await upsertMembership(env.DB, "personal:elsewhere", "9104", "admin");
  toru = await createSession(env.DB, "9101", "gho_toru");
  mika = await createSession(env.DB, "9102", "gho_mika");
  guest = await createSession(env.DB, "9103", "gho_gina");
  outsider = await createSession(env.DB, "9104", "gho_nobody");
});

test("a workspace is simple until an admin makes it a harness", async () => {
  const before = await (await get(`/orgs/mode?orgId=${ORG}`, mika)).json();
  expect(before).toMatchObject({ mode: "simple", canEdit: false, modes: ["simple", "harness"] });

  expect((await send("PUT", "/orgs/mode", mika, { orgId: ORG, mode: "harness" })).status).toBe(403);
  expect((await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "kylon" })).status).toBe(400);
  const set = await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "harness" });
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ mode: "harness", canEdit: true });
  expect((await (await get(`/orgs/mode?orgId=${ORG}`, mika)).json()).mode).toBe("harness");

  // And back, losing nothing.
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "simple" });
  expect((await (await get(`/orgs/mode?orgId=${ORG}`, mika)).json()).mode).toBe("simple");
});

test("someone outside the workspace, or a guest in it, reaches none of it", async () => {
  expect((await get(`/orgs/mode?orgId=${ORG}`, outsider)).status).toBe(403);
  expect((await get(`/apps?orgId=${ORG}`, outsider)).status).toBe(403);
  expect((await get(`/tables?orgId=${ORG}`, guest)).status).toBe(403);
  expect((await send("POST", "/apps", guest, { orgId: ORG, template: "crm" })).status).toBe(403);
});

test("a table keeps its values in the column's type", async () => {
  const made = await send("POST", "/tables", mika, {
    orgId: ORG, name: "Leads",
    columns: [
      { name: "Company", type: "text" },
      { name: "Value", type: "number" },
      { name: "Stage", type: "select", options: ["Lead", "Won"] },
      { name: "Close", type: "date" },
      { name: "Hot", type: "checkbox" },
    ],
  });
  expect(made.status).toBe(201);
  const { table } = await made.json();
  expect(table.columns.map((c) => c.id)).toEqual(["company", "value", "stage", "close", "hot"]);

  const row = await (await send("POST", `/tables/${table.id}/rows`, mika, {
    orgId: ORG, values: { Company: "Acme", Value: "$1,200", Stage: "Nope", close: "2026-11-01", hot: "yes", unknown: 1 },
  })).json();
  expect(row.row.values).toEqual({ company: "Acme", value: 1200, stage: null, close: "2026-11-01", hot: true });

  const changed = await (await send("PATCH", `/tables/${table.id}/rows/${row.row.id}`, toru, { orgId: ORG, values: { stage: "Won" } })).json();
  expect(changed.row.values).toMatchObject({ company: "Acme", stage: "Won" });
  expect(changed.row.updatedBy).toBe("9101");

  await send("POST", `/tables/${table.id}/rows`, mika, { orgId: ORG, values: { Company: "Globex", Value: 50 } });
  const sorted = await (await get(`/tables/${table.id}?orgId=${ORG}&sort=-value`, mika)).json();
  expect(sorted.rows.map((r) => r.values.company)).toEqual(["Acme", "Globex"]);
  const found = await (await get(`/tables/${table.id}?orgId=${ORG}&q=glob`, mika)).json();
  expect(found.rows).toHaveLength(1);

  // Renaming a column keeps its data.
  const renamed = await (await send("PUT", `/tables/${table.id}`, mika, {
    orgId: ORG, columns: table.columns.map((c) => (c.id === "company" ? { ...c, name: "Account" } : c)),
  })).json();
  expect(renamed.table.columns[0]).toMatchObject({ id: "company", name: "Account" });
});

test("an app from a template: its views, worked out on the server", async () => {
  const made = await send("POST", "/apps", mika, { orgId: ORG, template: "crm", channel: "b:sales" });
  expect(made.status).toBe(201);
  const { app } = await made.json();
  expect(app).toMatchObject({ name: "Sales CRM", template: "crm", version: 1 });

  const rendered = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  expect(rendered.rows).toHaveLength(3);
  expect(rendered.app.channels).toEqual(["b:sales"]);
  const board = rendered.views.find((v) => v.type === "board");
  expect(board.lanes.map((l) => l.key)).toEqual(["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]);
  expect(board.lanes.find((l) => l.key === "Proposal").rows[0].values.company).toBe("Acme");
  const forecast = rendered.views.find((v) => v.type === "metrics");
  expect(forecast.values.find((m) => m.label === "Open pipeline").value).toBe(42000);
  expect(forecast.values.find((m) => m.label === "Open deals").value).toBe(3);

  // Linked to the room it was made in, and found from it.
  const inRoom = await (await get(`/apps?orgId=${ORG}&channel=b:sales`, mika)).json();
  expect(inRoom.apps.map((a) => a.id)).toEqual([app.id]);
  expect(inRoom.apps[0].channels).toEqual(["b:sales"]);
});

test("an app is versioned, and an old version comes back as a new one", async () => {
  const { app } = await (await send("POST", "/apps", mika, { orgId: ORG, template: "tracker", sample: false })).json();
  const v2 = await (await send("PUT", `/apps/${app.id}`, mika, { orgId: ORG, name: "Launch checklist", note: "Renamed" })).json();
  expect(v2.app).toMatchObject({ name: "Launch checklist", version: 2 });
  const versions = await (await get(`/apps/${app.id}/versions?orgId=${ORG}`, mika)).json();
  expect(versions.versions.map((v) => v.version)).toEqual([2, 1]);
  const back = await (await send("POST", `/apps/${app.id}/versions`, mika, { orgId: ORG, version: 1 })).json();
  expect(back.app).toMatchObject({ name: "Tracker", version: 3 });
});

test("only its maker or an admin deletes an app, and the table goes with it", async () => {
  const { app } = await (await send("POST", "/apps", toru, { orgId: ORG, template: "invoices" })).json();
  expect((await call(`/apps/${app.id}?orgId=${ORG}`, { method: "DELETE", headers: headers(mika) })).status).toBe(403);
  expect((await call(`/tables/${app.tableId}?orgId=${ORG}`, { method: "DELETE", headers: headers(toru) })).status).toBe(409);
  expect((await call(`/apps/${app.id}?orgId=${ORG}`, { method: "DELETE", headers: headers(toru) })).status).toBe(200);
  expect((await get(`/tables/${app.tableId}?orgId=${ORG}`, toru)).status).toBe(404);
  const log = await env.DB.prepare("SELECT action FROM audit_log WHERE org_id = ?1 ORDER BY created_at").bind(ORG).all().catch(() => ({ results: [] }));
  if (log.results.length) expect(log.results.map((r) => r.action)).toEqual(expect.arrayContaining(["app.created", "app.deleted"]));
});

test("a sentence becomes an app without a model, through the closest template", async () => {
  const res = await send("POST", "/apps/generate", mika, { orgId: ORG, prompt: "請求書を追いかけるトラッカーを #ops に" });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body).toMatchObject({ source: "template", room: "ops" });
  expect(body.app.template).toBe("invoices");

  expect((await specFromPrompt("a hiring pipeline for designers")).spec.template).toBe("hiring");
  expect((await specFromPrompt("track our office plants")).spec.template).toBe("tracker");
});

test("a model's design is used when it holds up, and ignored when it does not", async () => {
  const good = await specFromPrompt("warehouse counts", {
    complete: async () => JSON.stringify({ name: "Warehouse counts", icon: "📦", columns: [{ name: "SKU", type: "text" }, { name: "Count", type: "number" }], views: [{ type: "table", name: "All" }] }),
  });
  expect(good).toMatchObject({ source: "model", spec: { name: "Warehouse counts" } });
  const bad = await specFromPrompt("warehouse counts", { complete: async () => "not json" });
  expect(bad.source).toBe("template");
});

test("views drop what the table no longer has, and count what is overdue", () => {
  const { columns } = normalizeColumns([{ name: "Status", type: "select", options: ["Open", "Done"] }, { name: "Due", type: "date" }, { name: "Amount", type: "number" }]);
  const def = normalizeDefinition({ views: [
    { type: "board", groupBy: "missing" },
    { type: "metrics", metrics: [{ op: "sum", column: "gone" }, { label: "Late", op: "count", overdue: "Due", where: { Status: "Open" } }, { label: "Total", op: "sum", column: "Amount" }] },
    { type: "pie" },
  ] }, columns);
  expect(def.views.map((v) => v.type)).toEqual(["board", "metrics"]);
  expect(def.views[0].groupBy).toBe("status");
  const rows = [
    { values: { status: "Open", due: "2026-01-01", amount: 10 } },
    { values: { status: "Open", due: "2099-01-01", amount: 5 } },
    { values: { status: "Done", due: "2026-01-01", amount: 1 } },
  ];
  const m = computeView(def.views[1], { columns }, rows, "2026-10-15");
  expect(m.values.map((v) => [v.label, v.value])).toEqual([["Late", 1], ["Total", 16]]);
  expect(coerce({ type: "email" }, "not an email")).toBeNull();
});

test('calendar views validate date columns and retain undated records without timezone conversion', async () => {
  const { normalizeDefinition, computeView } = await import('../src/harness/apps.js');
  const columns = [{ id: 'name', name: 'Name', type: 'text' }, { id: 'due', name: 'Due', type: 'date' }];
  const { views } = normalizeDefinition({ views: [{ type: 'calendar', dateColumn: 'Due', name: 'Calendar' }] }, columns);
  expect(views[0]).toMatchObject({ type: 'calendar', dateColumn: 'due' });
  const rows = [
    { id: 'leap', values: { due: '2028-02-29' } },
    { id: 'newyear', values: { due: '2029-01-01' } },
    { id: 'empty', values: {} },
    { id: 'invalid', values: { due: '2027-02-29' } },
  ];
  const computed = computeView(views[0], { columns }, rows);
  expect(computed.days.map(d => d.date)).toEqual(['2028-02-29', '2029-01-01']);
  expect(computed.undated.map(r => r.id)).toEqual(['empty', 'invalid']);
  expect(normalizeDefinition({ views: [{ type: 'calendar', dateColumn: 'Name' }] }, columns).views[0].type).toBe('table');
});

test('private apps protect their table, versions, home and MCP even from workspace admins and in Simple', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, template: 'crm' })).json();
  const accessPath = `/apps/${app.id}/access`;
  expect((await send('PUT', accessPath, toru, { orgId: ORG, visibility: 'private', version: 0 })).status).toBe(403);
  expect((await send('PUT', accessPath, mika, { orgId: ORG, visibility: 'private', version: 0 })).status).toBe(200);
  for (const mode of ['simple', 'harness']) {
    await send('PUT', '/orgs/mode', toru, { orgId: ORG, mode });
    for (const path of [`/apps/${app.id}`, `/apps/${app.id}/versions`, accessPath, `/tables/${app.tableId}`]) {
      expect((await get(`${path}?orgId=${ORG}`, toru)).status).toBe(404);
    }
    expect((await (await get(`/apps?orgId=${ORG}`, toru)).json()).apps).toEqual([]);
    expect((await (await get(`/tables?orgId=${ORG}`, toru)).json()).tables).toEqual([]);
    expect((await (await get(`/harness/home?orgId=${ORG}`, toru)).json()).apps).toEqual([]);
    expect((await send('POST', `/tables/${app.tableId}/rows`, toru, { orgId: ORG, values: {} })).status).toBe(404);
    expect((await send('PUT', `/apps/${app.id}`, toru, { orgId: ORG, name: 'Stolen' })).status).toBe(404);
    const { callHarnessTool } = await import('../src/harness/mcpTools.js');
    const principal = { orgId: ORG, githubId: '9101' };
    expect((await callHarnessTool(env, principal, 'list_apps', {})).structuredContent.apps).toEqual([]);
    expect((await callHarnessTool(env, principal, 'read_app', { appId: app.id })).isError).toBe(true);
    expect((await callHarnessTool(env, principal, 'query_rows', { tableId: app.tableId })).isError).toBe(true);
    expect((await callHarnessTool(env, principal, 'add_row', { tableId: app.tableId, values: {} })).isError).toBe(true);
  }
  expect((await get(`/apps/${app.id}?orgId=${ORG}`, mika)).status).toBe(200);
  expect((await send('PUT', accessPath, mika, { orgId: ORG, visibility: 'workspace', version: 0 })).status).toBe(409);
  expect((await send('PUT', accessPath, mika, { orgId: ORG, visibility: 'workspace', version: 1 })).status).toBe(200);
  expect((await get(`/tables/${app.tableId}?orgId=${ORG}`, toru)).status).toBe(200);
});

test('app creators cannot spoof ownership and private grants require live membership', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, by: '9101', name: 'Owned', columns: [{ name: 'Name', type: 'text' }] })).json();
  expect(app.createdBy).toBe('9102');
  const { setAppAccess, mayUseApp } = await import('../src/harness/resourceAccess.js');
  expect((await setAppAccess(env.DB, ORG, app.id, '9102', { visibility: 'public', version: 0 })).error).toBeTruthy();
  await setAppAccess(env.DB, ORG, app.id, '9102', { visibility: 'private', version: 0 });
  await env.DB.prepare('DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2').bind(ORG, '9102').run();
  expect(await mayUseApp(env.DB, ORG, app.id, '9102')).toBe(false);
});

test('table workflows lose access when an app becomes private, including historical runs', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, template: 'crm', sample: false })).json();
  const { createWorkflow, startRun, getRun, getWorkflow } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, { name: 'Write CRM', trigger: { type: 'manual' }, steps: [{ type: 'add_row', tableId: app.tableId, values: { company: 'Before' } }] }, '9101');
  const before = await startRun(env, { orgId: ORG, workflow, trigger: 'manual' });
  expect(before.status).toBe('done');
  await send('PUT', `/apps/${app.id}/access`, mika, { orgId: ORG, visibility: 'private', version: 0 });
  expect(await getWorkflow(env.DB, ORG, workflow.id, { viewerId: '9101' })).toBeNull();
  expect(await getRun(env.DB, ORG, before.id, { viewerId: '9101' })).toBeNull();
  const after = await startRun(env, { orgId: ORG, workflow, trigger: 'manual' });
  expect(after).toMatchObject({ status: 'failed', log: [expect.objectContaining({ error: 'Table access required.' })] });
});

test('MCP can summarize a calendar view', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Calendar', columns: [{ name: 'Due', type: 'date' }], definition: { views: [{ type: 'calendar', dateColumn: 'Due' }] } })).json();
  const { callHarnessTool } = await import('../src/harness/mcpTools.js');
  const result = await callHarnessTool(env, { orgId: ORG, githubId: '9102' }, 'read_app', { appId: app.id });
  expect(result.structuredContent.views[0]).toMatchObject({ days: [], undated: 0 });
});

test('record edits and deletes reject stale snapshots without losing newer values', async () => {
  const { table } = await (await send('POST', '/tables', mika, { orgId: ORG, name: 'Concurrent', columns: [{ name: 'Name', type: 'text' }] })).json();
  const path = `/tables/${table.id}/rows`;
  const { row } = await (await send('POST', path, mika, { orgId: ORG, values: { name: 'Initial' } })).json();
  const updated = await send('PATCH', `${path}/${row.id}`, mika, { orgId: ORG, values: { name: 'Newer' }, expectedUpdatedAt: row.updatedAt });
  expect(updated.status).toBe(200);
  const next = (await updated.json()).row;
  expect(next.updatedAt > row.updatedAt).toBe(true);
  expect((await send('PATCH', `${path}/${row.id}`, toru, { orgId: ORG, values: { name: 'Stale' }, expectedUpdatedAt: row.updatedAt })).status).toBe(409);
  expect((await call(`${path}/${row.id}?orgId=${ORG}&expectedUpdatedAt=${encodeURIComponent(row.updatedAt)}`, { method: 'DELETE', headers: headers(toru) })).status).toBe(409);
  const rows = (await (await get(`/tables/${table.id}?orgId=${ORG}`, mika)).json()).rows;
  expect(rows[0].values.name).toBe('Newer');
  const { callHarnessTool } = await import('../src/harness/mcpTools.js');
  const queried = await callHarnessTool(env, { orgId: ORG, githubId: '9102' }, 'query_rows', { tableId: table.id });
  expect(queried.structuredContent.rowVersions[row.id]).toBe(next.updatedAt);
  const staleMcp = await callHarnessTool(env, { orgId: ORG, githubId: '9102' }, 'update_row', { tableId: table.id, rowId: row.id, values: { name: 'MCP stale' }, expectedUpdatedAt: row.updatedAt });
  expect(staleMcp.isError).toBe(true);
  expect((await call(`${path}/${row.id}?orgId=${ORG}&expectedUpdatedAt=${encodeURIComponent(next.updatedAt)}`, { method: 'DELETE', headers: headers(mika) })).status).toBe(200);
});

test('strict record contract rejects invalid fields atomically while legacy coercion stays available', async () => {
  const { table } = await (await send('POST', '/tables', mika, { orgId: ORG, name: 'Contract', columns: [
    { name: 'Amount', type: 'number' }, { name: 'Day', type: 'date' }, { name: 'Link', type: 'url' }, { name: 'Done', type: 'checkbox' }, { name: 'Stage', type: 'select', options: ['Open'] },
  ] })).json();
  const contract = await get(`/tables/${table.id}/contract?orgId=${ORG}`, mika);
  expect(contract.status).toBe(200);
  const spec = await contract.json();
  expect(spec.openapi).toBe('3.1.0');
  expect(spec.components.schemas.Values.additionalProperties).toBe(false);
  expect(spec.components.schemas.Values.properties.amount.type).toEqual(['number', 'null']);
  expect((await get(`/tables/${table.id}/contract?orgId=${ORG}`, outsider)).status).toBe(403);
  for (const values of [{ amount: '120' }, { day: '2026-02-30' }, { link: 'https://' }, { done: 'yes' }, { stage: 'Closed' }, { unknown: 1 }, { constructor: 'bad' }, [], null]) {
    const invalid = await send('POST', `/tables/${table.id}/rows`, mika, { orgId: ORG, values, validation: 'strict' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).fields.length).toBeGreaterThan(0);
  }
  expect((await (await get(`/tables/${table.id}?orgId=${ORG}`, mika)).json()).rows).toHaveLength(0);
  const valid = await send('POST', `/tables/${table.id}/rows`, mika, { orgId: ORG, validation: 'strict', values: { amount: 120, day: '2028-02-29', link: null, done: false, stage: 'Open' } });
  expect(valid.status).toBe(201);
  const { row } = await valid.json();
  const rejected = await send('PATCH', `/tables/${table.id}/rows/${row.id}`, mika, { orgId: ORG, validation: 'strict', expectedUpdatedAt: row.updatedAt, values: { amount: 42, day: 'invalid' } });
  expect(rejected.status).toBe(400);
  expect((await (await get(`/tables/${table.id}?orgId=${ORG}`, mika)).json()).rows[0]).toMatchObject({ values: { amount: 120 }, updatedAt: row.updatedAt });
  expect((await send('POST', `/tables/${table.id}/rows`, mika, { orgId: ORG, values: { amount: '$1,200' } })).status).toBe(201);
});

 test('two writers using the same snapshot cannot both commit', async () => {
  const { createTable, addRow, updateRow, getRow } = await import('../src/harness/tables.js');
  const { table } = await createTable(env.DB, { orgId: ORG, name: 'Race', columns: [{ name: 'Name', type: 'text' }], by: '9102' });
  const { row } = await addRow(env.DB, ORG, table.id, { name: 'Before' }, '9102');
  const results = await Promise.all(['One', 'Two'].map(name => updateRow(env.DB, ORG, table.id, row.id, { name }, '9102', row.updatedAt)));
  expect(results.filter(r => r.status === 409)).toHaveLength(1);
  const winner = results.find(r => r.row);
  expect(await getRow(env.DB, ORG, table.id, row.id)).toEqual(winner.row);
 });

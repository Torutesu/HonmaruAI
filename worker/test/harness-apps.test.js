import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { computeView, normalizeDefinition, specFromPrompt } from "../src/harness/apps.js";
import { coerce, normalizeColumns } from "../src/harness/tables.js";
import { joined, message } from "./helpers.js";

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

test("Simple-only display preference syncs to the same member, not the workspace or other members", async () => {
  await send("PUT", "/orgs/mode", toru, { orgId: ORG, mode: "harness" });
  const initial = await (await get(`/orgs/mode?orgId=${ORG}`, mika)).json();
  expect(initial).toMatchObject({ mode: "harness", simpleOnly: false, revision: 0 });

  const { ws: mikaSocket, messages: mikaMessages } = await joined(ORG, mika);
  const { ws: toruSocket, messages: toruMessages } = await joined(ORG, toru);
  const saved = await send("PUT", "/hx/display-preference", mika, { orgId: ORG, simpleOnly: true });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ simpleOnly: true, revision: 1 });
  const changed = await message(mikaMessages, event => event.name === "display_preference_changed");
  expect(changed?.value).toMatchObject({ orgId: ORG, simpleOnly: true, revision: 1 });
  expect(toruMessages.some(event => event.name === "display_preference_changed")).toBe(false);
  expect((await (await get(`/orgs/mode?orgId=${ORG}`, mika)).json())).toMatchObject({ mode: "harness", simpleOnly: true, revision: 1 });
  expect((await (await get(`/orgs/mode?orgId=${ORG}`, toru)).json())).toMatchObject({ mode: "harness", simpleOnly: false, revision: 0 });

  const invalid = await send("PUT", "/hx/display-preference", mika, { orgId: ORG, simpleOnly: "true" });
  expect(invalid.status).toBe(400);
  expect((await send("PUT", "/hx/display-preference", outsider, { orgId: ORG, simpleOnly: true })).status).toBe(403);
  expect((await send("PUT", "/hx/display-preference", guest, { orgId: ORG, simpleOnly: true })).status).toBe(200);
  expect((await (await get(`/orgs/mode?orgId=${ORG}`, mika)).json()).mode).toBe("harness");
  mikaSocket.close();
  toruSocket.close();
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
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?1,'sales','Sales',0,'9101',?2)").bind(ORG, at).run();
  const made = await send("POST", "/apps", mika, { orgId: ORG, template: "crm", channel: "b:sales" });
  expect(made.status).toBe(201);
  const { app } = await made.json();
  expect(app).toMatchObject({ name: "Sales CRM", template: "crm", version: 1 });

  const rendered = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  expect(rendered.table.name).toBe("Deals");
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

test("room links require app authority and room access, and hidden room names are filtered from app listings", async () => {
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?1,'confidential','Confidential',1,'9101',?2)").bind(ORG, at).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES (?1,'b:confidential','toru','toru',?2)").bind(ORG, at).run();

  const created = await send("POST", "/apps", toru, { orgId: ORG, name: "Private room link", columns: [{ name: "Title", type: "text" }] });
  expect(created.status).toBe(201);
  const { app } = await created.json();
  await env.DB.prepare("INSERT INTO hx_app_links(app_id,org_id,channel,created_by,created_at) VALUES (?1,?2,'b:confidential','9101',?3)").bind(app.id, ORG, at).run();

  const privateDirect = await send("POST", "/apps", toru, { orgId: ORG, name: "Private direct app", channel: "b:confidential", columns: [{ name: "Title", type: "text" }] });
  expect(privateDirect.status).toBe(201);
  const { app: directApp } = await privateDirect.json();
  expect(await env.DB.prepare("SELECT visibility FROM hx_app_access WHERE org_id=?1 AND app_id=?2").bind(ORG, directApp.id).first()).toEqual({ visibility: "private" });
  expect(await (await get(`/apps/${directApp.id}?orgId=${ORG}`, mika)).status).toBe(404);

  const privateTemplate = await send("POST", "/apps", toru, { orgId: ORG, template: "tracker", channel: "b:confidential", sample: false });
  expect(privateTemplate.status).toBe(201);
  const { app: templateApp } = await privateTemplate.json();
  expect(await env.DB.prepare("SELECT visibility FROM hx_app_access WHERE org_id=?1 AND app_id=?2").bind(ORG, templateApp.id).first()).toEqual({ visibility: "private" });

  const hidden = await (await get(`/apps/${app.id}?orgId=${ORG}`, mika)).json();
  expect(hidden.app.channels).toEqual([]);
  expect(hidden.canCustomize).toBe(false);
  const snapshotHidden=await (await get(`/hx/personal-views/${app.id}?orgId=${ORG}`,mika)).json();
  expect(snapshotHidden.snapshot.app.channels).toEqual([]);
  expect(snapshotHidden.snapshot.canCustomize).toBe(false);
  const snapshotOwner=await (await get(`/hx/personal-views/${app.id}?orgId=${ORG}`,toru)).json();
  expect(snapshotOwner.snapshot.app.channels).toEqual(['b:confidential']);
  const snapshotSaved=await (await send('PUT',`/hx/personal-views/${app.id}`,mika,{orgId:ORG,expectedRevision:0,views:[],layouts:{}})).json();
  expect(snapshotSaved.snapshot.app.channels).toEqual([]);
  const library = await (await get(`/apps?orgId=${ORG}`, mika)).json();
  expect(library.apps.find(item => item.id === app.id).channels).toEqual([]);
  const home = await (await get(`/harness/home?orgId=${ORG}`, mika)).json();
  expect(home.apps.find(item => item.id === app.id).channels).toEqual([]);
  const { callHarnessTool } = await import("../src/harness/mcpTools.js");
  const mcp = await callHarnessTool(env, { orgId: ORG, githubId: "9102", login: "mika" }, "list_apps", {});
  expect(mcp.structuredContent.apps.find(item => item.id === app.id).rooms).toEqual([]);
  expect((await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json()).app.channels).toEqual(["b:confidential"]);

  const deniedAdd = await send("POST", `/apps/${app.id}/links`, mika, { orgId: ORG, channel: "b:public" });
  expect(deniedAdd.status).toBe(403);
  const deniedRemove = await send("DELETE", `/apps/${app.id}/links?orgId=${encodeURIComponent(ORG)}&channel=b%3Aconfidential`, mika, { orgId: ORG });
  expect(deniedRemove.status, JSON.stringify(await deniedRemove.json())).toBe(403);

  const memberOwned = await send("POST", "/apps", mika, { orgId: ORG, name: "Member-owned app", columns: [{ name: "Title", type: "text" }] });
  expect(memberOwned.status).toBe(201);
  const { app: memberApp } = await memberOwned.json();
  const deniedPrivateLink = await send("POST", `/apps/${memberApp.id}/links`, mika, { orgId: ORG, channel: "b:confidential" });
  expect(deniedPrivateLink.status).toBe(404);
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?1").bind(ORG).first();
  const deniedPrivateCreate = await send("POST", "/apps", mika, { orgId: ORG, name: "Wrong room", channel: "b:confidential", columns: [{ name: "Title", type: "text" }] });
  expect(deniedPrivateCreate.status).toBe(404);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?1").bind(ORG).first()).toEqual(before);

  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_by,created_at) VALUES (?1,'shared','Shared',0,'9101',?2)").bind(ORG, at).run();
  const linked = await send("POST", `/apps/${memberApp.id}/links`, mika, { orgId: ORG, channel: "b:shared" });
  expect(linked.status).toBe(200);
  expect((await (await get(`/apps/${memberApp.id}?orgId=${ORG}`, mika)).json()).app.channels).toEqual(["b:shared"]);
  expect((await send("DELETE", `/apps/${memberApp.id}/links?orgId=${encodeURIComponent(ORG)}&channel=b%3Ashared`, mika, { orgId: ORG })).status).toBe(200);
});

test('shared app templates are pinned, sanitized, expiring and revocable bearer links', async () => {
  const made = await send('POST', '/apps', mika, {
    orgId: ORG, name: 'Partner pipeline', tableName: 'Deals', description: 'Sales overview', icon: '💼',
    columns: [{ name: 'Company', type: 'text' }, { name: 'Stage', type: 'select', options: ['Lead', 'Won'] }],
    definition: { views: [{ type: 'board', name: 'Pipeline', groupBy: 'Stage' }] },
    sample: [{ Company: 'Acme customer', Stage: 'Lead' }],
  });
  const { app } = await made.json();
  const historical = await env.DB.prepare('SELECT definition FROM hx_app_versions WHERE app_id=?1 AND org_id=?2 AND version=1').bind(app.id, ORG).first();
  const historicalDefinition = JSON.parse(historical.definition);
  historicalDefinition.description = 'private description text';
  historicalDefinition.custom = { published: 'custom-secret-code' };
  historicalDefinition.views[0].name = 'private view label';
  historicalDefinition.views[0].filters = [{ column: 'company', op: 'eq', value: 'private filter value' }];
  historicalDefinition.views[0].where = { company: ['private where value'] };
  await env.DB.prepare('UPDATE hx_app_versions SET definition=?1 WHERE app_id=?2 AND org_id=?3 AND version=1').bind(JSON.stringify(historicalDefinition), app.id, ORG).run();
  await send('PUT', `/apps/${app.id}`, mika, { orgId: ORG, name: 'Pipeline v2', note: 'new version' });

  const created = await send('POST', `/apps/${app.id}/template-shares`, mika, { orgId: ORG, version: 1, expiresInDays: 7 });
  expect(created.status).toBe(201);
  const { share, token } = await created.json();
  expect(token).toMatch(/^tpl_[a-f0-9]{64}$/);
  expect(share).toMatchObject({ appVersion: 1, revokedAt: null });
  const stored = await env.DB.prepare('SELECT token_hash,snapshot,expires_at FROM hx_template_shares WHERE id=?1').bind(share.id).first();
  expect(stored.token_hash).not.toBe(token);
  expect(stored.snapshot).not.toContain(token);
  expect(stored.snapshot).not.toContain('Acme customer');
  expect(stored.snapshot).not.toContain('private description text');
  expect(stored.snapshot).not.toContain('custom-secret-code');
  expect(stored.snapshot).not.toContain('private filter value');
  expect(stored.snapshot).not.toContain('private where value');
  expect(stored.snapshot).toContain('private view label');
  expect(JSON.parse(stored.snapshot).app.name).toBe('Partner pipeline');
  expect(JSON.parse(stored.snapshot).version).toBe(1);

  const publicRead = await call(`/template-shares/${token}`, { method: 'GET' });
  expect(publicRead.status).toBe(200);
  expect(await publicRead.json()).toMatchObject({ snapshot: { app: { name: 'Partner pipeline' }, version: 1 } });
  expect((await call(`/template-shares/${'tpl_' + '0'.repeat(64)}`, { method: 'GET' })).status).toBe(404);

  const imported = await send('POST', `/template-shares/${token}/import`, outsider, { orgId: 'personal:elsewhere' });
  expect(imported.status).toBe(201);
  const { app: copy } = await imported.json();
  expect(copy).toMatchObject({ orgId: 'personal:elsewhere', name: 'Partner pipeline', template: 'shared' });
  const details = await (await get(`/apps/${copy.id}?orgId=personal:elsewhere`, outsider)).json();
  expect(details.table.columns.map(column => column.name)).toEqual(['Company', 'Stage']);
  expect(details.rows).toEqual([]);
  expect(details.views.find(view => view.type === 'board').groupBy).toBe('stage');

  const listed = await (await get(`/apps/${app.id}/template-shares?orgId=${ORG}`, mika)).json();
  expect(listed.shares).toEqual([expect.objectContaining({ id: share.id, appVersion: 1, revokedAt: null })]);
  expect(JSON.stringify(listed)).not.toContain(token);
  const revoked = await send('POST', `/apps/${app.id}/template-shares/${share.id}/revoke`, mika, { orgId: ORG });
  expect(revoked.status).toBe(200);
  expect((await call(`/template-shares/${token}`, { method: 'GET' })).status).toBe(404);
  expect((await send('POST', `/template-shares/${token}/import`, outsider, { orgId: 'personal:elsewhere' })).status).toBe(404);
});

test('template links require an app editor and bounded expiry choices', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, name: 'Private template', sample: false, columns: [{ name: 'Task', type: 'text' }] })).json();
  expect((await send('POST', `/apps/${app.id}/template-shares`, guest, { orgId: ORG, version: 1 })).status).toBe(403);
  expect((await send('POST', `/apps/${app.id}/template-shares`, mika, { orgId: ORG, version: 1, expiresInDays: 365 })).status).toBe(400);
  const issued = await send('POST', `/apps/${app.id}/template-shares`, mika, { orgId: ORG, version: 1, expiresInDays: 1 });
  expect(issued.status).toBe(201);
  const { token, share } = await issued.json();
  await env.DB.prepare("UPDATE hx_template_shares SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(share.id).run();
  expect((await call(`/template-shares/${token}`, { method: 'GET' })).status).toBe(404);
});

test("an app title and its primary table label stay separate through version restore", async () => {
  const made = await send("POST", "/apps", mika, {
    orgId: ORG, name: "UI確認用タスク", tableName: "タスク", sample: false,
    columns: [{ name: "タスク名", type: "text" }],
  });
  expect(made.status).toBe(201);
  const { app } = await made.json();
  expect(app.name).toBe("UI確認用タスク");
  const detail = await (await get(`/apps/${app.id}?orgId=${ORG}`, mika)).json();
  expect(detail.table.name).toBe("タスク");

  const renamed = await send("PUT", `/tables/${app.tableId}`, mika, { orgId: ORG, name: "作業項目" });
  expect((await renamed.json()).table.name).toBe("作業項目");
  const restored = await send("POST", `/apps/${app.id}/versions`, mika, { orgId: ORG, version: 1 });
  expect(restored.status).toBe(200);
  expect((await (await get(`/apps/${app.id}?orgId=${ORG}`, mika)).json()).table.name).toBe("タスク");
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
  const rendered = await (await get(`/apps/${body.app.id}?orgId=${ORG}`, mika)).json();
  expect(rendered.table.name).toBe("Invoices");
  expect(rendered.rows).toEqual([]);

  const withExamples = await send("POST", "/apps/generate", mika, { orgId: ORG, prompt: "請求書を管理する", sampleCount: 2, useModel: false });
  const exampleApp = (await withExamples.json()).app;
  const examples = await (await get(`/apps/${exampleApp.id}?orgId=${ORG}`, mika)).json();
  expect(examples.rows).toHaveLength(2);
  expect(examples.views[0].rows).toHaveLength(2);

  expect((await specFromPrompt("a hiring pipeline for designers")).spec.template).toBe("hiring");
  expect((await specFromPrompt("track our office plants")).spec.template).toBe("tracker");
});

test("a model's design is used when it holds up, and ignored when it does not", async () => {
  const good = await specFromPrompt("warehouse counts", {
    complete: async () => JSON.stringify({ name: "Warehouse counts", tableName: "Inventory", icon: "📦", columns: [{ name: "SKU", type: "text" }, { name: "Count", type: "number" }], views: [{ type: "table", name: "All" }] }),
  });
  expect(good).toMatchObject({ source: "model", spec: { name: "Warehouse counts", tableName: "Inventory" } });
  const sameName = await specFromPrompt("warehouse counts", { complete: async () => JSON.stringify({ name: "Warehouse counts", columns: [{ name: "SKU", type: "text" }] }) });
  expect(sameName.spec.tableName).toBe("Warehouse counts");
  const bad = await specFromPrompt("warehouse counts", { complete: async () => "not json" });
  expect(bad.source).toBe("template");
});

test("app generation rejects invalid sample limits before creating an app", async () => {
  for (const sampleCount of [-1, 21, 1.5, "1"]) {
    const response = await send("POST", "/apps/generate", mika, {orgId:ORG,prompt:"Invoice tracker",sampleCount,useModel:false});
    expect(response.status).toBe(400);
  }
  expect((await send("POST", "/apps/generate", mika, {orgId:ORG,prompt:"請求書とサンプルデータを追加",useModel:false})).status).toBe(400);
  expect((await send("POST", "/apps/generate", mika, {orgId:ORG,prompt:"請求書とサンプルデータを追加",sampleCount:0,useModel:false})).status).toBe(400);
  expect((await send("POST", "/apps/generate", mika, {orgId:ORG,prompt:"請求書を管理。サンプルデータは不要",sampleCount:2,useModel:false})).status).toBe(400);
  for (const instruction of ["サンプルデータは作る前に相談して", "サンプルデータは追加前に確認", "サンプルデータは承認後に作成", "サンプルデータの追加は相談してから決める", "Create sample data only after approval"]) {
    expect((await send("POST", "/apps/generate", mika, {orgId:ORG,prompt:`請求書を管理。${instruction}`,sampleCount:5,useModel:false})).status).toBe(400);
  }
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id=?").bind(ORG).first()).n).toBe(0);
});

test("generated app views retain explicit board, ordering, and multiple-view requests", async () => {
  const columns = [{ name: "Status", type: "select", options: ["Open", "Done"] }, { name: "Due", type: "date" }];
  const views = [{ type: "table", name: "期限順", sort: "Due" }, { type: "board", name: "状態別", groupBy: "Status" }, { type: "board", name: "担当別", groupBy: "Status" }];
  const standard = await specFromPrompt("担当者と期限を管理するタスクアプリ", {
    complete: async () => JSON.stringify({ name: "Tasks", columns, viewPolicy: "default", views }),
  });
  expect(standard.spec.definition.views).toEqual([{type:"table",name:"すべて"}]);
  const made = await specFromPrompt("期限順の一覧と状態別・担当別のボードビューを2つ作り、カレンダーは不要", {
    complete: async () => JSON.stringify({ name: "Tasks", columns, viewPolicy: "requested", views }),
  });
  expect(made.spec.definition.views).toEqual(views);
  const mistakenPolicy = await specFromPrompt("期限順とボードで表示", {complete: async () => JSON.stringify({name:"Tasks",columns,viewPolicy:"default",views})});
  expect(mistakenPolicy.spec.definition.views).toEqual(views);
  const calendarViews=[{type:"table",name:"All"},{type:"calendar",name:"Calendar",dateColumn:"Due"}];
  const noCalendarModel=await specFromPrompt("タスク管理。カレンダーは不要",{complete:async()=>JSON.stringify({name:"Tasks",columns,viewPolicy:"default",views:calendarViews})});
  expect(noCalendarModel.spec.definition.views.map(view=>view.type)).toEqual(["table"]);
  const corrected=await specFromPrompt("カレンダーは不要、やはりカレンダーを作って",{complete:async()=>JSON.stringify({name:"Tasks",columns,views:calendarViews})});
  expect(corrected.spec.definition.views.map(view=>view.type)).toEqual(["table","calendar"]);
  const calendarWithNoSamples=await specFromPrompt("カレンダーを表示してサンプルデータは追加しない",{complete:async()=>JSON.stringify({name:"Tasks",columns,views:calendarViews})});
  expect(calendarWithNoSamples.spec.definition.views.map(view=>view.type)).toEqual(["table","calendar"]);
  const boardWithNoRows=await specFromPrompt("ボードを作って新規行を追加しない",{complete:async()=>JSON.stringify({name:"Tasks",columns,views:[{type:"board",name:"Board",groupBy:"Status"}]})});
  expect(boardWithNoRows.spec.definition.views.map(view=>view.type)).toEqual(["board"]);
  const board = await specFromPrompt("タスクをボードで表示", { complete: async () => JSON.stringify({ name: "Tasks", columns, views: [{type:"board", name:"Board", groupBy:"Status"}] }) });
  expect(board.spec.definition.views.map(view => view.type)).toEqual(["board"]);
  const ids = await specFromPrompt("2つのビュー", {complete: async () => JSON.stringify({name:"Tasks",columns,views:[{id:"personal_same",type:"table",name:"A"},{id:"personal_same",type:"table",name:"B"}]})});
  const normalized = normalizeDefinition(ids.spec.definition, normalizeColumns(columns).columns).views;
  expect(new Set(normalized.map(view=>view.id)).size).toBe(2);
  expect(normalized.every(view=>!view.id.startsWith('personal_'))).toBe(true);
  const noViews = await specFromPrompt("タスク管理", { complete: async () => JSON.stringify({ name: "Tasks", columns }) });
  expect(noViews.spec.definition.views).toEqual([{type:"table",name:"すべて"}]);
  const invalidBoard = await specFromPrompt("タスクをボードで表示", {complete:async()=>JSON.stringify({name:"Tasks",columns:[{name:"Task",type:"text"}],views:[{type:"board",name:"Board"}]})});
  expect(invalidBoard.error).toContain("選択肢フィールド");
  const invalidCalendar = await specFromPrompt("カレンダーで表示", {complete:async()=>JSON.stringify({name:"Tasks",columns:[{name:"Task",type:"text"}],views:[{type:"calendar",name:"Calendar",dateColumn:"Task"}]})});
  expect(invalidCalendar.error).toContain("日付フィールド");
  const fallback = await specFromPrompt("a team work tracker", { complete: null });
  expect(fallback.spec.definition.views).toEqual([{ type: "table", name: "All" }]);
  const boardFallback = await specFromPrompt("a kanban task board", { complete: null });
  expect(boardFallback.spec.definition.views.map(view => view.type)).toEqual(["table", "board"]);
  const noCalendar = await specFromPrompt("タスクをボードで表示。カレンダーは不要", { complete: null });
  expect(noCalendar.spec.definition.views.map(view => view.type)).toEqual(["table", "board"]);
  const noCalendarEnglish = await specFromPrompt("a tracker; do not add a calendar", { complete: null });
  expect(noCalendarEnglish.spec.definition.views.map(view => view.type)).toEqual(["table"]);
  for (const prompt of ["カレンダーのないタスク管理", "カレンダーを省いたタスク管理", "カレンダーを外してボードで表示"]) {
    const result = await specFromPrompt(prompt, {complete:null});
    expect(result.spec.definition.views.some(view=>view.type==='calendar')).toBe(false);
  }
  const dueOrder = await specFromPrompt("タスクを期限順に表示", { complete: null });
  expect(dueOrder.spec.definition.views[0]).toEqual({type:"table",name:"すべて",sort:"Due"});
});

test("generated samples require an explicit count and never invent people references", async () => {
  const spec = {name:"Tasks",columns:[{name:"Task",type:"text"},{name:"Assignee",type:"person"}],sample:[{Assignee:"made-up-user"},{Task:"Example",Assignee:"made-up-user",assignee:"another-made-up-user"},{Task:"Second"},{Task:"Third"}]};
  const complete = async () => JSON.stringify(spec);
  for(const prompt of ["タスク管理。サンプルデータは不要", "サンプルデータを追加しない", "サンプルデータを追加せず開始", "サンプルデータの追加は禁止", "サンプルデータは作成禁止", "サンプルデータを入れるのをやめて", "サンプルデータは後日追加", "サンプルデータを後で追加", "サンプルデータは零件で追加", "サンプルデータを追加するか相談", "サンプルデータを追加。ただし0件", "サンプルデータを追加してください。ただし、まだ追加しないで", "Task tracker; don't include sample data", "include sample data but no rows", "include sample data with zero rows", "Add sample data, but do not insert any rows yet", "タスク管理のサンプルアプリを作成", "create a sample app", "サンプルデータを追加、1件だけ"]) {
    expect((await specFromPrompt(prompt,{complete})).spec.sample, prompt).toEqual([]);
  }
  expect((await specFromPrompt("タスク管理",{complete,sampleCount:3})).spec.sample).toEqual([{Task:"Example"},{Task:"Second"},{Task:"Third"}]);
  expect((await specFromPrompt("タスク管理",{complete,sampleCount:1})).spec.sample).toEqual([{Task:"Example"}]);
  expect((await specFromPrompt("請求書を管理し初期データは0件",{complete:null})).spec.sample).toEqual([]);
});

test("natural-language assignee fields become workspace-member references", async () => {
  const raw = JSON.stringify({ name: "Task board", icon: "📋", columns: [
    { name: "タスク名", type: "text" }, { name: "担当者", type: "text" },
    { name: "期限", type: "date" }, { name: "状態", type: "select", options: ["未着手", "完了"] },
  ], views: [{ type: "table", name: "すべて" }] });
  const result = await specFromPrompt("担当者はワークスペースのメンバーから選択するタスク管理アプリ", { complete: async () => raw });
  expect(result.spec.columns.map(({ name, type }) => [name, type])).toEqual([
    ["タスク名", "text"], ["担当者", "person"], ["期限", "date"], ["状態", "select"],
  ]);
  const freeForm = await specFromPrompt("担当者を自由記述で入力する管理アプリ", { complete: async () => raw });
  expect(freeForm.spec.columns.find(column => column.name === "担当者").type).toBe("text");
  const separateFreeForm = await specFromPrompt("担当者はワークスペースのメンバーから選択し、メモ欄は自由記述で管理", { complete: async () => raw });
  expect(separateFreeForm.spec.columns.find(column => column.name === "担当者").type).toBe("person");
  const guidedFreeForm = await specFromPrompt("担当者を記録するタスクアプリ", { complete: async () => raw, guidelines: "担当者は自由記述で入力する" });
  expect(guidedFreeForm.spec.columns.find(column => column.name === "担当者").type).toBe("text");
  const explicitMember = await specFromPrompt("担当者はワークスペースのメンバーから選択", { complete: async () => raw, guidelines: "担当者は自由記述で入力する" });
  expect(explicitMember.spec.columns.find(column => column.name === "担当者").type).toBe("person");
  const negatedFreeForm = await specFromPrompt("担当者を記録する", { complete: async () => raw, guidelines: "担当者は自由記述ではなくワークスペースのメンバーを選択" });
  expect(negatedFreeForm.spec.columns.find(column => column.name === "担当者").type).toBe("person");
  const noFreeForm = await specFromPrompt("担当者の自由記述は不要", {complete:async()=>raw});
  expect(noFreeForm.spec.columns.find(column=>column.name==='担当者').type).toBe('person');
  for(const prompt of ["担当者はワークスペースのメンバーから選ばない", "担当者はメンバーから選ばず、自由記述にする"]) {
    const result = await specFromPrompt(prompt,{complete:async()=>raw,guidelines:"担当者は自由記述"});
    expect(result.spec.columns.find(column=>column.name==='担当者').type,prompt).toBe('text');
  }
  const english = await specFromPrompt("a task tracker with an assignee", { complete: async () => JSON.stringify({ name: "Tasks", columns: [{ name: "Assignee", type: "text" }] }) });
  expect(english.spec.columns[0].type).toBe("person");
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

test('row pages filter before slicing and reject malformed queries', async () => {
  const { createTable, addRow } = await import('../src/harness/tables.js');
  const { table } = await createTable(env.DB, { orgId: ORG, name: 'Pages', columns: [{ name: 'Name', type: 'text' }], by: '9102' });
  for (const name of ['Keep A', 'Skip', 'Keep B', 'Keep C']) await addRow(env.DB, ORG, table.id, { name }, '9102');
  const path = `/tables/${table.id}?orgId=${ORG}`;
  const first = await (await get(`${path}&q=Keep&limit=2`, mika)).json();
  expect(first).toMatchObject({ total: 3, nextOffset: 2, offset: 0 });
  expect(first.rows.map(r => r.values.name)).toEqual(['Keep A', 'Keep B']);
  const last = await (await get(`${path}&q=Keep&limit=2&offset=${first.nextOffset}`, mika)).json();
  expect(last).toMatchObject({ total: 3, nextOffset: null });
  expect(last.rows.map(r => r.values.name)).toEqual(['Keep C']);
  for (const query of ['where=%7B', 'where=null', 'where=[]', 'where=%7B%22unknown%22:1%7D', 'limit=-1', 'limit=0', 'limit=1.5', 'offset=-1', 'offset=oops', 'sort=unknown']) {
    expect((await get(`${path}&${query}`, mika)).status).toBe(400);
  }
  const { callHarnessTool } = await import('../src/harness/mcpTools.js');
  const page = await callHarnessTool(env, { orgId: ORG, githubId: '9102' }, 'query_rows', { tableId: table.id, q: 'Keep', limit: 2, offset: 2 });
  expect(page.structuredContent).toMatchObject({ total: 3, nextOffset: null, rows: [{ name: 'Keep C' }] });
});

test('app views include records beyond the default API page size', async () => {
  const { app } = await (await send('POST', '/apps', mika, { orgId: ORG, template: 'crm' })).json();
  const before = await (await get(`/apps/${app.id}?orgId=${ORG}`, mika)).json();
  await env.DB.batch(Array.from({ length: 501 }, (_, i) => env.DB.prepare(
    'INSERT INTO hx_rows (id, table_id, org_id, data, position, created_by, updated_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)'
  ).bind(`page_test_${i}`, app.tableId, ORG, JSON.stringify({ company: `Added ${i}`, stage: 'Lead', value: 1 }), i + 10, '9102', '2026-10-16T00:00:00.000Z')));
  const after = await (await get(`/apps/${app.id}?orgId=${ORG}`, mika)).json();
  expect(after.rows.length).toBe(before.rows.length + 501);
  const pipeline = data => data.views.find(v => v.type === 'metrics').values.find(m => m.label === 'Open pipeline').value;
  expect(pipeline(after)).toBe(pipeline(before) + 501);
});

test('custom releases require owner permission, separate drafts and reject stale writes', async () => {
  const { app } = await (await send('POST', '/apps', toru, { orgId: ORG, template: 'tracker', sample: false })).json();
  const path = `/apps/${app.id}/custom`;
  const draft = { orgId: ORG, action: 'draft', version: 1, html: '<h1>Custom dashboard</h1>' };
  expect((await send('POST', path, mika, draft)).status).toBe(403);
  expect((await send('POST', path, outsider, draft)).status).not.toBe(200);
  expect((await send('POST', path, toru, draft)).status).toBe(200);
  expect((await send('POST', path, toru, draft)).status).toBe(409);
  let current = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  expect(current.app.definition.custom.draft).toBe(draft.html);
  expect(current.app.definition.custom.published).toBeUndefined();
  expect((await send('POST', path, toru, { orgId: ORG, action: 'publish', version: 2 })).status).toBe(200);
  await send('PUT', `/apps/${app.id}`, mika, { orgId: ORG, definition: { custom: { published: 'injected' } } });
  current = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  expect(current.app.definition.custom.published).toBe(draft.html);
  expect((await send('POST', path, toru, { orgId: ORG, action: 'unpublish', version: current.app.version })).status).toBe(200);
  current = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  expect(current.app.definition.custom.published).toBeUndefined();
  expect(current.app.definition.custom.draft).toBe(draft.html);
});

test('custom generation validates source and fails without an existing AI allowance', async () => {
  const { generateCustomSource } = await import('../src/harness/customApps.js');
  expect((await generateCustomSource('dashboard', { columns: [] }, null)).status).toBe(503);
  expect((await generateCustomSource('dashboard', { columns: [] }, async () => '{bad')).status).toBe(502);
  expect((await generateCustomSource('dashboard', { columns: [] }, async () => JSON.stringify({ html: '<button>計算</button>' }))).html).toContain('計算');
});

test('custom runner has no external capabilities or authentication data', async () => {
  const response = await call('/custom-app-runner');
  expect(response.status).toBe(200);
  const policy = response.headers.get('content-security-policy');
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("frame-src 'none'");
  expect(policy).toContain('sandbox allow-scripts');
  expect(policy).not.toContain('allow-same-origin');
  expect(await response.text()).toContain('e.source===child.contentWindow');
});

test('pins synchronize across sessions and remain per-user', async () => {
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  const {createSession}=await import('../src/db.js');
  const second=await createSession(env.DB,'9101','gho_second');
  expect((await send('PUT','/hx/app-pins',toru,{orgId:ORG,appId:app.id,pinned:true})).status).toBe(200);
  expect(await (await get(`/hx/app-pins?orgId=${ORG}`,second)).json()).toEqual({pins:[app.id]});
  expect(await (await get(`/hx/app-pins?orgId=${ORG}`,mika)).json()).toEqual({pins:[]});
  await send('PUT','/hx/app-pins',second,{orgId:ORG,appId:app.id,pinned:false});
  expect(await (await get(`/hx/app-pins?orgId=${ORG}`,toru)).json()).toEqual({pins:[]});
  expect((await send('PUT','/hx/app-pins',outsider,{orgId:ORG,appId:app.id,pinned:true})).status).toBe(403);
  expect((await send('PUT','/hx/app-pins',guest,{orgId:ORG,appId:app.id,pinned:true})).status).toBe(403);
  expect((await send('PUT','/hx/app-pins',toru,{orgId:ORG,appId:'missing',pinned:true})).status).toBe(404);
  expect((await send('PUT','/hx/app-pins',toru,{orgId:ORG,appId:app.id,pinned:'yes'})).status).toBe(400);
});

test('view filters and arbitrary-column groups compute the same rows for all clients', () => {
  const columns=[{id:'name',name:'Name',type:'text'},{id:'n',name:'Number',type:'number'}];
  const view=normalizeDefinition({views:[{id:'v',type:'table',groupBy:'Name',filters:[{column:'Number',op:'gt',value:'2'},{column:'name',op:'contains',value:'al'}]}]},columns).views[0];
  const rows=[{id:'a',values:{name:'Alpha',n:10}},{id:'b',values:{name:'Alpha',n:1}},{id:'c',values:{name:'Beta',n:20}}];
  const result=computeView(view,{columns},rows);
  expect(result.rows.map(r=>r.id)).toEqual(['a']);
  expect(result.lanes).toEqual([{key:'Alpha',rows:[rows[0]]}]);
  expect(computeView({type:'table',filters:[{column:'n',op:'empty',value:''}]},{columns},[{id:'z',values:{n:0}},{id:'e',values:{}}]).rows.map(r=>r.id)).toEqual(['e']);
});

test('relation filters compare linked record IDs and treat empty multi-relations as empty',()=>{
 const columns=[{id:'company',name:'Company',type:'relation'},{id:'watchers',name:'Watchers',type:'relation',multiple:true}];
 const rows=[
  {id:'a',values:{company:'acme',watchers:['acme','north']}},
  {id:'b',values:{company:'north',watchers:['north']}},
  {id:'c',values:{company:null,watchers:[]}},
  {id:'d',values:{}},
 ];
 const select=(column,op,value)=>computeView({type:'table',filters:[{column,op,value}]},{columns},rows).rows.map(row=>row.id);
 expect(select('company','eq','acme')).toEqual(['a']);
 expect(select('company','neq','acme')).toEqual(['b','c','d']);
 expect(select('watchers','eq','north')).toEqual(['a','b']);
 expect(select('watchers','contains','acme')).toEqual(['a']);
 expect(select('watchers','empty','')).toEqual(['c','d']);
 expect(select('watchers','not_empty','')).toEqual(['a','b']);
});

test('stale view edits do not replace newer definitions', async () => {
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  expect((await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:app.version,name:'New name'})).status).toBe(200);
  expect((await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:app.version,name:'Stale name'})).status).toBe(409);
  expect((await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json()).app.name).toBe('New name');
});

test('revoked app access removes pins from the response without leaking app names', async () => {
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  expect((await send('PUT','/hx/app-pins',mika,{orgId:ORG,appId:app.id,pinned:true})).status).toBe(200);
  await env.DB.prepare("INSERT OR REPLACE INTO hx_app_access (org_id,app_id,visibility,version) VALUES (?1,?2,'private',1)").bind(ORG,app.id).run();
  expect(await (await get(`/hx/app-pins?orgId=${ORG}`,mika)).json()).toEqual({pins:[]});
});

test('saved filters and grouping persist when a view is read again', async () => {
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  const data=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
  const column=data.table.columns[0].id;
  const definition={views:[{id:'filtered',type:'table',name:'Filtered',groupBy:column,filters:[{column,op:'contains',value:'Example'}]}]};
  expect((await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:app.version,definition})).status).toBe(200);
  const reread=await (await get(`/apps/${app.id}?orgId=${ORG}`,mika)).json();
  expect(reread.app.definition.views[0]).toMatchObject(definition.views[0]);
  expect(reread.views[0].groupBy).toBe(column);
});

test('personal views and column layouts persist across sessions without changing shared views', async () => {
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  const original=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
  const ids=original.table.columns.map(c=>c.id);
  const path=`/hx/personal-views/${app.id}`;
  const body={orgId:ORG,expectedRevision:0,views:[{id:'personal_test',type:'table',name:'自分用',filters:[{column:ids[0],op:'contains',value:'Acme'}]}],layouts:{personal_test:{wrapText:true,order:[ids[1],ids[1],'deleted',ids[0]],hidden:[ids[0],ids[1],ids[1],'deleted'],widths:{[ids[0]]:320,[ids[1]]:9999,deleted:100}}}};
  const saved=await send('PUT',path,mika,body); expect(saved.status).toBe(200);
  const result=await saved.json(); expect(result.revision).toBe(1);expect(result.layouts.personal_test.order).toEqual([ids[1],ids[0],...ids.slice(2),'$row.id','$row.createdAt','$row.updatedAt']);expect(result.layouts.personal_test.widths).toEqual({[ids[0]]:320,[ids[1]]:600});
  expect(result.layouts.personal_test.wrapText).toBe(true);
  expect(result.layouts.personal_test.hidden).toEqual([ids[1],'$row.id','$row.createdAt','$row.updatedAt']);
  const {createSession}=await import('../src/db.js'); const second=await createSession(env.DB,'9102','second');
  expect(await (await get(`${path}?orgId=${ORG}`,second)).json()).toEqual(result);
  expect((await (await get(`${path}?orgId=${ORG}&userId=9102`,toru)).json()).views).toEqual([]);
  expect((await send('PUT',path,second,body)).status).toBe(409);
  expect((await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json()).app).toEqual(original.app);
  expect((await get(`${path}?orgId=${ORG}`,guest)).status).toBe(403);
  expect((await get(`${path}?orgId=${ORG}`,outsider)).status).toBe(403);
  expect((await send('PUT',path,mika,{...body,expectedRevision:1,views:[{id:'shared',type:'table',name:'bad'}]})).status).toBe(400);
  const revealed=await (await send('PUT',path,second,{...body,expectedRevision:1,layouts:{personal_test:{...result.layouts.personal_test,hidden:[]}}})).json();
  expect(revealed.revision).toBe(2);
  expect(revealed.layouts.personal_test).toEqual({...result.layouts.personal_test,hidden:[]});
  expect((await (await get(`${path}?orgId=${ORG}`,mika)).json()).layouts).toEqual(revealed.layouts);
});

test('personal view access follows app visibility and current columns', async () => {
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 const rendered=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();const id=rendered.table.columns[0].id;
 const path=`/hx/personal-views/${app.id}`;
 expect((await send('PUT',path,mika,{orgId:ORG,expectedRevision:0,activeView:'personal_mine',views:[{id:'personal_mine',type:'table',name:'Mine'}],layouts:{personal_mine:{order:[id],widths:{[id]:250}}}})).status).toBe(200);
 expect((await (await get(`${path}?orgId=${ORG}`,mika)).json()).activeView).toBe('personal_mine');
 await env.DB.prepare("INSERT OR REPLACE INTO hx_app_access (org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,app.id).run();
 expect((await get(`${path}?orgId=${ORG}`,mika)).status).toBe(404);
 expect((await send('PUT',path,mika,{orgId:ORG,expectedRevision:1,views:[],layouts:{}})).status).toBe(404);
});

test('deleting a personal view falls back to the shared view and synchronizes without changing records', async () => {
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 const original=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const path=`/hx/personal-views/${app.id}`;
 const view={id:'personal_mine',type:'table',name:'Mine'};
 const input={orgId:ORG,expectedRevision:0,activeView:view.id,views:[view],layouts:{[view.id]:{order:original.table.columns.map(c=>c.id),widths:{}}}};
 expect((await send('PUT',path,mika,input)).status).toBe(200);
 const {createSession}=await import('../src/db.js');const otherDevice=await createSession(env.DB,'9102','delete-view-device');
 const removed=await send('PUT',path,otherDevice,{orgId:ORG,expectedRevision:1,views:[],layouts:{}});
 expect(removed.status).toBe(200);
 const settings=await removed.json();
 expect(settings.activeView).toBe(original.app.definition.views[0].id);
 expect(settings.views).toEqual([]);expect(settings.layouts).toEqual({});
 expect(await (await get(`${path}?orgId=${ORG}`,mika)).json()).toEqual(settings);
 expect((await send('PUT',path,mika,{...input,expectedRevision:1})).status).toBe(409);
 const after=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 expect(after.app.definition).toEqual(original.app.definition);
 expect(after.rows).toEqual(original.rows);
 expect((await (await get(`${path}?orgId=${ORG}`,toru)).json()).views).toEqual([]);
});

test('new personal and shared view ID collisions are rejected without changing app or table', async () => {
 const shared={id:'personal_legacy',type:'table',name:'Shared'};
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Legacy shared',columns:[{name:'Name',type:'text'}],definition:{views:[shared]}})).json();
 const path=`/hx/personal-views/${app.id}`;
 expect((await send('PUT',path,mika,{orgId:ORG,expectedRevision:0,views:[{...shared,name:'Mine'}],layouts:{}})).status).toBe(409);
 const mine={id:'personal_new',type:'table',name:'Mine'};
 expect((await send('PUT',path,mika,{orgId:ORG,expectedRevision:0,views:[mine],layouts:{}})).status).toBe(200);
 const before=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const result=await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:app.version,tableName:'Must not be saved',definition:{views:[shared,{...mine,name:'Shared collision'}]}});
 expect(result.status).toBe(409);
 const after=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 expect(after.app).toEqual(before.app);
 expect(after.table).toEqual(before.table);
 expect((await (await get(`${path}?orgId=${ORG}`,mika)).json()).views).toEqual([mine]);
});

test('discarded view definitions do not block an otherwise valid table edit',async()=>{
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Normalized',columns:[{name:'Name',type:'text'}]})).json();
 const original=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const shared=original.app.definition.views[0],mine={id:'personal_mine',type:'table',name:'Mine'};
 expect((await send('PUT',`/hx/personal-views/${app.id}`,mika,{orgId:ORG,expectedRevision:0,views:[mine],layouts:{}})).status).toBe(200);
 const cases=[
  [shared,{...mine,type:'invalid'}],
  [shared,{...mine,type:'board'}],
  [shared,{...mine,type:'calendar'}],
  [shared,...Array.from({length:11},(_,i)=>({id:`view_${i}`,type:'table',name:`View ${i}`})),mine],
 ];
 let version=app.version;
 for(const [index,views] of cases.entries()){
  const response=await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:version,tableName:`Updated ${index}`,definition:{views}});
  expect(response.status).toBe(200);
  const body=await response.json();version=body.app.version;
  expect(body.app.definition.views.some(view=>view.id===mine.id)).toBe(false);
  expect((await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json()).table.name).toBe(`Updated ${index}`);
 }
});

test('a view made valid by the planned schema still fences a personal ID collision',async()=>{
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Planned schema',columns:[{name:'Name',type:'text'}]})).json();
 const before=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const mine={id:'personal_mine',type:'table',name:'Mine'};
 expect((await send('PUT',`/hx/personal-views/${app.id}`,mika,{orgId:ORG,expectedRevision:0,views:[mine],layouts:{}})).status).toBe(200);
 const response=await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:app.version,
  columns:[...before.table.columns,{name:'Status',type:'select',options:['Open']}],
  definition:{views:[...before.app.definition.views,{id:mine.id,type:'board',name:'Board',groupBy:'Status'}]}});
 expect(response.status).toBe(409);
 const after=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 expect(after.app).toEqual(before.app);expect(after.table).toEqual(before.table);
});

test('legacy collisions remain readable and removable without deleting a shared layout', async () => {
 const shared={id:'personal_legacy',type:'table',name:'Shared'};
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Legacy shared',columns:[{name:'Name',type:'text'}],definition:{views:[shared]}})).json();
 const original=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const id=original.table.columns[0].id,path=`/hx/personal-views/${app.id}`;
 const old={views:[{...shared,name:'Mine'}],activeView:shared.id,layouts:{[shared.id]:{order:[id],widths:{[id]:220}}}};
 await env.DB.prepare('INSERT INTO hx_personal_views(org_id,user_id,app_id,revision,settings) VALUES (?,?,?,?,?)').bind(ORG,'9102',app.id,1,JSON.stringify(old)).run();
 const before=await (await get(`${path}?orgId=${ORG}`,mika)).json();expect(before.views).toHaveLength(1);
 const removed=await send('PUT',path,mika,{orgId:ORG,expectedRevision:1,activeView:shared.id,views:[],layouts:before.layouts});
 expect(removed.status).toBe(200);
 const settings=await removed.json();
 expect(settings.views).toEqual([]);expect(settings.activeView).toBe(shared.id);
 expect(settings.layouts[shared.id].widths[id]).toBe(220);
 expect((await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json()).app.definition).toEqual(original.app.definition);
});

test('concurrent personal and shared view creation cannot introduce a collision',async()=>{
 const {updateApp}=await import('../src/harness/apps.js');
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Race',columns:[{name:'Name',type:'text'}]})).json();
 const before=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const mine={id:'personal_race',type:'table',name:'Mine'};
 const draft={expectedRevision:0,views:[mine],activeView:mine.id,layouts:{}};
 let injected=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{
   const statement=db.prepare(sql);
   if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async run(){
    if(!injected){injected=true;const result=await updateApp(env.DB,ORG,app.id,{definition:{views:[...before.app.definition.views,{...mine,name:'Shared'}]}},'9101');expect(result.error).toBeUndefined()}
    return bound.run();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id,draft);
 expect(result.status).toBe(409);
 expect((await (await get(`/hx/personal-views/${app.id}?orgId=${ORG}`,mika)).json()).views).toEqual([]);
});

test('a concurrent personal view fences a shared view and its table edit in the same batch',async()=>{
 const {updateApp}=await import('../src/harness/apps.js');
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Race',columns:[{name:'Name',type:'text'}]})).json();
 const before=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 const mine={id:'personal_race',type:'table',name:'Mine'};
 let injected=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key==='batch')return async statements=>{
   if(!injected){injected=true;const result=await personalViews(env.DB,ORG,'9102',app.id,{expectedRevision:0,views:[mine],activeView:mine.id,layouts:{}});expect(result.error).toBeUndefined()}
   return db.batch(statements);
  };
  return typeof db[key]==='function'?db[key].bind(db):db[key];
 }});
 const result=await updateApp(racing,ORG,app.id,{tableName:'Must not be saved',definition:{views:[...before.app.definition.views,{...mine,name:'Shared'}]}},'9101');
 expect(result.status).toBe(409);
 const after=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 expect(after.app).toEqual(before.app);expect(after.table).toEqual(before.table);
 expect((await (await get(`/hx/personal-views/${app.id}?orgId=${ORG}`,mika)).json()).views).toEqual([mine]);
});

test('personal view saves fail closed when app access is revoked before the write',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 let revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{
   const statement=db.prepare(sql);
   if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async run(){
    if(!revoked){revoked=true;await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,app.id).run()}
    return bound.run();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id,{expectedRevision:0,views:[{id:'personal_mine',type:'table',name:'Mine'}],layouts:{}});
 expect(result.status).toBe(404);
 expect(await env.DB.prepare('SELECT 1 FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(ORG,'9102',app.id).first()).toBeNull();
});

test('personal view saves fail closed when membership becomes a mixed-case guest before the write',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 let demoted=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{
   const statement=db.prepare(sql);
   if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async run(){
    if(!demoted){demoted=true;await env.DB.prepare("UPDATE memberships SET role='Guest' WHERE org_id=? AND user_github_id=?").bind(ORG,'9102').run()}
    return bound.run();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id,{expectedRevision:0,views:[{id:'personal_mine',type:'table',name:'Mine'}],layouts:{}});
 expect(result.status).toBe(404);
 expect(await env.DB.prepare('SELECT 1 FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(ORG,'9102',app.id).first()).toBeNull();
});

test('personal view reads do not return computed rows after app access is revoked',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 expect((await personalViews(env.DB,ORG,'9102',app.id,{expectedRevision:0,views:[{id:'personal_mine',type:'table',name:'Mine'}],layouts:{}})).error).toBeUndefined();
 let revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{
   const statement=db.prepare(sql);
   if(!sql.startsWith('SELECT 1 AS allowed WHERE EXISTS(SELECT 1 FROM hx_apps a'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async first(){
    if(!revoked){revoked=true;await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,app.id).run()}
    return bound.first();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id);
 expect(result.status).toBe(404);
 expect(result.computed).toBeUndefined();
});

test('personal view reads reject an app version change before returning computed rows',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {updateApp}=await import('../src/harness/apps.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 let changed=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{
   const statement=db.prepare(sql);
   if(!sql.startsWith('SELECT 1 AS allowed WHERE EXISTS(SELECT 1 FROM hx_apps a'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async first(){
    if(!changed){changed=true;const result=await updateApp(env.DB,ORG,app.id,{name:'Changed'},'9101');expect(result.error).toBeUndefined()}
    return bound.first();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id);
 expect(result.status).toBe(409);expect(result.computed).toBeUndefined();
});

test('metadata query columns normalize without becoming editable/group/calendar fields',()=>{
 const columns=[{id:'id',name:'ID',type:'text'}];
 const view=normalizeDefinition({views:[{id:'v',type:'table',groupBy:'$row.id',sort:'-$row.updatedAt',filters:[{column:'$row.id',op:'contains',value:'row_'},{column:'$row.createdAt',op:'gt',value:'2026-01-01T00:00:00Z'}]}]},columns).views[0];
 expect(view.sort).toBe('-$row.updatedAt');expect(view.filters).toHaveLength(2);expect(view.groupBy).toBeUndefined();
 expect(normalizeDefinition({views:[{type:'table',sort:'ID'}]},columns).views[0].sort).toBe('id');
});
test('metadata sort/filter use real IDs and chronological instants, with missing dates last',()=>{
 const table={columns:[{id:'id',type:'text'}]};
 const rows=[{id:'row_b',createdAt:'2026-10-18T10:00:00.900+09:00',updatedAt:'2026-10-18T03:00:00Z',values:{id:'A','$row.id':'spoof'}},{id:'row_a',createdAt:'2026-10-18T02:00:00Z',updatedAt:'2026-10-18T02:00:00Z',values:{id:'B'}},{id:'row_c',values:{}}];
 const result=patch=>computeView({type:'table',...patch},table,rows).rows.map(r=>r.id);
 expect(result({sort:'$row.id'})).toEqual(['row_a','row_b','row_c']);
 expect(result({sort:'-$row.id'})).toEqual(['row_c','row_b','row_a']);
 expect(result({sort:'$row.createdAt'})).toEqual(['row_b','row_a','row_c']);
 expect(result({sort:'-$row.createdAt'})).toEqual(['row_a','row_b','row_c']);
 expect(result({sort:'-$row.updatedAt'})).toEqual(['row_b','row_a','row_c']);
 const filter=(column,op,value)=>({filters:[{column,op,value}]});
 expect(result(filter('$row.id','eq','spoof'))).toEqual([]);
 expect(result(filter('$row.id','contains','ROW_A'))).toEqual(['row_a']);
 expect(result(filter('$row.createdAt','eq','2026-10-18T01:00:00Z'))).toEqual(['row_b']);
 expect(result(filter('$row.createdAt','gt','2026-10-18T01:30:00Z'))).toEqual(['row_a']);
 expect(result(filter('$row.updatedAt','lt','2026-10-18T03:00:00Z'))).toEqual(['row_a']);
 expect(result(filter('$row.updatedAt','empty',''))).toEqual(['row_c']);
 expect(result(filter('$row.createdAt','gt','invalid'))).toEqual([]);
 expect(result({sort:'$row.id',filters:[{column:'$row.id',op:'neq',value:'row_c'},{column:'$row.updatedAt',op:'not_empty',value:''}]})).toEqual(['row_a','row_b']);
});
test('shared and personal metadata queries persist with independent layouts and server computed rows',async()=>{
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
 const definition={views:[{id:'metadata',type:'table',name:'Metadata',sort:'-$row.createdAt',filters:[{column:'$row.id',op:'contains',value:'row_'}]}]};
 expect((await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,expectedVersion:app.version,definition})).status).toBe(200);
 const shared=await (await get(`/apps/${app.id}?orgId=${ORG}`,mika)).json();expect(shared.app.definition.views[0]).toMatchObject(definition.views[0]);
 const path=`/hx/personal-views/${app.id}`;
 const views=[{...definition.views[0],id:'personal_meta',sort:'$row.updatedAt'}];
 const saved=await send('PUT',path,mika,{orgId:ORG,expectedRevision:0,activeView:'personal_meta',views,layouts:{}});expect(saved.status).toBe(200);
 const result=await saved.json();expect(result.views).toEqual(views);expect(result.computed[0].sort).toBe('$row.updatedAt');
 const {createSession}=await import('../src/db.js');const second=await createSession(env.DB,'9102','metadata-second');
 expect(await (await get(`${path}?orgId=${ORG}`,second)).json()).toEqual(result);
 expect((await (await get(`${path}?orgId=${ORG}`,toru)).json()).views).toEqual([]);
 expect((await (await get(`/apps/${app.id}?orgId=${ORG}`,mika)).json()).app.definition.views).toEqual(shared.app.definition.views);
});

test("a shared app's definition is changed or restored only by its maker or an admin", async () => {
  const { app } = await (await send("POST", "/apps", toru, { orgId: ORG, template: "tracker", sample: false })).json();
  await send("PUT", `/apps/${app.id}`, toru, { orgId: ORG, name: "Launch checklist", expectedVersion: 1 });
  const before = await (await get(`/apps/${app.id}?orgId=${ORG}`, mika)).json();
  expect(before.canCustomize).toBe(false);
  const views = before.app.definition.views.map((v, i) => (i === 0 ? { ...v, name: "Hidden by Mika" } : v));

  const edit = await send("PUT", `/apps/${app.id}`, mika, { orgId: ORG, expectedVersion: before.app.version, definition: { ...before.app.definition, views }, columns: [...before.table.columns, { name: "Extra", type: "text" }] });
  expect(edit.status).toBe(403);
  expect((await send("POST", `/apps/${app.id}/versions`, mika, { orgId: ORG, version: 1 })).status).toBe(403);
  const after = await (await get(`/apps/${app.id}?orgId=${ORG}`, toru)).json();
  expect(after.app).toEqual(before.app);
  expect(after.table.columns).toEqual(before.table.columns);
  expect((await (await get(`/apps/${app.id}/versions?orgId=${ORG}`, toru)).json()).versions.map((v) => v.version)).toEqual([2, 1]);

  // Its maker still can, and the app stays usable by everyone.
  expect((await send("PUT", `/apps/${app.id}`, toru, { orgId: ORG, expectedVersion: 2, definition: { ...before.app.definition, views } })).status).toBe(200);
  expect((await (await send("POST", `/apps/${app.id}/versions`, toru, { orgId: ORG, version: 1 })).json()).app).toMatchObject({ name: "Tracker", version: 4 });
  expect((await get(`/apps/${app.id}?orgId=${ORG}`, mika)).status).toBe(200);
});

test("a save that loses to another leaves the app's table, definition and history as the winner left them", async () => {
  const { updateApp, getApp, listVersions } = await import("../src/harness/apps.js");
  const { getTable } = await import("../src/harness/tables.js");
  const { app } = await (await send("POST", "/apps", toru, { orgId: ORG, template: "tracker", sample: false })).json();
  const columns = (await getTable(env.DB, ORG, app.tableId)).columns;
  // Save B commits just before save A writes the app: A has already read it
  // and planned its new column, as two editors on one revision would.
  let competitor = null;
  const beat = () => (competitor ||= updateApp(env.DB, ORG, app.id, { name: "B wins" }, "9101"));
  const real = new WeakMap();
  const racing = new Proxy(env.DB, {
    get(db, key) {
      if (key === "batch") return async (statements) => { await beat(); return db.batch(statements.map((s) => real.get(s) || s)); };
      if (key !== "prepare") return typeof db[key] === "function" ? db[key].bind(db) : db[key];
      return (sql) => {
        const prepared = db.prepare(sql);
        if (!sql.startsWith("UPDATE hx_apps SET name")) return prepared;
        return { bind: (...args) => { const bound = prepared.bind(...args); const late = { run: async () => { await beat(); return bound.run(); } }; real.set(late, bound); return late; } };
      };
    },
  });
  const extra = [...columns, { name: "Extra", type: "text" }];
  expect(await updateApp(racing, ORG, app.id, { expectedVersion: 1, columns: extra }, "9102")).toMatchObject({ status: 409 });
  expect((await getTable(env.DB, ORG, app.tableId)).columns).toEqual(columns);
  expect(await getApp(env.DB, ORG, app.id)).toMatchObject({ name: "B wins", version: 2 });
  expect((await listVersions(env.DB, ORG, app.id)).versions.map((v) => v.version)).toEqual([2, 1]);

  // Uncontested, the same save writes the column and the version together.
  const won = await updateApp(env.DB, ORG, app.id, { expectedVersion: 2, columns: extra }, "9102");
  expect(won.app.version).toBe(3);
  expect((await getTable(env.DB, ORG, app.tableId)).columns.map((c) => c.name)).toContain("Extra");
});

test('app automation drafts are private to editors, inert and protected against concurrent saves',async()=>{
 const {app}=await(await send('POST','/apps',toru,{orgId:ORG,template:'crm',sample:false})).json();
 const path=`/apps/${app.id}/automations`;
 const first=await(await get(`${path}?orgId=${ORG}`,toru)).json();expect(first).toMatchObject({revision:0,version:app.version,draft:{version:1,items:[]},published:null});
 const automations={version:1,items:[{key:'review',name:'Review',enabled:true,trigger:{type:'manual'},steps:[{type:'post',channel:'b:general',text:'draft-private-note'}]}]};
 const appTrigger={type:'app_record_change',appId:app.id,entityId:'missing-entity',events:['update']};
 expect((await send('PUT',path,toru,{orgId:ORG,version:app.version,revision:0,automations:{version:1,items:[{...automations.items[0],trigger:appTrigger}]}})).status).toBe(400);
 expect((await send('PUT',path,toru,{orgId:ORG,version:app.version,revision:0,automations:{version:1,items:[{...automations.items[0],trigger:{...appTrigger,appId:'other_app',entityId:'primary'}}]}})).status).toBe(400);
 expect((await send('PUT',path,toru,{orgId:ORG,version:app.version,revision:0,automations:{version:1,items:[{...automations.items[0],trigger:{type:'app_record_change',appId:app.id,entityId:'primary',events:['update'],when:{where:{no_such_field:'x'}}}}]}})).status).toBe(400);
 expect((await get(`${path}?orgId=${ORG}`,mika)).status).toBe(403);
 expect((await send('PUT',path,mika,{orgId:ORG,version:app.version,revision:0,automations})).status).toBe(403);
 const results=await Promise.all([send('PUT',path,toru,{orgId:ORG,version:app.version,revision:0,automations}),send('PUT',path,toru,{orgId:ORG,version:app.version,revision:0,automations})]);
 expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 const saved=await(await get(`${path}?orgId=${ORG}`,toru)).json();expect(saved).toMatchObject({revision:1,draft:automations,published:null});
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
 expect(JSON.stringify(await(await get(`/apps/${app.id}?orgId=${ORG}`,mika)).json())).not.toContain('draft-private-note');
 const edit=await send('PUT',`/apps/${app.id}`,toru,{orgId:ORG,name:'Changed app',expectedVersion:app.version});expect(edit.status).toBe(200);
 expect((await send('PUT',path,toru,{orgId:ORG,version:app.version,revision:1,automations})).status).toBe(409);
 const invalid=await send('PUT',path,toru,{orgId:ORG,version:app.version+1,revision:1,automations:{version:1,items:[...automations.items,...automations.items]}});expect(invalid.status).toBe(400);
 expect((await(await get(`${path}?orgId=${ORG}`,toru)).json()).revision).toBe(1);
});

test('automation plan reports live drift but hides newly inaccessible workflow definitions',async()=>{
 const {app}=await(await send('POST','/apps',toru,{orgId:ORG,template:'crm',sample:false})).json();
 const path=`/apps/${app.id}/automations`;
 const declaration={key:'review',name:'Review',enabled:false,trigger:{type:'manual'},steps:[{type:'add_row',tableId:app.tableId,values:{}}]};
 const automations={version:1,items:[declaration]};
 expect((await send('PUT',path,toru,{orgId:ORG,version:app.version,revision:0,automations})).status).toBe(200);
 const initial=await(await get(`${path}?orgId=${ORG}`,toru)).json();expect(initial.plan[0].status).toBe('added');
 const {workflow}=await(await send('POST','/workflows',toru,{orgId:ORG,...declaration})).json();
 await env.DB.prepare('UPDATE hx_app_automation_state SET published=draft,release_id=?1 WHERE org_id=?2 AND app_id=?3').bind('release',ORG,app.id).run();
 await env.DB.prepare('INSERT INTO hx_app_automation_bindings(org_id,app_id,declaration_key,workflow_id,applied,release_id) VALUES (?1,?2,?3,?4,?5,?6)').bind(ORG,app.id,'review',workflow.id,JSON.stringify(declaration),'release').run();
 const unchanged=await(await get(`${path}?orgId=${ORG}`,toru)).json();expect(unchanged.plan[0].status).toBe('unchanged');
 await env.DB.prepare('UPDATE hx_workflows SET name=?1,hook_secret=?2 WHERE org_id=?3 AND id=?4').bind('Live changed','never-show-this-secret',ORG,workflow.id).run();
 const changed=await(await get(`${path}?orgId=${ORG}`,toru)).json();expect(changed.plan[0]).toMatchObject({status:'drifted',live:{name:'Live changed'},declared:{name:'Review'}});expect(JSON.stringify(changed)).not.toContain('never-show-this-secret');
 await env.DB.prepare('UPDATE hx_workflows SET trigger=?1 WHERE org_id=?2 AND id=?3').bind(JSON.stringify({type:'row',tableId:'foreign-table',on:'any'}),ORG,workflow.id).run();
 const denied=await get(`${path}?orgId=${ORG}`,toru);expect(denied.status).toBe(403);expect(JSON.stringify(await denied.json())).not.toContain('Live changed');
});

async function automationReleaseFixture() {
 const {app}=await(await send('POST','/apps',toru,{orgId:ORG,template:'crm',sample:false})).json();
 const declaration={key:'review',name:'Review',enabled:true,trigger:{type:'manual'},steps:[{type:'add_row',tableId:app.tableId,values:{}}]};
 const automations={version:1,items:[declaration]};
 await send('PUT',`/apps/${app.id}/automations`,toru,{orgId:ORG,version:app.version,revision:0,automations});
 const {releaseAppAutomations}=await import('../src/harness/appAutomationRelease.js');
 const {getApp}=await import('../src/harness/apps.js');
 const release=async (input,db=env.DB)=>releaseAppAutomations(db,ORG,await getApp(env.DB,ORG,app.id),input,'9101');
 return {app,automations,release};
}

test('automation release is atomic, replayable and stops managed work without deleting history',async()=>{
 const f=await automationReleaseFixture();
 const request={action:'publish',requestId:'publish_request_0001',version:f.app.version,revision:1};
 const published=await f.release(request);expect(published).toMatchObject({saved:true,revision:2,version:f.app.version+1});
 const {results:workflows}=await env.DB.prepare('SELECT id,enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).all();expect(workflows).toHaveLength(1);expect(workflows[0].enabled).toBe(1);
 expect(await f.release(request)).toMatchObject({...published,replay:true});
 expect((await f.release({...request,action:'unpublish'})).status).toBe(409);
 const stopped=await f.release({action:'unpublish',requestId:'unpublish_request_01',version:published.version,revision:published.revision});expect(stopped.saved).toBe(true);
 expect(await env.DB.prepare('SELECT id,enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({id:workflows[0].id,enabled:0});
 const state=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();expect(state.published).toBeNull();expect(state.draft).toEqual(f.automations);
 const again=await f.release({action:'publish',requestId:'publish_request_0002',version:stopped.version,revision:stopped.revision});expect(again.saved).toBe(true);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({n:1});
});

test('failed workflow insertion rolls the entire automation publication back',async()=>{
 const f=await automationReleaseFixture();
 await env.DB.exec("CREATE TRIGGER fail_app_workflow BEFORE INSERT ON hx_workflows BEGIN SELECT RAISE(ABORT,'forced'); END;");
 await expect(f.release({action:'publish',requestId:'publish_request_0001',version:f.app.version,revision:1})).rejects.toThrow();
 await env.DB.exec('DROP TRIGGER fail_app_workflow;');
 const state=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();expect(state).toMatchObject({revision:1,version:f.app.version,published:null});
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_automation_releases WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
});

test('a drifted live definition rejects publication without changing the app or other workflows',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_request_0001',version:f.app.version,revision:1});expect(first.saved).toBe(true);
 await env.DB.prepare('UPDATE hx_workflows SET name=?1 WHERE org_id=?2').bind('Independent edit',ORG).run();
 const next=await f.release({action:'publish',requestId:'publish_request_0002',version:first.version,revision:first.revision});expect(next.status).toBe(409);
 expect((await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json()).revision).toBe(first.revision);
 expect(await env.DB.prepare('SELECT name FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({name:'Independent edit'});
});

test('live edits between review and commit reject the entire automation release',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_request_0001',version:f.app.version,revision:1});
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  await env.DB.prepare('UPDATE hx_workflows SET name=?1 WHERE org_id=?2').bind('Concurrent edit',ORG).run();
  return env.DB.batch(statements);
 }};
 expect((await f.release({action:'publish',requestId:'publish_request_0002',version:first.version,revision:first.revision},db)).status).toBe(409);
 const current=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();expect(current).toMatchObject({revision:first.revision,version:first.version});
 expect(await env.DB.prepare('SELECT name FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({name:'Concurrent edit'});
});

test('membership revocation before commit cannot enable app automations',async()=>{
 const f=await automationReleaseFixture();
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,'9101').run();
  return env.DB.batch(statements);
 }};
 expect((await f.release({action:'publish',requestId:'publish_request_0001',version:f.app.version,revision:1},db)).status).toBe(409);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
});


test('managed automation claims reject stopped releases and old runs cannot resume after republication',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_guard_000001',version:f.app.version,revision:1});
 const {getWorkflow,startRun,continueRun}=await import('../src/harness/workflows.js');
 const {managedAutomationMayRun}=await import('../src/harness/appAutomationGuard.js');
 const binding=await env.DB.prepare('SELECT workflow_id,release_id FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2').bind(ORG,f.app.id).first();
 const workflow=await getWorkflow(env.DB,ORG,binding.workflow_id);
 expect(await managedAutomationMayRun(env.DB,ORG,workflow.id,binding.release_id)).toBe(true);
 const stopped=await f.release({action:'unpublish',requestId:'unpublish_guard_001',version:first.version,revision:first.revision});
 expect(await startRun(env,{orgId:ORG,workflow,trigger:'manual',startedBy:'9101'})).toBeNull();
 expect(await managedAutomationMayRun(env.DB,ORG,workflow.id,binding.release_id)).toBe(false);
 const again=await f.release({action:'publish',requestId:'republish_guard_001',version:stopped.version,revision:stopped.revision});expect(again.saved).toBe(true);
 expect(await managedAutomationMayRun(env.DB,ORG,workflow.id,binding.release_id)).toBe(false);
 const active=await startRun(env,{orgId:ORG,workflow:await getWorkflow(env.DB,ORG,workflow.id),trigger:'manual',startedBy:'9101'});expect(active.status).toBe('done');
 await env.DB.prepare("UPDATE hx_workflow_runs SET status='running',next_step=0 WHERE id=?1").bind(active.id).run();
 await f.release({action:'unpublish',requestId:'unpublish_guard_002',version:again.version,revision:again.revision});
 const resumed=await continueRun(env,{orgId:ORG,runId:active.id});expect(resumed.status).toBe('failed');expect(JSON.stringify(resumed.log)).toContain('stopped');
});

test('deleting an app disables its managed workflow while retaining the ownership tombstone',async()=>{
 const f=await automationReleaseFixture();
 await f.release({action:'publish',requestId:'publish_delete_00001',version:f.app.version,revision:1});
 const {getWorkflow,startRun}=await import('../src/harness/workflows.js');
 const {deleteApp}=await import('../src/harness/apps.js');
 const binding=await env.DB.prepare('SELECT workflow_id FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2').bind(ORG,f.app.id).first();
 const workflow=await getWorkflow(env.DB,ORG,binding.workflow_id);
 expect(await deleteApp(env.DB,ORG,f.app.id)).toEqual({deleted:true});
 expect(await getWorkflow(env.DB,ORG,workflow.id)).toMatchObject({enabled:false});
 expect(await env.DB.prepare('SELECT workflow_id FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2').bind(ORG,f.app.id).first()).toEqual(binding);
 expect(await startRun(env,{orgId:ORG,workflow,trigger:'manual',startedBy:'9101'})).toBeNull();
});

test('a stale workflow definition cannot be claimed under a newer app release',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_stale_000001',version:f.app.version,revision:1});
 const {getWorkflow,startRun}=await import('../src/harness/workflows.js');
 const binding=await env.DB.prepare('SELECT workflow_id FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2').bind(ORG,f.app.id).first();
 const old=await getWorkflow(env.DB,ORG,binding.workflow_id);
 const automations={...f.automations,items:f.automations.items.map(item=>({...item,name:'New release'}))};
 const saved=await(await send('PUT',`/apps/${f.app.id}/automations`,toru,{orgId:ORG,version:first.version,revision:first.revision,automations})).json();
 expect((await f.release({action:'publish',requestId:'publish_stale_000002',version:first.version,revision:saved.revision})).saved).toBe(true);
 expect(await startRun(env,{orgId:ORG,workflow:old,trigger:'manual',startedBy:'9101'})).toBeNull();
 const current=await getWorkflow(env.DB,ORG,binding.workflow_id);
 expect((await startRun(env,{orgId:ORG,workflow:current,trigger:'manual',startedBy:'9101'})).status).toBe('done');
});

test('custom source unpublish stops automation atomically and source republish alone does not restart it',async()=>{
 const f=await automationReleaseFixture();
 await f.release({action:'publish',requestId:'publish_custom_00001',version:f.app.version,revision:1});
 const {getApp}=await import('../src/harness/apps.js');
 const {saveCustomRelease}=await import('../src/harness/customApps.js');
 const edit=async input=>{const app=await getApp(env.DB,ORG,f.app.id);return saveCustomRelease(env.DB,ORG,app,{...input,version:app.version},'9101');};
 expect((await edit({action:'draft',html:'<html><body>App</body></html>'})).saved).toBe(true);
 expect((await edit({action:'publish'})).saved).toBe(true);
 const stale=await getApp(env.DB,ORG,f.app.id);
 expect((await edit({action:'draft',html:'<html>New</html>'})).saved).toBe(true);
 expect((await saveCustomRelease(env.DB,ORG,stale,{action:'unpublish',version:stale.version},'9101')).status).toBe(409);
 expect((await env.DB.prepare('SELECT enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).enabled).toBe(1);
 expect((await edit({action:'unpublish'})).saved).toBe(true);
 const state=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();
 expect(state.published).toBeNull();expect(state.draft).toEqual(f.automations);expect(state.plan[0].status).toBe('added');
 expect((await env.DB.prepare('SELECT enabled,next_run_at FROM hx_workflows WHERE org_id=?1').bind(ORG).first())).toEqual({enabled:0,next_run_at:null});
 expect((await edit({action:'publish'})).saved).toBe(true);
 expect((await env.DB.prepare('SELECT enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).enabled).toBe(0);
});

test('combined source and automation publication commits one version and replays the same receipt',async()=>{
 const f=await automationReleaseFixture();
 const {getApp}=await import('../src/harness/apps.js');
 const {saveCustomRelease}=await import('../src/harness/customApps.js');
 const source='<html><body>Combined release</body></html>';
 const draft=await saveCustomRelease(env.DB,ORG,f.app,{action:'draft',version:f.app.version,html:source},'9101');
 const request={action:'publish',requestId:'publish_combined_001',version:draft.version,revision:1,includeSource:true};
 expect((await f.release({...request,includeSource:false})).status).toBe(409);
 const released=await f.release(request);expect(released).toMatchObject({saved:true,version:draft.version+1});
 expect((await getApp(env.DB,ORG,f.app.id)).definition.custom.published).toBe(source);
 expect(await f.release(request)).toMatchObject({...released,replay:true});
 expect((await f.release({...request,includeSource:false})).status).toBe(409);
 const stopped=await f.release({action:'unpublish',requestId:'unpublish_combined01',version:released.version,revision:released.revision,includeSource:true});expect(stopped.saved).toBe(true);
 expect((await getApp(env.DB,ORG,f.app.id)).definition.custom.published).toBeUndefined();
 expect((await env.DB.prepare('SELECT enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).enabled).toBe(0);
});

test('combined publication rolls source and automation state back when a workflow write fails',async()=>{
 const f=await automationReleaseFixture();
 const {getApp}=await import('../src/harness/apps.js');
 const {saveCustomRelease}=await import('../src/harness/customApps.js');
 const draft=await saveCustomRelease(env.DB,ORG,f.app,{action:'draft',version:f.app.version,html:'<html>Draft only</html>'},'9101');
 await env.DB.exec("CREATE TRIGGER fail_combined BEFORE INSERT ON hx_workflows BEGIN SELECT RAISE(ABORT,'forced'); END;");
 await expect(f.release({action:'publish',requestId:'rollback_combined_01',version:draft.version,revision:1,includeSource:true})).rejects.toThrow();
 await env.DB.exec('DROP TRIGGER fail_combined;');
 const app=await getApp(env.DB,ORG,f.app.id);expect(app.version).toBe(draft.version);expect(app.definition.custom.published).toBeUndefined();
 expect((await env.DB.prepare('SELECT published,revision FROM hx_app_automation_state WHERE org_id=?1 AND app_id=?2').bind(ORG,f.app.id).first())).toEqual({published:null,revision:1});
});

test('stopping a managed release works despite inaccessible live drift without disclosing or overwriting it',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_stop_drift01',version:f.app.version,revision:1});
 await env.DB.prepare('UPDATE hx_workflows SET name=?1,trigger=?2 WHERE org_id=?3').bind('Private independent edit',JSON.stringify({type:'row',tableId:'foreign-table',on:'any'}),ORG).run();
 expect((await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).status).toBe(403);
 const result=await f.release({action:'unpublish',requestId:'unpublish_drift_0001',version:first.version,revision:first.revision});expect(result.saved).toBe(true);
 expect(JSON.stringify(result)).not.toContain('Private independent edit');
 const live=await env.DB.prepare('SELECT name,trigger,enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first();expect(live).toMatchObject({name:'Private independent edit',enabled:0});expect(JSON.parse(live.trigger).tableId).toBe('foreign-table');
});

test('stopping still succeeds when a managed workflow has been independently deleted',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_stop_missing1',version:f.app.version,revision:1});
 await env.DB.prepare('DELETE FROM hx_workflows WHERE org_id=?1').bind(ORG).run();
 const result=await f.release({action:'unpublish',requestId:'unpublish_missing01',version:first.version,revision:first.revision});expect(result.saved).toBe(true);
 const state=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();expect(state.published).toBeNull();expect(state.plan[0].status).toBe('missing');
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
});

test('reviewed live drift can be replaced, but stale or unrelated reviews cannot authorize publication',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_review_00001',version:f.app.version,revision:1});
 await env.DB.prepare('UPDATE hx_workflows SET name=?1 WHERE org_id=?2').bind('Independent edit',ORG).run();
 const plan=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();const item=plan.plan[0];
 const reviewed=[{key:item.key,workflowId:item.workflowId,action:'replace',live:item.live}];
 const request={action:'publish',requestId:'publish_review_00002',version:first.version,revision:first.revision,reviewed};
 expect((await f.release({...request,reviewed:[{...reviewed[0],live:{...item.live,name:'Wrong reviewed name'}}]})).status).toBe(409);
 expect((await f.release({...request,reviewed:[{...reviewed[0],key:'unrelated'}]})).status).toBe(409);
 const result=await f.release(request);expect(result.saved).toBe(true);
 expect((await env.DB.prepare('SELECT name FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).name).toBe('Review');
 expect(await f.release(request)).toMatchObject({...result,replay:true});
});

test('a live edit after explicit review still rejects the entire publication',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_race_review1',version:f.app.version,revision:1});
 await env.DB.prepare('UPDATE hx_workflows SET name=?1 WHERE org_id=?2').bind('Reviewed edit',ORG).run();
 const plan=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();const item=plan.plan[0];
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  await env.DB.prepare('UPDATE hx_workflows SET name=?1 WHERE org_id=?2').bind('Newer unreviewed edit',ORG).run();return env.DB.batch(statements);
 }};
 const result=await f.release({action:'publish',requestId:'publish_race_review2',version:first.version,revision:first.revision,reviewed:[{key:item.key,workflowId:item.workflowId,action:'replace',live:item.live}]},db);
 expect(result.status).toBe(409);expect((await env.DB.prepare('SELECT name FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).name).toBe('Newer unreviewed edit');
});

test('replacing a reviewed schedule drift clears the live schedule for a manual declaration',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_schedule_001',version:f.app.version,revision:1});
 await env.DB.prepare('UPDATE hx_workflows SET trigger=?1,next_run_at=?2 WHERE org_id=?3').bind(JSON.stringify({type:'schedule',cadence:'daily',hour:9,minute:0,timezone:'Asia/Tokyo'}),'2099-01-01T00:00:00.000Z',ORG).run();
 const plan=await(await get(`/apps/${f.app.id}/automations?orgId=${ORG}`,toru)).json();const item=plan.plan[0];
 expect((await f.release({action:'publish',requestId:'publish_schedule_002',version:first.version,revision:first.revision,reviewed:[{key:item.key,workflowId:item.workflowId,action:'replace',live:item.live}]})).saved).toBe(true);
 expect((await env.DB.prepare('SELECT next_run_at FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).next_run_at).toBeNull();
});

test('a missing automation is recreated only after an explicit review, retaining its stable identity',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_recreate_001',version:f.app.version,revision:1});
 const old=await env.DB.prepare('SELECT id FROM hx_workflows WHERE org_id=?1').bind(ORG).first();
 await env.DB.prepare('DELETE FROM hx_workflows WHERE org_id=?1').bind(ORG).run();
 const request={action:'publish',requestId:'publish_recreate_002',version:first.version,revision:first.revision};
 expect((await f.release(request)).status).toBe(409);
 const reviewed=[{key:'review',workflowId:old.id,action:'recreate',live:null}];
 const result=await f.release({...request,reviewed});expect(result.saved).toBe(true);
 expect(await env.DB.prepare('SELECT id,name,enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({id:old.id,name:'Review',enabled:1});
 expect(await f.release({...request,reviewed})).toMatchObject({...result,replay:true});
});

test('recreation refuses to overwrite a workflow that reappears after the missing-state review',async()=>{
 const f=await automationReleaseFixture();
 const first=await f.release({action:'publish',requestId:'publish_reappear_001',version:f.app.version,revision:1});
 const old=await env.DB.prepare('SELECT * FROM hx_workflows WHERE org_id=?1').bind(ORG).first();
 await env.DB.prepare('DELETE FROM hx_workflows WHERE org_id=?1').bind(ORG).run();
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  await env.DB.prepare('INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)').bind(old.id,ORG,'Restored elsewhere',0,old.trigger,old.steps,old.created_by,old.created_at,old.updated_at).run();
  return env.DB.batch(statements);
 }};
 const result=await f.release({action:'publish',requestId:'publish_reappear_002',version:first.version,revision:first.revision,reviewed:[{key:'review',workflowId:old.id,action:'recreate',live:null}]},db);
 expect(result.status).toBe(409);expect((await env.DB.prepare('SELECT name,enabled FROM hx_workflows WHERE org_id=?1').bind(ORG).first())).toEqual({name:'Restored elsewhere',enabled:0});
});

test('automation lifecycle API is editor-only and state remains available for stop when live visibility fails',async()=>{
 const f=await automationReleaseFixture();const path=`/apps/${f.app.id}/automations`;
 const input={orgId:ORG,action:'publish',requestId:'publish_api_0000001',version:f.app.version,revision:1};
 expect((await send('POST',path,mika,input)).status).toBe(403);
 const response=await send('POST',path,toru,input);expect(response.status).toBe(200);const first=await response.json();expect(first.saved).toBe(true);
 expect((await(await send('POST',path,toru,input)).json()).replay).toBe(true);
 await env.DB.prepare('UPDATE hx_workflows SET trigger=?1 WHERE org_id=?2').bind(JSON.stringify({type:'row',tableId:'foreign-table',on:'any'}),ORG).run();
 expect((await get(`${path}?orgId=${ORG}`,toru)).status).toBe(403);
 expect((await get(`${path}?orgId=${ORG}&stateOnly=1`,mika)).status).toBe(403);
 const state=await(await get(`${path}?orgId=${ORG}&stateOnly=1`,toru)).json();expect(state.revision).toBe(first.revision);expect(JSON.stringify(state)).not.toContain('foreign-table');
 const stopped=await send('POST',path,toru,{orgId:ORG,action:'unpublish',requestId:'unpublish_api_000001',version:state.version,revision:state.revision});expect(stopped.status).toBe(200);
});

test('app automation generation produces a disabled proposal without writing workflows or app drafts',async()=>{
 const {app}=await(await send('POST','/apps',toru,{orgId:ORG,template:'crm',sample:false})).json();
 const {appAutomationFromPrompt}=await import('../src/harness/appAutomationGeneration.js');
 const result=await appAutomationFromPrompt(env.DB,ORG,'9101',{prompt:'Create a row',complete:async()=>JSON.stringify({name:'Create row',trigger:{type:'manual'},steps:[{type:'add_row',tableId:app.tableId,values:{}}]})});
 expect(result.automation).toMatchObject({name:'Create row',enabled:false,trigger:{type:'manual'}});
 expect(result.automation.key).toMatch(/^auto_/);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_automation_state WHERE org_id=?1').bind(ORG).first()).toEqual({n:0});
 expect((await send('POST',`/apps/${app.id}/automations`,mika,{orgId:ORG,action:'generate',prompt:'Create row',useModel:false})).status).toBe(403);
 expect((await send('POST',`/apps/${app.id}/automations`,toru,{orgId:ORG,action:'generate',prompt:'Create row',useModel:false})).status).toBe(503);
});

test('managed follow-ups retain their published origin and cannot run after stop and republication',async()=>{
 const f=await automationReleaseFixture();
 const {upsertBusiness}=await import('../src/db.js');
 await upsertBusiness(env.DB,ORG,{name:'Ops',createdBy:'9101'});
 const automations={version:1,items:[{...f.automations.items[0],steps:[{type:'followup',channel:'b:ops',minutes:1,text:'Managed reminder'}]}]};
 const saved=await(await send('PUT',`/apps/${f.app.id}/automations`,toru,{orgId:ORG,version:f.app.version,revision:1,automations})).json();
 const first=await f.release({action:'publish',requestId:'publish_followup_001',version:f.app.version,revision:saved.revision});expect(first.saved).toBe(true);
 const {getWorkflow,startRun}=await import('../src/harness/workflows.js');
 const {runDueFollowups,scheduleFollowup}=await import('../src/harness/followups.js');
 const binding=await env.DB.prepare('SELECT workflow_id,release_id FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2').bind(ORG,f.app.id).first();
 const workflow=await getWorkflow(env.DB,ORG,binding.workflow_id);
 expect((await startRun(env,{orgId:ORG,workflow,trigger:'manual',startedBy:'9101'})).status).toBe('done');
 const followup=await env.DB.prepare('SELECT * FROM hx_followups WHERE org_id=?1').bind(ORG).first();
 expect(followup).toMatchObject({origin_workflow_id:workflow.id,origin_release_id:binding.release_id,status:'scheduled'});
 const stopped=await f.release({action:'unpublish',requestId:'unpublish_followup01',version:first.version,revision:first.revision});
 expect((await scheduleFollowup(env.DB,{orgId:ORG,channel:'b:ops',instruction:'Stale reminder',dueAt:new Date(Date.now()+60000).toISOString(),by:'9101',originWorkflowId:workflow.id,originReleaseId:binding.release_id})).status).toBe(409);
 expect((await f.release({action:'publish',requestId:'republish_followup01',version:stopped.version,revision:stopped.revision})).saved).toBe(true);
 expect(await runDueFollowups({...env,OPENAI_API_KEY:undefined},{now:new Date(Date.now()+120000)})).toBe(0);
 expect(await env.DB.prepare('SELECT status FROM hx_followups WHERE id=?1').bind(followup.id).first()).toEqual({status:'failed'});
});

test('personal view saves reject a direct table schema change before the write',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {updateTable}=await import('../src/harness/tables.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Schema race',columns:[{name:'Name',type:'text'}]})).json();
 let changed=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{
   const statement=db.prepare(sql);
   if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async run(){
    if(!changed){changed=true;const result=await updateTable(env.DB,ORG,app.tableId,{columns:[{name:'Changed',type:'text'}]});expect(result.error).toBeUndefined()}
    return bound.run();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id,{expectedRevision:0,views:[{id:'personal_mine',type:'table',name:'Mine'}],layouts:{}});
 expect(result.status).toBe(409);
 expect(await env.DB.prepare('SELECT 1 FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(ORG,'9102',app.id).first()).toBeNull();
});

test('personal views return rows and computed views from one captured row set even when rows change during save',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Row snapshot',columns:[{name:'Name',type:'text'}]})).json();
 const created=await (await send('POST',`/tables/${app.tableId}/rows`,toru,{orgId:ORG,values:{Name:'Before'}})).json();
 const before=await (await get(`/apps/${app.id}?orgId=${ORG}`,toru)).json();
 let changed=false;
 const racing=new Proxy(env.DB,{get(db,key){
  if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
  return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
   return {bind(...args){const bound=statement.bind(...args);return {async run(){
    if(!changed){changed=true;const response=await send('PATCH',`/tables/${app.tableId}/rows/${created.row.id}`,toru,{orgId:ORG,values:{Name:'After'},expectedUpdatedAt:created.row.updatedAt});expect(response.status).toBe(200)}
    return bound.run();
   }}}};
  };
 }});
 const result=await personalViews(racing,ORG,'9102',app.id,{expectedRevision:0,views:[{id:'personal_mine',type:'table',name:'Mine'}],layouts:{}});
 expect(result.error).toBeUndefined();
 const key=before.table.columns[0].id;
 expect(result.snapshot.rows[0].values[key]).toBe('Before');
 expect(result.computed[0].rows[0].values[key]).toBe('Before');
 const latest=await personalViews(env.DB,ORG,'9102',app.id);
 expect(latest.snapshot.rows[0].values[key]).toBe('After');
 expect(latest.computed[0].rows[0].values[key]).toBe('After');
});

test.each(['primary','entity'])('personal view snapshot denies a table shared with an inaccessible private app through %s',async relation=>{
 const {app:publicApp}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Public',columns:[{name:'Name',type:'text'}]})).json();
 const {app:privateApp}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Private',columns:[{name:'Name',type:'text'}]})).json();
 await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,privateApp.id).run();
 if(relation==='primary')await env.DB.prepare('UPDATE hx_apps SET table_id=? WHERE org_id=? AND id=?').bind(publicApp.tableId,ORG,privateApp.id).run();
 else {
  await env.DB.prepare('DELETE FROM hx_app_entities WHERE org_id=? AND table_id=?').bind(ORG,publicApp.tableId).run();
  await env.DB.prepare("INSERT INTO hx_app_entities(org_id,app_id,table_id,entity_key) VALUES (?,?,?,'linked')").bind(ORG,privateApp.id,publicApp.tableId).run();
 }
 const path=`/hx/personal-views/${publicApp.id}`;
 expect((await get(`${path}?orgId=${ORG}`,mika)).status).toBe(404);
 expect((await send('PUT',path,mika,{orgId:ORG,expectedRevision:0,views:[],layouts:{}})).status).toBe(404);
 expect((await get(`${path}?orgId=${ORG}`,toru)).status).toBe(200);
});

test('personal view saves fail when another table-sharing app becomes private before the write',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app:publicApp}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Public',columns:[{name:'Name',type:'text'}]})).json();
 const {app:otherApp}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Other',columns:[{name:'Name',type:'text'}]})).json();
 await env.DB.prepare('UPDATE hx_apps SET table_id=? WHERE org_id=? AND id=?').bind(publicApp.tableId,ORG,otherApp.id).run();
 let revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];return sql=>{
  const statement=db.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
  return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!revoked){revoked=true;await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,otherApp.id).run()}return bound.run()}}}};
 }}});
 const result=await personalViews(racing,ORG,'9102',publicApp.id,{expectedRevision:0,views:[],layouts:{}});
 expect(result.status).toBe(404);
 expect(await env.DB.prepare('SELECT 1 FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(ORG,'9102',publicApp.id).first()).toBeNull();
});

test('personal view reads do not return rows if another table-sharing app becomes private before response',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app:publicApp}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Public',columns:[{name:'Name',type:'text'}]})).json();
 const {app:otherApp}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Other',columns:[{name:'Name',type:'text'}]})).json();
 await env.DB.prepare('UPDATE hx_apps SET table_id=? WHERE org_id=? AND id=?').bind(publicApp.tableId,ORG,otherApp.id).run();
 let revoked=false;
 const racing=new Proxy(env.DB,{get(db,key){if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];return sql=>{
  const statement=db.prepare(sql);if(!sql.startsWith('SELECT 1 AS allowed WHERE EXISTS(SELECT 1 FROM hx_apps a'))return statement;
  return {bind(...args){const bound=statement.bind(...args);return {async first(){if(!revoked){revoked=true;await env.DB.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,otherApp.id).run()}return bound.first()}}}};
 }}});
 const result=await personalViews(racing,ORG,'9102',publicApp.id);
 expect(result.status).toBe(404);expect(result.snapshot).toBeUndefined();expect(result.computed).toBeUndefined();
});

test.each(['read','write'])('personal view %s rejects a table replacement with the same schema and timestamp',async operation=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Original',columns:[{name:'Name',type:'text'}]})).json();
 const {app:replacement}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Replacement',columns:[{name:'Name',type:'text'}]})).json();
 await env.DB.prepare('UPDATE hx_tables SET columns=(SELECT columns FROM hx_tables WHERE org_id=? AND id=?),updated_at=(SELECT updated_at FROM hx_tables WHERE org_id=? AND id=?) WHERE org_id=? AND id=?').bind(ORG,app.tableId,ORG,app.tableId,ORG,replacement.tableId).run();
 let swapped=false;
 const racing=new Proxy(env.DB,{get(db,key){if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];return sql=>{
  const statement=db.prepare(sql);const target=operation==='write'?sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'):sql.startsWith('SELECT 1 AS allowed WHERE EXISTS(SELECT 1 FROM hx_apps a');if(!target)return statement;
  return {bind(...args){const bound=statement.bind(...args);const swap=async()=>{if(!swapped){swapped=true;await env.DB.prepare('UPDATE hx_apps SET table_id=? WHERE org_id=? AND id=?').bind(replacement.tableId,ORG,app.id).run()}};return operation==='write'?{async run(){await swap();return bound.run()}}:{async first(){await swap();return bound.first()}}}};
 }}});
 const result=await personalViews(racing,ORG,'9102',app.id,operation==='write'?{expectedRevision:0,views:[],layouts:{}}:undefined);
 expect(result.status).toBe(409);expect(result.snapshot).toBeUndefined();expect(result.computed).toBeUndefined();
 if(operation==='write')expect(await env.DB.prepare('SELECT 1 FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(ORG,'9102',app.id).first()).toBeNull();
});

test('personal view denies a newly orphaned table entity reference before writing',async()=>{
 const {personalViews}=await import('../src/harness/personalViews.js');
 const {app}=await (await send('POST','/apps',toru,{orgId:ORG,name:'Orphan reference',columns:[{name:'Name',type:'text'}]})).json();
 await env.DB.prepare("INSERT INTO hx_apps(id,org_id,name,description,icon,table_id,template,version,definition,created_by,created_at,updated_at) SELECT 'other_org_app','other-org',name,description,icon,table_id,template,version,definition,created_by,created_at,updated_at FROM hx_apps WHERE org_id=? AND id=?").bind(ORG,app.id).run();
 let inserted=false;
 const racing=new Proxy(env.DB,{get(db,key){if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];return sql=>{
  const statement=db.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO hx_personal_views'))return statement;
  return {bind(...args){const bound=statement.bind(...args);return {async run(){if(!inserted){inserted=true;await env.DB.prepare("INSERT INTO hx_app_entities(org_id,app_id,entity_key,table_id) VALUES (?,'other_org_app','orphan',?)").bind(ORG,app.tableId).run()}return bound.run()}}}};
 }}});
 const result=await personalViews(racing,ORG,'9102',app.id,{expectedRevision:0,views:[],layouts:{}});
 expect(result.status).toBe(404);
 expect(await env.DB.prepare('SELECT 1 FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(ORG,'9102',app.id).first()).toBeNull();
});

test.each(['primary', 'entity'])('app row reads and home summaries enforce private shared %s table access', async relation => {
  const { app } = await (await send('POST', '/apps', toru, { orgId: ORG, template: 'crm' })).json();
  const { app: linked } = await (await send('POST', '/apps', mika, { orgId: ORG, template: 'crm' })).json();
  const added = await send('POST', `/tables/${app.tableId}/rows`, toru, { orgId: ORG, values: { Company: 'Secret row' } });
  expect(added.status).toBe(201);
  if (relation === 'primary') await env.DB.prepare('UPDATE hx_apps SET table_id=? WHERE org_id=? AND id=?').bind(app.tableId, ORG, linked.id).run();
  else await env.DB.prepare("INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) VALUES (?,?,'shared',?)").bind(ORG, linked.id, app.tableId).run();
  expect((await send('PUT', `/apps/${linked.id}/access`, mika, { orgId: ORG, visibility: 'private', version: 0 })).status).toBe(200);
  const { callHarnessTool } = await import('../src/harness/mcpTools.js');
  expect((await get(`/apps/${app.id}?orgId=${ORG}`, toru)).status).toBe(404);
  expect((await callHarnessTool(env, {orgId:ORG, githubId:'9101'}, 'read_app', {appId:app.id})).isError).toBe(true);
  expect((await (await get(`/harness/home?orgId=${ORG}`, toru)).json()).apps.some(a=>a.id===app.id)).toBe(false);
  expect((await get(`/apps/${app.id}?orgId=${ORG}`, mika)).status).toBe(200);
  expect((await callHarnessTool(env, {orgId:ORG, githubId:'9102'}, 'read_app', {appId:app.id})).isError).not.toBe(true);
});

test.each(['http', 'mcp', 'home'])('app row read checks linked visibility again at response boundary for %s', async mode => {
  const { app } = await (await send('POST', '/apps', toru, { orgId: ORG, template: 'crm' })).json();
  const { app: linked } = await (await send('POST', '/apps', mika, { orgId: ORG, template: 'crm' })).json();
  await env.DB.prepare("INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) VALUES (?,?,'shared',?)").bind(ORG, linked.id, app.tableId).run();
  let changed = false;
  const racing = new Proxy(env.DB, {get(db,key) {
    if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
    return sql => { const statement=db.prepare(sql); if(!sql.startsWith('SELECT 1 AS allowed FROM hx_apps target'))return statement;
      return {bind(...args) {const bound=statement.bind(...args);return {async first() {
        if(!changed && args[1]===app.id) {changed=true;await db.prepare("INSERT INTO hx_app_access(org_id,app_id,visibility,version) VALUES (?,?,'private',1)").bind(ORG,linked.id).run();}
        return bound.first();
      }}}};
    };
  }});
  if(mode==='mcp') {
    const {callHarnessTool}=await import('../src/harness/mcpTools.js');
    expect((await callHarnessTool({...env,DB:racing},{orgId:ORG,githubId:'9101'},'read_app',{appId:app.id})).isError).toBe(true);
  } else {
    const path = mode==='home'?'/harness/home':`/apps/${app.id}`;
    const response=await worker.fetch(new Request(`https://example.com${path}?orgId=${ORG}`,{headers:headers(toru)}),{...env,DB:racing});
    if(mode==='home')expect((await response.json()).apps.some(a=>a.id===app.id)).toBe(false);
    else expect(response.status).toBe(404);
  }
  expect(changed).toBe(true);
});

test('a changed primary table cannot authorize rows read from the previous table',async()=>{
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  const {app:replacement}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  let changed=false;
  const racing=new Proxy(env.DB,{get(db,key){
    if(key!=='prepare')return typeof db[key]==='function'?db[key].bind(db):db[key];
    return sql=>{const statement=db.prepare(sql);if(!sql.startsWith('SELECT 1 AS allowed FROM hx_apps target'))return statement;
      return {bind(...args){const bound=statement.bind(...args);return {async first(){
        if(!changed){changed=true;await db.prepare('UPDATE hx_apps SET table_id=? WHERE org_id=? AND id=?').bind(replacement.tableId,ORG,app.id).run()}
        return bound.first();
      }}}};
    };
  }});
  const response=await worker.fetch(new Request(`https://example.com/apps/${app.id}?orgId=${ORG}`,{headers:headers(toru)}),{...env,DB:racing});
  expect(changed).toBe(true);
  expect(response.status).toBe(404);
});

test('app row reads fail closed when a table entity has no app in this workspace',async()=>{
  const {app}=await (await send('POST','/apps',toru,{orgId:ORG,template:'crm'})).json();
  const {app:other}=await (await send('POST','/apps',outsider,{orgId:'personal:elsewhere',template:'crm'})).json();
  // The foreign key is on app_id alone, so this inconsistent org reference is
  // possible without disabling foreign keys; mayUseTable denies it.
  await env.DB.prepare("INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) VALUES (?,?,'invalid',?)").bind(ORG,other.id,app.tableId).run();
  expect((await get(`/tables/${app.tableId}?orgId=${ORG}`,toru)).status).toBe(404);
  expect((await get(`/apps/${app.id}?orgId=${ORG}`,toru)).status).toBe(404);
  const {callHarnessTool}=await import('../src/harness/mcpTools.js');
  expect((await callHarnessTool(env,{orgId:ORG,githubId:'9101'},'read_app',{appId:app.id})).isError).toBe(true);
  expect((await (await get(`/harness/home?orgId=${ORG}`,toru)).json()).apps.some(a=>a.id===app.id)).toBe(false);
});

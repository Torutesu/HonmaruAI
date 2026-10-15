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

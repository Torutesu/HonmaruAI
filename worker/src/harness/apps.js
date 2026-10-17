// Apps: internal tools built on a Table (docs/kylon-gap-plan.md).
//
// An app is a table plus views over it — table, board, metrics — kept as a
// versioned definition. It can be linked to rooms, where it shows next to the
// conversation. Apps start from a template or from a sentence ("an invoice
// tracker for #ops"); with a model the sentence can describe any table, and
// without one it still lands on the closest template.

import { TEMPLATES, matchTemplate } from "./templates.js";
import { createTable, getTable, listRows, addRow, updateTable, MAX_ROWS } from "./tables.js";

export const VIEW_TYPES = ["table", "board", "metrics", "calendar"];
export const METRIC_OPS = ["count", "sum", "avg", "min", "max"];
export const MAX_APPS_PER_ORG = 100;

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const now = () => new Date().toISOString();
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/// Views as the app keeps them: each names columns by id, so a column the
/// table no longer has is dropped instead of breaking the app.
export function normalizeDefinition(definition, columns) {
  const ids = new Set(columns.map((c) => c.id));
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c.id]));
  const col = (ref) => (ids.has(ref) ? ref : byName.get(String(ref ?? "").toLowerCase()) || null);
  const where = (w) => {
    if (!w || typeof w !== "object") return undefined;
    const out = {};
    for (const [k, v] of Object.entries(w)) {
      const id = col(k);
      if (id) out[id] = (Array.isArray(v) ? v : [v]).map(String);
    }
    return Object.keys(out).length ? out : undefined;
  };
  const views = [];
  for (const raw of Array.isArray(definition?.views) ? definition.views.slice(0, 12) : []) {
    const type = VIEW_TYPES.includes(raw?.type) ? raw.type : null;
    if (!type) continue;
    const view = { id: typeof raw.id === "string" ? raw.id.slice(0, 32) : newId("view"), type, name: String(raw.name || type).slice(0, 40) };
    const w = where(raw.where);
    if (w) view.where = w;
    if (raw.sort) {
      const desc = String(raw.sort).startsWith("-");
      const id = col(String(raw.sort).replace(/^-/, ""));
      if (id) view.sort = desc ? `-${id}` : id;
    }
    if (type === "calendar") {
      const dateColumn = col(raw.dateColumn) || columns.find(c => c.type === "date")?.id;
      if (!columns.some(c => c.id === dateColumn && c.type === "date")) continue;
      view.dateColumn = dateColumn;
    }
    if (type === "board") {
      const groupBy = col(raw.groupBy) || columns.find((c) => c.type === "select")?.id;
      if (!groupBy) continue;
      view.groupBy = groupBy;
    }
    if (type === "metrics") {
      view.metrics = (Array.isArray(raw.metrics) ? raw.metrics.slice(0, 8) : [])
        .map((m) => {
          const op = METRIC_OPS.includes(m?.op) ? m.op : "count";
          const metric = { label: String(m?.label || op).slice(0, 40), op };
          if (op !== "count") {
            const c = col(m.column);
            if (!c) return null;
            metric.column = c;
          }
          const mw = where(m.where);
          if (mw) metric.where = mw;
          if (m.overdue) {
            const c = col(m.overdue);
            if (c) metric.overdue = c;
          }
          return metric;
        })
        .filter(Boolean);
    }
    views.push(view);
  }
  if (!views.length) views.push({ id: newId("view"), type: "table", name: "All" });
  return { views };
}

const matches = (values, where) => !where || Object.entries(where).every(([k, allowed]) => allowed.includes(String(values[k] ?? "")));

/// What a view shows, worked out on the server so every client — web, iOS,
/// an agent over MCP — reads the same numbers.
export function computeView(view, table, rows, today = new Date().toISOString().slice(0, 10)) {
  let shown = rows.filter((r) => matches(r.values, view.where));
  if (view.sort) {
    const desc = view.sort.startsWith("-");
    const key = view.sort.replace(/^-/, "");
    shown = [...shown].sort((a, b) => {
      const x = a.values[key], y = b.values[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return desc ? -c : c;
    });
  }
  if (view.type === "calendar") {
    const days = new Map();
    const undated = [];
    for (const row of shown) {
      const date = row.values[view.dateColumn];
      const valid = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
        && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
      if (!valid) { undated.push(row); continue; }
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(row);
    }
    return { ...view, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({ date, rows })), undated };
  }
  if (view.type === "board") {
    const column = table.columns.find((c) => c.id === view.groupBy);
    const lanes = (column?.options || []).map((option) => ({ key: option, rows: [] }));
    const none = { key: null, rows: [] };
    for (const row of shown) {
      const lane = lanes.find((l) => l.key === row.values[view.groupBy]);
      (lane || none).rows.push(row);
    }
    if (none.rows.length) lanes.push(none);
    return { ...view, lanes };
  }
  if (view.type === "metrics") {
    const values = (view.metrics || []).map((m) => {
      let set = shown.filter((r) => matches(r.values, m.where));
      if (m.overdue) set = set.filter((r) => r.values[m.overdue] && r.values[m.overdue] < today);
      const nums = m.column ? set.map((r) => r.values[m.column]).filter((v) => typeof v === "number") : [];
      let value;
      switch (m.op) {
        case "sum": value = nums.reduce((a, b) => a + b, 0); break;
        case "avg": value = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null; break;
        case "min": value = nums.length ? Math.min(...nums) : null; break;
        case "max": value = nums.length ? Math.max(...nums) : null; break;
        default: value = set.length;
      }
      return { ...m, value };
    });
    return { ...view, values };
  }
  return { ...view, rows: shown };
}

const publicApp = (row) => row && ({
  id: row.id, orgId: row.org_id, name: row.name, description: row.description || "", icon: row.icon || "📋",
  tableId: row.table_id, template: row.template || null, version: row.version,
  definition: parse(row.definition, { views: [] }),
  createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
});

export async function getApp(db, orgId, id) {
  return publicApp(await db.prepare("SELECT * FROM hx_apps WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first());
}

export async function listApps(db, orgId, { channel } = {}) {
  const sql = channel
    ? "SELECT a.* FROM hx_apps a JOIN hx_app_links l ON l.app_id = a.id WHERE a.org_id = ?1 AND l.channel = ?2 ORDER BY a.created_at ASC"
    : "SELECT * FROM hx_apps WHERE org_id = ?1 ORDER BY created_at ASC";
  const stmt = db.prepare(sql);
  const { results } = await (channel ? stmt.bind(orgId, channel) : stmt.bind(orgId)).all();
  const apps = (results || []).map(publicApp);
  if (!apps.length) return apps;
  const { results: links } = await db
    .prepare(`SELECT app_id, channel FROM hx_app_links WHERE org_id = ?1 AND app_id IN (${apps.map((_, i) => `?${i + 2}`).join(",")})`)
    .bind(orgId, ...apps.map((a) => a.id))
    .all();
  for (const app of apps) app.channels = (links || []).filter((l) => l.app_id === app.id).map((l) => l.channel);
  return apps;
}

/// Build an app: a new table from the spec, its views, and the first version.
export async function createApp(db, { orgId, by, name, description, icon, columns, definition, template, sample = [], channel }) {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM hx_apps WHERE org_id = ?1").bind(orgId).first();
  if (Number(count?.n || 0) >= MAX_APPS_PER_ORG) return { error: "This workspace has as many apps as it can hold." };
  const clean = String(name ?? "").trim().slice(0, 80);
  if (!clean) return { error: "Give the app a name." };
  const made = await createTable(db, { orgId, name: clean, columns, by });
  if (made.error) return made;
  const table = made.table;
  const def = normalizeDefinition(definition, table.columns);
  const id = newId("app");
  const at = now();
  await db
    .prepare(
      `INSERT INTO hx_apps (id, org_id, name, description, icon, table_id, template, version, definition, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?10)`,
    )
    .bind(id, orgId, clean, String(description || "").slice(0, 300), String(icon || "📋").slice(0, 8), table.id, template || null, JSON.stringify(def), String(by), at)
    .run();
  await db
    .prepare("INSERT INTO hx_app_versions (app_id, org_id, version, definition, note, created_by, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)")
    .bind(id, orgId, JSON.stringify({ name: clean, columns: table.columns, ...def }), "Created", String(by), at)
    .run();
  for (const values of sample.slice(0, 20)) await addRow(db, orgId, table.id, values, by);
  if (channel) await linkApp(db, orgId, id, channel, by);
  return { app: await getApp(db, orgId, id) };
}

export async function createFromTemplate(db, { orgId, by, template, name, channel, withSample = true }) {
  const t = TEMPLATES[template];
  if (!t) return { error: "No such template." };
  return createApp(db, {
    orgId, by, template, channel,
    name: name || t.name, description: t.description, icon: t.icon,
    columns: t.columns, definition: { views: t.views }, sample: withSample ? t.sample : [],
  });
}

/// A new version: change the name, the views, or the table's columns. The
/// previous definition is kept, so a change can be undone.
export async function updateApp(db, orgId, id, { name, description, icon, columns, definition, note }, by) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  let table = await getTable(db, orgId, app.tableId);
  if (columns !== undefined) {
    const changed = await updateTable(db, orgId, app.tableId, { columns });
    if (changed.error) return changed;
    table = changed.table;
  }
  const def = normalizeDefinition(definition ?? app.definition, table.columns);
  if (app.definition.custom) def.custom = app.definition.custom;
  const next = {
    name: name !== undefined ? String(name).trim().slice(0, 80) || app.name : app.name,
    description: description !== undefined ? String(description).slice(0, 300) : app.description,
    icon: icon !== undefined ? String(icon).slice(0, 8) : app.icon,
  };
  const version = app.version + 1;
  const at = now();
  const changed = await db
    .prepare("UPDATE hx_apps SET name = ?1, description = ?2, icon = ?3, definition = ?4, version = ?5, updated_at = ?6 WHERE id = ?7 AND org_id = ?8 AND version = ?9")
    .bind(next.name, next.description, next.icon, JSON.stringify(def), version, at, id, orgId, app.version)
    .run();
  if (!changed.meta?.changes) return { error: "This app changed. Reload before saving.", status: 409 };
  await db
    .prepare("INSERT INTO hx_app_versions (app_id, org_id, version, definition, note, created_by, created_at) VALUES (?1, ?7, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, version, JSON.stringify({ name: next.name, columns: table.columns, ...def }), note ? String(note).slice(0, 200) : null, String(by), at, orgId)
    .run();
  return { app: await getApp(db, orgId, id) };
}

export async function listVersions(db, orgId, id) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  const { results } = await db
    .prepare("SELECT version, note, created_by, created_at FROM hx_app_versions WHERE app_id = ?1 AND org_id = ?2 ORDER BY version DESC")
    .bind(id, orgId)
    .all();
  return { versions: (results || []).map((v) => ({ version: v.version, note: v.note, createdBy: v.created_by, createdAt: v.created_at })) };
}

/// Go back to an earlier version — as a new version, so nothing is lost.
export async function restoreVersion(db, orgId, id, version, by) {
  const row = await db.prepare("SELECT definition FROM hx_app_versions WHERE app_id = ?1 AND org_id = ?2 AND version = ?3").bind(id, orgId, Number(version)).first();
  if (!row) return { error: "No such version.", status: 404 };
  const old = parse(row.definition, {});
  return updateApp(db, orgId, id, { name: old.name, columns: old.columns, definition: { views: old.views }, note: `Restored version ${version}` }, by);
}

export async function deleteApp(db, orgId, id) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  await db.batch([
    db.prepare("DELETE FROM hx_app_links WHERE app_id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_app_versions WHERE app_id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_apps WHERE id = ?1 AND org_id = ?2").bind(id, orgId),
    db.prepare("DELETE FROM hx_rows WHERE table_id = ?1 AND org_id = ?2").bind(app.tableId, orgId),
    db.prepare("DELETE FROM hx_tables WHERE id = ?1 AND org_id = ?2").bind(app.tableId, orgId),
  ]);
  return { deleted: true };
}

export async function linkApp(db, orgId, id, channel, by) {
  const key = String(channel || "").trim().slice(0, 200);
  if (!key) return { error: "channel is required" };
  await db
    .prepare("INSERT OR IGNORE INTO hx_app_links (app_id, org_id, channel, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, orgId, key, String(by), now())
    .run();
  return { linked: true };
}

export async function unlinkApp(db, orgId, id, channel) {
  await db.prepare("DELETE FROM hx_app_links WHERE app_id = ?1 AND org_id = ?2 AND channel = ?3").bind(id, orgId, String(channel)).run();
  return { unlinked: true };
}

/// The app with every view worked out, ready to draw.
export async function renderApp(db, orgId, id) {
  const app = await getApp(db, orgId, id);
  if (!app) return { error: "No such app.", status: 404 };
  const { table, rows } = await listRows(db, orgId, app.tableId, { limit: MAX_ROWS });
  const { results: links } = await db.prepare("SELECT channel FROM hx_app_links WHERE app_id = ?1 AND org_id = ?2").bind(id, orgId).all();
  app.channels = (links || []).map((l) => l.channel);
  return { app, table, rows, views: app.definition.views.map((v) => computeView(v, table, rows)) };
}

/// A spec from a sentence. A model, when there is one, may design any table;
/// it answers in JSON and the answer is validated like any other input.
/// Without a model, or when its answer does not hold up, the closest
/// template is used — "an invoice tracker for #ops" always gets an app.
export async function specFromPrompt(prompt, { complete } = {}) {
  const text = String(prompt || "").trim().slice(0, 1000);
  if (!text) return { error: "Say what the app is for." };
  if (complete) {
    try {
      const raw = await complete(
        [
          "Design a small internal business app as JSON, nothing else.",
          'Shape: {"name": string, "icon": one emoji, "description": string, "columns": [{"name": string, "type": "text"|"number"|"date"|"select"|"checkbox"|"url"|"person"|"email", "options"?: string[]}],',
          '"views": [{"type": "table"|"board"|"metrics"|"calendar", "dateColumn"?: column name, "name": string, "groupBy"?: column name, "sort"?: column name or "-name", "metrics"?: [{"label": string, "op": "count"|"sum"|"avg", "column"?: column name}]}]}',
          "At most 10 columns. A board needs a select column to group by. Name things in the language of the request.",
        ].join("\n"),
        text,
      );
      const spec = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, "").trim());
      if (spec && Array.isArray(spec.columns) && spec.columns.length && spec.name) {
        return { spec: { name: spec.name, icon: spec.icon, description: spec.description, columns: spec.columns.slice(0, 10), definition: { views: spec.views || [] } }, source: "model" };
      }
    } catch { /* fall through to a template */ }
  }
  const id = matchTemplate(text) || "tracker";
  const t = TEMPLATES[id];
  const room = text.match(/#([\p{L}\p{N}_-]+)/u)?.[1];
  return {
    spec: { name: t.name, icon: t.icon, description: t.description, columns: t.columns, definition: { views: t.views }, template: id, sample: t.sample },
    source: "template",
    room: room || null,
  };
}

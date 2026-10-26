import { validateValues } from "./tableContract.js";
import { appRelationDeleteGuard, appRelationWriteGuard, hasAppRelationsToRow, validateAppRelations } from './appRelations.js';
// Tables: the typed database under an App (docs/kylon-gap-plan.md).
//
// A table names its columns; a row is JSON keyed by column id. Values are
// coerced to the column's type on the way in, so a view or an agent reading
// a row never has to guess whether "1,200" is a number.

export const COLUMN_TYPES = ["text", "number", "date", "select", "checkbox", "url", "person", "email", "relation"];
export const MAX_COLUMNS = 40;
export const MAX_ROWS = 5000;
export const MAX_TABLES_PER_ORG = 200;

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const now = () => new Date().toISOString();

/// Column ids are short and stable: renaming a column keeps its data.
function columnId(name, taken) {
  const base = String(name).toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "col";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/// Clean a column list, or say what is wrong with it.
export function normalizeColumns(input, existing = [], { allowRelations = false } = {}) {
  if (!Array.isArray(input) || input.length === 0) return { error: "A table needs at least one column." };
  if (input.length > MAX_COLUMNS) return { error: `A table has at most ${MAX_COLUMNS} columns.` };
  const taken = new Set();
  const known = new Map(existing.map((c) => [c.id, c]));
  const out = [];
  for (const raw of input) {
    const name = String(raw?.name ?? "").trim().slice(0, 60);
    if (!name) return { error: "Every column needs a name." };
    const type = COLUMN_TYPES.includes(raw?.type) ? raw.type : "text";
    let id = typeof raw?.id === "string" && known.has(raw.id) && !taken.has(raw.id) ? raw.id : null;
    if (id) taken.add(id);
    else id = columnId(name, taken);
    const column = { id, name, type };
    if (type === "select") {
      const options = (Array.isArray(raw.options) ? raw.options : [])
        .map((o) => String(o ?? "").trim().slice(0, 40))
        .filter(Boolean);
      column.options = [...new Set(options)].slice(0, 30);
    }
    if (type === "relation") {
      if (!allowRelations) return { error: "Relations can only be added through an app database migration." };
      const targetEntity = String(raw.targetEntity ?? "");
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(targetEntity)) return { error: "A relation field names a valid app entity." };
      column.targetEntity = targetEntity;
      column.multiple = raw.multiple === true;
    }
    out.push(column);
  }
  return { columns: out };
}

/// One value, as its column keeps it. Undefined means "leave it out".
export function coerce(column, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  switch (column.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[,\s$¥€£]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return value === true || value === 1 || ["true", "yes", "1", "on"].includes(String(value).toLowerCase());
    case "date": {
      const s = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case "select": {
      const s = String(value).trim();
      return column.options?.includes(s) ? s : null;
    }
    case "url": {
      const s = String(value).trim();
      return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : null;
    }
    case "email": {
      const s = String(value).trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.slice(0, 320) : null;
    }
    case "person":
      return String(value).trim().replace(/^@/, "").slice(0, 64) || null;
    case "relation":
      if (column.multiple) {
        if (!Array.isArray(value)) return value;
        if (value.some(item => typeof item !== 'string')) return value;
        const ids=value.map(item=>item.trim());
        if(ids.length>100||ids.some(id=>!id||id.length>64))return ids;
        return [...new Set(ids)];
      }
      return typeof value==='string' ? value.trim().slice(0,65) || null : value;
    default:
      return String(value).slice(0, 5000);
  }
}

/// A row's values, cleaned against the table. Unknown keys are dropped; a
/// column may be named by its id or its name.
export function cleanValues(columns, values) {
  const out = {};
  if (!values || typeof values !== "object") return out;
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const [key, value] of Object.entries(values)) {
    const column = byId.get(key) || byName.get(String(key).toLowerCase());
    if (!column) continue;
    const v = coerce(column, value);
    if (v !== undefined) out[column.id] = v;
  }
  return out;
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const publicTable = (row) => row && ({
  id: row.id, orgId: row.org_id, name: row.name, columns: parse(row.columns, []),
  createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
});
const publicRow = (row) => row && ({
  id: row.id, tableId: row.table_id, values: parse(row.data, {}), position: row.position,
  createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
});

// Apps include this insertion in the same transaction as their access policy.
export async function prepareTable(db, { orgId, name, columns, by }) {
  const clean = String(name ?? "").trim().slice(0, 80);
  if (!clean) return { error: "Give the table a name." };
  const cols = normalizeColumns(columns);
  if (cols.error) return cols;
  const count = await db.prepare("SELECT COUNT(*) AS n FROM hx_tables WHERE org_id = ?1").bind(orgId).first();
  if (Number(count?.n || 0) >= MAX_TABLES_PER_ORG) return { error: "This workspace has as many tables as it can hold." };
  const id = newId("tbl");
  const at = now();
  const statement = db
    .prepare("INSERT INTO hx_tables (id, org_id, name, columns, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)")
    .bind(id, orgId, clean, JSON.stringify(cols.columns), String(by), at);
  return { statement, table: publicTable({id, org_id:orgId, name:clean, columns:JSON.stringify(cols.columns), created_by:String(by), created_at:at, updated_at:at}) };
}

export async function createTable(db, input) {
  const prepared = await prepareTable(db, input);
  if (prepared.error) return prepared;
  await prepared.statement.run();
  return {table:prepared.table};
}

export async function getTable(db, orgId, id) {
  return publicTable(await db.prepare("SELECT * FROM hx_tables WHERE id = ?1 AND org_id = ?2").bind(id, orgId).first());
}

export async function listTables(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM hx_tables WHERE org_id = ?1 ORDER BY created_at ASC").bind(orgId).all();
  return (results || []).map(publicTable);
}

export async function updateTable(db, orgId, id, input) {
  const plan = await planTableUpdate(db, orgId, id, input);
  if (plan.error) return plan;
  const changed = await plan.statement.run();
  if(!changed.meta?.changes)return {error:'Table schema changed. Reload before editing.',status:409};
  return { table: await getTable(db, orgId, id) };
}

/// A table edit checked but not yet written: the columns it makes, and the
/// statement that writes them only while nobody else has changed the table.
/// `guard` is one more condition the write waits on, as SQL whose own
/// parameters start at ?9 — an app's save writes its table only while the
/// app is still the version that save was made from.
export async function planTableUpdate(db, orgId, id, { name, columns }, guard = { sql: "1", binds: [] }) {
  const table = await getTable(db, orgId, id);
  if (!table) return { error: "No such table.", status: 404 };
  const next = { name: table.name, columns: table.columns };
  if (name !== undefined) {
    const clean = String(name ?? "").trim().slice(0, 80);
    if (!clean) return { error: "Give the table a name." };
    next.name = clean;
  }
  if (columns !== undefined) {
    const managed = await db.prepare(`SELECT a.id FROM hx_apps a JOIN hx_app_database_state s ON s.app_id=a.id AND s.org_id=a.org_id WHERE a.org_id=?1 AND s.version>0 AND (a.table_id=?2 OR EXISTS (SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=?2))`).bind(orgId,id).first();
    if(managed) return {error:'This schema is migration-managed. Use the app database migration editor.',status:409};
    const cols = normalizeColumns(columns, table.columns);
    if (cols.error) return cols;
    next.columns = cols.columns;
  }
  const statement = db
    .prepare(`UPDATE hx_tables SET name = ?1, columns = ?2, updated_at = ?3 WHERE id = ?4 AND org_id = ?5 AND columns=?6 AND updated_at=?7
      AND (?8=0 OR NOT EXISTS (SELECT 1 FROM hx_apps a JOIN hx_app_database_state s ON s.app_id=a.id AND s.org_id=a.org_id WHERE a.org_id=?5 AND s.version>0 AND (a.table_id=?4 OR EXISTS (SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=?4))))
      AND (${guard.sql})`)
    .bind(next.name, JSON.stringify(next.columns), new Date(Math.max(Date.now(),Date.parse(table.updatedAt)+1)).toISOString(), id, orgId, JSON.stringify(table.columns),table.updatedAt,columns===undefined?0:1, ...guard.binds);
  return { table: { ...table, ...next }, statement };
}

export async function deleteTable(db, orgId, id) {
  const inUse = await db.prepare("SELECT id FROM hx_apps WHERE table_id = ?1 AND org_id = ?2 UNION SELECT app_id AS id FROM hx_app_entities WHERE table_id = ?1 AND org_id = ?2 LIMIT 1").bind(id, orgId).first();
  if (inUse) return { error: "An app is built on this table. Delete the app first.", status: 409 };
  await db.prepare("DELETE FROM hx_rows WHERE table_id = ?1 AND org_id = ?2").bind(id, orgId).run();
  const res = await db.prepare("DELETE FROM hx_tables WHERE id = ?1 AND org_id = ?2").bind(id, orgId).run();
  return res.meta?.changes ? { deleted: true } : { error: "No such table.", status: 404 };
}

/// Rows, optionally narrowed: `where` is { columnId: value } (equality),
/// `q` matches any text, `sort` is a column id with an optional leading "-".
export async function listRows(db, orgId, tableId, { where, q, sort, limit = 500, offset = 0 } = {}) {
  const table = await getTable(db, orgId, tableId);
  if (!table) return { error: "No such table.", status: 404 };
  const pageSize = Number(limit), start = Number(offset);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_ROWS || !Number.isInteger(start) || start < 0 || start > MAX_ROWS) return { error: "Invalid pagination: limit must be 1–5000 and offset 0–5000.", status: 400 };
  if (where !== undefined && (!where || typeof where !== "object" || Array.isArray(where))) return { error: "where must be an object.", status: 400 };
  if (where && Object.keys(where).some(key => !table.columns.some(c => c.id === key || c.name.toLowerCase() === key.toLowerCase()))) return { error: "Unknown filter column.", status: 400 };
  if (sort && !table.columns.some(c => c.id === String(sort).replace(/^-/, ""))) return { error: "Unknown sort column.", status: 400 };
  const { results } = await db
    .prepare("SELECT * FROM hx_rows WHERE table_id = ?1 AND org_id = ?2 ORDER BY position ASC, created_at ASC, id ASC LIMIT ?3")
    .bind(tableId, orgId, MAX_ROWS)
    .all();
  let rows = (results || []).map(publicRow);
  if (where && typeof where === "object") {
    const clean = cleanValues(table.columns, where);
    rows = rows.filter((r) => Object.entries(clean).every(([k, v]) => r.values[k] === v));
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => Object.values(r.values).some((v) => v != null && String(v).toLowerCase().includes(needle)));
  }
  if (sort) {
    const desc = String(sort).startsWith("-");
    const key = String(sort).replace(/^-/, "");
    rows.sort((a, b) => {
      const x = a.values[key], y = b.values[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return desc ? -c : c;
    });
  }
  const total = rows.length;
  return { table, rows: rows.slice(start, start + pageSize), total, offset: start, limit: pageSize, nextOffset: start + pageSize < total ? start + pageSize : null };
}

export async function getRow(db, orgId, tableId, rowId) {
  return publicRow(await db.prepare("SELECT * FROM hx_rows WHERE id = ?1 AND table_id = ?2 AND org_id = ?3").bind(rowId, tableId, orgId).first());
}

export async function addRow(db, orgId, tableId, values, by, validation) {
  const table = await getTable(db, orgId, tableId);
  if (!table) return { error: "No such table.", status: 404 };
  const invalid = checkValues(table, values, validation);
  if (invalid) return invalid;
  const storedValues = validation === 'strict' ? values : cleanValues(table.columns, values);
  const relationError = await validateAppRelations(db, orgId, tableId, table.columns, storedValues);
  if (relationError) return relationError;
  const relationGuard = await appRelationWriteGuard(db, orgId, tableId, table.columns, storedValues, 8);
  if (relationGuard.error) return relationGuard.error;
  const count = await db.prepare("SELECT COUNT(*) AS n, MAX(position) AS p FROM hx_rows WHERE table_id = ?1 AND org_id = ?2").bind(tableId, orgId).first();
  if (Number(count?.n || 0) >= MAX_ROWS) return { error: `A table holds at most ${MAX_ROWS} rows.` };
  const id = newId("row");
  const at = now();
  const inserted = await db
    .prepare(`INSERT INTO hx_rows (id, table_id, org_id, data, position, created_by, updated_by, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7 WHERE ${relationGuard.sql}`)
    .bind(id, tableId, orgId, JSON.stringify(storedValues), Number(count?.p || 0) + 1, String(by), at, ...relationGuard.binds)
    .run();
  if (!inserted.meta?.changes) return { error: 'A linked record changed before this record could be saved. Reload and try again.', status: 409 };
  return { table, row: await getRow(db, orgId, tableId, id) };
}

/// Change some values of a row; the others stay. Returns the row before and
/// after, so a caller can tell what changed (Workflows trigger on it).
export async function updateRow(db, orgId, tableId, rowId, values, by, expectedUpdatedAt, validation) {
  const table = await getTable(db, orgId, tableId);
  if (!table) return { error: "No such table.", status: 404 };
  const before = await getRow(db, orgId, tableId, rowId);
  if (!before) return { error: "No such row.", status: 404 };
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== before.updatedAt) return rowConflict();
  const invalid = checkValues(table, values, validation);
  if (invalid) return invalid;
  const merged = { ...before.values, ...(validation === "strict" ? values : cleanValues(table.columns, values)) };
  const relationError = await validateAppRelations(db, orgId, tableId, table.columns, merged);
  if (relationError) return relationError;
  const relationGuard = await appRelationWriteGuard(db, orgId, tableId, table.columns, merged, 8);
  if (relationGuard.error) return relationGuard.error;
  // Strictly advance even when two writes happen within the same millisecond.
  const at = new Date(Math.max(Date.now(), Date.parse(before.updatedAt) + 1)).toISOString();
  const changed = await db
    .prepare(`UPDATE hx_rows SET data = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4 AND table_id = ?5 AND org_id = ?6 AND updated_at = ?7 AND (${relationGuard.sql}) RETURNING *`)
    .bind(JSON.stringify(merged), String(by), at, rowId, tableId, orgId, before.updatedAt, ...relationGuard.binds)
    .first();
  if (!changed) return rowConflict();
  return { table, before, row: publicRow(changed) };
}

const rowConflict = () => ({ error: "This row changed. Reload the app before trying again.", status: 409 });

export async function deleteRow(db, orgId, tableId, rowId, expectedUpdatedAt) {
  const table = await getTable(db, orgId, tableId);
  if (!table) return { error: "No such row.", status: 404 };
  const before = await getRow(db, orgId, tableId, rowId);
  if (!before) return { error: "No such row.", status: 404 };
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== before.updatedAt) return rowConflict();
  if (await hasAppRelationsToRow(db, orgId, tableId, rowId)) return { error: 'This record is linked from another app record. Remove that link before deleting it.', status: 409 };
  const relationGuard = await appRelationDeleteGuard(db, orgId, tableId, 5);
  const deleted = await db.prepare(`DELETE FROM hx_rows WHERE id = ?1 AND table_id = ?2 AND org_id = ?3 AND updated_at = ?4 AND (${relationGuard.sql}) RETURNING id`).bind(rowId, tableId, orgId, before.updatedAt, ...relationGuard.binds).first();
  if (!deleted) {
    if (await hasAppRelationsToRow(db, orgId, tableId, rowId)) return { error: 'This record is linked from another app record. Remove that link before deleting it.', status: 409 };
    return rowConflict();
  }
  return { table, deleted: true, before };
}

function checkValues(table, values, validation) {
  if (validation === undefined) return null;
  if (validation !== "strict") return { error: "Unknown validation mode.", status: 400 };
  const errors = validateValues(table.columns, values);
  return errors.length ? { error: "Invalid record values.", status: 400, fields: errors } : null;
}

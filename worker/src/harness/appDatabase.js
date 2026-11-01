import { getTable, normalizeColumns, MAX_TABLES_PER_ORG, MAX_ROWS } from './tables.js';
import { validateValues } from './tableContract.js';
import { normalizeMemberFields } from './memberFields.js';
const err = (error, status = 400) => ({ error, status });
const keyOK = k => typeof k === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(k);
export const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

export function relationStateError(entities) {
  const byKey = new Map((entities || []).map(entity => [entity.key, new Set((entity.rows || []).map(row => row.id))]));
  for (const entity of entities || []) for (const column of entity.table.columns || []) {
    if (column.type !== 'relation') continue;
    const targets = byKey.get(column.targetEntity);
    if (!targets) return `The relation field "${column.name}" points to an unavailable app entity.`;
    for (const row of entity.rows || []) {
      const value = row.values?.[column.id];
      if (value == null) continue;
      if (column.multiple && (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length)) return `The linked records in "${column.name}" are invalid.`;
      const ids = column.multiple ? value : [value];
      if (ids.some(id => typeof id !== 'string' || !targets.has(id))) return `A record linked from "${column.name}" no longer exists in this app.`;
    }
  }
  return null;
}

export async function databaseView(db, orgId, app) {
  const state = await db.prepare('SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2').bind(orgId, app.id).first();
  const { results } = await db.prepare('SELECT entity_key, table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 ORDER BY entity_key').bind(orgId, app.id).all();
  const entities = [{ key: 'primary', table: await getTable(db, orgId, app.tableId) }];
  for (const r of results || []) entities.push({ key: r.entity_key, table: await getTable(db, orgId, r.table_id) });
  const journal = await db.prepare('SELECT migration_id AS id, version, checksum, plan, created_at AS createdAt FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 ORDER BY version DESC LIMIT 50').bind(orgId, app.id).all();
  return { version: state?.version || 0, entities, migrations: (journal.results || []).map(r => ({ ...r, plan: JSON.parse(r.plan) })) };
}

const MIGRATABLE_COLUMN_TYPES = new Set(['text', 'number', 'date', 'select', 'checkbox', 'url', 'email']);
const isEmptyMigrationValue = value => value === undefined || value === null || value === '';
const boundedString = value => typeof value === 'string' && value.length <= 5000;

function dateValue(value) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  if (!dateValue(value.slice(0, 10))) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function convertColumnValue(value, target) {
  if (value === undefined) return { ok: true, value };
  if (value === null || value === '') return { ok: true, value: null };
  if (target.type === 'text') {
    if (typeof value === 'string') return boundedString(value) ? { ok: true, value } : { ok: false };
    if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return { ok: true, value: String(value) };
    return { ok: false };
  }
  if (target.type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return { ok: false };
    const number = Number(value.trim());
    return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
  }
  if (target.type === 'date') {
    const date = dateValue(value);
    return date ? { ok: true, value: date } : { ok: false };
  }
  if (target.type === 'checkbox') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (typeof value === 'number' && (value === 0 || value === 1)) return { ok: true, value: value === 1 };
    if (typeof value !== 'string') return { ok: false };
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return { ok: true, value: true };
    if (['false', 'no', '0'].includes(normalized)) return { ok: true, value: false };
    return { ok: false };
  }
  if (typeof value !== 'string') return { ok: false };
  if (target.type === 'select') return target.options.includes(value) ? { ok: true, value } : { ok: false };
  if (target.type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320 ? { ok: true, value } : { ok: false };
  if (target.type === 'url') {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && value.length <= 2000 ? { ok: true, value } : { ok: false };
    } catch { return { ok: false }; }
  }
  return { ok: false };
}

// Additive changes remain backward compatible. Non-additive changes require a row preview.
export function planMigration(current, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 12) return err('Specify 1–12 database operations.');
  const entities = new Map(current.entities.map(e => [e.key, { ...e.table, columns: [...e.table.columns] }]));
  const changed = new Map();
  const mutatedColumns = new Set();
  const createdEntities = new Set();
  for (const op of operations) {
    if (!op || !keyOK(op.entity)) return err('Invalid entity key.');
    if (op.op === 'create_entity') {
      if (entities.has(op.entity) || entities.size >= 12) return err('Entity already exists or the 12-entity limit was reached.');
      if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 80) return err('Give the entity a name (1–80 characters).');
      const cols = normalizeColumns(op.columns, [], { allowRelations: true });
      if (cols.error) return cols;
      const table = { id: `tbl_${crypto.randomUUID().replace(/-/g, '')}`, name: op.name.trim(), columns: cols.columns };
      entities.set(op.entity, table); createdEntities.add(op.entity); changed.set(op.entity, { table, create: true });
    } else if (op.op === 'add_columns') {
      const table = entities.get(op.entity);
      if (!table) return err('No such entity.');
      if (!Array.isArray(op.columns) || !op.columns.length || op.columns.some(c => c.id || table.columns.some(old => old.name.toLowerCase() === String(c.name).toLowerCase()))) return err('Add new columns; existing columns cannot be replaced.');
      const cols = normalizeColumns([...table.columns, ...op.columns], table.columns, { allowRelations: true });
      if (cols.error) return cols;
      const next = { ...table, columns: cols.columns };
      entities.set(op.entity, next); changed.set(op.entity, { ...changed.get(op.entity), table: next });
    } else if (['rename_column', 'convert_column', 'drop_empty_column'].includes(op.op)) {
      const table = entities.get(op.entity);
      if (!table) return err('No such entity.');
      if (createdEntities.has(op.entity)) return err('Create an entity before migrating its columns in a separate change.');
      const index = table.columns.findIndex(column => column.id === op.column);
      if (index < 0) return err('Choose an existing stable column ID.');
      const mutationKey = `${op.entity}:${op.column}`;
      if (mutatedColumns.has(mutationKey)) return err('Change each existing column at most once per migration.');
      mutatedColumns.add(mutationKey);
      const existing = table.columns[index];
      if (!MIGRATABLE_COLUMN_TYPES.has(existing.type)) return err('Person and relation columns cannot be changed by this migration.');
      let nextColumns = [...table.columns];
      if (op.op === 'rename_column') {
        if (typeof op.name !== 'string' || !op.name.trim() || op.name.trim().length > 60) return err('Give the renamed column a name (1–60 characters).');
        if (nextColumns.some((column, i) => i !== index && column.name.toLowerCase() === op.name.trim().toLowerCase())) return err('A column already has that name.');
        nextColumns[index] = { ...existing, name: op.name.trim() };
      } else if (op.op === 'convert_column') {
        if (!MIGRATABLE_COLUMN_TYPES.has(op.type)) return err('Choose a supported scalar column type.');
        const candidate = { ...existing, type: op.type };
        if (op.type === 'select') candidate.options = op.options;
        else delete candidate.options;
        const normalized = normalizeColumns(nextColumns.map((column, i) => i === index ? candidate : column), table.columns, { allowRelations: true });
        if (normalized.error) return normalized;
        nextColumns = normalized.columns;
      } else {
        if (table.columns.length <= 1) return err('A table must keep at least one column.');
        nextColumns.splice(index, 1);
      }
      const next = { ...table, columns: nextColumns };
      entities.set(op.entity, next); changed.set(op.entity, { ...changed.get(op.entity), table: next });
    } else return err('Unsupported database migration operation.');
  }
  for (const table of entities.values()) for (const column of table.columns) {
    if (column.type === 'relation' && !entities.has(column.targetEntity)) return err(`The relation field "${column.name}" points to an unavailable app entity.`);
  }
  return { changes: [...changed].map(([key, value]) => ({ key, ...value })) };
}

const hasDataOperation = operations => operations.some(operation => ['convert_column', 'drop_empty_column'].includes(operation?.op));

async function buildMigrationPreview(db, orgId, app, input) {
  if (!keyOK(input.id) || !Number.isSafeInteger(input.version) || input.version < 0) return err('A migration ID and database version are required.');
  const serialized = JSON.stringify(input.operations);
  if (!serialized || serialized.length > 30000) return err('Migration is too large.');
  const current = await databaseView(db, orgId, app);
  if (current.version !== input.version) return err('Database schema changed. Reload before previewing.', 409);
  const planned = planMigration(current, input.operations);
  if (planned.error) return planned;
  const snapshots = [], updates = [], summaries = [], blockers = [];
  let bytes = new TextEncoder().encode(serialized).length;
  let storedBytes = 0;
  for (const change of planned.changes) {
    const ops = input.operations.filter(operation => operation.entity === change.key);
    const rowOps = ops.filter(operation => ['convert_column', 'drop_empty_column'].includes(operation.op));
    const oldColumns = current.entities.find(entity => entity.key === change.key)?.table.columns || [];
    const schemaChanges = ops.map(operation => {
      const before = oldColumns.find(column => column.id === operation.column);
      const after = change.table.columns.find(column => column.id === operation.column);
      if (operation.op === 'create_entity') return { op: operation.op, entity: change.key, tableName: change.table.name, columns: change.table.columns };
      if (operation.op === 'add_columns') return { op: operation.op, columns: operation.columns };
      if (operation.op === 'rename_column') return { op: operation.op, column: operation.column, from: before?.name, to: after?.name };
      if (operation.op === 'convert_column') return { op: operation.op, column: operation.column, name: before?.name, from: before?.type, to: after?.type, options: after?.options };
      if (operation.op === 'drop_empty_column') return { op: operation.op, column: operation.column, name: before?.name, type: before?.type };
      return { op: operation.op };
    });
    if (!rowOps.length) {
      summaries.push({ entity: change.key, tableName: change.table.name, operations: ops.map(operation => operation.op), schemaChanges, rowsScanned: 0, rowsChanged: 0, examples: [], blockers: [] });
      continue;
    }
    const size = await db.prepare('SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(orgId, change.table.id).first();
    if (Number(size?.rows || 0) > MAX_ROWS) return err('This table has too many rows for a safe schema migration.', 413);
    storedBytes += Number(size?.bytes || 0);
    if (storedBytes > 500_000) return err('This migration preview exceeds the 500 KB safe snapshot limit. Split it into smaller migrations.', 413);
    const { results = [] } = await db.prepare('SELECT id,data,updated_at FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id LIMIT ?3').bind(orgId, change.table.id, MAX_ROWS).all();
    const rows = results.map(row => ({ id: row.id, data: row.data, updatedAt: row.updated_at }));
    const snapshot = { key: change.key, tableId: change.table.id, columns: JSON.stringify(current.entities.find(entity => entity.key === change.key).table.columns), rows };
    snapshots.push(snapshot);
    const updatedRows = [];
    const columnNames = new Map(current.entities.find(entity => entity.key === change.key).table.columns.map(column => [column.id, column.name]));
    for (const row of rows) {
      let values;
      try { values = JSON.parse(row.data || '{}'); } catch { blockers.push({ entity: change.key, id: row.id, reason: 'Stored record data is not valid JSON.' }); continue; }
      if (!values || typeof values !== 'object' || Array.isArray(values)) { blockers.push({ entity: change.key, id: row.id, reason: 'Stored record values are not an object.' }); continue; }
      const before = { ...values };
      let blocked = false;
      for (const operation of rowOps) {
        const source = values[operation.column];
        if (operation.op === 'convert_column') {
          const target = change.table.columns.find(column => column.id === operation.column);
          const converted = convertColumnValue(source, target);
          if (!converted.ok) {
            blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'Value cannot be converted without data loss.' });
            blocked = true; break;
          }
          if (converted.value === undefined) delete values[operation.column];
          else values[operation.column] = converted.value;
        } else if (!isEmptyMigrationValue(source)) {
          blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'Column contains data; only null and empty-string values can be dropped.' });
          blocked = true; break;
        } else delete values[operation.column];
      }
      if (blocked) continue;
      const nextData = JSON.stringify(values);
      if (nextData !== row.data) updatedRows.push({ id: row.id, data: nextData, updatedAt: row.updatedAt });
    }
    const update = { key: change.key, tableId: change.table.id, rows: updatedRows };
    updates.push(update);
    summaries.push({
      entity: change.key, tableName: change.table.name, operations: ops.map(operation => operation.op), schemaChanges, rowsScanned: rows.length,
      rowsChanged: updatedRows.length, examples: updatedRows.slice(0, 3).map(row => ({ id: row.id, before: JSON.parse(rows.find(source => source.id === row.id).data || '{}'), after: JSON.parse(row.data) })), blockers: [],
    });
  }
  const snapshotText = JSON.stringify(snapshots), updateText = JSON.stringify(updates);
  bytes += new TextEncoder().encode(snapshotText).length + new TextEncoder().encode(updateText).length;
  if (bytes > 1_200_000) return err('This migration preview is too large. Split it into smaller migrations.', 413);
  const schema = current.entities.map(entity => ({ key: entity.key, tableId: entity.table.id, columns: JSON.stringify(entity.table.columns) }));
  const previewChecksum = await digest(JSON.stringify({ id: input.id, version: input.version, operations: input.operations, schema, snapshots }));
  return { current, planned, snapshots, updates, schema, previewChecksum, summaries, blockers, serialized, nonAdditive: hasDataOperation(input.operations) };
}

export async function previewMigration(db, orgId, app, input) {
  const result = await buildMigrationPreview(db, orgId, app, input);
  if (result.error) return result;
  return { previewChecksum: result.previewChecksum, canApply: result.blockers.length === 0, changes: result.summaries, blockers: result.blockers.slice(0, 20), blockerCount: result.blockers.length };
}

export async function applyMigration(db, orgId, app, input, by) {
  if (!keyOK(input.id) || !Number.isSafeInteger(input.version) || input.version < 0) return err('A migration ID and database version are required.');
  const serializedInput = JSON.stringify(input.operations);
  if (!serializedInput || serializedInput.length > 30000) return err('Migration is too large.');
  const checksum = await digest(serializedInput);
  const old = await db.prepare('SELECT checksum, version FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 AND migration_id=?3').bind(orgId, app.id, input.id).first();
  if (old) return old.checksum === checksum ? { applied: true, replay: true, version: old.version } : err('This migration ID has different content.', 409);
  const preview = await buildMigrationPreview(db, orgId, app, input);
  if (preview.error) return preview;
  if (preview.blockers.length) return err('Resolve every blocked row in the preview before applying this migration.', 409);
  if (preview.nonAdditive && input.previewChecksum !== preview.previewChecksum) return err('Data changed after preview. Preview the migration again.', 409);
  if (input.previewChecksum && input.previewChecksum !== preview.previewChecksum) return err('Migration preview changed. Review it again.', 409);
  const { serialized, current, planned } = preview;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM hx_tables WHERE org_id=?1').bind(orgId).first();
  if (count.n + planned.changes.filter(c => c.create).length > MAX_TABLES_PER_ORG) return err('Workspace table limit reached.', 409);
  const latestRowChange = preview.snapshots.flatMap(snapshot => snapshot.rows).reduce((latest, row) => Math.max(latest, Date.parse(row.updatedAt) + 1 || 0), Date.now());
  const nonce = crypto.randomUUID(), at = new Date(latestRowChange).toISOString(), version = current.version + 1;
  const guard = 'EXISTS (SELECT 1 FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 AND nonce=?3)';
  const rowGuard = `AND NOT EXISTS (SELECT 1 FROM json_each(?5) e WHERE
    (SELECT COUNT(*) FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId'))!=json_array_length(e.value,'$.rows')
    OR EXISTS (SELECT 1 FROM json_each(e.value,'$.rows') expected WHERE NOT EXISTS
      (SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId') AND r.id=json_extract(expected.value,'$.id') AND r.data=json_extract(expected.value,'$.data') AND r.updated_at=json_extract(expected.value,'$.updatedAt'))))`;
  const schemaGuard = `AND (SELECT COUNT(*) FROM hx_app_entities WHERE org_id=?1 AND app_id=?2)=json_array_length(?4)-1
    AND NOT EXISTS (SELECT 1 FROM json_each(?4) e WHERE NOT EXISTS
      (SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(e.value,'$.tableId') AND t.columns=json_extract(e.value,'$.columns')
        AND ((json_extract(e.value,'$.key')='primary' AND EXISTS (SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.table_id=t.id))
          OR EXISTS (SELECT 1 FROM hx_app_entities l WHERE l.org_id=?1 AND l.app_id=?2 AND l.entity_key=json_extract(e.value,'$.key') AND l.table_id=t.id))))`;
  const stmts = [
    db.prepare('INSERT OR IGNORE INTO hx_app_database_state (org_id,app_id,version) VALUES (?1,?2,0)').bind(orgId, app.id),
    // Reject a concurrent legacy schema edit too, not just another migration.
    db.prepare(`UPDATE hx_app_database_state SET version=version+1 WHERE org_id=?1 AND app_id=?2 AND version=?3 ${schemaGuard} ${rowGuard}`).bind(orgId, app.id, current.version, JSON.stringify(preview.schema), JSON.stringify(preview.snapshots)),
    db.prepare('INSERT INTO hx_app_migrations (org_id,app_id,migration_id,version,checksum,plan,nonce,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes()=1').bind(orgId, app.id, input.id, version, checksum, serialized, nonce, String(by), at),
  ];
  for (const c of planned.changes) {
    if (c.create) {
      stmts.push(db.prepare(`INSERT INTO hx_tables (org_id,id,name,columns,created_by,created_at,updated_at) SELECT ?1,?4,?5,?6,?7,?8,?8 WHERE ${guard}`).bind(orgId, app.id, nonce, c.table.id, c.table.name, JSON.stringify(c.table.columns), String(by), at));
      stmts.push(db.prepare(`INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) SELECT ?1,?2,?4,?5 WHERE ${guard}`).bind(orgId, app.id, nonce, c.key, c.table.id));
    } else stmts.push(db.prepare(`UPDATE hx_tables SET columns=?4,updated_at=?5 WHERE org_id=?1 AND id=?6 AND ${guard}`).bind(orgId, app.id, nonce, JSON.stringify(c.table.columns), at, c.table.id));
  }
  for (const update of preview.updates) if (update.rows.length) {
    const data = JSON.stringify(update.rows);
    stmts.push(db.prepare(`UPDATE hx_rows SET data=(SELECT json_extract(e.value,'$.data') FROM json_each(?4) e WHERE json_extract(e.value,'$.id')=hx_rows.id),updated_by=?5,updated_at=?6
      WHERE org_id=?1 AND table_id=?7 AND id IN (SELECT json_extract(e.value,'$.id') FROM json_each(?4) e) AND ${guard}`).bind(orgId, app.id, nonce, data, String(by), at, update.tableId));
  }
  const result = await db.batch(stmts);
  return result[2]?.meta?.changes ? { applied: true, version } : err('Database schema changed. Reload before applying.', 409);
}

export async function generateMigration(prompt, current, complete) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return err('Describe the database change in 1–4000 characters.');
  if (!complete) return err('AI generation is unavailable within the current allowance.', 503);
  try {
    const raw = await complete('Return JSON {"operations":[...]}. Supported database migration operations: {op:"create_entity",entity:"lowercase_key",name:"Name",columns:[{name,type,options?}]}, {op:"add_columns",entity:"existing_key",columns:[{name,type,options?}]}, {op:"rename_column",entity:"existing_key",column:"stable_column_id",name:"New name"}, {op:"convert_column",entity:"existing_key",column:"stable_column_id",type:"text|number|date|select|checkbox|url|email",options?:[...]} and {op:"drop_empty_column",entity:"existing_key",column:"stable_column_id"}. Conversion is strict and blocks if any stored value cannot be represented. Dropping is allowed only when every value is null or an empty string. Never use person or relation columns for conversion or deletion. Never create a column ID. Prefer additive changes; only rename, convert or drop a column when explicitly requested. Current schema: '+JSON.stringify(current.entities), prompt);
    const plan = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const operations = Array.isArray(plan.operations) ? plan.operations.map(operation => operation && Array.isArray(operation.columns)
      ? { ...operation, columns: normalizeMemberFields(prompt, operation.columns) } : operation) : plan.operations;
    const checked = planMigration(current, operations);
    return checked.error ? checked : { operations };
  } catch { return err('The model did not return a valid migration.', 502); }
}

// A private writable snapshot, bounded to 750KB, never merged silently into production.
export async function forkDatabase(db, orgId, app, by) {
  const tableScope = 'SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 UNION SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2';
  const [tables,rows,links,total] = await db.batch([
    db.prepare(`SELECT * FROM hx_tables WHERE org_id=?1 AND id IN (${tableScope})`).bind(orgId,app.id),
    db.prepare(`SELECT * FROM hx_rows WHERE org_id=?1 AND table_id IN (${tableScope}) AND (SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM hx_rows WHERE org_id=?1 AND table_id IN (${tableScope}))<=700000 ORDER BY position,id`).bind(orgId,app.id),
    db.prepare('SELECT entity_key,table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2').bind(orgId,app.id),
    db.prepare(`SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM hx_rows WHERE org_id=?1 AND table_id IN (${tableScope})`).bind(orgId,app.id),
  ]);
  if(total.results[0].bytes>700000)return err('This database is too large for a preview snapshot.',413);
  const entities=(tables.results||[]).map(t=>({key:t.id===app.tableId?'primary':links.results.find(e=>e.table_id===t.id).entity_key,
    table:{id:t.id,name:t.name,columns:JSON.parse(t.columns)},rows:(rows.results||[]).filter(r=>r.table_id===t.id).map(r=>({id:r.id,values:JSON.parse(r.data),updatedAt:r.updated_at}))}));
  const data = JSON.stringify(entities);
  if (new TextEncoder().encode(data).length > 750000) return err('This database is too large for a preview snapshot.', 413);
  const id = crypto.randomUUID();
  await db.batch([db.prepare(`INSERT INTO hx_app_forks (org_id,app_id,created_by,id,revision,data,created_at) VALUES (?1,?2,?3,?4,1,?5,?6)
    ON CONFLICT(org_id,app_id,created_by) DO UPDATE SET id=excluded.id,revision=hx_app_forks.revision+1,data=excluded.data,created_at=excluded.created_at`).bind(orgId, app.id, String(by), id, data, new Date().toISOString()),
    db.prepare('DELETE FROM hx_app_fork_bases WHERE org_id=?1 AND app_id=?2 AND created_by=?3').bind(orgId,app.id,String(by)),
    db.prepare('INSERT INTO hx_app_fork_bases (org_id,app_id,created_by,fork_id,data) VALUES (?1,?2,?3,?4,?5)').bind(orgId,app.id,String(by),id,data)]);
  return readFork(db, orgId, app.id, by);
}
export async function readFork(db, orgId, appId, by) {
  const row = await db.prepare('SELECT id,revision,data,created_at AS createdAt,(SELECT created_at FROM hx_app_fork_merges m WHERE m.fork_id=hx_app_forks.id) AS mergedAt FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3').bind(orgId, appId, String(by)).first();
  return { fork: row ? { id: row.id, revision: row.revision, entities: JSON.parse(row.data), createdAt: row.createdAt, mergedAt:row.mergedAt } : null };
}
export async function mutateFork(db, orgId, appId, by, input) {
  const { fork } = await readFork(db, orgId, appId, by);
  if (!fork || fork.id !== input.forkId || fork.revision !== input.revision) return err('Preview data changed. Reload before editing.', 409);
  if(fork.mergedAt)return err('This preview was merged. Create a new preview before editing.',409);
  const entity = fork.entities.find(e => e.key === input.entity);
  if (!entity || !['create','update','remove'].includes(input.operation)) return err('Invalid preview operation.');
  const row = entity.rows.find(r => r.id === input.rowId);
  if (input.operation !== 'create' && !row) return err('No such preview row.', 404);
  if (row && input.expectedUpdatedAt !== undefined && row.updatedAt !== input.expectedUpdatedAt) return err('Preview row changed. Review it again.',409);
  if (input.operation !== 'remove') {
    const invalid = validateValues(entity.table.columns, input.values);
    if (invalid.length) return err('Invalid record values: '+invalid.map(e=>e.message || e).join(', '));
  }
  const at = new Date(Math.max(Date.now(),row ? Date.parse(row.updatedAt)+1 : 0)).toISOString();
  let result;
  if (input.operation === 'create') {
    if (entity.rows.length >= 5000) return err('Preview row limit reached.');
    result = { id: crypto.randomUUID(), values: input.values, updatedAt: at }; entity.rows.push(result);
  } else if (input.operation === 'update') { row.values = { ...row.values, ...input.values }; row.updatedAt = at; result = row; }
  else { entity.rows = entity.rows.filter(r => r.id !== input.rowId); result = { deleted: true }; }
  const relationError = relationStateError(fork.entities);
  if (relationError) return err(relationError, 409);
  const data = JSON.stringify(fork.entities);
  if (new TextEncoder().encode(data).length > 750000) return err('Preview database is too large.', 413);
  const saved = await db.prepare('UPDATE hx_app_forks SET data=?1,revision=revision+1 WHERE org_id=?2 AND app_id=?3 AND created_by=?4 AND id=?5 AND revision=?6 AND NOT EXISTS (SELECT 1 FROM hx_app_fork_merges m WHERE m.fork_id=hx_app_forks.id)').bind(data, orgId, appId, String(by), fork.id, fork.revision).run();
  return saved.meta?.changes ? { result, revision: fork.revision+1 } : err('Preview data changed. Reload before editing.', 409);
}

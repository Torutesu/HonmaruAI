import { databaseAuthority, mayUseDatabase } from './databaseAccess.js';
import { getTable, normalizeColumns, COLUMN_TYPES, MAX_TABLES_PER_ORG, MAX_ROWS } from './tables.js';
import { validateValues } from './tableContract.js';
import { normalizeMemberFields } from './memberFields.js';
import { parseRfc3339 } from './temporal.js';
const err = (error, status = 400) => ({ error, status });
const keyOK = k => typeof k === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(k);
const MAX_MIGRATION_PLAN_BYTES = 30_000;
const MAX_ROLLBACK_BYTES = 500_000;
export const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fieldState(values, columnId) {
  return Object.hasOwn(values, columnId) ? { present: true, value: values[columnId] } : { present: false };
}

function validFieldState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.present !== 'boolean') return false;
  const keys = Object.keys(state);
  return state.present ? keys.length === 2 && keys.includes('value') && state.value !== undefined : keys.length === 1;
}

function sameFieldState(values, columnId, state) {
  const current = fieldState(values, columnId);
  return current.present === state.present && (!current.present || canonicalJson(current.value) === canonicalJson(state.value));
}

function serializedPlanSize(operations) {
  return new TextEncoder().encode(JSON.stringify(operations) || '').length;
}

function isRestorePlan(operations) {
  return Array.isArray(operations) && operations.some(operation => operation?.op === 'restore_converted_column');
}

function validRestoreRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return false;
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id || row.id.length > 64 || ids.has(row.id)
      || !validFieldState(row.expected) || !validFieldState(row.restore)) return false;
    ids.add(row.id);
  }
  return true;
}

function readJournalPlan(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { operations: parsed, inverseOperations: null, rollbackUnavailableReason: null };
    if (parsed?.format === 2 && Array.isArray(parsed.operations)
      && (parsed.inverseOperations === null || Array.isArray(parsed.inverseOperations))
      && (parsed.rollbackUnavailableReason == null || ['snapshot_limit', 'multiple_conversions'].includes(parsed.rollbackUnavailableReason))) {
      return { operations: parsed.operations, inverseOperations: parsed.inverseOperations, rollbackUnavailableReason: parsed.rollbackUnavailableReason || null };
    }
  } catch { /* malformed journals are surfaced as unverified below */ }
  return null;
}

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

export async function databaseView(db, orgId, app, { includeRollbackOperations = false } = {}) {
  const state = await db.prepare('SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2').bind(orgId, app.id).first();
  const { results } = await db.prepare('SELECT entity_key, table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 ORDER BY entity_key').bind(orgId, app.id).all();
  const entities = [{ key: 'primary', table: await getTable(db, orgId, app.tableId) }];
  for (const r of results || []) entities.push({ key: r.entity_key, table: await getTable(db, orgId, r.table_id) });
  const journal = await db.prepare('SELECT migration_id AS id, version, checksum, plan, created_at AS createdAt FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 ORDER BY version DESC LIMIT 50').bind(orgId, app.id).all();
  const migrations = await Promise.all((journal.results || []).map(async r => {
    const decoded = readJournalPlan(r.plan);
    const integrityValid = decoded !== null && await digest(r.plan) === r.checksum;
    return {
      ...r,
      plan: integrityValid ? decoded.operations : null,
      inverseOperations: integrityValid && includeRollbackOperations ? decoded.inverseOperations : null,
      rollbackUnavailableReason: integrityValid ? decoded.rollbackUnavailableReason : null,
      integrityValid,
    };
  }));
  return { version: state?.version || 0, entities, migrations };
}

const MIGRATABLE_COLUMN_TYPES = new Set(COLUMN_TYPES);
const isEmptyMigrationValue = (value, column) => value === undefined || value === null || value === '' || column?.type === 'relation' && column.multiple && Array.isArray(value) && value.length === 0;
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

export function convertColumnValue(value, target, source, operation, relationResolver) {
  if (value === undefined) return { ok: true, value };
  if (value === null || value === '') return { ok: true, value: null };
  if (target.type === 'relation') {
    let ids;
    if (operation.matchBy) {
      if (source.type !== 'text' || typeof value !== 'string' || !relationResolver) return { ok: false };
      let labels;
      if (target.multiple) {
        try {
          const parsed = JSON.parse(value);
          labels = Array.isArray(parsed) ? parsed : [value];
        } catch { labels = [value]; }
      } else labels = [value];
      if (labels.length > 100 || labels.some(label => typeof label !== 'string' || label.length > 5000)) return { ok: false };
      ids = [];
      const relationMatches = [];
      for (const label of labels) {
        const matches = relationResolver.get(JSON.stringify(label)) || [];
        const selected = operation.matchResolutions?.[label];
        if (selected !== undefined && !matches.includes(selected)) return { ok: false, resolution: { label, candidates: matches } };
        if (matches.length > 1 && selected === undefined || matches.length === 0) return { ok: false, resolution: { label, candidates: matches } };
        const recordId = selected ?? matches[0];
        ids.push(recordId);
        relationMatches.push({ label, recordId, matchBy: operation.matchBy });
      }
      if (target.multiple) return { ok: true, value: ids, relationMatches };
      if (ids.length === 0) return { ok: true, value: null, relationMatches };
      if (ids.length !== 1) return { ok: false };
      return { ok: true, value: ids[0], relationMatches };
    } else if (source.type === 'relation' && source.multiple) {
      if (!Array.isArray(value)) return { ok: false };
      ids = value;
    } else if (source.type === 'relation') {
      if (typeof value !== 'string') return { ok: false };
      ids = [value];
    } else if (Array.isArray(value)) ids = value;
    else if (target.multiple && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        ids = Array.isArray(parsed) ? parsed : [value];
      } catch { ids = [value]; }
    } else ids = [value];
    if (ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 64) || new Set(ids).size !== ids.length) return { ok: false };
    if (target.multiple) return { ok: true, value: ids };
    if (ids.length === 0) return { ok: true, value: null };
    if (ids.length !== 1) return { ok: false };
    return { ok: true, value: ids[0] };
  }
  if (source.type === 'relation') {
    if (target.type !== 'text') return { ok: false };
    if (source.multiple) {
      if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !id || id.length > 64) || new Set(value).size !== value.length) return { ok: false };
      const encoded = JSON.stringify(value);
      return boundedString(encoded) ? { ok: true, value: encoded } : { ok: false };
    }
    return typeof value === 'string' && value.length <= 64 ? { ok: true, value } : { ok: false };
  }
  if (target.type === 'person') {
    if (typeof value !== 'string') return { ok: false };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: null };
    const login = trimmed.replace(/^@/, '');
    if (!login) return { ok: false };
    return login.length <= 64 ? { ok: true, value: login } : { ok: false };
  }
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
  if (target.type === 'datetime') {
    const stamp = parseRfc3339(value);
    return stamp === null ? { ok: false } : { ok: true, value: new Date(stamp).toISOString() };
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
    } else if (op.op === 'drop_entity') {
      if (op.entity === 'primary') return err('The primary entity cannot be deleted.');
      const table = entities.get(op.entity);
      if (!table) return err('No such entity.');
      if (createdEntities.has(op.entity)) return err('Create and delete an entity in separate changes.');
      entities.delete(op.entity);
      changed.set(op.entity, { table, drop: true });
    } else if (op.op === 'add_columns') {
      const table = entities.get(op.entity);
      if (!table) return err('No such entity.');
      if (!Array.isArray(op.columns) || !op.columns.length || op.columns.some(c => c.id || table.columns.some(old => old.name.toLowerCase() === String(c.name).toLowerCase()))) return err('Add new columns; existing columns cannot be replaced.');
      const cols = normalizeColumns([...table.columns, ...op.columns], table.columns, { allowRelations: true });
      if (cols.error) return cols;
      const next = { ...table, columns: cols.columns };
      entities.set(op.entity, next); changed.set(op.entity, { ...changed.get(op.entity), table: next });
    } else if (['rename_column', 'convert_column', 'drop_empty_column', 'restore_converted_column'].includes(op.op)) {
      const table = entities.get(op.entity);
      if (!table) return err('No such entity.');
      if (createdEntities.has(op.entity)) return err('Create an entity before migrating its columns in a separate change.');
      const index = table.columns.findIndex(column => column.id === op.column);
      if (index < 0) return err('Choose an existing stable column ID.');
      const mutationKey = `${op.entity}:${op.column}`;
      if (mutatedColumns.has(mutationKey)) return err('Change each existing column at most once per migration.');
      mutatedColumns.add(mutationKey);
      const existing = table.columns[index];
      let nextColumns = [...table.columns];
      if (op.op === 'rename_column') {
        if (typeof op.name !== 'string' || !op.name.trim() || op.name.trim().length > 60) return err('Give the renamed column a name (1–60 characters).');
        if (nextColumns.some((column, i) => i !== index && column.name.toLowerCase() === op.name.trim().toLowerCase())) return err('A column already has that name.');
        nextColumns[index] = { ...existing, name: op.name.trim() };
      } else if (op.op === 'restore_converted_column') {
        if (!op.expectedColumn || canonicalJson(existing) !== canonicalJson(op.expectedColumn)
          || !op.restoreColumn || op.restoreColumn.id !== existing.id || !validRestoreRows(op.rows) || !op.rows.length) {
          return err('The saved conversion rollback is incomplete or no longer matches the schema.', 409);
        }
        const normalized = normalizeColumns(nextColumns.map((column, i) => i === index ? op.restoreColumn : column), table.columns, { allowRelations: true });
        if (normalized.error || canonicalJson(normalized.columns[index]) !== canonicalJson(op.restoreColumn)) return err('The saved conversion rollback contains an unsupported original column definition.', 409);
        nextColumns = normalized.columns;
      } else if (op.op === 'convert_column') {
        if (!MIGRATABLE_COLUMN_TYPES.has(op.type)) return err('Choose a supported column type.');
        const candidate = { ...existing, type: op.type };
        if (op.type === 'select') candidate.options = op.options;
        else delete candidate.options;
        if (op.type === 'relation') {
          const targetEntity = op.targetEntity ?? existing.targetEntity;
          const multiple = op.multiple ?? existing.multiple;
          if (!keyOK(targetEntity) || typeof multiple !== 'boolean') return err('A relation conversion needs a target entity and single/multiple setting.');
          if (op.matchBy !== undefined && op.matchBy !== null) {
            const targetColumns = entities.get(targetEntity)?.columns || [];
            const matchColumn = targetColumns.find(column => column.id === op.matchBy);
            if (existing.type !== 'text' || typeof op.matchBy !== 'string' || !matchColumn || !['text', 'select', 'date', 'url', 'email'].includes(matchColumn.type)) return err('Exact relation matching needs a text source and a stable text-like target column ID.');
          }
          if (op.matchResolutions !== undefined && (op.matchBy == null || !op.matchResolutions || typeof op.matchResolutions !== 'object' || Array.isArray(op.matchResolutions) || Object.keys(op.matchResolutions).length > 100 || Object.entries(op.matchResolutions).some(([label, id]) => label.length > 5000 || typeof id !== 'string' || !id || id.length > 64))) return err('Relation match resolutions must map source labels to stable target record IDs.');
          candidate.targetEntity = targetEntity;
          candidate.multiple = multiple;
        } else {
          if (op.matchBy !== undefined && op.matchBy !== null || op.matchResolutions !== undefined) return err('matchBy and matchResolutions are only available when converting to a relation.');
          delete candidate.targetEntity;
          delete candidate.multiple;
        }
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

const hasDataOperation = operations => operations.some(operation => ['convert_column', 'restore_converted_column', 'drop_empty_column', 'drop_entity'].includes(operation?.op));

async function hasWorkflowEntityReference(db, orgId, appId, entityKey, tableId) {
  return Boolean(await db.prepare(`SELECT 1 AS referenced FROM hx_workflows w WHERE w.org_id=?1 AND (
    (json_extract(w.trigger,'$.type')='row' AND json_extract(w.trigger,'$.tableId')=?2)
    OR (json_extract(w.trigger,'$.type')='app_record_change' AND json_extract(w.trigger,'$.appId')=?3 AND json_extract(w.trigger,'$.entityId')=?4)
  ) LIMIT 1`).bind(orgId,tableId,appId,entityKey).first());
}

async function buildMigrationPreview(db, orgId, app, input) {
  if (!keyOK(input.id) || !Number.isSafeInteger(input.version) || input.version < 0) return err('A migration ID and database version are required.');
  const serialized = JSON.stringify(input.operations);
  const planLimit = isRestorePlan(input.operations) ? MAX_ROLLBACK_BYTES : MAX_MIGRATION_PLAN_BYTES;
  if (!serialized || serializedPlanSize(input.operations) > planLimit) return err(isRestorePlan(input.operations) ? 'This rollback plan exceeds the 500 KB safe snapshot limit.' : 'Migration is too large.', 413);
  const current = await databaseView(db, orgId, app);
  if (current.version !== input.version) return err('Database schema changed. Reload before previewing.', 409);
  const planned = planMigration(current, input.operations);
  if (planned.error) return planned;
  for (const operation of input.operations.filter(item => item?.op === 'drop_entity')) {
    const entity=current.entities.find(item=>item.key===operation.entity);
    if(!entity)return err('No such entity.');
    if(await hasWorkflowEntityReference(db,orgId,app.id,entity.key,entity.table.id))return err('Remove Workflow references before deleting this entity.',409);
  }
  const snapshots = [], updates = [], summaries = [], blockers = [];
  const plannedEntities = new Map(current.entities.map(entity => [entity.key, entity.table]));
  for (const change of planned.changes) { if(change.drop)plannedEntities.delete(change.key);else plannedEntities.set(change.key, change.table); }
  const relationUses = new Map();
  const relationMatchExamples = new Map();
  const relationResolvers = new Map(), relationLookupSnapshots = new Map();
  for (const operation of input.operations.filter(item => item?.op === 'convert_column' && item.type === 'relation' && item.matchBy)) {
    const target = plannedEntities.get(operation.entity)?.columns.find(column => column.id === operation.column);
    const targetTable = plannedEntities.get(target?.targetEntity);
    const cacheKey = `${target.targetEntity}:${operation.matchBy}`;
    if (relationResolvers.has(cacheKey)) continue;
    const size = await db.prepare('SELECT COUNT(*) AS rows FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(orgId, targetTable.id).first();
    if (Number(size?.rows || 0) > MAX_ROWS) return err('This relation lookup has too many rows for a safe preview.', 413);
    const { results = [] } = await db.prepare('SELECT id,data,updated_at FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id LIMIT ?3').bind(orgId, targetTable.id, MAX_ROWS).all();
    const matches = new Map();
    const rows = results.map(row => ({ id: row.id, data: row.data, updatedAt: row.updated_at }));
    for (const row of rows) {
      try {
        const values = JSON.parse(row.data || '{}'), matchValue = values?.[operation.matchBy];
        if (typeof matchValue !== 'string') continue;
        const key = JSON.stringify(matchValue), found = matches.get(key) || [];
        found.push(row.id); matches.set(key, found);
      } catch { /* malformed target rows cannot match; their snapshot is still guarded */ }
    }
    relationResolvers.set(cacheKey, matches);
    const currentTarget = current.entities.find(entity => entity.key === target.targetEntity);
    relationLookupSnapshots.set(targetTable.id, { key: target.targetEntity, tableId: targetTable.id, columns: JSON.stringify(currentTarget?.table.columns || targetTable.columns), rows });
  }
  let bytes = new TextEncoder().encode(serialized).length;
  for (const change of planned.changes) {
    const ops = input.operations.filter(operation => operation.entity === change.key);
    const rowOps = ops.filter(operation => ['convert_column', 'restore_converted_column', 'drop_empty_column'].includes(operation.op));
    const oldColumns = current.entities.find(entity => entity.key === change.key)?.table.columns || [];
    const schemaChanges = ops.map(operation => {
      const before = oldColumns.find(column => column.id === operation.column);
      const after = change.table.columns.find(column => column.id === operation.column);
      if (operation.op === 'create_entity') return { op: operation.op, entity: change.key, tableName: change.table.name, columns: change.table.columns };
      if (operation.op === 'drop_entity') return { op: operation.op, entity: change.key, tableName: change.table.name };
      if (operation.op === 'add_columns') return { op: operation.op, columns: operation.columns };
      if (operation.op === 'rename_column') return { op: operation.op, column: operation.column, from: before?.name, to: after?.name };
      if (operation.op === 'convert_column') return { op: operation.op, column: operation.column, name: before?.name, from: before?.type, to: after?.type, options: after?.options, ...(after?.type === 'relation' ? { targetEntity: after.targetEntity, multiple: after.multiple, ...(operation.matchBy ? { matchBy: operation.matchBy } : {}) } : {}) };
      if (operation.op === 'restore_converted_column') return { op: operation.op, column: operation.column, name: operation.expectedColumn?.name, from: operation.expectedColumn?.type, to: operation.restoreColumn?.type };
      if (operation.op === 'drop_empty_column') return { op: operation.op, column: operation.column, name: before?.name, type: before?.type };
      return { op: operation.op };
    });
    if(change.drop) {
      const entity=current.entities.find(item=>item.key===change.key);
      const size=await db.prepare('SELECT COUNT(*) AS rows FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(orgId,entity.table.id).first();
      if(Number(size?.rows||0)>MAX_ROWS)return err('This entity has too many records to safely review for deletion.',413);
      const {results=[]}=await db.prepare('SELECT id,data,updated_at FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id LIMIT ?3').bind(orgId,entity.table.id,MAX_ROWS).all();
      const rows=results.map(row=>({id:row.id,data:row.data,updatedAt:row.updated_at}));
      snapshots.push({key:change.key,tableId:entity.table.id,columns:JSON.stringify(entity.table.columns),rows});
      if(rows.length)blockers.push({entity:change.key,id:rows[0].id,reason:'Delete every record in the preview before deleting this entity.'});
      summaries.push({entity:change.key,tableName:entity.table.name,operations:ops.map(operation=>operation.op),schemaChanges,rowsScanned:rows.length,rowsChanged:0,examples:[],blockers:rows.length?[{id:rows[0].id,reason:'The entity must be empty before it can be deleted.'}]:[]});
      continue;
    }
    if (!rowOps.length) {
      summaries.push({ entity: change.key, tableName: change.table.name, operations: ops.map(operation => operation.op), schemaChanges, rowsScanned: 0, rowsChanged: 0, examples: [], blockers: [] });
      continue;
    }
    const size = await db.prepare('SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM hx_rows WHERE org_id=?1 AND table_id=?2').bind(orgId, change.table.id).first();
    if (Number(size?.rows || 0) > MAX_ROWS) return err('This table has too many rows for a safe schema migration.', 413);
    const { results = [] } = await db.prepare('SELECT id,data,updated_at FROM hx_rows WHERE org_id=?1 AND table_id=?2 ORDER BY id LIMIT ?3').bind(orgId, change.table.id, MAX_ROWS).all();
    const rows = results.map(row => ({ id: row.id, data: row.data, updatedAt: row.updated_at }));
    const snapshot = { key: change.key, tableId: change.table.id, columns: JSON.stringify(current.entities.find(entity => entity.key === change.key).table.columns), rows };
    snapshots.push(snapshot);
    const updatedRows = [];
    const columnNames = new Map(current.entities.find(entity => entity.key === change.key).table.columns.map(column => [column.id, column.name]));
    const restoreRowsByOperation = new Map(rowOps.filter(item => item.op === 'restore_converted_column').map(operation => [operation, new Map(operation.rows.map(item => [item.id, item]))]));
    for (const operation of rowOps.filter(item => item.op === 'restore_converted_column')) {
      const expectedIds = restoreRowsByOperation.get(operation);
      const actualIds = new Set(rows.map(row => row.id));
      for (const rowId of expectedIds.keys()) if (!actualIds.has(rowId)) blockers.push({ entity: change.key, id: rowId, column: columnNames.get(operation.column) || operation.column, reason: 'A record from the saved conversion rollback no longer exists.' });
      for (const row of rows) if (!expectedIds.has(row.id)) blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'A record was added after conversion and is not covered by the saved rollback.' });
    }
    for (const row of rows) {
      let values;
      try { values = JSON.parse(row.data || '{}'); } catch { blockers.push({ entity: change.key, id: row.id, reason: 'Stored record data is not valid JSON.' }); continue; }
      if (!values || typeof values !== 'object' || Array.isArray(values)) { blockers.push({ entity: change.key, id: row.id, reason: 'Stored record values are not an object.' }); continue; }
      const before = { ...values };
      let blocked = false;
      const rowRelations = [];
      const rowRelationMatches = [];
      for (const operation of rowOps) {
        const source = values[operation.column];
        if (operation.op === 'convert_column') {
          const target = change.table.columns.find(column => column.id === operation.column);
          const sourceColumn = oldColumns.find(column => column.id === operation.column);
          const converted = convertColumnValue(source, target, sourceColumn, operation, operation.matchBy ? relationResolvers.get(`${target.targetEntity}:${operation.matchBy}`) : null);
          if (!converted.ok) {
            blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'Value cannot be converted without data loss.', ...(converted.resolution ? { resolution: { entity: change.key, columnId: operation.column, label: converted.resolution.label, candidates: converted.resolution.candidates } } : {}) });
            blocked = true; break;
          }
          if (converted.value === undefined) delete values[operation.column];
          else values[operation.column] = converted.value;
          if (target.type === 'relation' && converted.value != null) {
            const refs = Array.isArray(converted.value) ? converted.value : [converted.value];
            for (const id of refs) rowRelations.push({ targetEntity: target.targetEntity, id, entity: change.key, rowId: row.id, column: columnNames.get(operation.column) || operation.column });
            if (converted.relationMatches?.length) rowRelationMatches.push({ column: operation.column, targetEntity: target.targetEntity, matches: converted.relationMatches });
          }
        } else if (operation.op === 'restore_converted_column') {
          const restore = restoreRowsByOperation.get(operation).get(row.id);
          if (!restore || !sameFieldState(values, operation.column, restore.expected)) {
            blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'The converted value changed after migration; the saved rollback will not overwrite it.' });
            blocked = true; break;
          }
          if (restore.restore.present) {
            const restored = { [operation.column]: restore.restore.value };
            if (validateValues([operation.restoreColumn], restored).length) {
              blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'The original value does not match the saved column definition.' });
              blocked = true; break;
            }
            values[operation.column] = restore.restore.value;
            if (operation.restoreColumn.type === 'relation' && restore.restore.value != null) {
              const refs = Array.isArray(restore.restore.value) ? restore.restore.value : [restore.restore.value];
              for (const id of refs) rowRelations.push({ targetEntity: operation.restoreColumn.targetEntity, id, entity: change.key, rowId: row.id, column: columnNames.get(operation.column) || operation.column });
            }
          } else delete values[operation.column];
        } else if (!isEmptyMigrationValue(source, oldColumns.find(column => column.id === operation.column))) {
          blockers.push({ entity: change.key, id: row.id, column: columnNames.get(operation.column) || operation.column, reason: 'Column contains data; only null, empty-string, or empty multiple-relation values can be dropped.' });
          blocked = true; break;
        } else delete values[operation.column];
      }
      if (blocked) continue;
      if (rowRelationMatches.length) relationMatchExamples.set(`${change.key}:${row.id}`, rowRelationMatches);
      for (const reference of rowRelations) {
        let uses = relationUses.get(reference.targetEntity);
        if (!uses) { uses = new Map(); relationUses.set(reference.targetEntity, uses); }
        const rowsUsingId = uses.get(reference.id) || [];
        rowsUsingId.push({ entity: reference.entity, rowId: reference.rowId, column: reference.column });
        uses.set(reference.id, rowsUsingId);
      }
      const nextData = JSON.stringify(values);
      if (nextData !== row.data) updatedRows.push({ id: row.id, data: nextData, updatedAt: row.updatedAt });
    }
    const update = { key: change.key, tableId: change.table.id, rows: updatedRows };
    updates.push(update);
    summaries.push({
      entity: change.key, tableName: change.table.name, operations: ops.map(operation => operation.op), schemaChanges, rowsScanned: rows.length,
      rowsChanged: updatedRows.length, examples: updatedRows.slice(0, 3).map(row => ({ id: row.id, before: JSON.parse(rows.find(source => source.id === row.id).data || '{}'), after: JSON.parse(row.data), ...(relationMatchExamples.has(`${change.key}:${row.id}`) ? { relationMatches: relationMatchExamples.get(`${change.key}:${row.id}`) } : {}) })), blockers: [],
    });
  }
  for (const snapshot of relationLookupSnapshots.values()) if (!snapshots.some(existing => existing.tableId === snapshot.tableId)) snapshots.push(snapshot);
  const storedBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.rows.reduce((total, row) => total + new TextEncoder().encode(row.data || '').length, 0), 0);
  if (storedBytes > 500_000) return err('This migration preview exceeds the 500 KB safe snapshot limit. Split it into smaller migrations.', 413);
  const relationTargets = [];
  let relationTargetCount = 0;
  for (const [entityKey, uses] of relationUses) {
    const table = plannedEntities.get(entityKey);
    const ids = [...uses.keys()];
    relationTargetCount += ids.length;
    if (relationTargetCount > MAX_ROWS) return err('This migration references too many related records for a safe preview. Split it into smaller migrations.', 413);
    const { results = [] } = await db.prepare(`SELECT target.id FROM hx_rows target
      JOIN json_each(?1) requested ON requested.value=target.id
      WHERE target.org_id=?2 AND target.table_id=?3`).bind(JSON.stringify(ids), orgId, table.id).all();
    const found = new Set(results.map(row => row.id));
    for (const id of ids) if (!found.has(id)) for (const source of uses.get(id) || []) {
      blockers.push({ entity: source.entity, id: source.rowId, column: source.column, reason: 'A linked record does not exist in the target app entity.' });
    }
    relationTargets.push({ tableId: table.id, ids: ids.filter(id => found.has(id)).sort() });
  }
  const snapshotText = JSON.stringify(snapshots), updateText = JSON.stringify(updates);
  const relationTargetText = JSON.stringify(relationTargets);
  bytes += new TextEncoder().encode(snapshotText).length + new TextEncoder().encode(updateText).length + new TextEncoder().encode(relationTargetText).length;
  if (bytes > 1_200_000) return err('This migration preview is too large. Split it into smaller migrations.', 413);
  const schema = current.entities.map(entity => ({ key: entity.key, tableId: entity.table.id, columns: JSON.stringify(entity.table.columns) }));
  const previewChecksum = await digest(JSON.stringify({ id: input.id, version: input.version, operations: input.operations, schema, snapshots, relationTargets }));
  const restoreOperations = new Map();
  for (const operation of input.operations.filter(item => item?.op === 'convert_column')) {
    const entity = current.entities.find(item => item.key === operation.entity);
    const snapshot = snapshots.find(item => item.key === operation.entity);
    const nextColumn = planned.changes.find(item => item.key === operation.entity)?.table.columns.find(column => column.id === operation.column);
    const oldColumn = entity?.table.columns.find(column => column.id === operation.column);
    if (!snapshot || !oldColumn || !nextColumn) continue;
    const update = updates.find(item => item.tableId === snapshot.tableId);
    const updatedRows = new Map((update?.rows || []).map(row => [row.id, row.data]));
    const rows = [];
    let populated = false;
    for (const row of snapshot.rows) {
      let before, after;
      try {
        before = JSON.parse(row.data || '{}');
        after = JSON.parse(updatedRows.get(row.id) ?? (row.data || '{}'));
      } catch { return err('Stored record data is not valid JSON.', 409); }
      const restore = fieldState(before, operation.column), expected = fieldState(after, operation.column);
      if (!isEmptyMigrationValue(restore.present ? restore.value : undefined, oldColumn)) populated = true;
      rows.push({ id: row.id, expected, restore });
    }
    if (populated) {
      const restoreOperation = { op: 'restore_converted_column', entity: operation.entity, column: operation.column,
        expectedColumn: nextColumn, restoreColumn: oldColumn, rows };
      restoreOperations.set(`${operation.entity}:${operation.column}`, restoreOperation);
    }
  }
  let inverseOperations = buildInverseOperations({ current, planned, input, snapshots, restoreOperations });
  const conversionCounts = new Map();
  for (const operation of input.operations) if (operation?.op === 'convert_column') conversionCounts.set(operation.entity, (conversionCounts.get(operation.entity) || 0) + 1);
  let rollbackUnavailableReason = inverseOperations === null && [...conversionCounts.values()].some(count => count > 1) ? 'multiple_conversions' : null;
  let journalPlan = JSON.stringify({ format: 2, operations: input.operations, inverseOperations, ...(rollbackUnavailableReason ? { rollbackUnavailableReason } : {}) });
  if (new TextEncoder().encode(journalPlan).length > MAX_ROLLBACK_BYTES && inverseOperations !== null) {
    inverseOperations = null;
    rollbackUnavailableReason = 'snapshot_limit';
    journalPlan = JSON.stringify({ format: 2, operations: input.operations, inverseOperations, rollbackUnavailableReason });
  }
  if (new TextEncoder().encode(journalPlan).length > MAX_ROLLBACK_BYTES) return err('This migration plan exceeds the 500 KB safe journal limit.', 413);
  return { current, planned, snapshots, updates, schema, relationTargets, previewChecksum, summaries, blockers, serialized, inverseOperations, rollbackUnavailableReason, nonAdditive: hasDataOperation(input.operations) };
}

function buildInverseOperations({ current, planned, input, snapshots, restoreOperations }) {
  const conversionCounts = new Map();
  for (const operation of input.operations) if (operation?.op === 'convert_column') {
    conversionCounts.set(operation.entity, (conversionCounts.get(operation.entity) || 0) + 1);
  }
  // Each inverse currently describes the final schema. Reversing multiple
  // conversions on one table would make the next inverse's schema stale.
  if ([...conversionCounts.values()].some(count => count > 1)) return null;
  const emptyColumnConversion = operation => {
    if (operation?.op !== 'convert_column') return false;
    const entity = current.entities.find(item => item.key === operation.entity);
    const column = entity?.table.columns.find(item => item.id === operation.column);
    const snapshot = snapshots.find(item => item.tableId === entity?.table.id);
    return Boolean(column && snapshot && snapshot.rows.every(row => {
      try { return isEmptyMigrationValue(JSON.parse(row.data || '{}')?.[column.id], column); }
      catch { return false; }
    }));
  };
  const emptyColumnDrop = operation => {
    if (operation?.op !== 'drop_empty_column') return false;
    const entity = current.entities.find(item => item.key === operation.entity);
    const column = entity?.table.columns.find(item => item.id === operation.column);
    const snapshot = snapshots.find(item => item.tableId === entity?.table.id);
    return Boolean(column && snapshot && snapshot.rows.every(row => {
      try { return isEmptyMigrationValue(JSON.parse(row.data || '{}')?.[column.id], column); }
      catch { return false; }
    }));
  };
  const emptyEntityChange = operation => {
    if (operation?.op === 'create_entity') return !current.entities.some(item => item.key === operation.entity);
    if (operation?.op !== 'drop_entity') return false;
    const snapshot = snapshots.find(item => item.key === operation.entity);
    return Boolean(snapshot && snapshot.rows.length === 0 && planned.changes.some(item => item.key === operation.entity && item.drop));
  };
  const reversible = input.operations.length > 0 && input.operations.every(operation => {
    if (['add_columns', 'rename_column'].includes(operation?.op) || emptyColumnDrop(operation) || emptyEntityChange(operation)) return true;
    return operation?.op === 'convert_column' && (restoreOperations.has(`${operation.entity}:${operation.column}`) || emptyColumnConversion(operation));
  });
  if (!reversible) return null;
  return [...input.operations].reverse().flatMap(operation => {
    if (operation.op === 'create_entity') return [{ op: 'drop_entity', entity: operation.entity }];
    if (operation.op === 'drop_entity') {
      const before = current.entities.find(entity => entity.key === operation.entity);
      if (!before) return [];
      return [{ op: 'create_entity', entity: operation.entity, name: before.table.name,
        columns: before.table.columns.map(column => ({ name: column.name, type: column.type,
          ...(column.type === 'select' ? { options: column.options || [] } : {}),
          ...(column.type === 'relation' ? { targetEntity: column.targetEntity, multiple: Boolean(column.multiple) } : {}) })) }];
    }
    if (operation.op === 'drop_empty_column') {
      const before = current.entities.find(entity => entity.key === operation.entity)?.table.columns.find(column => column.id === operation.column);
      if (!before) return [];
      return [{ op: 'add_columns', entity: operation.entity, columns: [{ name: before.name, type: before.type,
        ...(before.type === 'select' ? { options: before.options || [] } : {}),
        ...(before.type === 'relation' ? { targetEntity: before.targetEntity, multiple: Boolean(before.multiple) } : {}) }] }];
    }
    if (operation.op === 'add_columns') {
      const change = planned.changes.find(item => item.key === operation.entity);
      const existingIds = new Set(current.entities.find(entity => entity.key === operation.entity)?.table.columns.map(column => column.id) || []);
      return (change?.table.columns || []).filter(column => !existingIds.has(column.id)).map(column => ({
        op: 'drop_empty_column', entity: operation.entity, column: column.id,
      }));
    }
    const before = current.entities.find(entity => entity.key === operation.entity)?.table.columns.find(column => column.id === operation.column);
    if (!before) return [];
    if (operation.op === 'rename_column') return [{ op: 'rename_column', entity: operation.entity, column: operation.column, name: before.name }];
    const restore = restoreOperations.get(`${operation.entity}:${operation.column}`);
    if (restore) return [restore];
    return [{ op: 'convert_column', entity: operation.entity, column: operation.column, type: before.type,
      ...(before.type === 'select' ? { options: before.options || [] } : {}),
      ...(before.type === 'relation' ? { targetEntity: before.targetEntity, multiple: Boolean(before.multiple) } : {}) }];
  });
}

export async function previewMigration(db, orgId, app, input, by) {
  const result = await buildMigrationPreview(db, orgId, app, input);
  if (result.error) return result;
  if (!await mayUseDatabase(db,orgId,app.id,by,result.current.entities.map(entity=>entity.table.id),true)) return err('No such app.',404);
  return { tableIds: result.current.entities.map(entity=>entity.table.id), previewChecksum: result.previewChecksum, canApply: result.blockers.length === 0, changes: result.summaries, blockers: result.blockers.slice(0, 20), blockerCount: result.blockers.length };
}

export async function applyMigration(db, orgId, app, input, by) {
  if (!keyOK(input.id) || !Number.isSafeInteger(input.version) || input.version < 0) return err('A migration ID and database version are required.');
  const serializedInput = JSON.stringify(input.operations);
  const inputLimit = isRestorePlan(input.operations) ? MAX_ROLLBACK_BYTES : MAX_MIGRATION_PLAN_BYTES;
  if (!serializedInput || serializedPlanSize(input.operations) > inputLimit) return err(isRestorePlan(input.operations) ? 'This rollback plan exceeds the 500 KB safe snapshot limit.' : 'Migration is too large.', 413);
  const old = await db.prepare('SELECT checksum, version, plan FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 AND migration_id=?3').bind(orgId, app.id, input.id).first();
  if (old) {
    const decoded = readJournalPlan(old.plan);
    if (!decoded || await digest(old.plan) !== old.checksum) return err('Migration journal integrity check failed.', 409);
    return JSON.stringify(decoded.operations) === serializedInput
      ? { applied: true, replay: true, version: old.version }
      : err('This migration ID has different content.', 409);
  }
  const preview = await buildMigrationPreview(db, orgId, app, input);
  if (preview.error) return preview;
  if (preview.blockers.length) return err('Resolve every blocked row in the preview before applying this migration.', 409);
  if (preview.nonAdditive && input.previewChecksum !== preview.previewChecksum) return err('Data changed after preview. Preview the migration again.', 409);
  if (input.previewChecksum && input.previewChecksum !== preview.previewChecksum) return err('Migration preview changed. Review it again.', 409);
  const { current, planned, inverseOperations, rollbackUnavailableReason } = preview;
  // New journal entries wrap the exact requested operations and their reviewed,
  // stable-ID inverse. Legacy array entries remain readable and replayable.
  const journalPlan = JSON.stringify({ format: 2, operations: input.operations, inverseOperations, ...(rollbackUnavailableReason ? { rollbackUnavailableReason } : {}) });
  const checksum = await digest(journalPlan);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM hx_tables WHERE org_id=?1').bind(orgId).first();
  if (count.n + planned.changes.filter(c => c.create).length > MAX_TABLES_PER_ORG) return err('Workspace table limit reached.', 409);
  const latestRowChange = preview.snapshots.flatMap(snapshot => snapshot.rows).reduce((latest, row) => Math.max(latest, Date.parse(row.updatedAt) + 1 || 0), Date.now());
  const nonce = crypto.randomUUID(), at = new Date(latestRowChange).toISOString(), version = current.version + 1;
  const guard = 'EXISTS (SELECT 1 FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 AND nonce=?3)';
  const rowGuard = `AND NOT EXISTS (SELECT 1 FROM json_each(?5) e WHERE
    (SELECT COUNT(*) FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId'))!=json_array_length(e.value,'$.rows')
    OR EXISTS (SELECT 1 FROM json_each(e.value,'$.rows') expected WHERE NOT EXISTS
      (SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.tableId') AND r.id=json_extract(expected.value,'$.id') AND r.data=json_extract(expected.value,'$.data') AND r.updated_at=json_extract(expected.value,'$.updatedAt'))))
    AND NOT EXISTS (SELECT 1 FROM json_each(?6) target_group JOIN json_each(target_group.value,'$.ids') required
      WHERE NOT EXISTS (SELECT 1 FROM hx_rows target WHERE target.org_id=?1 AND target.table_id=json_extract(target_group.value,'$.tableId') AND target.id=required.value))`;
  const schemaGuard = `AND (SELECT COUNT(*) FROM hx_app_entities WHERE org_id=?1 AND app_id=?2)=json_array_length(?4)-1
    AND NOT EXISTS (SELECT 1 FROM json_each(?4) e WHERE NOT EXISTS
      (SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(e.value,'$.tableId') AND t.columns=json_extract(e.value,'$.columns')
        AND ((json_extract(e.value,'$.key')='primary' AND EXISTS (SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.table_id=t.id))
          OR EXISTS (SELECT 1 FROM hx_app_entities l WHERE l.org_id=?1 AND l.app_id=?2 AND l.entity_key=json_extract(e.value,'$.key') AND l.table_id=t.id))))`;
  const stmts = [
    db.prepare(`INSERT OR IGNORE INTO hx_app_database_state (org_id,app_id,version) SELECT ?1,?2,0 WHERE ${databaseAuthority('?1','?2','?3',"'[]'",true)}`).bind(orgId, app.id,String(by)),
    // Reject a concurrent legacy schema edit too, not just another migration.
    db.prepare(`UPDATE hx_app_database_state SET version=version+1 WHERE org_id=?1 AND app_id=?2 AND version=?3 ${schemaGuard} ${rowGuard} AND ${databaseAuthority('?1','?2','?7',"(SELECT json_group_array(json_extract(value,'$.tableId')) FROM json_each(?4))",true)}`).bind(orgId, app.id, current.version, JSON.stringify(preview.schema), JSON.stringify(preview.snapshots), JSON.stringify(preview.relationTargets),String(by)),
    db.prepare('INSERT INTO hx_app_migrations (org_id,app_id,migration_id,version,checksum,plan,nonce,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes()=1').bind(orgId, app.id, input.id, version, checksum, journalPlan, nonce, String(by), at),
  ];
  for (const c of planned.changes) {
    if (c.create) {
      stmts.push(db.prepare(`INSERT INTO hx_tables (org_id,id,name,columns,created_by,created_at,updated_at) SELECT ?1,?4,?5,?6,?7,?8,?8 WHERE ${guard}`).bind(orgId, app.id, nonce, c.table.id, c.table.name, JSON.stringify(c.table.columns), String(by), at));
      stmts.push(db.prepare(`INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) SELECT ?1,?2,?4,?5 WHERE ${guard}`).bind(orgId, app.id, nonce, c.key, c.table.id));
    } else if (c.drop) {
      stmts.push(db.prepare(`DELETE FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 AND entity_key=?4 AND table_id=?5 AND ${guard}`).bind(orgId,app.id,nonce,c.key,c.table.id));
      stmts.push(db.prepare(`DELETE FROM hx_tables WHERE org_id=?1 AND id=?4 AND NOT EXISTS (SELECT 1 FROM hx_rows WHERE org_id=?1 AND table_id=?4) AND ${guard}`).bind(orgId,app.id,nonce,c.table.id));
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
    const raw = await complete('Return JSON {"operations":[...]}. Supported database migration operations: {op:"create_entity",entity:"lowercase_key",name:"Name",columns:[{name,type,options?}]}, {op:"drop_entity",entity:"existing_empty_entity_key"}, {op:"add_columns",entity:"existing_key",columns:[{name,type,options?}]}, {op:"rename_column",entity:"existing_key",column:"stable_column_id",name:"New name"}, {op:"convert_column",entity:"existing_key",column:"stable_column_id",type:"text|number|date|datetime|select|checkbox|url|email|person|relation",options?:[...],targetEntity?:"existing_entity_key",multiple?:boolean,matchBy?:"stable_target_column_id"} and {op:"drop_empty_column",entity:"existing_key",column:"stable_column_id"}. Entity deletion is restricted to empty non-primary entities with no Workflow trigger references; remove preview records first and keep every relation target available. Conversion is strict: person conversion accepts only strings up to 64 characters; relation conversion may use stable record IDs or exact-match text against the target entity’s stable text/select/date/url/email column ID in matchBy. Every match must resolve to exactly one existing record; missing or duplicate matches are blockers, and target rows are checked again when applying. Multiple relations may use a JSON array of IDs or exact-match labels. Dropping is allowed only when every value is null, an empty string, or an empty multiple-relation list. Never create a column ID. Prefer additive changes; only rename, convert or drop when explicitly requested. Current schema: '+JSON.stringify(current.entities), prompt);
    const plan = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    const operations = Array.isArray(plan.operations) ? plan.operations.map(operation => operation && Array.isArray(operation.columns)
      ? { ...operation, columns: normalizeMemberFields(prompt, operation.columns) } : operation) : plan.operations;
    const checked = planMigration(current, operations);
    return checked.error ? checked : { operations };
  } catch { return err('The model did not return a valid migration.', 502); }
}

// Capture the schema and rows in one D1 batch so a snapshot never mixes database generations.
export async function snapshotDatabase(db, orgId, app, by) {
  if (!await mayUseDatabase(db, orgId, app.id, by, [], true)) return err('No such app.',404);
  const tableScope = 'SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 UNION SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2';
  const [tables,rows,links,total,primary,state] = await db.batch([
    db.prepare(`SELECT * FROM hx_tables WHERE org_id=?1 AND id IN (${tableScope})`).bind(orgId,app.id),
    db.prepare(`SELECT * FROM hx_rows WHERE org_id=?1 AND table_id IN (${tableScope}) AND (SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM hx_rows WHERE org_id=?1 AND table_id IN (${tableScope}))<=700000 ORDER BY position,id`).bind(orgId,app.id),
    db.prepare('SELECT entity_key,table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2').bind(orgId,app.id),
    db.prepare(`SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM hx_rows WHERE org_id=?1 AND table_id IN (${tableScope})`).bind(orgId,app.id),
    db.prepare('SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2').bind(orgId,app.id),
    db.prepare('SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2').bind(orgId,app.id),
  ]);
  if(primary.results?.[0]?.table_id!==app.tableId)return err('Database schema changed. Reload before creating a preview.',409);
  if(total.results[0].bytes>700000)return err('This database is too large for a preview snapshot.',413);
  const scopes=[{entity_key:'primary',table_id:primary.results[0].table_id},...(links.results||[])];
  const entities=[];
  for(const scope of scopes) {
    const t=(tables.results||[]).find(table=>table.id===scope.table_id);
    if(!t)return err('Database schema changed. Reload before creating a preview.',409);
    entities.push({key:scope.entity_key,table:{id:t.id,name:t.name,columns:JSON.parse(t.columns)},rows:(rows.results||[]).filter(r=>r.table_id===t.id).map(r=>({id:r.id,values:JSON.parse(r.data),updatedAt:r.updated_at}))});
  }
  const tableIds = [...new Set(entities.map(entity => entity.table.id))];
  if (!await mayUseDatabase(db, orgId, app.id, by, tableIds, true)) return err('No such app.',404);
  const data = JSON.stringify(entities);
  if (new TextEncoder().encode(data).length > 750000) return err('This database is too large for a preview snapshot.', 413);
  return { entities, tableIds, data, schemaVersion:Number(state.results?.[0]?.version||0) };
}

// A private writable snapshot, bounded to 750KB, never merged silently into production.
export async function forkDatabase(db, orgId, app, by) {
  const snapshot=await snapshotDatabase(db,orgId,app,by);
  if(snapshot.error)return snapshot;
  const {entities,tableIds,data}=snapshot;
  const id = crypto.randomUUID();
  const authority=databaseAuthority('?1','?2','?3','?7',true);
  const saved=await db.batch([db.prepare(`INSERT INTO hx_app_forks (org_id,app_id,created_by,id,revision,data,created_at)
    SELECT ?1,?2,?3,?4,1,?5,?6 WHERE ${authority}
    AND (SELECT COUNT(DISTINCT id) FROM (SELECT table_id AS id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2))=json_array_length(?7)
    AND NOT EXISTS (SELECT 1 FROM json_each(?7) selected WHERE selected.value NOT IN (SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2))
    ON CONFLICT(org_id,app_id,created_by) DO UPDATE SET id=excluded.id,revision=hx_app_forks.revision+1,data=excluded.data,created_at=excluded.created_at`).bind(orgId, app.id, String(by), id, data, new Date().toISOString(), JSON.stringify(tableIds)),
    db.prepare('DELETE FROM hx_app_fork_bases WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND EXISTS (SELECT 1 FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND id=?4)').bind(orgId,app.id,String(by),id),
    db.prepare('INSERT INTO hx_app_fork_bases (org_id,app_id,created_by,fork_id,data) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (SELECT 1 FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND id=?4)').bind(orgId,app.id,String(by),id,data)]);
  if (!saved[0]?.meta?.changes) return err('Database access or schema changed. Reload before creating a preview.',409);
  if (!await mayUseDatabase(db, orgId, app.id, by, tableIds, true)) return err('No such app.',404);
  return readFork(db, orgId, app.id, by);
}

// Older previews predate the persisted three-way baseline. Never guess their
// creation-time state. A user explicitly adopting the current production state
// creates a new, transaction-fenced baseline while preserving the preview.
export async function rebaseLegacyFork(db,orgId,app,by,input) {
  const {fork}=await readFork(db,orgId,app.id,by);
  if(!fork||fork.id!==input.forkId||fork.revision!==input.revision)return err('Preview changed. Reload before creating a baseline.',409);
  if(fork.mergedAt)return err('This preview was already merged. Create a fresh preview before editing.',409);
  const existing=await db.prepare('SELECT 1 AS present FROM hx_app_fork_bases WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND fork_id=?4').bind(orgId,app.id,String(by),fork.id).first();
  if(existing)return {rebased:true,replay:true,forkId:fork.id,revision:fork.revision};
  const snapshot=await snapshotDatabase(db,orgId,app,by);
  if(snapshot.error)return snapshot;
  const {data,tableIds,schemaVersion}=snapshot;
  const authority=databaseAuthority('?1','?2','?3','?8',true);
  const saved=await db.prepare(`INSERT INTO hx_app_fork_bases (org_id,app_id,created_by,fork_id,data)
    SELECT ?1,?2,?3,?4,?5 WHERE ${authority}
      AND EXISTS (SELECT 1 FROM hx_app_forks f WHERE f.org_id=?1 AND f.app_id=?2 AND f.created_by=?3 AND f.id=?4 AND f.revision=?6)
      AND NOT EXISTS (SELECT 1 FROM hx_app_fork_bases b WHERE b.org_id=?1 AND b.app_id=?2 AND b.created_by=?3 AND b.fork_id=?4)
      AND COALESCE((SELECT version FROM hx_app_database_state WHERE org_id=?1 AND app_id=?2),0)=?7
      AND (SELECT COUNT(DISTINCT table_id) FROM (SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2))=json_array_length(?8)
      AND NOT EXISTS (SELECT 1 FROM json_each(?8) wanted WHERE wanted.value NOT IN (SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2 UNION SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2))
      AND NOT EXISTS (SELECT 1 FROM json_each(?5) e WHERE
        NOT EXISTS (SELECT 1 FROM hx_tables t WHERE t.org_id=?1 AND t.id=json_extract(e.value,'$.table.id') AND json(t.columns)=json_extract(e.value,'$.table.columns') AND t.name=json_extract(e.value,'$.table.name'))
        OR (json_extract(e.value,'$.key')='primary' AND NOT EXISTS (SELECT 1 FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.table_id=json_extract(e.value,'$.table.id')))
        OR (json_extract(e.value,'$.key')!='primary' AND NOT EXISTS (SELECT 1 FROM hx_app_entities l WHERE l.org_id=?1 AND l.app_id=?2 AND l.entity_key=json_extract(e.value,'$.key') AND l.table_id=json_extract(e.value,'$.table.id'))))
      AND (SELECT COUNT(*) FROM hx_rows r WHERE r.org_id=?1 AND r.table_id IN (SELECT json_extract(value,'$.table.id') FROM json_each(?5)))=(SELECT COALESCE(SUM(json_array_length(value,'$.rows')),0) FROM json_each(?5))
      AND NOT EXISTS (SELECT 1 FROM json_each(?5) e JOIN json_each(e.value,'$.rows') expected WHERE NOT EXISTS
        (SELECT 1 FROM hx_rows r WHERE r.org_id=?1 AND r.table_id=json_extract(e.value,'$.table.id') AND r.id=json_extract(expected.value,'$.id') AND json(r.data)=json(json_extract(expected.value,'$.values')) AND r.updated_at=json_extract(expected.value,'$.updatedAt')))
  `).bind(orgId,app.id,String(by),fork.id,data,fork.revision,schemaVersion,JSON.stringify(tableIds)).run();
  if(!saved.meta?.changes)return err('Production data, schema or preview changed while creating the legacy baseline. Reload and try again.',409);
  if(!await mayUseDatabase(db,orgId,app.id,by,tableIds,true))return err('No such app.',404);
  return {rebased:true,forkId:fork.id,revision:fork.revision,baselineSchemaVersion:schemaVersion};
}

export async function readFork(db, orgId, appId, by) {
  const row = await db.prepare('SELECT id,revision,data,created_at AS createdAt,(SELECT created_at FROM hx_app_fork_merges m WHERE m.fork_id=hx_app_forks.id) AS mergedAt,EXISTS(SELECT 1 FROM hx_app_fork_bases b WHERE b.org_id=hx_app_forks.org_id AND b.app_id=hx_app_forks.app_id AND b.created_by=hx_app_forks.created_by AND b.fork_id=hx_app_forks.id) AS hasBaseline FROM hx_app_forks WHERE org_id=?1 AND app_id=?2 AND created_by=?3').bind(orgId, appId, String(by)).first();
  return { fork: row ? { id: row.id, revision: row.revision, entities: JSON.parse(row.data), createdAt: row.createdAt, mergedAt:row.mergedAt, hasBaseline:Boolean(row.hasBaseline) } : null };
}
export async function mutateFork(db, orgId, appId, by, input) {
  const { fork } = await readFork(db, orgId, appId, by);
  const tableIds = fork ? await existingForkTableIds(db,orgId,fork.entities) : [];
  if (fork && !await mayUseDatabase(db, orgId, appId, by, tableIds, true)) return err('No such app.',404);
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
  const authority=databaseAuthority('?2','?3','?4','?7',true);
  const saved = await db.prepare(`UPDATE hx_app_forks SET data=?1,revision=revision+1 WHERE org_id=?2 AND app_id=?3 AND created_by=?4 AND id=?5 AND revision=?6 AND NOT EXISTS (SELECT 1 FROM hx_app_fork_merges m WHERE m.fork_id=hx_app_forks.id) AND ${authority}`).bind(data, orgId, appId, String(by), fork.id, fork.revision,JSON.stringify(tableIds)).run();
  if (!saved.meta?.changes) return err('Preview data or access changed. Reload before editing.', 409);
  if (!await mayUseDatabase(db,orgId,appId,by,tableIds,true)) return err('No such app.',404);
  return { result, revision: fork.revision+1, tableIds };
}

async function existingForkTableIds(db,orgId,entities) {
  const ids=[...new Set((entities||[]).map(entity=>entity.table?.id).filter(Boolean))];
  if(!ids.length)return [];
  const {results=[]}=await db.prepare('SELECT id FROM hx_tables WHERE org_id=?1 AND id IN (SELECT value FROM json_each(?2))').bind(orgId,JSON.stringify(ids)).all();
  return results.map(row=>row.id);
}

// Keep every schema edit private until review. Conversion and empty-drop
// operations share the strict validation rules used by production migrations.
export async function mutateForkSchema(db, orgId, appId, by, input) {
  const { fork } = await readFork(db, orgId, appId, by);
  const tableIds=fork?await existingForkTableIds(db,orgId,fork.entities):[];
  if(fork&&!await mayUseDatabase(db,orgId,appId,by,tableIds,true))return err('No such app.',404);
  if (!fork || fork.id !== input.forkId || fork.revision !== input.revision) return err('Preview data changed. Reload before editing.', 409);
  if (fork.mergedAt) return err('This preview was merged. Create a new preview before editing.', 409);
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 12) return err('Specify 1–12 preview database operations.');
  const checked=planMigration({entities:fork.entities},input.operations);
  if(checked.error)return checked;
  let entities=fork.entities.map(entity=>({...entity,table:{...entity.table,columns:[...entity.table.columns]},rows:entity.rows.map(row=>({...row,values:{...row.values}}))}));
  for(const operation of input.operations){
    const planned=planMigration({entities},[operation]);
    if(planned.error)return planned;
    const change=planned.changes.find(item=>item.key===operation.entity);
    if(!change)continue;
    if(change.drop){
      const entity=entities.find(item=>item.key===change.key);
      if(!entity||entity.rows.length)return err('Delete every record in the preview before deleting this entity.',409);
      if(await hasWorkflowEntityReference(db,orgId,appId,entity.key,entity.table.id))return err('Remove Workflow references before deleting this entity.',409);
      entities=entities.filter(item=>item.key!==change.key);
      continue;
    }
    if(change.create){entities.push({key:change.key,table:change.table,rows:[]});continue;}
    const entity=entities.find(item=>item.key===change.key);
    if(!entity)return err('No such preview entity.');
    if(operation.op==='convert_column'){
      const source=entity.table.columns.find(column=>column.id===operation.column);
      const target=change.table.columns.find(column=>column.id===operation.column);
      const targetEntity=target?.type==='relation'?entities.find(item=>item.key===target.targetEntity):null;
      const resolver=new Map();
      if(operation.matchBy&&targetEntity)for(const row of targetEntity.rows){
        const label=row.values?.[operation.matchBy];
        if(typeof label==='string'){const key=JSON.stringify(label),matches=resolver.get(key)||[];matches.push(row.id);resolver.set(key,matches);}
      }
      for(const row of entity.rows){
        const converted=convertColumnValue(row.values?.[operation.column],target,source,operation,operation.matchBy?resolver:null);
        if(!converted.ok)return err(`Preview value in "${source?.name||operation.column}" cannot be converted without data loss.`,409);
        if(converted.value===undefined)delete row.values[operation.column];else row.values[operation.column]=converted.value;
      }
    }else if(operation.op==='drop_empty_column'){
      const source=entity.table.columns.find(column=>column.id===operation.column);
      if(entity.rows.some(row=>!isEmptyMigrationValue(row.values?.[operation.column],source)))return err(`Preview column "${source?.name||operation.column}" contains values and cannot be dropped.`,409);
      for(const row of entity.rows)delete row.values[operation.column];
    }
    entity.table={...entity.table,columns:change.table.columns};
  }
  const relationError=relationStateError(entities);if(relationError)return err(relationError,409);
  for(const entity of entities)for(const row of entity.rows){const invalid=validateValues(entity.table.columns,row.values);if(invalid.length)return err(`Preview contains invalid values: ${invalid.map(item=>item.message||item).join(', ')}`,409);}
  const data = JSON.stringify(entities);
  if (new TextEncoder().encode(data).length > 750000) return err('Preview database is too large.', 413);
  const authority = databaseAuthority('?2','?3','?4','?7',true);
  const saved = await db.prepare(`UPDATE hx_app_forks SET data=?1,revision=revision+1 WHERE org_id=?2 AND app_id=?3 AND created_by=?4 AND id=?5 AND revision=?6 AND NOT EXISTS (SELECT 1 FROM hx_app_fork_merges m WHERE m.fork_id=hx_app_forks.id) AND ${authority}`).bind(data,orgId,appId,String(by),fork.id,fork.revision,JSON.stringify(tableIds)).run();
  if (!saved.meta?.changes) return err('Preview data or access changed. Reload before editing.', 409);
  if(!await mayUseDatabase(db,orgId,appId,by,tableIds,true))return err('No such app.',404);
  return { revision: fork.revision + 1, tableIds };
}

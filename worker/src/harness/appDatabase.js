import { getTable, listRows, normalizeColumns, MAX_TABLES_PER_ORG } from './tables.js';
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

// Additive migrations only. Stable column IDs and existing values are never dropped or coerced.
export function planMigration(current, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 12) return err('Specify 1–12 additive database operations.');
  const entities = new Map(current.entities.map(e => [e.key, { ...e.table, columns: [...e.table.columns] }]));
  const changed = new Map();
  for (const op of operations) {
    if (!op || !keyOK(op.entity)) return err('Invalid entity key.');
    if (op.op === 'create_entity') {
      if (entities.has(op.entity) || entities.size >= 12) return err('Entity already exists or the 12-entity limit was reached.');
      if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 80) return err('Give the entity a name (1–80 characters).');
      const cols = normalizeColumns(op.columns, [], { allowRelations: true });
      if (cols.error) return cols;
      const table = { id: `tbl_${crypto.randomUUID().replace(/-/g, '')}`, name: op.name.trim(), columns: cols.columns };
      entities.set(op.entity, table); changed.set(op.entity, { table, create: true });
    } else if (op.op === 'add_columns') {
      const table = entities.get(op.entity);
      if (!table) return err('No such entity.');
      if (!Array.isArray(op.columns) || !op.columns.length || op.columns.some(c => c.id || table.columns.some(old => old.name.toLowerCase() === String(c.name).toLowerCase()))) return err('Add new columns; existing columns cannot be replaced.');
      const cols = normalizeColumns([...table.columns, ...op.columns], table.columns, { allowRelations: true });
      if (cols.error) return cols;
      const next = { ...table, columns: cols.columns };
      entities.set(op.entity, next); changed.set(op.entity, { ...changed.get(op.entity), table: next });
    } else return err('Only create_entity and add_columns are supported.');
  }
  for (const table of entities.values()) for (const column of table.columns) {
    if (column.type === 'relation' && !entities.has(column.targetEntity)) return err(`The relation field "${column.name}" points to an unavailable app entity.`);
  }
  return { changes: [...changed].map(([key, value]) => ({ key, ...value })) };
}

export async function applyMigration(db, orgId, app, input, by) {
  if (!keyOK(input.id) || !Number.isSafeInteger(input.version) || input.version < 0) return err('A migration ID and database version are required.');
  const serialized = JSON.stringify(input.operations);
  if (!serialized || serialized.length > 30000) return err('Migration is too large.');
  const checksum = await digest(serialized);
  const old = await db.prepare('SELECT checksum, version FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 AND migration_id=?3').bind(orgId, app.id, input.id).first();
  if (old) return old.checksum === checksum ? { applied: true, replay: true, version: old.version } : err('This migration ID has different content.', 409);
  const current = await databaseView(db, orgId, app);
  if (current.version !== input.version) return err('Database schema changed. Reload before applying.', 409);
  const planned = planMigration(current, input.operations);
  if (planned.error) return planned;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM hx_tables WHERE org_id=?1').bind(orgId).first();
  if (count.n + planned.changes.filter(c => c.create).length > MAX_TABLES_PER_ORG) return err('Workspace table limit reached.', 409);
  const nonce = crypto.randomUUID(), at = new Date().toISOString(), version = current.version + 1;
  const guard = 'EXISTS (SELECT 1 FROM hx_app_migrations WHERE org_id=?1 AND app_id=?2 AND nonce=?3)';
  const stmts = [
    db.prepare('INSERT OR IGNORE INTO hx_app_database_state (org_id,app_id,version) VALUES (?1,?2,0)').bind(orgId, app.id),
    // Reject a concurrent legacy schema edit too, not just another migration.
    db.prepare(`UPDATE hx_app_database_state SET version=version+1 WHERE org_id=?1 AND app_id=?2 AND version=?3 AND NOT EXISTS (SELECT 1 FROM json_each(?4) e JOIN hx_tables t ON t.id=json_extract(e.value,'$.id') AND t.org_id=?1 WHERE t.columns!=json_extract(e.value,'$.columns'))`).bind(orgId, app.id, current.version, JSON.stringify(current.entities.map(e => ({ id: e.table.id, columns: JSON.stringify(e.table.columns) })))),
    db.prepare('INSERT INTO hx_app_migrations (org_id,app_id,migration_id,version,checksum,plan,nonce,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes()=1').bind(orgId, app.id, input.id, version, checksum, serialized, nonce, String(by), at),
  ];
  for (const c of planned.changes) {
    if (c.create) {
      stmts.push(db.prepare(`INSERT INTO hx_tables (org_id,id,name,columns,created_by,created_at,updated_at) SELECT ?1,?4,?5,?6,?7,?8,?8 WHERE ${guard}`).bind(orgId, app.id, nonce, c.table.id, c.table.name, JSON.stringify(c.table.columns), String(by), at));
      stmts.push(db.prepare(`INSERT INTO hx_app_entities (org_id,app_id,entity_key,table_id) SELECT ?1,?2,?4,?5 WHERE ${guard}`).bind(orgId, app.id, nonce, c.key, c.table.id));
    } else stmts.push(db.prepare(`UPDATE hx_tables SET columns=?4,updated_at=?5 WHERE org_id=?1 AND id=?6 AND ${guard}`).bind(orgId, app.id, nonce, JSON.stringify(c.table.columns), at, c.table.id));
  }
  const result = await db.batch(stmts);
  return result[2]?.meta?.changes ? { applied: true, version } : err('Database schema changed. Reload before applying.', 409);
}

export async function generateMigration(prompt, current, complete) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return err('Describe the database change in 1–4000 characters.');
  if (!complete) return err('AI generation is unavailable within the current allowance.', 503);
  try {
    const raw = await complete('Return JSON {"operations":[...]}. Additive database migration only: {op:"create_entity",entity:"lowercase_key",name:"Name",columns:[{name,type,options?}]} or {op:"add_columns",entity:"existing_key",columns:[{name,type,options?}]}. Types: text,number,date,select,checkbox,url,person,email,relation. A relation column uses targetEntity with an existing app entity key and optional multiple:true to link more than one record. Relation values are stable record IDs and must reference records in this same app. Internal owners, assignees, reviewers, interviewers and approvers use person references to workspace members, not free text unless explicitly requested. Never delete or replace columns. No column IDs in new columns. Current schema: '+JSON.stringify(current.entities), prompt);
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

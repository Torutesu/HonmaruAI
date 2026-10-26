const invalid = (message, field) => ({ error: message, status: 400, ...(field ? { fields: [{ field, message }] } : {}) });

async function appForTable(db, orgId, tableId) {
  return db.prepare(`SELECT a.id, a.table_id AS primaryTable FROM hx_apps a
    WHERE a.org_id=?1 AND (a.table_id=?2 OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.table_id=?2))
    LIMIT 1`).bind(orgId, tableId).first();
}

async function entityTables(db, orgId, app) {
  const { results = [] } = await db.prepare('SELECT entity_key AS key,table_id AS tableId FROM hx_app_entities WHERE org_id=?1 AND app_id=?2').bind(orgId, app.id).all();
  return new Map([['primary', app.primaryTable], ...results.map(row => [row.key, row.tableId])]);
}

export async function validateAppRelations(db, orgId, tableId, columns, values) {
  const relations = (columns || []).filter(column => column.type === 'relation');
  if (!relations.length) return null;
  const app = await appForTable(db, orgId, tableId);
  if (!app) return invalid('Relation fields must belong to an app database.');
  const entities = await entityTables(db, orgId, app);
  const requested = new Map(), columnsByTarget = new Map();
  for (const column of relations) {
    const targetTable = entities.get(column.targetEntity);
    if (!targetTable) return invalid('A relation field points to an unavailable app entity.', column.id);
    const value = values?.[column.id];
    if (value == null) continue;
    if (column.multiple && (!Array.isArray(value) || value.length > 100)) return invalid('Choose up to 100 records from the linked app entity.', column.id);
    const ids = column.multiple ? value : [value];
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id.length > 64) return invalid('A linked record ID is invalid.', column.id);
    }
    let targetIds = requested.get(targetTable);
    if (!targetIds) { targetIds = new Set(); requested.set(targetTable, targetIds); }
    for (const id of ids) targetIds.add(id);
    columnsByTarget.set(column.id, { tableId: targetTable, ids });
  }
  for (const [targetTable, ids] of requested) {
    const { results = [] } = await db.prepare(`SELECT target.id FROM hx_rows target
      JOIN json_each(?1) requested ON requested.value=target.id
      WHERE target.org_id=?2 AND target.table_id=?3`).bind(JSON.stringify([...ids]), orgId, targetTable).all();
    const found = new Set(results.map(row => row.id));
    for (const column of relations) {
      const check = columnsByTarget.get(column.id);
      if (check?.tableId === targetTable && check.ids.some(id => !found.has(id))) return invalid('A linked record no longer exists in this app.', column.id);
    }
  }
  return null;
}

// Return SQL predicates as well as an early validation result. The predicates
// run in the same statement as the row write, closing the check/delete race.
export async function appRelationWriteGuard(db, orgId, tableId, columns, values, firstParameter) {
  const relations = (columns || []).filter(column => column.type === 'relation' && values?.[column.id] != null);
  if (!relations.length) return { sql: '1', binds: [] };
  const app = await appForTable(db, orgId, tableId);
  if (!app) return { error: invalid('Relation fields must belong to an app database.') };
  const entities = await entityTables(db, orgId, app), clauses = [], binds = [];
  let next = firstParameter;
  for (const column of relations) {
    const targetTable = entities.get(column.targetEntity), value = values[column.id];
    if (!targetTable) return { error: invalid('A relation field points to an unavailable app entity.', column.id) };
    if (column.multiple) {
      if (!Array.isArray(value)) return { error: invalid('Choose records from the linked app entity.', column.id) };
      clauses.push(`NOT EXISTS(SELECT 1 FROM json_each(?${next}) linked WHERE NOT EXISTS(SELECT 1 FROM hx_rows target WHERE target.org_id=?${next + 1} AND target.table_id=?${next + 2} AND target.id=linked.value))`);
      binds.push(JSON.stringify(value), orgId, targetTable); next += 3;
    } else {
      if (typeof value !== 'string' || !value || value.length > 64) return { error: invalid('A linked record ID is invalid.', column.id) };
      clauses.push(`EXISTS(SELECT 1 FROM hx_rows target WHERE target.org_id=?${next} AND target.table_id=?${next + 1} AND target.id=?${next + 2})`);
      binds.push(orgId, targetTable, value); next += 3;
    }
  }
  return { sql: clauses.join(' AND '), binds };
}

async function incomingRelations(db, orgId, targetTableId) {
  const app = await appForTable(db, orgId, targetTableId);
  if (!app) return [];
  const entities = await entityTables(db, orgId, app);
  const { results = [] } = await db.prepare('SELECT id,columns FROM hx_tables WHERE org_id=?1 AND id IN (SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 UNION SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2)').bind(orgId, app.id).all();
  const tableColumns = new Map(results.map(row => [row.id, (() => { try { return JSON.parse(row.columns); } catch { return []; } })()]));
  const sources = [];
  for (const [entity, sourceTable] of entities) {
    for (const column of tableColumns.get(sourceTable) || []) {
      if (column.type === 'relation' && entities.get(column.targetEntity) === targetTableId) sources.push({ tableId: sourceTable, column });
    }
  }
  return sources;
}

export async function hasAppRelationsToRow(db, orgId, tableId, rowId) {
  const sources = await incomingRelations(db, orgId, tableId);
  if (!sources.length) return false;
  const clauses = [], binds = [orgId, rowId];
  for (const source of sources) {
    const path = `$.${source.column.id}`;
    const predicate = source.column.multiple
      ? `EXISTS(SELECT 1 FROM json_each(source.data,'${path}') linked WHERE linked.value=?2)`
      : `json_extract(source.data,'${path}')=?2`;
    const tableParameter = binds.length + 1;
    clauses.push(`(source.table_id=?${tableParameter} AND ${predicate})`);
    binds.push(source.tableId);
  }
  return !!(await db.prepare(`SELECT 1 AS found FROM hx_rows source WHERE source.org_id=?1 AND (${clauses.join(' OR ')}) LIMIT 1`).bind(...binds).first());
}

export async function appRelationDeleteGuard(db, orgId, tableId, firstParameter) {
  const sources = await incomingRelations(db, orgId, tableId), clauses = [], binds = [];
  let next = firstParameter;
  for (const source of sources) {
    const path = `$.${source.column.id}`;
    const predicate = source.column.multiple
      ? `EXISTS(SELECT 1 FROM json_each(source.data,'${path}') linked WHERE linked.value=?1)`
      : `json_extract(source.data,'${path}')=?1`;
    clauses.push(`NOT EXISTS(SELECT 1 FROM hx_rows source WHERE source.org_id=?3 AND source.table_id=?${next} AND ${predicate})`);
    binds.push(source.tableId); next += 1;
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', binds };
}

import { getTable } from './tables.js';
import { validateValues } from './tableContract.js';
import { mayUseApp, mayUseTable } from './resourceAccess.js';

const MAX_PAGE_SIZE = 100;
const MAX_SCAN_SIZE = 500;
const MAX_FILTERS = 40;
const MAX_CANDIDATES = 100;

const b64encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
const b64decode = value => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
};

function normalizeWhere(table, input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > MAX_FILTERS) throw Object.assign(new Error('Invalid table query filter.'), {status: 400});
  const where = {};
  for (const [key, value] of Object.entries(input)) {
    const column = table.columns.find(item => item.id === key || item.name.toLowerCase() === key.toLowerCase());
    if (!column) throw Object.assign(new Error('Invalid table query filter.'), {status: 400});
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && (value.length > MAX_CANDIDATES || value.some(item => Array.isArray(item) || (item !== null && !['string','number','boolean'].includes(typeof item))))) throw Object.assign(new Error('Invalid table query filter.'), {status: 400});
    if (!Array.isArray(value) && value !== null && !['string','number','boolean'].includes(typeof value)) throw Object.assign(new Error('Invalid table query filter.'), {status: 400});
    for (const candidate of values) {
      if (candidate !== null && validateValues(table.columns, {[column.id]: candidate}).length) throw Object.assign(new Error('Invalid table query filter.'), {status: 400});
    }
    Object.defineProperty(where, column.id, {value: Array.isArray(value) ? [...value] : value, enumerable:true, configurable:true, writable:true});
  }
  return Object.fromEntries(Object.entries(where).sort(([left],[right]) => left.localeCompare(right)));
}

async function filterFingerprint(where, q, appId, entityId, tableId) {
  const value = JSON.stringify({where, q, appId, entityId, tableId});
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2,'0')).join('');
}

function decodeCursor(cursor, expected) {
  if (cursor === undefined) return {snapshotAt: new Date().toISOString(), afterCreatedAt: null, afterId: null};
  if (typeof cursor !== 'string' || cursor.length > 2048) throw Object.assign(new Error('Invalid table query cursor.'), {status:400});
  let value;
  try { value = JSON.parse(b64decode(cursor)); } catch { throw Object.assign(new Error('Invalid table query cursor.'), {status:400}); }
  const keys = ['v','appId','entityId','tableId','filter','snapshotAt','createdAt','id'].sort();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== keys.join('\0')
    || value.v !== 1 || value.appId !== expected.appId || value.entityId !== expected.entityId || value.tableId !== expected.tableId
    || value.filter !== expected.filter || typeof value.snapshotAt !== 'string' || Number.isNaN(Date.parse(value.snapshotAt))
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || typeof value.id !== 'string' || !value.id || value.id.length > 200) {
    throw Object.assign(new Error('Invalid table query cursor.'), {status:400});
  }
  return {snapshotAt:value.snapshotAt,afterCreatedAt:value.createdAt,afterId:value.id};
}

const nextCursor = (identity, filter, snapshotAt, row) => b64encode(JSON.stringify({
  v:1, appId:identity.appId, entityId:identity.entityId, tableId:identity.tableId,
  filter, snapshotAt, createdAt:row.created_at, id:row.id,
}));

function matches(row, where, q) {
  for (const [column, filter] of Object.entries(where)) {
    if (Array.isArray(filter) ? !filter.some(value => row.values[column] === value) : row.values[column] !== filter) return false;
  }
  return !q || Object.values(row.values).some(value => value != null && String(value).toLowerCase().includes(q));
}

// Page through an immutable creation-order keyset. The first-page timestamp
// excludes rows inserted after a scan begins; row values are read live on each
// page, so callers still need to tolerate edits/deletions during a long scan.
export async function queryWorkflowTablePage(db, {orgId, appId, entityId, tableId, viewerId}, input, at=Date.now()) {
  if (!Number.isSafeInteger(at) || at < 0 || ![orgId,appId,entityId,tableId,viewerId].every(value => typeof value === 'string' && value.length > 0)) return {error:'Invalid table query scope.',status:400};
  const pageSize = input.pageSize === undefined ? 100 : input.pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) return {error:'Table query pageSize must be between 1 and 100.',status:400};
  const q = input.q === undefined ? '' : input.q;
  if (typeof q !== 'string' || q.length > 200) return {error:'Invalid table query text.',status:400};
  const mapped = await db.prepare(`SELECT 1 AS allowed FROM hx_apps a WHERE a.org_id=?1 AND a.id=?2 AND a.table_id=?3 AND ?4='primary'
    UNION ALL SELECT 1 AS allowed FROM hx_app_entities e WHERE e.org_id=?1 AND e.app_id=?2 AND e.table_id=?3 AND e.entity_key=?4 LIMIT 1`)
    .bind(orgId,appId,tableId,entityId).first();
  if (!mapped || !(await mayUseApp(db,orgId,appId,viewerId)) || !(await mayUseTable(db,orgId,tableId,viewerId))) return {error:'The workflow source is no longer accessible.',status:404};
  const table = await getTable(db,orgId,tableId);
  if (!table) return {error:'The workflow source is no longer accessible.',status:404};
  const where = normalizeWhere(table,input.where);
  const normalizedQ = q.trim().toLowerCase();
  const filter = await filterFingerprint(where,normalizedQ,appId,entityId,tableId);
  const cursor = decodeCursor(input.cursor,{appId,entityId,tableId,filter});
  const scanLimit = MAX_SCAN_SIZE + 1;
  const rowsResult = await db.prepare(`SELECT id,table_id,data,position,created_by,updated_by,created_at,updated_at FROM hx_rows
    WHERE org_id=?1 AND table_id=?2 AND created_at<=?3
      AND (?4 IS NULL OR created_at>?4 OR (created_at=?4 AND id>?5))
    ORDER BY created_at ASC,id ASC LIMIT ?6`).bind(orgId,tableId,cursor.snapshotAt,cursor.afterCreatedAt,cursor.afterId,scanLimit).all();
  const scanned = rowsResult.results || [];
  const hasUnscanned = scanned.length > MAX_SCAN_SIZE;
  const considered = scanned.slice(0,MAX_SCAN_SIZE);
  const decoded = considered.map(row => ({id:row.id,tableId:row.table_id,values:JSON.parse(row.data),position:row.position,createdBy:row.created_by,updatedBy:row.updated_by,createdAt:row.created_at,updatedAt:row.updated_at}));
  const matched=[];
  for (let index=0; index<decoded.length; index++) {
    if (matches(decoded[index],where,normalizedQ)) matched.push({row:decoded[index],source:considered[index]});
    if (matched.length > pageSize) break;
  }
  const selected=matched.slice(0,pageSize);
  let complete;
  let continuation;
  if (matched.length > pageSize) {
    complete=false;
    continuation=nextCursor({appId,entityId,tableId},filter,cursor.snapshotAt,selected.at(-1).source);
  } else if (hasUnscanned) {
    complete=false;
    continuation=nextCursor({appId,entityId,tableId},filter,cursor.snapshotAt,considered.at(-1));
  } else {
    complete=true;
    continuation=null;
  }
  let outputRows=selected.map(item=>item.row);
  while(outputRows.length&&new TextEncoder().encode(JSON.stringify({rows:outputRows,complete,cursor:continuation})).length>180_000){
    outputRows=outputRows.slice(0,-1);
    continuation=outputRows.length?nextCursor({appId,entityId,tableId},filter,cursor.snapshotAt,selected[outputRows.length-1].source):(input.cursor??null);
    complete=false;
  }
  if(!outputRows.length&&selected.length)return {error:'A single table row exceeds the Workflow page transport limit.',status:413};
  // Recheck the selected App/Table grant after reading. This prevents a page
  // whose grant was revoked during the DB read from leaving the Worker.
  if (!(await mayUseApp(db,orgId,appId,viewerId)) || !(await mayUseTable(db,orgId,tableId,viewerId))) return {error:'The workflow source is no longer accessible.',status:404};
  return {rows:outputRows,complete,cursor:continuation,scanned:considered.length,...(outputRows.length<selected.length?{incompleteReason:'page_size_limit'}:{})};
}

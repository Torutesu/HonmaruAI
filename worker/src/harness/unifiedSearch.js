import { parseQuery } from '../channels.js';
import { fileScopeAuthority } from './fileAuthority.js';
import { downloadFileVersion } from './fileDownload.js';
import { mayReadAppRows } from './resourceAccess.js';

// The palette asks for a small, bounded set of content matches. The existing
// message search remains its own API and its response is deliberately untouched.
const FILE_SCAN = 25;
const FILE_RESULTS = 8;
const FILE_BYTES = 128 * 1024;
const ROWS_PER_APP = 11;
const RECORD_RESULTS = 8;
const TEXT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/json', 'application/yaml', 'text/yaml', 'application/xml',
  'text/xml',
]);

const escapeLike = (value) => `%${String(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const decodeText = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
};
const safeSnippet = (text, needle, max = 160) => {
  const normalized = String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const at = normalized.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  const start = Math.max(0, Math.min(at < 0 ? 0 : at - 55, normalized.length - max));
  return `${start ? '…' : ''}${normalized.slice(start, start + max)}${start + max < normalized.length ? '…' : ''}`;
};
const stringValues = (value, out = []) => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  return out;
};
const validCursor = (value, fields) => {
  if (!value || typeof value !== 'string' || value.length > 500) return null;
  try {
    const cursor = JSON.parse(value);
    return cursor && fields.every((field) => typeof cursor[field] === 'string' && cursor[field].length > 0 && cursor[field].length <= 200) ? cursor : null;
  } catch { return null; }
};

function contentQuery(raw) {
  const q = parseQuery(raw);
  // Keep Slack filters scoped to message results. Resource search runs only on
  // an ordinary text query, so `from:`, `in:`, and `has:file` keep their meaning.
  if (!q.text || q.phrases.length || q.not.length || q.from || q.in || q.to || q.before || q.after || q.on || q.during || q.hasList.length || q.isList.length) return null;
  return q.text.trim().slice(0, 120);
}

async function searchFiles(env, orgId, userId, needle, cursorRaw) {
  const cursor = validCursor(cursorRaw, ['updatedAt', 'id']);
  const { results = [] } = await env.DB.prepare(`SELECT f.id,f.scope,f.path,f.updated_at,f.current_version,v.content_type,v.size
    FROM hx_workspace_files f
    JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
    WHERE f.org_id=?1 AND f.current_version>0 AND v.kind='content' AND v.size<=?2
      AND lower(v.content_type) IN (${[...TEXT_TYPES].map((_, i) => `?${i + 4}`).join(',')})
      AND ${fileScopeAuthority('f.org_id', 'f.scope', '?3')}
      AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)
      AND NOT EXISTS(SELECT 1 FROM media_deletions d WHERE d.key=v.object_key)
      AND (?${TEXT_TYPES.size + 4} IS NULL OR f.updated_at<?${TEXT_TYPES.size + 4} OR (f.updated_at=?${TEXT_TYPES.size + 4} AND f.id>?${TEXT_TYPES.size + 5}))
    ORDER BY f.updated_at DESC,f.id ASC LIMIT ${FILE_SCAN + 1}`)
    .bind(orgId, FILE_BYTES, userId, ...TEXT_TYPES, cursor?.updatedAt ?? null, cursor?.id ?? null).all();
  const candidates = results.slice(0, FILE_SCAN);
  const hits = [];
  for (const file of candidates) {
    // Every body read is both count- and size-bounded; downloadFileVersion
    // checks live ACL and the content hash around its R2 read.
    let response;
    try { response = await downloadFileVersion(env, { orgId, fileId: file.id, userId, version: file.current_version }); }
    catch { continue; }
    if (!response) continue;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > FILE_BYTES) continue;
    const body = decodeText(bytes);
    if (body === null || !body.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) continue;

    // The file may have moved, been deleted, or lost access while R2 was read.
    // Reauthorize and bind the result metadata to the same live version.
    const live = await env.DB.prepare(`SELECT f.id,f.scope,f.path,f.updated_at,f.current_version
      FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
      WHERE f.org_id=?1 AND f.id=?2 AND f.current_version=?3 AND v.kind='content'
       AND ${fileScopeAuthority('f.org_id', 'f.scope', '?4')}
       AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)`)
      .bind(orgId, file.id, file.current_version, userId).first();
    if (!live) continue;
    hits.push({ id: live.id, name: live.path.split('/').pop() || live.path, scope: live.scope, updatedAt: live.updated_at, snippet: safeSnippet(body, needle) });
  }
  const page = hits.slice(0, FILE_RESULTS);
  const hasMore = hits.length > FILE_RESULTS || results.length > FILE_SCAN;
  const lastHit = page.at(-1);
  const scanned = candidates.at(-1);
  const next = hits.length > FILE_RESULTS && lastHit
    ? { updatedAt: lastHit.updatedAt, id: lastHit.id }
    : results.length > FILE_SCAN && scanned ? { updatedAt: scanned.updated_at, id: scanned.id } : null;
  return { files: page, filesTruncated: hasMore, filesNextCursor: next ? JSON.stringify(next) : null };
}

async function searchRecords(db, orgId, userId, needle, cursorRaw) {
  const cursor = validCursor(cursorRaw, ['updatedAt', 'appId', 'rowId']);
  // Enumerate all table-backed apps (bounded by the workspace's 200-table
  // invariant) and authorize before any row query or candidate LIMIT.
  const { results: listed = [] } = await db.prepare(`SELECT a.id AS app_id,a.name AS app_name,a.table_id,t.name AS table_name,t.columns
    FROM hx_apps a JOIN hx_tables t ON t.org_id=a.org_id AND t.id=a.table_id
    WHERE a.org_id=?1 ORDER BY a.id ASC`).bind(orgId).all();
  const allowed = [];
  for (const app of listed) if (await mayReadAppRows(db, orgId, app.app_id, app.table_id, userId)) allowed.push(app);
  const apps = allowed;
  const pattern = escapeLike(needle);
  const found = new Map();
  let rowsTruncated = false;
  let lastCandidate = null;
  for (const app of apps) {
    const { results: rows = [] } = await db.prepare(`SELECT id,data,updated_at FROM hx_rows
      WHERE org_id=?1 AND table_id=?2 AND lower(data) LIKE lower(?3) ESCAPE '\\'
       AND (?4 IS NULL OR updated_at<?4 OR (updated_at=?4 AND (?5>?6 OR (?5=?6 AND id>?7))))
      ORDER BY updated_at DESC,id ASC LIMIT ${ROWS_PER_APP + 1}`).bind(orgId, app.table_id, pattern, cursor?.updatedAt ?? null, app.app_id, cursor?.appId ?? null, cursor?.rowId ?? null).all();
    if (rows.length > ROWS_PER_APP) rowsTruncated = true;
    const columns = (() => { try { return JSON.parse(app.columns || '[]'); } catch { return []; } })();
    for (const row of rows.slice(0, ROWS_PER_APP)) {
      const candidate = { updatedAt: row.updated_at, appId: app.app_id, rowId: row.id };
      if (!lastCandidate || candidate.updatedAt < lastCandidate.updatedAt || (candidate.updatedAt === lastCandidate.updatedAt && (candidate.appId > lastCandidate.appId || (candidate.appId === lastCandidate.appId && candidate.rowId > lastCandidate.rowId)))) lastCandidate = candidate;
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      const matches = [];
      for (const column of columns) {
        if (!column || column.type === 'relation') continue;
        const value = data?.[column.id];
        for (const text of stringValues(value)) if (text.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) matches.push(`${column.name}: ${text}`);
      }
      if (!matches.length) continue;
      // Recheck app/table policy after the bounded SQL scan before exposing
      // even the row id, app name, or a value snippet.
      if (!(await mayReadAppRows(db, orgId, app.app_id, app.table_id, userId))) continue;
      const item = { id: row.id, appId: app.app_id, appName: app.app_name, tableId: app.table_id, tableName: app.table_name, rowId: row.id, updatedAt: row.updated_at, snippet: safeSnippet(matches[0], needle) };
      found.set(row.id, item);
    }
  }
  const records = [...found.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.appId.localeCompare(b.appId) || a.rowId.localeCompare(b.rowId));
  const page = records.slice(0, RECORD_RESULTS);
  const hasMore = rowsTruncated || records.length > RECORD_RESULTS;
  const lastHit = page.at(-1);
  const next = records.length > RECORD_RESULTS && lastHit
    ? { updatedAt: lastHit.updatedAt, appId: lastHit.appId, rowId: lastHit.rowId }
    : rowsTruncated ? lastCandidate : null;
  return { records: page, recordsTruncated: hasMore, recordsNextCursor: next ? JSON.stringify(next) : null };
}

export async function searchHarnessResources(env, orgId, userId, raw, cursors = {}) {
  const needle = contentQuery(raw);
  if (!needle || needle.length < 2) return { files: [], records: [], filesNextCursor: null, recordsNextCursor: null };
  const [files, records] = await Promise.all([
    cursors.skipFiles ? Promise.resolve({ files: [], filesTruncated: false, filesNextCursor: null }) : searchFiles(env, orgId, userId, needle, cursors.file),
    cursors.skipRecords ? Promise.resolve({ records: [], recordsTruncated: false, recordsNextCursor: null }) : searchRecords(env.DB, orgId, userId, needle, cursors.record),
  ]);
  return { ...files, ...records };
}

import { searchMessages, parseQuery, VISIBLE, viewOf } from '../channels.js';
import { accessFor } from '../access.js';
import { fileScopeAuthority } from './fileAuthority.js';
import { mayUseTable } from './resourceAccess.js';
import { listWorkflows } from './workflows.js';

const MAX_TERMS = 8;
const MAX_RESULTS = 8;

function termsOf(parsed) {
  const words = String(parsed.text || '').trim().split(/\s+/).filter(Boolean);
  return [...words, ...(parsed.phrases || [])].slice(0, MAX_TERMS);
}

function allMatch(value, terms) {
  const haystack = String(value || '').toLocaleLowerCase();
  return terms.every(term => haystack.includes(term.toLocaleLowerCase()));
}

export async function searchGlobalResources(db, { orgId, userId, login, members, raw }) {
  if (typeof raw !== 'string' || raw.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
    return { error: 'Invalid search query.', status: 400 };
  }
  const parsed = parseQuery(raw);
  const terms = termsOf(parsed);
  const messageResult = await searchMessages(db, orgId, login, members, raw, { limit: MAX_RESULTS });
  if (!terms.length) return { messages: messageResult.messages, files: [], records: [], automations: [] };

  const fileTerms = terms.map((_, i) => {
    const p = `?${i + 3}`;
    return `(instr(lower(f.path),lower(${p}))>0 OR instr(lower(COALESCE(s.body,'')),lower(${p}))>0)`;
  }).join(' AND ');
  const { results: fileRows } = await db.prepare(`WITH candidates AS (
      SELECT org_id,id,scope,path,current_version,updated_at FROM hx_workspace_files
      WHERE org_id=?1 ORDER BY updated_at DESC,id LIMIT 5000
    ) SELECT f.id,f.scope,f.path,f.updated_at,s.body
    FROM candidates f
    JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version AND v.kind='content'
    LEFT JOIN hx_workspace_file_search s ON s.org_id=f.org_id AND s.file_id=f.id AND s.version=f.current_version
    WHERE f.org_id=?1 AND ${fileScopeAuthority('f.org_id','f.scope','?2')}
      AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)
      AND ${fileTerms}
    ORDER BY f.updated_at DESC,f.id LIMIT ${MAX_RESULTS}`)
    .bind(orgId, String(userId), ...terms).all();
  const workspaceFiles = (fileRows || []).map(row => ({
    id: row.id,
    scope: row.scope,
    path: row.path,
    matchedBy: allMatch(row.path, terms) ? 'name' : 'content',
    source: 'workspace',
    updatedAt: row.updated_at,
  }));

  const attachmentTerms = terms.map((_, i) => `instr(lower(f.name),lower(?${i + 3}))>0`).join(' AND ');
  const { results: attachmentRows } = await db.prepare(`WITH candidates AS (
      SELECT org_id,id,channel,message_id,name,created_at FROM message_files
      WHERE org_id=?1 AND message_id IS NOT NULL ORDER BY created_at DESC,id LIMIT 5000
    ) SELECT f.id,f.channel,f.message_id,f.name,f.created_at,m.parent_id
    FROM candidates f JOIN channel_messages m ON m.org_id=f.org_id AND m.id=f.message_id AND m.channel=f.channel
    WHERE m.org_id=?1 AND ${VISIBLE} AND m.deleted_at IS NULL
      AND (m.parent_id IS NULL OR EXISTS(SELECT 1 FROM channel_messages parent WHERE parent.org_id=m.org_id AND parent.channel=m.channel AND parent.id=m.parent_id AND parent.deleted_at IS NULL))
      AND ${attachmentTerms}
    ORDER BY f.created_at DESC,f.id LIMIT ${MAX_RESULTS * 2}`)
    .bind(orgId, login, ...terms).all();
  const access = await accessFor(db, orgId, login);
  const attachments = [];
  for (const row of attachmentRows || []) {
    const view = viewOf(row.channel, login, members, access);
    if (!view) continue;
    attachments.push({ id: row.id, name: row.name, view, messageId: row.message_id, parentId: row.parent_id || null,
      matchedBy: 'name', source: 'attachment', updatedAt: row.created_at });
    if (attachments.length >= MAX_RESULTS) break;
  }
  const files = [...workspaceFiles, ...attachments].sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_RESULTS);

  const recordTerms = terms.map((_, i) => `instr(lower(r.data),lower(?${i + 3}))>0`).join(' AND ');
  const { results: recordRows } = await db.prepare(`WITH candidates AS (
      SELECT id,table_id,org_id,data,updated_at FROM hx_rows WHERE org_id=?1 ORDER BY updated_at DESC,id LIMIT 5000
    ) SELECT r.id AS rowId,r.table_id AS tableId,r.data,t.name AS tableName,
      (SELECT a.id FROM hx_apps a WHERE a.org_id=r.org_id AND a.table_id=r.table_id
       UNION ALL SELECT e.app_id FROM hx_app_entities e WHERE e.org_id=r.org_id AND e.table_id=r.table_id LIMIT 1) AS appId
    FROM candidates r JOIN hx_tables t ON t.org_id=r.org_id AND t.id=r.table_id
    WHERE r.org_id=?1 AND ${recordTerms}
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=r.org_id AND m.user_github_id=?2 AND m.role!='guest')
      AND NOT EXISTS(SELECT 1 FROM hx_apps linked LEFT JOIN hx_app_access policy
        ON policy.org_id=linked.org_id AND policy.app_id=linked.id
        WHERE linked.org_id=r.org_id AND (linked.table_id=r.table_id OR EXISTS(
          SELECT 1 FROM hx_app_entities e WHERE e.org_id=linked.org_id AND e.app_id=linked.id AND e.table_id=r.table_id))
          AND COALESCE(policy.visibility,'workspace')!='workspace' AND linked.created_by IS NOT ?2)
      AND NOT EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=r.org_id AND e.table_id=r.table_id
        AND NOT EXISTS(SELECT 1 FROM hx_apps linked WHERE linked.org_id=e.org_id AND linked.id=e.app_id))
    ORDER BY r.updated_at DESC,r.id LIMIT ${MAX_RESULTS * 2}`)
    .bind(orgId, String(userId), ...terms).all();
  const records = [];
  for (const row of recordRows || []) {
    // The SQL applies the same linked-App visibility rule as mayUseTable;
    // recheck live authorization before returning a result after the query.
    if (!await mayUseTable(db, orgId, row.tableId, userId)) continue;
    records.push({ rowId: row.rowId, tableId: row.tableId, tableName: row.tableName, appId: row.appId || null });
    if (records.length >= MAX_RESULTS) break;
  }

  const workflows = await listWorkflows(db, orgId, { viewerId: String(userId) });
  const automations = workflows.filter(workflow => allMatch(workflow.name, terms)).slice(0, MAX_RESULTS)
    .map(workflow => ({ id: workflow.id, name: workflow.name, enabled: Boolean(workflow.enabled), triggerType: workflow.trigger?.type || 'manual' }));

  return { messages: messageResult.messages, files, records, automations };
}

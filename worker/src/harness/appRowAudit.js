import { audit } from '../audit.js';

const ACTIONS = {
  create: 'app.record_created',
  update: 'app.record_updated',
  delete: 'app.record_deleted',
};

function fieldIds(action, before, after) {
  const oldValues = before?.values && typeof before.values === 'object' ? before.values : {};
  const newValues = after?.values && typeof after.values === 'object' ? after.values : {};
  if (action === 'create') return Object.keys(newValues).sort().slice(0, 40);
  if (action === 'delete') return Object.keys(oldValues).sort().slice(0, 40);
  return [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])]
    .filter(id => JSON.stringify(oldValues[id]) !== JSON.stringify(newValues[id]))
    .sort().slice(0, 40);
}

// Record App row changes in the workspace's existing hash-chained audit log.
// Values never enter that log; only stable column IDs and row versions do.
export async function auditAppRowChange(env, request, {
  orgId, tableId, table, rowId, action, actor, before = null, after = null, source = 'app',
}) {
  const auditAction = ACTIONS[action];
  if (!auditAction || !env?.DB || !orgId || !tableId || !rowId) return null;
  let linked;
  try {
    linked = await env.DB.prepare(`SELECT 1 AS linked FROM hx_apps a WHERE a.org_id=?1 AND a.table_id=?2
      UNION ALL SELECT 1 FROM hx_app_entities e JOIN hx_apps a ON a.org_id=e.org_id AND a.id=e.app_id
      WHERE e.org_id=?1 AND e.table_id=?2 LIMIT 1`).bind(orgId, tableId).first();
  } catch {
    return null;
  }
  if (!linked) return null;
  const allowedSource = ['app', 'external_app', 'mcp', 'workflow'].includes(source) ? source : 'app';
  return audit(env, request, {
    orgId,
    action: auditAction,
    actor: actor || { type: 'system' },
    entity: { type: 'table', id: String(tableId), ...(table?.name ? { name: String(table.name).slice(0, 120) } : {}) },
    details: {
      tableId: String(tableId),
      rowId: String(rowId),
      fieldIds: fieldIds(action, before, after),
      source: allowedSource,
      ...(before?.updatedAt ? { previousVersion: before.updatedAt } : {}),
      ...(after?.updatedAt ? { version: after.updatedAt } : {}),
    },
  });
}

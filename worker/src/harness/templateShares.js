import { createApp } from './apps.js';

const now = () => new Date().toISOString();
const newId = () => `tshare_${crypto.randomUUID().replaceAll('-', '')}`;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const validToken = value => typeof value === 'string' && /^tpl_[a-f0-9]{64}$/.test(value);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

function sanitizedSnapshot(source, version) {
  const columns = (Array.isArray(source?.columns) ? source.columns : []).slice(0, 40).map(column => ({
    id: String(column?.id || ''),
    name: String(column?.name || '').slice(0, 60),
    // A relation points into live app data. Preserve the label as a plain
    // field, never a foreign key into the source app.
    type: column?.type === 'relation' ? 'text' : String(column?.type || 'text'),
    ...(column?.type === 'select' ? { options: (Array.isArray(column.options) ? column.options : []).map(option => String(option).slice(0, 40)).slice(0, 30) } : {}),
  })).filter(column => column.name);
  const byId = new Map(columns.map(column => [column.id, column.name]));
  const relationIds = new Set((source?.columns || []).filter(column => column?.type === 'relation').map(column => column.id));
  const ref = key => byId.get(String(key)) || null;
  const views = (Array.isArray(source?.views) ? source.views : []).slice(0, 12).map(view => {
    const out = { type: view?.type, name: String(view?.name || view?.type || 'View').slice(0, 40) };
    if (view?.type === 'board') {
      const groupBy = relationIds.has(view.groupBy) ? null : ref(view.groupBy);
      if (groupBy) out.groupBy = groupBy;
    }
    if (view?.type === 'table') {
      const groupBy = relationIds.has(view.groupBy) ? null : ref(view.groupBy);
      if (groupBy) out.groupBy = groupBy;
    }
    if (view?.sort) {
      const desc = String(view.sort).startsWith('-');
      const column = String(view.sort).replace(/^-/, '');
      const name = ref(column);
      if (name && !relationIds.has(column)) out.sort = `${desc ? '-' : ''}${name}`;
    }
    if (view?.type === 'calendar' && ref(view.dateColumn)) out.dateColumn = ref(view.dateColumn);
    if (view?.type === 'metrics') {
      out.metrics = (Array.isArray(view.metrics) ? view.metrics : []).slice(0, 8).map(metric => {
        const result = { label: String(metric?.label || metric?.op || 'Count').slice(0, 40), op: metric?.op };
        if (metric?.column && ref(metric.column) && !relationIds.has(metric.column)) result.column = ref(metric.column);
        if (metric?.overdue && ref(metric.overdue) && !relationIds.has(metric.overdue)) result.overdue = ref(metric.overdue);
        return result;
      });
    }
    return out;
  }).filter(view => ['table', 'board', 'metrics', 'calendar'].includes(view.type));
  return {
    format: 1,
    app: {
      name: String(source?.name || 'Untitled app').slice(0, 80),
      // Descriptions are free-form text and may contain project details.
      // They are intentionally omitted from a portable template.
      description: '',
      icon: String(source?.icon || '📋').slice(0, 8),
    },
    version,
    tableName: String(source?.tableName || source?.name || 'Records').slice(0, 80),
    columns,
    definition: { views },
  };
}

export async function createTemplateShare(db, orgId, app, { version, expiresInDays = 7 } = {}, by) {
  const pinnedVersion = Number(version);
  if (!Number.isSafeInteger(pinnedVersion) || pinnedVersion < 1 || pinnedVersion > app.version) return { error: 'Choose an existing app version.', status: 400 };
  const days = Number(expiresInDays);
  if (![1, 7, 30, 90].includes(days)) return { error: 'Choose an expiry of 1, 7, 30 or 90 days.', status: 400 };
  const row = await db.prepare('SELECT definition FROM hx_app_versions WHERE org_id=?1 AND app_id=?2 AND version=?3').bind(orgId, app.id, pinnedVersion).first();
  if (!row) return { error: 'No such app version.', status: 404 };
  const source = parse(row.definition, null);
  if (!source || !Array.isArray(source.columns) || !source.columns.length) return { error: 'This version has no reusable table definition.', status: 409 };
  const active = await db.prepare(`SELECT COUNT(*) AS count FROM hx_template_shares
    WHERE org_id=?1 AND app_id=?2 AND revoked_at IS NULL AND expires_at>?3`).bind(orgId, app.id, now()).first();
  if (Number(active?.count || 0) >= 50) return { error: 'This app already has 50 active template links.', status: 409 };
  const token = `tpl_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const id = newId();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const snapshot = sanitizedSnapshot(source, pinnedVersion);
  await db.prepare(`INSERT INTO hx_template_shares
    (id, token_hash, org_id, app_id, app_version, snapshot, created_by, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
    .bind(id, await digest(token), orgId, app.id, pinnedVersion, JSON.stringify(snapshot), String(by), createdAt, expiresAt).run();
  return { share: { id, appVersion: pinnedVersion, createdAt, expiresAt, revokedAt: null }, token };
}

export async function listTemplateShares(db, orgId, appId) {
  const { results = [] } = await db.prepare(`SELECT id, app_version AS appVersion, created_at AS createdAt,
    expires_at AS expiresAt, revoked_at AS revokedAt FROM hx_template_shares
    WHERE org_id=?1 AND app_id=?2 ORDER BY created_at DESC LIMIT 50`).bind(orgId, appId).all();
  return { shares: results };
}

export async function revokeTemplateShare(db, orgId, appId, shareId) {
  const at = now();
  const result = await db.prepare(`UPDATE hx_template_shares SET revoked_at=?1
    WHERE id=?2 AND org_id=?3 AND app_id=?4 AND revoked_at IS NULL`).bind(at, shareId, orgId, appId).run();
  if (!result.meta?.changes) return { error: 'No active template link was found.', status: 404 };
  return { revoked: true, revokedAt: at };
}

async function readShareRow(db, token) {
  if (!validToken(token)) return null;
  const row = await db.prepare(`SELECT snapshot, expires_at AS expiresAt, revoked_at AS revokedAt
    FROM hx_template_shares WHERE token_hash=?1`).bind(await digest(token)).first();
  if (!row || row.revokedAt || row.expiresAt <= now()) return null;
  const snapshot = parse(row.snapshot, null);
  if (!snapshot || snapshot.format !== 1 || !Array.isArray(snapshot.columns)) return null;
  return { snapshot, expiresAt: row.expiresAt };
}

export async function readTemplateShare(db, token) {
  const result = await readShareRow(db, token);
  if (!result) return { error: 'This template link is unavailable.', status: 404 };
  return result;
}

export async function importTemplateShare(db, token, { orgId, by, name } = {}) {
  const result = await readShareRow(db, token);
  if (!result) return { error: 'This template link is unavailable.', status: 404 };
  const { snapshot } = result;
  const appName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : snapshot.app.name;
  const made = await createApp(db, {
    orgId, by, name: appName, tableName: snapshot.tableName,
    description: snapshot.app.description, icon: snapshot.app.icon,
    columns: snapshot.columns.map(({ name: columnName, type, options }) => ({ name: columnName, type, ...(options ? { options } : {}) })),
    definition: snapshot.definition, template: 'shared', sample: [],
  });
  return made.error ? made : { app: made.app, sourceVersion: snapshot.version, expiresAt: result.expiresAt };
}

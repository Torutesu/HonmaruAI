import { explicitlyDeniedAppMember } from './resourceAccess.js';
import { renderApp } from './apps.js';

const tokenHash = async token => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join('');
const now = () => new Date().toISOString();
const validToken = token => typeof token === 'string' && /^app_[a-f0-9]{64}$/.test(token);
const customSource = app => {
  const custom = app?.definition?.custom;
  if (!custom || typeof custom.published !== 'string' || !custom.published.trim()) return null;
  if (custom.publishedCommit || custom.publishedCommitApprovalId) return null;
  return custom.published;
};

export async function createAppShare(db, orgId, app, by, input, access) {
  if (!customSource(app)) return { error: 'Anyone links are available only for a published inline Custom App.', status: 409 };
  if (input.confirmDataExposure !== true) return { error: 'Confirm that anyone with this link can read the app and its current records.', status: 400 };
  if (!Number.isSafeInteger(input.version) || input.version !== app.version || !Number.isSafeInteger(input.accessVersion) || input.accessVersion !== access?.version) return { error: 'The app audience changed. Reload before creating a link.', status: 409 };
  const days = Number(input.expiresInDays ?? 7);
  if (![1, 7, 30, 90].includes(days)) return { error: 'Choose an expiry of 1, 7, 30 or 90 days.' };
  const active = await db.prepare("SELECT COUNT(*) AS count FROM hx_app_public_shares WHERE org_id=?1 AND app_id=?2 AND revoked_at IS NULL AND expires_at>?3").bind(orgId, app.id, now()).first();
  if (Number(active?.count || 0) >= 20) return { error: 'This app already has 20 active anyone links.', status: 409 };
  const token = `app_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const id = `apshare_${crypto.randomUUID().replaceAll('-', '')}`;
  const createdAt = now(), expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const inserted = await db.prepare(`INSERT INTO hx_app_public_shares
    (id,token_hash,org_id,app_id,app_version,access_version,created_by,created_at,expires_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
    WHERE EXISTS(SELECT 1 FROM hx_apps WHERE org_id=?3 AND id=?4 AND version=?5
      AND json_extract(definition,'$.custom.published') IS NOT NULL
      AND json_extract(definition,'$.custom.publishedCommit') IS NULL)
      AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?3 AND app_id=?4),0)=?6`)
    .bind(id, await tokenHash(token), orgId, app.id, app.version, access.version, String(by), createdAt, expiresAt).run();
  if (!inserted.meta?.changes) return { error: 'The app changed. Reload before creating a link.', status: 409 };
  return { share: { id, appVersion: app.version, createdAt, expiresAt, revokedAt: null }, token };
}

export async function listAppShares(db, orgId, appId) {
  const { results = [] } = await db.prepare(`SELECT id,app_version AS appVersion,access_version AS accessVersion,created_at AS createdAt,
    expires_at AS expiresAt,revoked_at AS revokedAt FROM hx_app_public_shares
    WHERE org_id=?1 AND app_id=?2 ORDER BY created_at DESC LIMIT 50`).bind(orgId, appId).all();
  return { shares: results };
}

export async function revokeAppShare(db, orgId, appId, shareId) {
  const revokedAt = now();
  const out = await db.prepare(`UPDATE hx_app_public_shares SET revoked_at=?1 WHERE org_id=?2 AND app_id=?3 AND id=?4 AND revoked_at IS NULL`).bind(revokedAt, orgId, appId, shareId).run();
  if (!out.meta?.changes) return { error: 'No active anyone link was found.', status: 404 };
  return { revoked: true, revokedAt };
}

// An anyone-link is a separate, read-only bearer grant. It intentionally works
// without a workspace identity, so per-member overrides cannot identify its
// reader; revoke or expire the link to withdraw this independent grant.
export async function readAppShare(db, token, viewerId = null) {
  if (!validToken(token)) return { error: 'This app link is unavailable.', status: 404 };
  const row = await db.prepare(`SELECT s.org_id AS orgId,s.app_id AS appId,s.app_version AS appVersion,
      s.access_version AS accessVersion,s.expires_at AS expiresAt,s.revoked_at AS revokedAt,
      a.name,a.icon,a.version,a.definition,a.table_id AS tableId
    FROM hx_app_public_shares s JOIN hx_apps a ON a.org_id=s.org_id AND a.id=s.app_id
    WHERE s.token_hash=?1`).bind(await tokenHash(token)).first();
  if (!row || row.revokedAt || row.expiresAt <= now() || Number(row.version) !== Number(row.appVersion)) return { error: 'This app link is unavailable.', status: 404 };
  // The bearer token remains public, but an authenticated current workspace
  // member's explicit per-App deny takes precedence over that broader grant.
  if (await explicitlyDeniedAppMember(db,row.orgId,row.appId,viewerId)) return { error: 'This app link is unavailable.', status: 404 };
  const current = await db.prepare('SELECT COALESCE((SELECT version FROM hx_app_access WHERE org_id=?1 AND app_id=?2),0) AS version').bind(row.orgId,row.appId).first();
  if (Number(current?.version || 0) !== Number(row.accessVersion)) return { error: 'This app link is unavailable.', status: 404 };
  let definition;
  try { definition = JSON.parse(row.definition || '{}'); } catch { return { error: 'This app link is unavailable.', status: 404 }; }
  const app = { id: row.appId, orgId: row.orgId, name: row.name, icon: row.icon || '📋', version: row.version, tableId: row.tableId, definition };
  const html = customSource(app);
  if (!html) return { error: 'This app link is unavailable.', status: 404 };
  const rendered = await renderApp(db, row.orgId, row.appId);
  if (rendered.error || Number(rendered.app.version) !== Number(row.appVersion)) return { error: 'This app link is unavailable.', status: 404 };
  // Rendering may take long enough for an owner to revoke the link or change
  // its audience. Recheck the complete fence immediately before returning data.
  const finalFence = await db.prepare(`SELECT s.revoked_at AS revokedAt,s.expires_at AS expiresAt,
      a.version AS appVersion,COALESCE((SELECT version FROM hx_app_access WHERE org_id=s.org_id AND app_id=s.app_id),0) AS accessVersion
    FROM hx_app_public_shares s JOIN hx_apps a ON a.org_id=s.org_id AND a.id=s.app_id
    WHERE s.token_hash=?1`).bind(await tokenHash(token)).first();
  if (!finalFence || finalFence.revokedAt || finalFence.expiresAt <= now()
      || Number(finalFence.appVersion) !== Number(row.appVersion)
      || Number(finalFence.accessVersion) !== Number(row.accessVersion)) return { error: 'This app link is unavailable.', status: 404 };
  return { share: { expiresAt: row.expiresAt }, app: { id: row.appId, name: row.name, icon: row.icon || '📋', version: Number(row.version) }, html, table: rendered.table, rows: rendered.rows.slice(0, 500) };
}

import { renderApp, normalizeDefinition, computeView } from './apps.js';
import { mayUseApp } from './resourceAccess.js';

import { SYSTEM_COLUMN_IDS } from './systemColumns.js';

export function normalizeLayout(raw, columns) {
  const ids = [...columns.map(c => c.id), ...SYSTEM_COLUMN_IDS];
  const order = [...new Set((Array.isArray(raw?.order) ? raw.order : []).filter(id => ids.includes(id)))];
  const widths = Object.fromEntries(ids.filter(id => Number.isFinite(raw?.widths?.[id])).map(id => [id, Math.max(80, Math.min(600, Math.round(raw.widths[id])))]));
  const hidden = [...new Set([...(Array.isArray(raw?.hidden) ? raw.hidden : []), ...SYSTEM_COLUMN_IDS.filter(id => !order.includes(id))])].filter(id => ids.includes(id) && id !== columns[0]?.id);
  return { order: [...order, ...ids.filter(id => !order.includes(id))], widths, hidden, ...(raw?.wrapText === true ? {wrapText:true} : {}) };
}
export async function personalViews(db, orgId, userId, appId, input) {
  if (!(await mayUseApp(db, orgId, appId, userId))) return { error: 'No such app.', status: 404 };
  const rendered = await renderApp(db, orgId, appId);
  if (rendered.error) return rendered;
  const record = await db.prepare('SELECT revision, settings FROM hx_personal_views WHERE org_id=? AND user_id=? AND app_id=?').bind(orgId, String(userId), appId).first();
  const revision = record?.revision || 0;
  let settings = record ? JSON.parse(record.settings) : { views: [], layouts: {} };
  const normalize = value => {
    const views = (value.views || []).map(v => normalizeDefinition({ views: [v] }, rendered.table.columns).views[0]).map((v,i) => ({...v,id:value.views[i].id}));
    const valid = [...rendered.app.definition.views, ...views].map(v => v.id);
    return { views, activeView: valid.includes(value.activeView) ? value.activeView : rendered.app.definition.views[0].id, layouts: Object.fromEntries(Object.entries(value.layouts || {}).filter(([id]) => valid.includes(id)).map(([id,layout]) => [id,normalizeLayout(layout,rendered.table.columns)])) };
  };
  if (input) {
    if (input.expectedRevision !== revision) return { error: '別の端末で更新されています。再読み込みしてください。', status: 409 };
    if (!Array.isArray(input.views) || input.views.length > 12 || input.views.some(v => !v || !/^personal_[a-zA-Z0-9_-]{1,23}$/.test(v.id) || !['table','board','calendar','metrics'].includes(v.type) || typeof v.name !== 'string' || !v.name.trim()) || new Set(input.views.map(v=>v.id)).size !== input.views.length || !input.layouts || typeof input.layouts !== 'object' || Array.isArray(input.layouts) || JSON.stringify(input).length > 50000) return {error:'Invalid personal views.',status:400};
    const existing=new Set((settings.views||[]).map(v=>v.id));
    const shared=new Set(rendered.app.definition.views.map(v=>v.id));
    if(input.views.some(v=>shared.has(v.id)&&!existing.has(v.id)))return {error:'ビューが変更されました。再読み込みしてください。',status:409};
    settings = normalize(input);
    const result = revision === 0
      ? await db.prepare('INSERT OR IGNORE INTO hx_personal_views (org_id,user_id,app_id,revision,settings) SELECT ?1,?2,?3,1,?4 WHERE EXISTS(SELECT 1 FROM hx_apps WHERE org_id=?1 AND id=?3 AND version=?5)').bind(orgId,String(userId),appId,JSON.stringify(settings),rendered.app.version).run()
      : await db.prepare('UPDATE hx_personal_views SET settings=?1,revision=revision+1 WHERE org_id=?2 AND user_id=?3 AND app_id=?4 AND revision=?5 AND EXISTS(SELECT 1 FROM hx_apps WHERE org_id=?2 AND id=?4 AND version=?6)').bind(JSON.stringify(settings),orgId,String(userId),appId,revision,rendered.app.version).run();
    if (!result.meta.changes) return {error:'別の端末で更新されています。再読み込みしてください。',status:409};
  }
  settings = normalize(settings);
  return {...settings, revision:revision+(input?1:0), computed:settings.views.map(v=>computeView(v,rendered.table,rendered.rows))};
}

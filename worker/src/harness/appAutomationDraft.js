import {normalizeAppAutomations,validateAutomationAppScope} from './appAutomationDefinition.js';

const empty = () => ({version:1,items:[]});
export async function readAutomationDraft(db,orgId,appId) {
  const row = await db.prepare('SELECT revision,draft,published,release_id,published_at FROM hx_app_automation_state WHERE org_id=?1 AND app_id=?2').bind(orgId,appId).first();
  return row ? {revision:row.revision,draft:JSON.parse(row.draft),published:row.published ? JSON.parse(row.published) : null,releaseId:row.release_id,publishedAt:row.published_at} : {revision:0,draft:empty(),published:null,releaseId:null,publishedAt:null};
}

// Call after app visibility/edit checks. Draft edits never instantiate a
// workflow or change the current published declaration. Both app and draft
// revisions are checked in the same write, including first-save races.
export async function saveAutomationDraft(db,orgId,app,input,by) {
  if (!Number.isSafeInteger(input?.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(input.version) || input.version !== app.version) return {error:'This app or automation draft changed. Reload before saving.',status:409};
  const normalized=normalizeAppAutomations(input.automations);
  if(normalized.error)return normalized;
  const scope=await validateAutomationAppScope(db,orgId,app.id,normalized.automations);
  if(scope)return scope;
  const row=await db.prepare(`INSERT INTO hx_app_automation_state(org_id,app_id,revision,draft,updated_at,updated_by)
    SELECT ?1,?2,?3+1,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM hx_apps WHERE org_id=?1 AND id=?2 AND version=?7)
      AND ((?3=0 AND NOT EXISTS(SELECT 1 FROM hx_app_automation_state WHERE org_id=?1 AND app_id=?2))
        OR EXISTS(SELECT 1 FROM hx_app_automation_state WHERE org_id=?1 AND app_id=?2 AND revision=?3))
    ON CONFLICT(org_id,app_id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft,updated_at=excluded.updated_at,updated_by=excluded.updated_by
      WHERE hx_app_automation_state.revision=?3
    RETURNING revision`).bind(orgId,app.id,input.revision,JSON.stringify(normalized.automations),new Date().toISOString(),String(by),input.version).first();
  return row ? {saved:true,revision:row.revision} : {error:'This app or automation draft changed. Reload before saving.',status:409};
}

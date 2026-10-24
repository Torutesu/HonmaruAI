import {allowed} from '../permissions.js';
import {readAutomationPlan} from './appAutomationPlan.js';
import {automationDefinition,sameAutomation} from './appAutomationDefinition.js';
import {mayViewWorkflow,unknownApprover,MAX_WORKFLOWS} from './workflows.js';
import {mayUseApp} from './resourceAccess.js';
import {nextRunAt} from '../schedule.js';
import {getTable} from './tables.js';

const conflict=()=>({error:'The app, draft or live automations changed. Review the plan again.',status:409});
const receipt=row=>({saved:true,releaseId:row.release_id,revision:row.revision,version:row.app_version});
const secret=()=>[...crypto.getRandomValues(new Uint8Array(24))].map(value=>value.toString(16).padStart(2,'0')).join('');

// Internal lifecycle primitive. Do not expose publication until every run
// entry point and app unpublish/delete path enforces managed ownership.
export async function releaseAppAutomations(db,orgId,app,input,by) {
  if(!await mayUseApp(db,orgId,app.id,by))return {error:'No such app.',status:404};
  const manageOthers=await allowed(db,orgId,String(by),'harness.delete_others');
  if(app.createdBy!==String(by) && !manageOthers)return {error:'App editor access required.',status:403};
  if(!['publish','unpublish'].includes(input.action) || typeof input.requestId!=='string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId))return {error:'A release needs an action and unique request ID.',status:400};
  if(!Number.isSafeInteger(input.revision) || input.revision<1 || input.revision>=Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(input.version))return conflict();
  const request=JSON.stringify({action:input.action,revision:input.revision,version:input.version,by:String(by)});
  const prior=await db.prepare('SELECT request,release_id,revision,app_version FROM hx_app_automation_releases WHERE org_id=?1 AND app_id=?2 AND request_id=?3').bind(orgId,app.id,input.requestId).first();
  if(prior)return prior.request===request?{...receipt(prior),replay:true}:conflict();
  if(input.version!==app.version)return conflict();
  const plan=await readAutomationPlan(db,orgId,app.id,by);
  if(plan.error)return plan;
  if(plan.revision!==input.revision)return conflict();
  if(plan.plan.some(item=>['drifted','missing'].includes(item.status)))return conflict();
  const desired=input.action==='publish'?plan.draft.items:[];
  for(const item of desired) {
    if(!await mayViewWorkflow(db,orgId,item,by))return {error:'An automation references an unavailable resource.',status:403};
    const invalid=await unknownApprover(db,orgId,item.steps);if(invalid)return {...invalid,status:400};
  }
  const {results:bindings}=await db.prepare('SELECT declaration_key,workflow_id,applied FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2 LIMIT 101').bind(orgId,app.id).all();
  if(bindings.length>100)return conflict();
  const snapshots=[];
  for(const binding of bindings) {
    const row=await db.prepare('SELECT id,name,enabled,trigger,steps,created_by FROM hx_workflows WHERE org_id=?1 AND id=?2').bind(orgId,binding.workflow_id).first();
    if(!row)return conflict();
    if(row.created_by!==String(by) && !manageOthers)return {error:'Workflow editor access required.',status:403};
    const current={name:row.name,enabled:Boolean(row.enabled),trigger:JSON.parse(row.trigger),steps:JSON.parse(row.steps)};
    const observed=plan.plan.find(item=>item.workflowId===row.id)?.live;
    if(!sameAutomation(current,observed))return conflict();
    snapshots.push(row);
  }
  const byKey=new Map(bindings.map(binding=>[binding.declaration_key,binding]));
  const added=desired.filter(item=>!byKey.has(item.key)).length;
  const at=new Date().toISOString(),releaseId=crypto.randomUUID(),revision=plan.revision+1,version=app.version+1;
  const published=input.action==='publish'?JSON.stringify(plan.draft):null;
  const table=await getTable(db,orgId,app.tableId);if(!table)return conflict();
  const guard='EXISTS(SELECT 1 FROM hx_app_automation_state WHERE org_id=?1 AND app_id=?2 AND release_id=?3)';
  const statements=[db.prepare(`UPDATE hx_app_automation_state SET published=?4,release_id=?5,published_at=?6,revision=revision+1,updated_at=?6,updated_by=?7
    WHERE org_id=?1 AND app_id=?2 AND revision=?3
      AND EXISTS(SELECT 1 FROM hx_apps WHERE org_id=?1 AND id=?2 AND version=?8)
      AND EXISTS(SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?7 AND role!='guest')
      AND (SELECT COUNT(*) FROM hx_workflows WHERE org_id=?1)+?10<=?11
      AND NOT EXISTS(SELECT 1 FROM json_each(?9) snapshot LEFT JOIN hx_workflows w ON w.org_id=?1 AND w.id=json_extract(snapshot.value,'$.id')
        WHERE w.id IS NULL OR w.name!=json_extract(snapshot.value,'$.name') OR w.enabled!=json_extract(snapshot.value,'$.enabled')
          OR w.trigger!=json_extract(snapshot.value,'$.trigger') OR w.steps!=json_extract(snapshot.value,'$.steps') OR w.created_by!=json_extract(snapshot.value,'$.created_by'))`)
    .bind(orgId,app.id,plan.revision,published,releaseId,at,String(by),app.version,JSON.stringify(snapshots),added,MAX_WORKFLOWS)];
  statements.push(db.prepare(`UPDATE hx_apps SET version=?4,updated_at=?5 WHERE org_id=?1 AND id=?2 AND ${guard}`).bind(orgId,app.id,releaseId,version,at));
  statements.push(db.prepare(`INSERT INTO hx_app_versions(app_id,org_id,version,definition,note,created_by,created_at)
    SELECT ?2,?1,?4,?5,?6,?7,?8 WHERE ${guard}`).bind(orgId,app.id,releaseId,version,JSON.stringify({name:app.name,columns:table.columns,...app.definition,automationRelease:releaseId}),'Automations: '+input.action,String(by),at));
  for(const item of desired) {
    const binding=byKey.get(item.key),id=binding?.workflow_id || `wf_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
    const next=item.enabled && item.trigger.type==='schedule'?nextRunAt(item.trigger):null;
    if(binding) {
      const candidate=item.trigger.type==='webhook'?secret():null;
      const applied=JSON.parse(binding.applied);
      const sameSchedule=sameAutomation({name:'',steps:[],enabled:item.enabled,trigger:item.trigger},{name:'',steps:[],enabled:applied.enabled,trigger:applied.trigger});
      statements.push(db.prepare(`UPDATE hx_workflows SET name=?5,enabled=?6,trigger=?7,steps=?8,next_run_at=CASE WHEN ?12=1 THEN next_run_at ELSE ?9 END,updated_at=?10,
        hook_secret=CASE WHEN ?11 IS NULL THEN NULL WHEN json_extract(trigger,'$.type')='webhook' THEN hook_secret ELSE ?11 END
        WHERE org_id=?1 AND id=?4 AND ${guard}`).bind(orgId,app.id,releaseId,id,item.name,item.enabled?1:0,JSON.stringify(item.trigger),JSON.stringify(item.steps),next,at,candidate,sameSchedule?1:0));
    } else {
      statements.push(db.prepare(`INSERT INTO hx_workflows(id,org_id,name,enabled,trigger,steps,hook_secret,next_run_at,created_by,created_at,updated_at)
        SELECT ?4,?1,?5,?6,?7,?8,?9,?10,?11,?12,?12 WHERE ${guard}`).bind(orgId,app.id,releaseId,id,item.name,item.enabled?1:0,JSON.stringify(item.trigger),JSON.stringify(item.steps),item.trigger.type==='webhook'?secret():null,next,String(by),at));
    }
    statements.push(db.prepare(`INSERT INTO hx_app_automation_bindings(org_id,app_id,declaration_key,workflow_id,applied,release_id)
      SELECT ?1,?2,?4,?5,?6,?3 WHERE ${guard}
      ON CONFLICT(org_id,app_id,declaration_key) DO UPDATE SET applied=excluded.applied,release_id=excluded.release_id`)
      .bind(orgId,app.id,releaseId,item.key,id,JSON.stringify(automationDefinition(item))));
  }
  for(const binding of bindings.filter(binding=>!desired.some(item=>item.key===binding.declaration_key))) {
    statements.push(db.prepare(`UPDATE hx_workflows SET enabled=0,next_run_at=NULL,updated_at=?5 WHERE org_id=?1 AND id=?4 AND ${guard}`).bind(orgId,app.id,releaseId,binding.workflow_id,at));
    const baseline={...JSON.parse(binding.applied),enabled:false};
    statements.push(db.prepare(`UPDATE hx_app_automation_bindings SET applied=?5,release_id=?3 WHERE org_id=?1 AND app_id=?2 AND declaration_key=?4 AND ${guard}`).bind(orgId,app.id,releaseId,binding.declaration_key,JSON.stringify(baseline)));
  }
  statements.push(db.prepare(`INSERT INTO hx_app_automation_releases(org_id,app_id,request_id,request,release_id,revision,app_version,created_at)
    SELECT ?1,?2,?4,?5,?3,?6,?7,?8 WHERE ${guard}`).bind(orgId,app.id,releaseId,input.requestId,request,revision,version,at));
  const result=await db.batch(statements);
  if(!result[0].meta?.changes) {
    const completed=await db.prepare('SELECT request,release_id,revision,app_version FROM hx_app_automation_releases WHERE org_id=?1 AND app_id=?2 AND request_id=?3').bind(orgId,app.id,input.requestId).first();
    return completed?.request===request?{...receipt(completed),replay:true}:conflict();
  }
  return {saved:true,releaseId,revision,version};
}

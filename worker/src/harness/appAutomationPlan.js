import {readAutomationDraft} from './appAutomationDraft.js';
import {diffAppAutomations,normalizeAppAutomations} from './appAutomationDefinition.js';
import {getWorkflow,mayViewWorkflow} from './workflows.js';

// The route checks app editor rights first. A workflow can drift into a
// private resource independently; do not disclose that new definition to a
// former reader merely because its original binding belonged to their app.
export async function readAutomationPlan(db,orgId,appId,viewerId) {
  const state=await readAutomationDraft(db,orgId,appId);
  const normalized=normalizeAppAutomations(state.draft);
  if(normalized.error)return {error:'The saved automation draft is invalid.',status:409};
  const {results:rows}=await db.prepare('SELECT declaration_key,workflow_id,applied FROM hx_app_automation_bindings WHERE org_id=?1 AND app_id=?2 LIMIT 101').bind(orgId,appId).all();
  if(rows.length>100)return {error:'Too many automation bindings to reconcile.',status:409};
  const bindings=[],workflows=[];
  const relevant=new Set([...state.draft.items,...(state.published?.items || [])].map(item=>item.key));
  for(const row of rows) {
    if(!relevant.has(row.declaration_key))continue;
    const workflow=await getWorkflow(db,orgId,row.workflow_id);
    if(workflow && !await mayViewWorkflow(db,orgId,workflow,viewerId))return {error:'A linked automation is no longer accessible.',status:403};
    let applied;
    try {applied=JSON.parse(row.applied);} catch {return {error:'The saved automation binding is invalid.',status:409};}
    bindings.push({key:row.declaration_key,workflowId:row.workflow_id,applied});
    if(workflow)workflows.push(workflow);
  }
  return {...state,plan:diffAppAutomations({draft:normalized.automations,published:state.published,bindings,workflows})};
}

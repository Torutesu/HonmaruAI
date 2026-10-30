import {getWorkflow,mayViewWorkflow,updateWorkflow} from './workflows.js';

// Every stored version is filtered by its own current resource permissions.
// Being able to see today's public definition does not grant its private past.
export async function workflowRevisions(db,orgId,workflowId,viewerId,{before}={}) {
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))return {error:'Invalid workflow revision cursor.',status:400};
 if(!await getWorkflow(db,orgId,workflowId,{viewerId}))return {error:'No such workflow.',status:404};
 const {results}=await db.prepare(`SELECT revision,definition,recorded_at FROM hx_workflow_revisions
 WHERE org_id=?1 AND workflow_id=?2 AND (?3 IS NULL OR revision<?3) ORDER BY revision DESC LIMIT 21`).bind(orgId,workflowId,before??null).all();
 const page=results.slice(0,20),items=[];
 for(const row of page){
  const definition=JSON.parse(row.definition);
  if(await mayViewWorkflow(db,orgId,{...definition,id:workflowId},viewerId))items.push({revision:row.revision,recordedAt:row.recorded_at,definition:{...definition,enabled:Boolean(definition.enabled)}});
 }
 return {items,nextCursor:results.length>20?page.at(-1).revision:null};
}

// Restoring an old definition is a normal edit that appends a new immutable
// revision. Runs already admitted keep the definition they started with.
export async function restoreWorkflowRevision(db,orgId,workflowId,viewerId,input={}) {
 const revision=input.revision;
 if(!Number.isSafeInteger(revision)||revision<1||typeof input.expectedUpdatedAt!=='string'||!input.expectedUpdatedAt)
  return {error:'Choose a workflow revision and reload before restoring it.',status:400};
 const current=await getWorkflow(db,orgId,workflowId,{viewerId});
 if(!current)return {error:'No such workflow.',status:404};
 if(current.updatedAt!==input.expectedUpdatedAt)return {error:'The workflow changed. Reload it before restoring a revision.',status:409};
 const prior=await db.prepare(`SELECT definition FROM hx_workflow_revisions WHERE org_id=?1 AND workflow_id=?2 AND revision=?3`)
  .bind(orgId,workflowId,revision).first();
 if(!prior)return {error:'No such workflow revision.',status:404};
 let definition;
 try{definition=JSON.parse(prior.definition)}catch{return {error:'This workflow revision cannot be read.',status:409};}
 if(definition&&[0,1].includes(definition.enabled))definition.enabled=Boolean(definition.enabled);
 if(!definition||typeof definition.name!=='string'||typeof definition.enabled!=='boolean'||!definition.trigger||!Array.isArray(definition.steps)||
   !await mayViewWorkflow(db,orgId,{...definition,id:workflowId},viewerId))return {error:'No such workflow revision.',status:404};
 if(definition.name===current.name&&definition.enabled===current.enabled&&JSON.stringify(definition.trigger)===JSON.stringify(current.trigger)&&JSON.stringify(definition.steps)===JSON.stringify(current.steps))
  return {error:'That revision already matches the current workflow definition.',status:409};
 if(current.safety?.paused_at&&definition.enabled&&input.confirmAutoPaused!==true)
  return {error:'Confirm restoring automatic triggers. The workflow will remain safety-paused until you resume it separately.',status:409};
 const restored=await updateWorkflow(db,orgId,workflowId,{
  name:definition.name,enabled:definition.enabled,trigger:definition.trigger,steps:definition.steps,
  expectedUpdatedAt:current.updatedAt,
 },viewerId);
 if(restored.error)return restored;
 return {workflow:restored.workflow,restoredRevision:revision,revision:restored.revision,safetyPaused:Boolean(current.safety?.paused_at)};
}

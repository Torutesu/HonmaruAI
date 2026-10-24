import {getWorkflow,mayViewWorkflow} from './workflows.js';

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

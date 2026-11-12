import {readWorkflowState,saveWorkflowState} from './workflowState.js';
import {activationScope} from './workflowActivationGuard.js';
import {queryWorkflowTablePage} from './workflowTableQuery.js';
import {workflowProgramSources} from './workflowProgramSources.js';
import {mayEditApp,mayEditTable} from './resourceAccess.js';

// Node authentication must supply gatewayId. Request bodies never supply run,
// checkpoint owner, attempt or workspace identity; the private binding does.
export async function workflowActivationState(db,activation,method,params,at=Date.now()) {
 activationScope(activation);
 if(!activation)throw Error('An authenticated activation is required.');
 const keys=method==='state.get'?['view','includeCurrentRun']:method==='state.set'?['state','expectedRevision','schemaVersion','businessDate','validationStatus','validationErrors']:method==='table.query'?['where','q','pageSize','cursor','entityId']:method==='table.insert'?['entityId','values']:null;
 if(!keys||!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>!keys.includes(key)))return {error:'Invalid state operation.',status:400};
 const binding=await db.prepare(`SELECT a.org_id,a.run_id,a.node_id,a.node_owner,a.node_attempt,d.definition,r.workflow_id FROM hx_workflow_activations a
 JOIN hx_gateway_jobs j ON j.org_id=a.org_id AND j.id=a.job_id
 JOIN hx_workflow_runs r ON r.org_id=a.org_id AND r.id=a.run_id
 JOIN hx_workflow_run_definitions d ON d.org_id=a.org_id AND d.run_id=a.run_id
 WHERE a.job_id=?1 AND j.gateway_id=?2 AND j.lease_hash=?3`)
 .bind(activation.jobId,activation.gatewayId,activation.leaseHash).first();
 if(!binding)return {error:'No active workflow execution.',status:409};
 const identity={orgId:binding.org_id,runId:binding.run_id,nodeId:binding.node_id,owner:binding.node_owner,attempt:binding.node_attempt,activation,at};
 if(method==='table.query'||method==='table.insert'){
  const authorized=await readWorkflowState(db,{...identity,view:'committed',includeCurrentRun:false});
  if(authorized.available===false)return {error:'Workflow execution is no longer authorized.',status:409};
  let definition;
  try{definition=JSON.parse(binding.definition)}catch{return {error:'The saved Workflow definition is unavailable.',status:409};}
  const step=definition.steps?.[0];
  const sources=workflowProgramSources(step);
  if(definition.id!==binding.workflow_id||step?.type!=='code'||!step.sourceAppId||!sources.length)return {error:'This program has no explicitly authorized App/Table source.',status:403};
  const entityId=params.entityId??(sources.length===1?sources[0].entityId:null);
  if(typeof entityId!=='string')return {error:'Choose an explicitly authorized App entity.',status:400};
  const source=sources.find(item=>item.entityId===entityId);
  if(!source)return {error:'The workflow source is no longer accessible.',status:404};
  if(method==='table.insert'){
   if(source.write!==true)return {error:'Row creation is not enabled for this App entity.',status:403};
   if(!params.values||typeof params.values!=='object'||Array.isArray(params.values))return {error:'Invalid row values.',status:400};
   if(!(await mayEditApp(db,binding.org_id,step.sourceAppId,definition.createdBy))||!(await mayEditTable(db,binding.org_id,source.tableId,definition.createdBy)))return {error:'The workflow creator no longer has edit access to this App entity.',status:403};
   return {staged:true};
  }
  try{return await queryWorkflowTablePage(db,{orgId:binding.org_id,appId:step.sourceAppId,entityId:source.entityId,tableId:source.tableId,viewerId:definition.createdBy},params,at);}
  catch(error){if(error?.status===400)return {error:'Invalid App/Table query or cursor.',status:400};throw error;}
 }
 // Public SDK writes are final commits unless the caller explicitly selects
 // pending progress. Internal checkpoint helpers retain their own defaults.
 return await (method==='state.get'?readWorkflowState(db,{...identity,...params}):saveWorkflowState(db,{...identity,...params,validationStatus:params.validationStatus===undefined?'passed':params.validationStatus}));
}

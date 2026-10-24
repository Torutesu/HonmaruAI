export class WorkflowStateInputError extends Error {}
import {managedAutomationGuard} from './appAutomationGuard.js';
import {workflowActivationFence,activationScope} from './workflowActivationGuard.js';
// Internal durable-state store. The executor must authorize source/resource
// access before obtaining its checkpoint lease. Never expose these helpers as
// a user-supplied run-ID API: the live lease is an additional write fence only.
const MAX_BYTES=128000;
const sourceTable="COALESCE(json_extract(d.definition,'$.trigger.tableId'),json_extract(r.input,'$.tableId'))";
const sourceTableAuthority=`(${sourceTable} IS NULL OR (EXISTS(SELECT 1 FROM hx_tables t WHERE t.org_id=r.org_id AND t.id=${sourceTable})
 AND NOT EXISTS(SELECT 1 FROM hx_apps app LEFT JOIN hx_app_access access ON access.org_id=app.org_id AND access.app_id=app.id
  WHERE app.org_id=r.org_id AND (app.table_id=${sourceTable} OR EXISTS(SELECT 1 FROM hx_app_entities entity WHERE entity.org_id=r.org_id AND entity.app_id=app.id AND entity.table_id=${sourceTable}))
   AND COALESCE(access.visibility,'workspace')!='workspace' AND app.created_by!=json_extract(d.definition,'$.createdBy'))))`;
// Source access is checked inside the same SQL statement as the lease and CAS.
// Unsourced workflows still require current workspace membership.
export const workflowStateAuthority=`${sourceTableAuthority} AND ${managedAutomationGuard('r.org_id','r.workflow_id',"json_extract(d.definition,'$.automationReleaseId')")} AND (json_type(d.definition,'$.safetyGeneration') IS NULL OR EXISTS(SELECT 1 FROM hx_workflow_safety safety WHERE safety.org_id=r.org_id AND safety.workflow_id=r.workflow_id AND safety.generation=json_extract(d.definition,'$.safetyGeneration') AND safety.paused_at IS NULL)) AND EXISTS(SELECT 1 FROM hx_workflows w
 JOIN memberships m ON m.org_id=w.org_id AND m.user_github_id=w.created_by
 JOIN users u ON u.github_id=w.created_by
 WHERE w.org_id=r.org_id AND w.id=r.workflow_id AND json_extract(d.definition,'$.id')=w.id AND json_extract(d.definition,'$.createdBy')=w.created_by AND lower(m.role) IN ('owner','admin','member')
 AND (NOT EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=w.id)
 OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=w.id
 AND source.created_by=w.created_by AND (
  (substr(source.channel,1,2)='b:' AND EXISTS(SELECT 1 FROM businesses b WHERE b.org_id=r.org_id AND 'b:'||b.slug=source.channel AND b.archived_at IS NULL
    AND (b.private=0 OR EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=r.org_id AND c.channel=source.channel AND c.login=u.login))))
  OR (substr(source.channel,1,2)='g:' AND EXISTS(SELECT 1 FROM conversation_members c WHERE c.org_id=r.org_id AND c.channel=source.channel AND c.login=u.login))
  OR (substr(source.channel,1,3)='dm:' AND EXISTS(SELECT 1 FROM users other JOIN memberships om ON om.user_github_id=other.github_id AND om.org_id=r.org_id
    WHERE other.login!=u.login AND (source.channel='dm:'||u.login||'|'||other.login OR source.channel='dm:'||other.login||'|'||u.login)))
  OR (substr(source.channel,1,3)='ag:' AND EXISTS(SELECT 1 FROM custom_agents a LEFT JOIN hx_agent_profiles p ON p.org_id=a.org_id AND p.agent_id=a.id
    WHERE a.org_id=r.org_id AND source.channel='ag:'||a.id||'|'||u.login AND a.deleted_at IS NULL
    AND (a.scope='team' OR a.owner_login=u.login)
    AND ((a.scope='team' AND a.provider IS NULL AND p.agent_id IS NOT NULL AND EXISTS(SELECT 1 FROM hx_agent_members role WHERE role.org_id=r.org_id AND role.agent_id=a.id AND role.user_id=u.github_id AND role.member_since=m.created_at)) OR p.agent_id IS NULL OR p.access='everyone' OR a.owner_login=u.login
      OR (p.access='people' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.people) THEN p.people ELSE '[]' END) person WHERE person.value=u.login)))))

 ))))`;
export function normalizeWorkflowState(value) {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkflowStateInputError('Workflow state must be a JSON object.');
 let nodes=0;
 const walk=(item,depth)=>{
  if(++nodes>10000||depth>32)throw new WorkflowStateInputError('Workflow state exceeds structural limits.');
  if(item===null||typeof item==='string'||typeof item==='boolean')return;
  if(typeof item==='number'&&Number.isFinite(item))return;
  if(typeof item!=='object'||!item)throw new WorkflowStateInputError('Workflow state contains a non-JSON value.');
  if(!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw new WorkflowStateInputError('Workflow state must contain plain objects.');
  if(Array.isArray(item)&&(Object.keys(item).length!==item.length||Object.keys(item).some((key,index)=>String(index)!==key)))throw new WorkflowStateInputError('Workflow state arrays must be dense JSON arrays.');
  for(const key of Reflect.ownKeys(item)) {
   if(Array.isArray(item)&&key==='length')continue;
   const descriptor=Object.getOwnPropertyDescriptor(item,key);
   if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw new WorkflowStateInputError('Workflow state requires enumerable JSON data properties.');
   if(['__proto__','constructor','prototype'].includes(key))throw new WorkflowStateInputError('Workflow state contains a reserved key.');
   walk(descriptor.value,depth+1);
  }
 };
 walk(value,0);
 const json=JSON.stringify(value);
 if(new TextEncoder().encode(json).length>MAX_BYTES)throw new WorkflowStateInputError('Workflow state exceeds 128 KB.');
 return json;
}
// Source run IDs are provenance, not cascading ownership: trimming execution
// history must not erase accepted business state or reset its revision counter.
// The workflow itself owns the retained versions and cascades their deletion.
// Compare-and-swap covers the workflow's entire state history, not just this
// run. A pending record is separate from a passed business-state commit.
export async function saveWorkflowState(db,{orgId,runId,nodeId,owner,attempt,expectedRevision,state,validationStatus='pending',schemaVersion,businessDate,validationErrors=[],activation,at=Date.now()}) {
 if(![orgId,runId,nodeId,owner].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)||!Number.isSafeInteger(attempt)||attempt<1||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(at)||at<0||!['pending','passed','failed'].includes(validationStatus))throw new WorkflowStateInputError('Invalid workflow state request.');
 for(const value of [schemaVersion,businessDate])if(value!==undefined&&(typeof value!=='string'||!value.trim()||value.length>128))throw new WorkflowStateInputError('Invalid workflow state metadata.');
 if(!Array.isArray(validationErrors))throw new WorkflowStateInputError('Validation errors must be an array of objects.');
 const metadata=normalizeWorkflowState({...(schemaVersion!==undefined?{schemaVersion}:{}),...(businessDate!==undefined?{businessDate}:{}),validationErrors});
 if(JSON.parse(metadata).validationErrors.some(value=>!value||typeof value!=='object'||Array.isArray(value)))throw new WorkflowStateInputError('Validation errors must be an array of objects.');
 if(new TextEncoder().encode(metadata).length>16000)throw new WorkflowStateInputError('Workflow state metadata exceeds 16 KB.');
 const [jobId,gatewayId,leaseHash]=activationScope(activation);
 const json=normalizeWorkflowState(state);
 const contentHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json))),byte=>byte.toString(16).padStart(2,'0')).join('');
 const savedMetadata=JSON.stringify({...JSON.parse(metadata),contentHash});
 const result=await db.prepare(`INSERT INTO hx_workflow_state_versions(org_id,workflow_id,revision,run_id,state,validation_status,created_at,metadata)
 SELECT r.org_id,r.workflow_id,?6+1,r.id,?7,?8,?9,json_set(?10,'$.definitionRevision',json_extract(d.definition,'$.definitionRevision')) FROM hx_workflow_runs r
 JOIN hx_workflow_node_checkpoints c ON c.org_id=r.org_id AND c.run_id=r.id
 JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
 WHERE r.org_id=?1 AND r.id=?2 AND r.status='running' AND ${workflowStateAuthority} AND c.node_id=?3 AND c.owner=?4 AND c.attempt=?5 AND c.status='running' AND c.lease_until>?9
 AND (?11 IS NULL OR ${workflowActivationFence('?11','?12','?13','?9')})
 AND ?6=COALESCE((SELECT MAX(s.revision) FROM hx_workflow_state_versions s WHERE s.org_id=r.org_id AND s.workflow_id=r.workflow_id),0)`)
 .bind(orgId,runId,nodeId,owner,attempt,expectedRevision,json,validationStatus,at,savedMetadata,jobId,gatewayId,leaseHash).run();
 return result.meta?.changes?{saved:true,revision:expectedRevision+1,currentRunId:runId,contentHash}:{saved:false};
}
// Reads derive workflow identity from the active execution, never from an
// arbitrary caller-supplied workflow ID. Transport/source ACLs are still required.
export async function readWorkflowState(db,{orgId,runId,nodeId,owner,attempt,at=Date.now(),view='committed',includeCurrentRun=false,activation}) {
 if(![orgId,runId,nodeId,owner].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)||!Number.isSafeInteger(attempt)||attempt<1||!Number.isSafeInteger(at)||at<0||!['committed','checkpoint'].includes(view)||typeof includeCurrentRun!=='boolean')throw new WorkflowStateInputError('Invalid workflow state read.');
 const [jobId,gatewayId,leaseHash]=activationScope(activation);
 const row=await db.prepare(`WITH active AS (
 SELECT r.workflow_id FROM hx_workflow_runs r JOIN hx_workflow_node_checkpoints c ON c.org_id=r.org_id AND c.run_id=r.id
 JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
 WHERE r.org_id=?1 AND r.id=?2 AND r.status='running' AND ${workflowStateAuthority} AND c.node_id=?3 AND c.owner=?4 AND c.attempt=?5 AND c.status='running' AND c.lease_until>?6 AND (?9 IS NULL OR ${workflowActivationFence('?9','?10','?11','?6')}))
 SELECT COALESCE((SELECT MAX(h.revision) FROM hx_workflow_state_versions h WHERE h.org_id=?1 AND h.workflow_id=a.workflow_id),0) AS head_revision,s.*
 FROM active a LEFT JOIN hx_workflow_state_versions s ON s.org_id=?1 AND s.workflow_id=a.workflow_id
 AND s.revision=(SELECT MAX(v.revision) FROM hx_workflow_state_versions v WHERE v.org_id=?1 AND v.workflow_id=a.workflow_id
 AND (?7='checkpoint' OR (v.validation_status='passed' AND (?8=1 OR v.run_id!=?2))))`)
 .bind(orgId,runId,nodeId,owner,attempt,at,view,includeCurrentRun?1:0,jobId,gatewayId,leaseHash).first();
 if(!row)return {available:false,found:false};
 // Failed progress retires pending progress, not prior accepted business results.
 if(!row.revision||row.validation_status==='failed')return {found:false,revision:row.head_revision};
 return {found:true,revision:row.head_revision,stateRevision:row.revision,sourceRunId:row.run_id,validationStatus:row.validation_status,state:JSON.parse(row.state),currentRunId:runId,metadata:JSON.parse(row.metadata)};
}

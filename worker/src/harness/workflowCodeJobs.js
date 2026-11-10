import {claimWorkflowNode,finishWorkflowNode} from './workflowCheckpoints.js';
import {workflowStateAuthority} from './workflowState.js';
import {allowed} from '../permissions.js';
import {workflowSettlementStatements} from './workflowSafety.js';
import {getMode} from './mode.js';
import {workspaceBudgetAdmission} from '../workspaceAIBudget.js';
import {mayUseApp,mayUseTable} from './resourceAccess.js';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export const WORKFLOW_PROGRAM_TIMEOUT_MS=15*60*1000;
export const WORKFLOW_PROGRAM_RESULT_GRACE_MS=30*1000;

// Evaluated inside claim/heartbeat/finish/expiry SQL, before a node receives
// private workflow input. Ordinary jobs have neither marker nor binding.
export function workflowProgramAccessCTE(at) {
 return `WITH authorized_workflow_runs AS MATERIALIZED (
  SELECT r.org_id,r.id FROM hx_workflow_runs r JOIN hx_workflow_run_definitions d ON d.run_id=r.id AND d.org_id=r.org_id WHERE r.status='running' AND ${workflowStateAuthority}
 ), authorized_program_jobs AS MATERIALIZED (
  SELECT j.id FROM hx_workflow_activations a
  JOIN authorized_workflow_runs authorized ON authorized.org_id=a.org_id AND authorized.id=a.run_id
  JOIN hx_gateway_jobs j ON j.id=a.job_id AND j.org_id=a.org_id
  JOIN hx_workflow_runs r ON r.id=a.run_id AND r.org_id=a.org_id
  JOIN hx_workflow_run_definitions d ON d.run_id=r.id AND d.org_id=r.org_id
  JOIN hx_workflow_node_checkpoints c ON c.org_id=a.org_id AND c.run_id=a.run_id AND c.node_id=a.node_id
  WHERE r.status='running' AND c.owner=a.node_owner AND c.attempt=a.node_attempt AND c.status='running' AND c.lease_until>${at}
   AND j.created_by=json_extract(d.definition,'$.createdBy')
   AND (json_extract(j.payload,'$.context.roomId') IS NULL OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=r.workflow_id AND source.channel=json_extract(j.payload,'$.context.roomId')))
 )`;
}
export const workflowProgramJobAccess=`((COALESCE(json_extract(hx_gateway_jobs.payload,'$.workflowProgram'),0)!=1 AND NOT EXISTS(SELECT 1 FROM hx_workflow_activations marker WHERE marker.job_id=hx_gateway_jobs.id)) OR id IN (SELECT id FROM authorized_program_jobs))`;

// Admission reads executable source only from the run's frozen definition.
// No route may pass replacement code, gateway, creator or checkpoint identity.
export async function enqueueWorkflowProgram(db,{orgId,runId,at=Date.now()}) {
 const run=await db.prepare(`SELECT r.*,d.definition FROM hx_workflow_runs r JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id WHERE r.org_id=?1 AND r.id=?2 AND r.status='running'`).bind(orgId,runId).first();
 if(!run)return {status:'failed',error:'No active frozen workflow.'};
 const definition=JSON.parse(run.definition),step=definition.steps?.[0];
 if(definition.id!==run.workflow_id||!definition.safetyGeneration||definition.steps?.length!==1||step?.type!=='code'||typeof step.code!=='string'||!step.code.trim()||typeof step.gatewayId!=='string')return {status:'failed',error:'A program requires one frozen TypeScript definition.'};
 if(!await allowed(db,orgId,definition.createdBy,'harness.build'))return {status:'failed',error:'Workflow execution access was removed.'};
 if(step.sourceAppId||step.sourceEntityId||step.sourceTableId){
  const mapped=step.sourceEntityId==='primary'
   ? await db.prepare('SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2').bind(orgId,step.sourceAppId).first()
   : await db.prepare('SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 AND entity_key=?3').bind(orgId,step.sourceAppId,step.sourceEntityId).first();
  if(!step.sourceAppId||!step.sourceEntityId||!step.sourceTableId||mapped?.table_id!==step.sourceTableId
   ||!await mayUseApp(db,orgId,step.sourceAppId,definition.createdBy)||!await mayUseTable(db,orgId,step.sourceTableId,definition.createdBy))return {status:'failed',error:'The Workflow App/Table source is no longer accessible.'};
 }
 const node=await db.prepare('SELECT * FROM hx_gateways WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL').bind(orgId,step.gatewayId).first();
 if(!node||!await allowed(db,orgId,node.created_by,'workspace.mode'))return {status:'failed',error:'Execution node is unavailable.'};
 if(await getMode(db,orgId)==='harness'){
  const budget=await workspaceBudgetAdmission(db,orgId);
  if(!budget.allowed)return {status:'failed',error:budget.message,reason:budget.reason};
 }
 const source=await db.prepare('SELECT channel FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,run.workflow_id).first();
 const input=run.input?JSON.parse(run.input):null;
 const trigger={kind:run.trigger,...(run.trigger==='app_record_change'&&input?.records?{records:input.records,totalCount:input.totalCount??input.records.length,truncated:Boolean(input.truncated)}:{input})};
 const payload=JSON.stringify({workflowProgram:true,code:step.code,context:{workspaceId:orgId,...(source?{roomId:source.channel}:{}),...(step.sourceAppId?{tableSource:{appId:step.sourceAppId,entityId:step.sourceEntityId,tableId:step.sourceTableId}}:{}),timezone:definition.trigger?.timezone||'UTC',trigger}});
 if(new TextEncoder().encode(payload).length>65536)return {status:'failed',error:'Workflow code and input exceed the execution limit.'};
 const nodeId='program',fingerprint=await digest(run.definition),lease=await claimWorkflowNode(db,{orgId,runId,nodeId,fingerprint,effect:true,at,ttl:300000});
 if(lease.status==='done')return lease.result;
 if(lease.status==='unavailable')return {status:'failed',error:'The workflow is no longer running.'};
 if(lease.status==='unknown'||lease.status==='conflict')return {status:'failed',error:'Previous execution requires reconciliation before retrying.'};
 if(lease.status!=='acquired'){
  const previous=await db.prepare('SELECT job_id FROM hx_workflow_activations WHERE org_id=?1 AND run_id=?2 AND node_id=?3 ORDER BY node_attempt DESC LIMIT 1').bind(orgId,runId,nodeId).first();
  return {status:'pending',...(previous?{jobId:previous.job_id}:{})};
 }
 const jobId=crypto.randomUUID(),requestId=`workflow-${runId}-${lease.attempt}`;
 const inserted=await db.batch([
  db.prepare(`INSERT INTO hx_gateway_jobs(id,org_id,gateway_id,created_by,request_id,payload,status,created_at)
   SELECT ?1,r.org_id,?4,json_extract(d.definition,'$.createdBy'),?5,?6,'queued',?7
   FROM hx_workflow_runs r JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
   JOIN hx_workflow_node_checkpoints c ON c.org_id=r.org_id AND c.run_id=r.id
   WHERE r.org_id=?2 AND r.id=?3 AND r.status='running' AND d.definition=?8 AND ${workflowStateAuthority}
   AND c.node_id='program' AND c.owner=?9 AND c.attempt=?10 AND c.status='running' AND c.lease_until>?7
   AND EXISTS(SELECT 1 FROM hx_gateways g JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by WHERE g.org_id=r.org_id AND g.id=?4 AND g.revoked_at IS NULL AND LOWER(TRIM(m.role)) IN ('owner','admin'))
   AND (SELECT COUNT(*) FROM hx_gateway_jobs WHERE org_id=r.org_id AND status IN ('queued','running'))<100`)
   .bind(jobId,orgId,runId,step.gatewayId,requestId,payload,at,run.definition,lease.owner,lease.attempt),
  db.prepare(`INSERT INTO hx_workflow_activations(org_id,job_id,run_id,node_id,node_owner,node_attempt)
   SELECT ?1,?2,?3,'program',?4,?5 WHERE EXISTS(SELECT 1 FROM hx_gateway_jobs WHERE org_id=?1 AND id=?2)`)
   .bind(orgId,jobId,runId,lease.owner,lease.attempt),
 ]);
 if(!inserted[0].meta?.changes){
  const result={status:'failed',error:'Workflow access changed or the execution queue is full.'};
  await finishWorkflowNode(db,{orgId,runId,nodeId,...lease,result,at});return result;
 }
 return {status:'pending',jobId};
}

// A workflow program may run for up to fifteen minutes. Renew its gateway
// lease and checkpoint together so state operations stay fenced to this exact
// activation. The absolute gateway deadline remains the hard execution cap.
export async function renewWorkflowProgramLease(db,{jobId,gatewayId,leaseHash,at=Date.now()}) {
 if(![jobId,gatewayId,leaseHash].every(value=>typeof value==='string'&&value.length>0&&value.length<=200)||!Number.isSafeInteger(at)||at<0)return false;
 const checkpoint=db.prepare(`${workflowProgramAccessCTE('?4')} UPDATE hx_workflow_node_checkpoints SET lease_until=MAX(lease_until,?5)
  WHERE node_id='program' AND status='running' AND lease_until>?4 AND EXISTS(
   SELECT 1 FROM hx_workflow_activations a JOIN hx_gateway_jobs j ON j.org_id=a.org_id AND j.id=a.job_id
   JOIN authorized_program_jobs authorized ON authorized.id=j.id
   WHERE a.job_id=?1 AND a.org_id=hx_workflow_node_checkpoints.org_id AND a.run_id=hx_workflow_node_checkpoints.run_id
    AND a.node_id=hx_workflow_node_checkpoints.node_id AND a.node_owner=hx_workflow_node_checkpoints.owner AND a.node_attempt=hx_workflow_node_checkpoints.attempt
    AND j.gateway_id=?2 AND j.status='running' AND j.lease_hash=?3 AND j.lease_until>?4 AND j.deadline>?4)
  RETURNING org_id,run_id,node_id,owner,attempt`).bind(jobId,gatewayId,leaseHash,at,at+300000);
 const gateway=db.prepare(`${workflowProgramAccessCTE('?4')} UPDATE hx_gateway_jobs SET lease_until=MIN(?4+90000,deadline)
  WHERE id=?1 AND gateway_id=?2 AND status='running' AND lease_hash=?3 AND lease_until>?4 AND deadline>?4
   AND ${workflowProgramJobAccess}`).bind(jobId,gatewayId,leaseHash,at);
 const [renewed,extended]=await db.batch([checkpoint,gateway]);
 return Boolean(renewed.meta?.changes&&extended.meta?.changes);
}

// Reconcile only persisted terminal results. The caller cannot supply an
// outcome, source, checkpoint lease, or replacement program. Retrying this
// transaction cannot increment the failure streak twice.
export async function settleWorkflowProgram(db,jobId) {
 const binding=await db.prepare(`SELECT a.org_id,a.run_id,d.definition FROM hx_workflow_activations a
  JOIN hx_workflow_run_definitions d ON d.org_id=a.org_id AND d.run_id=a.run_id WHERE a.job_id=?1`).bind(jobId).first();
 if(!binding)return {settled:false};
 const fingerprint=await digest(binding.definition);
 const update=db.prepare(`WITH terminal AS (
  SELECT r.org_id,r.id,j.id AS job_id,j.status AS job_status,j.result,j.finished_at,j.started_at AS job_started_at,j.created_at AS job_created_at,
   (j.status='succeeded' AND j.started_at IS NOT NULL AND j.finished_at>=j.started_at
    AND j.finished_at<j.lease_until AND j.finished_at<j.deadline AND j.finished_at<c.lease_until
    AND ${workflowStateAuthority}
    AND (json_extract(j.payload,'$.context.roomId') IS NULL OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=r.workflow_id AND source.channel=json_extract(j.payload,'$.context.roomId')))
    AND EXISTS(SELECT 1 FROM hx_gateways g JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by WHERE g.id=j.gateway_id AND g.org_id=r.org_id AND g.revoked_at IS NULL AND LOWER(TRIM(m.role)) IN ('admin','owner'))
   ) AS accepted
  FROM hx_workflow_activations a JOIN hx_gateway_jobs j ON j.id=a.job_id AND j.org_id=a.org_id
  JOIN hx_workflow_runs r ON r.id=a.run_id AND r.org_id=a.org_id
  JOIN hx_workflow_run_definitions d ON d.run_id=r.id AND d.org_id=r.org_id
  JOIN hx_workflow_node_checkpoints c ON c.org_id=a.org_id AND c.run_id=a.run_id AND c.node_id=a.node_id
  WHERE a.job_id=?1 AND r.status='running' AND a.node_id='program'
   AND c.owner=a.node_owner AND c.attempt=a.node_attempt AND c.fingerprint=?2 AND c.status IN ('running','unknown')
   AND d.definition=?3 AND json_array_length(d.definition,'$.steps')=1 AND json_extract(d.definition,'$.steps[0].type')='code'
   AND j.status IN ('succeeded','failed','timed_out','cancelled') AND j.finished_at IS NOT NULL
 ), outcome AS (
  SELECT *,CASE WHEN accepted THEN 'done' WHEN job_status='cancelled' THEN 'cancelled' ELSE 'failed' END AS run_status,
    json_object('step',1,'type','code','jobId',job_id,'operationId','workflow:'||id||':step:1',
    'startedAt',strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(job_started_at,job_created_at)/1000.0,'unixepoch'),
    'finishedAt',strftime('%Y-%m-%dT%H:%M:%fZ',finished_at/1000.0,'unixepoch'),
    'durationMs',MAX(0,finished_at-COALESCE(job_started_at,job_created_at)),
    'at',strftime('%Y-%m-%dT%H:%M:%fZ',finished_at/1000.0,'unixepoch'),
    'status',CASE WHEN accepted THEN 'done' ELSE 'failed' END,
    'output',CASE WHEN accepted THEN COALESCE(json_extract(result,'$.stdout'),'') ELSE NULL END,
    'messages',json(CASE WHEN accepted AND json_type(result,'$.messages')='array' THEN json_extract(result,'$.messages') ELSE '[]' END),
    'error',CASE WHEN accepted THEN NULL WHEN job_status='timed_out' THEN 'Program execution timed out.' WHEN job_status='cancelled' THEN 'Program execution was cancelled.' WHEN job_status='failed' THEN 'Program execution failed.' ELSE 'Program completion is no longer authorized or its lease expired.' END) AS entry
  FROM terminal
 ) UPDATE hx_workflow_runs SET status=(SELECT run_status FROM outcome),
  log=(SELECT json_array(json(entry)) FROM outcome),next_step=1,
  finished_at=(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',finished_at/1000.0,'unixepoch') FROM outcome)
  WHERE org_id=?4 AND id=?5 AND status='running' AND EXISTS(SELECT 1 FROM outcome WHERE outcome.id=hx_workflow_runs.id AND outcome.org_id=hx_workflow_runs.org_id)`)
  .bind(jobId,fingerprint,binding.definition,binding.org_id,binding.run_id);
 const checkpoint=db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='done',lease_until=0,
  result=(SELECT json_extract(log,'$[0]') FROM hx_workflow_runs WHERE org_id=?1 AND id=?2)
  WHERE org_id=?1 AND run_id=?2 AND node_id='program' AND status IN ('running','unknown')
   AND EXISTS(SELECT 1 FROM hx_workflow_activations a JOIN hx_workflow_runs r ON r.id=a.run_id AND r.org_id=a.org_id
    WHERE a.job_id=?3 AND a.node_owner=hx_workflow_node_checkpoints.owner AND a.node_attempt=hx_workflow_node_checkpoints.attempt
     AND r.status IN ('done','failed','cancelled') AND json_extract(r.log,'$[0].jobId')=?3)`)
  .bind(binding.org_id,binding.run_id,jobId);
 const result=await db.batch([update,checkpoint,...workflowSettlementStatements(db,binding.org_id,binding.run_id)]);
 return {settled:!!result[0].meta?.changes};
}

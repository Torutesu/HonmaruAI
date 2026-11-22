import {claimWorkflowNode,finishWorkflowNode} from './workflowCheckpoints.js';
import {workflowStateAuthority} from './workflowState.js';
import {allowed} from '../permissions.js';
import {workflowSettlementStatements} from './workflowSafety.js';
import {getMode} from './mode.js';
import {workspaceBudgetAdmission} from '../workspaceAIBudget.js';
import {mayUseApp,mayUseTable} from './resourceAccess.js';
import {workflowProgramSources} from './workflowProgramSources.js';
import {mayRunAgent} from './agents.js';
import {addRow,updateRow,deleteRow} from './tables.js';
import {prepareWorkflowRowEventIfWatched,drainWorkflowRowEvents} from './workflowRowEventDispatch.js';
import {appConnectionsForViewer} from './appConnectionGrants.js';
import {getUserByGithubId} from '../db.js';
import {workflowEffectAuthority} from './workflowEffectAuthority.js';
import {appendCardEvent} from '../events.js';
import {announceCards} from '../announce.js';
import {notifyCard,anyChannelConfigured} from '../notify.js';
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
const appWriteApprovalLabels={
 en:{title:'Approve external App request',app:'App connection',method:'Method',body:'Request body'},
 ja:{title:'外部Appリクエストを承認',app:'App接続',method:'Method',body:'リクエスト本文'},
 es:{title:'Aprobar solicitud externa de App',app:'Conexión de App',method:'Método',body:'Cuerpo de la solicitud'},
 fr:{title:'Approuver la requête externe de l’app',app:'Connexion d’app',method:'Méthode',body:'Corps de la requête'},
 de:{title:'Externe App-Anfrage freigeben',app:'App-Verbindung',method:'Methode',body:'Anfragetext'},
};
function appWriteApprovalLocalization(locale,name,workflowName,method,body){
 const code=String(locale||'en').toLowerCase().split('-')[0],labels=appWriteApprovalLabels[code];
 if(!labels||code==='en')return {};
 const encoded=typeof body==='string'?body:JSON.stringify(body);
 return {[code]:{
  title:labels.title,summary:`${name} · ${method}`,
  context:`Workflow: ${workflowName}\n${labels.app}: ${name}\n${labels.method}: ${method}\n${labels.body}:\n${encoded}`,
 }};
}
export const WORKFLOW_PROGRAM_TIMEOUT_MS=15*60*1000;
export const WORKFLOW_PROGRAM_RESULT_GRACE_MS=30*1000;

// Keep the saved Workflow's original input for compatibility while exposing
// row triggers in the SDK shape used by Kylon's TypeScript runtime.
export function workflowProgramTrigger(kind,input) {
 if(kind==='app_record_change'&&Array.isArray(input?.records))return {kind,records:input.records,totalCount:input.totalCount??input.records.length,truncated:Boolean(input.truncated)};
 if(kind==='row'){
  const deleted=input?.event==='deleted';
  const row=input?.row&&typeof input.row==='object'&&!Array.isArray(input.row)?input.row:{};
  const rowId=typeof input?.recordId==='string'?input.recordId:typeof row.__rowId==='string'?row.__rowId:typeof row.id==='string'?row.id:null;
  const title=deleted?null:[row.title,row.Title,row.name,row.Name].find(value=>typeof value==='string')??null;
  const cells=deleted?{}:Object.fromEntries(Object.entries(row).filter(([key])=>!['__rowId','updatedAt'].includes(key)));
  return {kind,rows:[{event:deleted?'deleted':input?.before?'changed':'added',rowId,title,cells}],totalCount:1,truncated:false,input};
 }
 return {kind,input};
}

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
 if(step.sourceAgents!==undefined){
  if(!Array.isArray(step.sourceAgents)||step.sourceAgents.length<1||step.sourceAgents.length>20||step.sourceAgents.some(id=>typeof id!=='string'||!id.trim()||id.length>200)||new Set(step.sourceAgents).size!==step.sourceAgents.length)return {status:'failed',error:'The Workflow Agent bindings are invalid.'};
  for(const agentId of step.sourceAgents){
   const agent=await db.prepare('SELECT id,scope,owner_login FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL').bind(orgId,agentId).first();
   if(!agent||!await mayRunAgent(db,orgId,agent,definition.createdBy))return {status:'failed',error:'A Workflow Agent binding is no longer accessible.'};
  }
 }
 const connectionSources=step.sourceConnections??[];
 if(!Array.isArray(connectionSources)||connectionSources.length>20||connectionSources.some(source=>!source||typeof source!=='object'||Array.isArray(source)
  ||!['appId,method,name,ownerId,version','appId,method,name,ownerId,version,write'].includes(Object.keys(source).sort().join(','))||typeof source.appId!=='string'||!source.appId.trim()||source.appId.length>200
  ||typeof source.name!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(source.name)||typeof source.ownerId!=='string'||!source.ownerId
  ||!Number.isSafeInteger(source.version)||source.version<1||!['GET','POST','PUT','PATCH','DELETE'].includes(source.method)
  ||source.method==='GET'&&source.write===true||source.method!=='GET'&&source.write!==true)||new Set(connectionSources.map(source=>`${source.appId}\0${source.name}`)).size!==connectionSources.length)
  return {status:'failed',error:'The Workflow App connection bindings are invalid.'};
 for(const source of connectionSources){
  const catalog=await appConnectionsForViewer(db,orgId,source.appId,definition.createdBy).catch(()=>({error:'unavailable'}));
  if(catalog.error||!catalog.connections?.some(item=>item.name===source.name&&String(item.ownerId)===source.ownerId&&Number(item.version)===source.version&&item.method===source.method&&Number(item.enabled)===1))return {status:'failed',error:'A Workflow App connection binding is no longer accessible.'};
 }
 const tableSources=workflowProgramSources(step);
 if(step.sourceAppId||step.sourceEntityId||step.sourceTableId||step.sourceTables!==undefined){
  if(!step.sourceAppId||!tableSources.length||tableSources.length>20||new Set(tableSources.map(source=>source.entityId)).size!==tableSources.length
   ||!await mayUseApp(db,orgId,step.sourceAppId,definition.createdBy))return {status:'failed',error:'The Workflow App/Table source is no longer accessible.'};
  for(const source of tableSources){
   const mapped=source.entityId==='primary'
    ? await db.prepare('SELECT table_id FROM hx_apps WHERE org_id=?1 AND id=?2').bind(orgId,step.sourceAppId).first()
    : await db.prepare('SELECT table_id FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 AND entity_key=?3').bind(orgId,step.sourceAppId,source.entityId).first();
   if(mapped?.table_id!==source.tableId||!await mayUseTable(db,orgId,source.tableId,definition.createdBy))return {status:'failed',error:'The Workflow App/Table source is no longer accessible.'};
  }
 }
 const node=await db.prepare('SELECT * FROM hx_gateways WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL').bind(orgId,step.gatewayId).first();
 if(!node||!await allowed(db,orgId,node.created_by,'workspace.mode'))return {status:'failed',error:'Execution node is unavailable.'};
 if(await getMode(db,orgId)==='harness'){
  const budget=await workspaceBudgetAdmission(db,orgId);
  if(!budget.allowed)return {status:'failed',error:budget.message,reason:budget.reason};
 }
 const source=await db.prepare('SELECT channel FROM hx_workflow_sources WHERE org_id=?1 AND workflow_id=?2').bind(orgId,run.workflow_id).first();
 const input=run.input?JSON.parse(run.input):null;
 const trigger=workflowProgramTrigger(run.trigger,input);
 const payload=JSON.stringify({workflowProgram:true,code:step.code,context:{workspaceId:orgId,...(source?{roomId:source.channel}:{}),...(step.sourceAppId?{tableSources:tableSources.map(item=>({appId:step.sourceAppId,entityId:item.entityId,tableId:item.tableId,...(item.write?{write:true}:{}),...(item.mutate?{mutate:true}:{})}))}:{}),...(connectionSources.length?{connectionSources}:{}),timezone:definition.trigger?.timezone||'UTC',trigger}});
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
export async function settleWorkflowProgram(db,jobId,env=null,{approvedWrite=false,writeDecision=false,declined=false,externalWriteResults=[]}={}) {
 const binding=await db.prepare(`SELECT a.org_id,a.run_id,d.definition,j.gateway_id,j.lease_hash,j.finished_at AS job_finished_at,j.status AS job_status FROM hx_workflow_activations a
  JOIN hx_workflow_run_definitions d ON d.org_id=a.org_id AND d.run_id=a.run_id
  JOIN hx_gateway_jobs j ON j.org_id=a.org_id AND j.id=a.job_id WHERE a.job_id=?1`).bind(jobId).first();
 if(!binding)return {settled:false};
 const fingerprint=await digest(binding.definition);
 const stored=await db.prepare('SELECT result FROM hx_gateway_jobs WHERE id=?1 AND org_id=?2').bind(jobId,binding.org_id).first();
 let programResult={};try{programResult=JSON.parse(stored?.result||'{}')}catch{}
 const step=JSON.parse(binding.definition).steps?.[0],sources=workflowProgramSources(step);
 const connectionWrites=Array.isArray(programResult.connectionWrites)?programResult.connectionWrites:[];
 if(programResult.connectionWrites!==undefined&&(!Array.isArray(programResult.connectionWrites)||connectionWrites.length<1||connectionWrites.length>3))return {settled:false,error:'A Workflow run may stage up to three external App writes.'};
 if(connectionWrites.length&&!writeDecision&&binding.job_status==='succeeded'){
  const sources=step?.sourceConnections||[],first=connectionWrites[0],source=sources.find(item=>item.appId===first?.appId&&item.name===first?.name),connectionBindings=new Map();
  const operationIds=new Set();
  for(const request of connectionWrites){
   const requestSource=sources.find(item=>item.appId===request?.appId&&item.name===request?.name);
   if(!requestSource||!source||request.ownerId!==source.ownerId||request.ownerId!==requestSource.ownerId||request.version!==requestSource.version||request.method!==requestSource.method||requestSource.method==='GET'||requestSource.write!==true
    ||typeof request.operationId!=='string'||! /^[a-zA-Z0-9_-]{1,32}$/.test(request.operationId)||operationIds.has(request.operationId)||!request.body||typeof request.body!=='object'||Array.isArray(request.body))return {settled:false,error:'The staged external writes do not match one frozen App connection.'};
   connectionBindings.set(`${requestSource.appId}\0${requestSource.name}`,requestSource);
   operationIds.add(request.operationId);
  }
  if(new TextEncoder().encode(JSON.stringify(connectionWrites)).length>20000)return {settled:false,error:'The staged external writes exceed the approval limit.'};
  const owner=await getUserByGithubId(db,source.ownerId).catch(()=>null);
  for(const bound of connectionBindings.values())if(!owner||!await appConnectionsForViewer(db,binding.org_id,bound.appId,JSON.parse(binding.definition).createdBy).then(result=>!result.error&&result.connections.some(item=>item.name===bound.name&&String(item.ownerId)===source.ownerId&&Number(item.version)===bound.version&&item.method===bound.method&&Number(item.enabled)===1)).catch(()=>false))return {settled:false,error:'The App connection owner or binding is no longer available.'};
  const at=new Date().toISOString(),cardId=`wf-${binding.run_id}-write-${(await digest(jobId)).slice(0,16)}`;
  const workflowName=JSON.parse(binding.definition).name||'Workflow';
  const requestSummary=connectionWrites.map((request,index)=>{const bound=connectionBindings.get(`${request.appId}\0${request.name}`);return `${index+1}. ${bound.name} · ${bound.method} · ${request.operationId}\n${JSON.stringify(request.body)}`}).join('\n\n');
  const connectionNames=[...new Set([...connectionBindings.values()].map(item=>item.name))],connectionSummary=connectionNames.join(', '),methodSummary=[...new Set([...connectionBindings.values()].map(item=>item.method))].join(', ');
  const bindingList=[...connectionBindings.values()].map(({appId,name,ownerId,version,method})=>({appId,name,ownerId,version,method}));
  let card={id:cardId,recipientUserID:owner.login,senderUserID:owner.login,type:'approval',title:'Approve external App requests',summary:`${connectionWrites.length} requests · ${connectionSummary}`,context:`Workflow: ${workflowName}\nApp connections: ${connectionSummary}\n${requestSummary}`,localized:appWriteApprovalLocalization(owner.locale,connectionSummary,workflowName,methodSummary,requestSummary),originalLanguage:'en',priority:'medium',status:'pending',createdAt:at,sourceApp:'Workflow',sourceDetail:workflowName,requestedBy:{login:owner.login,name:workflowName},workflowApproval:{runId:binding.run_id,workflowId:JSON.parse(binding.definition).id,codeWrite:{jobId,appId:source.appId,name:source.name,ownerId:source.ownerId,version:source.version,method:source.method,sources:bindingList,writes:connectionWrites}}};
  const guard=workflowEffectAuthority({org:'?1',runId:'?7',ownerId:'?8',recipientLogin:'?9'});
  const saved=await db.prepare(`INSERT INTO cards(org_id,card_id,recipient_user_id,sender_user_id,created_at,data,status,priority,decided_at,updated_at)
   SELECT ?1,?2,?3,?4,?5,?6,'pending','medium',NULL,?5 WHERE ${guard}
   ON CONFLICT(org_id,card_id) DO NOTHING`).bind(binding.org_id,cardId,owner.login,owner.login,at,JSON.stringify(card),binding.run_id,String(JSON.parse(binding.definition).createdBy),owner.login).run();
  if(!saved.meta?.changes){
   const previous=await db.prepare('SELECT recipient_user_id,data FROM cards WHERE org_id=?1 AND card_id=?2').bind(binding.org_id,cardId).first().catch(()=>null);
   let previousCard;try{previousCard=JSON.parse(previous?.data||'null')}catch{}
   if(previous?.recipient_user_id!==owner.login||previousCard?.workflowApproval?.runId!==binding.run_id
    ||previousCard?.workflowApproval?.codeWrite?.jobId!==jobId||JSON.stringify(previousCard?.workflowApproval?.codeWrite?.writes)!==JSON.stringify(connectionWrites))return {settled:false,error:'Workflow or approver access changed before the approval was created.'};
   if(previousCard.decision||previousCard.status!=='pending')return {settled:false,status:'awaiting-approval-settlement'};
   card=previousCard;
  }
  const waiting=await db.batch([
   db.prepare(`UPDATE hx_workflow_runs SET status='waiting',card_id=?1 WHERE org_id=?2 AND id=?3 AND status='running'
    AND EXISTS(SELECT 1 FROM cards WHERE org_id=?2 AND card_id=?1 AND recipient_user_id=?4)`).bind(cardId,binding.org_id,binding.run_id,owner.login),
   db.prepare(`UPDATE hx_workflow_node_checkpoints SET lease_until=0 WHERE org_id=?1 AND run_id=?2 AND node_id='program' AND status='running'
    AND EXISTS(SELECT 1 FROM hx_workflow_activations a WHERE a.org_id=?1 AND a.run_id=?2 AND a.job_id=?3
      AND a.node_owner=hx_workflow_node_checkpoints.owner AND a.node_attempt=hx_workflow_node_checkpoints.attempt)`).bind(binding.org_id,binding.run_id,jobId),
  ]);
  if(!waiting[0]?.meta?.changes||!waiting[1]?.meta?.changes)return {settled:false};
  if(saved.meta?.changes){
   await appendCardEvent(db,binding.org_id,{cardId,type:'created',actorUserId:owner.login,note:'workflow',snapshot:card}).catch(()=>{});
   if(env){
    await announceCards(env,binding.org_id,[card]).catch(()=>{});
    if(anyChannelConfigured(env)&&Object.hasOwn(appWriteApprovalLabels,String(owner.locale||'en').toLowerCase().split('-')[0]))
     await notifyCard(env,{card,kind:'created',excludeLogin:null,orgId:binding.org_id}).catch(()=>{});
   }
  }
  return {settled:true,status:'waiting',cardId};
 }
 const tableStatements=[];let writeFailed=connectionWrites.length>0&&writeDecision&&!approvedWrite;
 const writeOffsets=new Map();
 const legacyWrites=Array.isArray(programResult.tableWrites)?programResult.tableWrites:[];
 const requestedMutations=Array.isArray(programResult.tableMutations)?programResult.tableMutations.map(item=>({...item})):legacyWrites.map(item=>({...item,operation:'insert'}));
 if(programResult.tableMutations!==undefined&&(!Array.isArray(programResult.tableMutations)||legacyWrites.length)||requestedMutations.length>4)writeFailed=true;
 if(binding.job_status==='succeeded'&&requestedMutations.length){
  if(!step?.sourceAppId)writeFailed=true;
  const mutationTargets=new Set();
  for(const item of requestedMutations){
   if(writeFailed)break;
   const operation=item?.operation??'insert';
   if(!item||typeof item!=='object'||!['insert','update','delete'].includes(operation)||Object.keys(item).some(key=>!['operation','entityId','values','rowId','expectedUpdatedAt'].includes(key))||typeof item.entityId!=='string'){writeFailed=true;break;}
   const source=sources.find(value=>value.entityId===item.entityId&&(operation==='insert'?value.write===true:value.mutate===true));
   if(!source){writeFailed=true;break;}
   if(operation!=='insert'){
    if(typeof item.rowId!=='string'||!item.rowId||item.rowId.length>200||typeof item.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(item.expectedUpdatedAt))){writeFailed=true;break;}
    const key=`${source.entityId}\0${item.rowId}`;if(mutationTargets.has(key)){writeFailed=true;break;}mutationTargets.add(key);
   }
   const writeGuard={sql:start=>workflowProgramTableWriteGuard(start,operation==='insert'?'write':'mutate'),binds:[binding.org_id,binding.run_id,step.sourceAppId,source.entityId,source.tableId,jobId,binding.gateway_id,binding.lease_hash,binding.job_finished_at,JSON.parse(binding.definition).createdBy]};
   const by=JSON.parse(binding.definition).createdBy;
   const positionOffset=writeOffsets.get(source.tableId)||0;
   const row=operation==='insert'?await addRow(db,binding.org_id,source.tableId,item.values,by,'strict',by,writeGuard,{deferWrite:true,positionOffset}):operation==='update'?await updateRow(db,binding.org_id,source.tableId,item.rowId,item.values,by,item.expectedUpdatedAt,'strict',by,writeGuard,{deferWrite:true}):await deleteRow(db,binding.org_id,source.tableId,item.rowId,item.expectedUpdatedAt,by,writeGuard,{by,deferWrite:true});
   if(row.error){writeFailed=true;break;}
   if(operation==='insert')writeOffsets.set(source.tableId,positionOffset+1);
   const event=await prepareWorkflowRowEventIfWatched(db,{orgId:binding.org_id,table:row.table,before:row.before??null,row:row.row,by});
   tableStatements.push(row.statement,db.prepare(`INSERT INTO hx_workflow_node_checkpoints(org_id,run_id,node_id,fingerprint,effect,status,owner,attempt,lease_until)
    SELECT ?1,?2,'program','effect-fence',1,'invalid-effect','fence',1,0 WHERE changes()=0`).bind(binding.org_id,binding.run_id));
   if(event)tableStatements.push(event.statement,db.prepare(`INSERT INTO hx_workflow_node_checkpoints(org_id,run_id,node_id,fingerprint,effect,status,owner,attempt,lease_until)
    SELECT ?1,?2,'program','effect-fence',1,'invalid-effect','fence',1,0 WHERE changes()=0`).bind(binding.org_id,binding.run_id));
  }
 }
 const update=db.prepare(`WITH terminal AS (
  SELECT r.org_id,r.id,j.id AS job_id,j.status AS job_status,j.result,j.finished_at,j.started_at AS job_started_at,j.created_at AS job_created_at,
   (j.status='succeeded' AND j.started_at IS NOT NULL AND j.finished_at>=j.started_at
    AND j.finished_at<j.lease_until AND j.finished_at<j.deadline AND (j.finished_at<c.lease_until OR ?7=1)
    AND ${workflowStateAuthority} AND ?6=1
    AND (json_extract(j.payload,'$.context.roomId') IS NULL OR EXISTS(SELECT 1 FROM hx_workflow_sources source WHERE source.org_id=r.org_id AND source.workflow_id=r.workflow_id AND source.channel=json_extract(j.payload,'$.context.roomId')))
    AND EXISTS(SELECT 1 FROM hx_gateways g JOIN memberships m ON m.org_id=g.org_id AND m.user_github_id=g.created_by WHERE g.id=j.gateway_id AND g.org_id=r.org_id AND g.revoked_at IS NULL AND LOWER(TRIM(m.role)) IN ('admin','owner'))
    AND (json_array_length(j.result,'$.connectionWrites') IS NULL OR ?7=1)
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
  SELECT *,CASE WHEN accepted THEN 'done' WHEN ?8=1 THEN 'declined' WHEN job_status='cancelled' THEN 'cancelled' ELSE 'failed' END AS run_status,
    json_object('step',1,'type','code','jobId',job_id,'operationId','workflow:'||id||':step:1',
    'startedAt',strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(job_started_at,job_created_at)/1000.0,'unixepoch'),
    'finishedAt',strftime('%Y-%m-%dT%H:%M:%fZ',finished_at/1000.0,'unixepoch'),
    'durationMs',MAX(0,finished_at-COALESCE(job_started_at,job_created_at)),
    'at',strftime('%Y-%m-%dT%H:%M:%fZ',finished_at/1000.0,'unixepoch'),
    'status',CASE WHEN accepted THEN 'done' WHEN ?8=1 THEN 'declined' ELSE 'failed' END,
    'output',CASE WHEN accepted THEN COALESCE(json_extract(result,'$.stdout'),'') ELSE NULL END,
    'messages',json(CASE WHEN accepted AND json_type(result,'$.messages')='array' THEN json_extract(result,'$.messages') ELSE '[]' END),
    'externalWrite',json(CASE WHEN json_array_length(?9)>0 THEN json_extract(?9,'$[0]') ELSE 'null' END),
    'externalWrites',json(CASE WHEN json_valid(?9) AND json_type(?9)='array' THEN ?9 ELSE '[]' END),
    'error',CASE WHEN accepted THEN NULL WHEN ?8=1 THEN 'External App request was declined. No request was sent.'
      WHEN json_array_length(result,'$.connectionWrites')>0 AND ?7=0 THEN 'External request did not complete. Its result may be unknown; do not retry it.'
      WHEN job_status='timed_out' THEN 'Program execution timed out.' WHEN job_status='cancelled' THEN 'Program execution was cancelled.' WHEN job_status='failed' THEN 'Program execution failed.' WHEN ?6=0 THEN 'An App row change could not be applied under the current permissions or table schema.' ELSE 'Program completion is no longer authorized or its lease expired.' END) AS entry
  FROM terminal
 ) UPDATE hx_workflow_runs SET status=(SELECT run_status FROM outcome),
  log=(SELECT json_array(json(entry)) FROM outcome),next_step=1,
  finished_at=(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',finished_at/1000.0,'unixepoch') FROM outcome)
  WHERE org_id=?4 AND id=?5 AND status='running' AND EXISTS(SELECT 1 FROM outcome WHERE outcome.id=hx_workflow_runs.id AND outcome.org_id=hx_workflow_runs.org_id)`);
 const checkpoint=db.prepare(`UPDATE hx_workflow_node_checkpoints SET status='done',lease_until=0,
  result=(SELECT json_extract(log,'$[0]') FROM hx_workflow_runs WHERE org_id=?1 AND id=?2)
  WHERE org_id=?1 AND run_id=?2 AND node_id='program' AND status IN ('running','unknown')
   AND EXISTS(SELECT 1 FROM hx_workflow_activations a JOIN hx_workflow_runs r ON r.id=a.run_id AND r.org_id=a.org_id
    WHERE a.job_id=?3 AND a.node_owner=hx_workflow_node_checkpoints.owner AND a.node_attempt=hx_workflow_node_checkpoints.attempt
     AND r.status IN ('done','failed','declined','cancelled') AND json_extract(r.log,'$[0].jobId')=?3)`)
  .bind(binding.org_id,binding.run_id,jobId);
 const completionFence=db.prepare(`INSERT INTO hx_workflow_node_checkpoints(org_id,run_id,node_id,fingerprint,effect,status,owner,attempt,lease_until)
  SELECT ?1,?2,'program','effect-fence',1,'invalid-effect','fence',1,0 WHERE NOT EXISTS(
   SELECT 1 FROM hx_workflow_runs r WHERE r.org_id=?1 AND r.id=?2 AND r.status='done' AND json_extract(r.log,'$[0].jobId')=?3)`)
  .bind(binding.org_id,binding.run_id,jobId);
 const writeReceipts=JSON.stringify(Array.isArray(externalWriteResults)?externalWriteResults.filter(item=>item&&typeof item.appId==='string'&&typeof item.name==='string'&&typeof item.method==='string'&&typeof item.operationId==='string'&&['sent','unknown','not_sent'].includes(item.status)).map(item=>({appId:item.appId,name:item.name,method:item.method,operationId:item.operationId,status:item.status})):[]);
 const finish=async(accept)=>db.batch([...(accept?tableStatements:[]),update.bind(jobId,fingerprint,binding.definition,binding.org_id,binding.run_id,accept?1:0,approvedWrite?1:0,declined?1:0,writeReceipts),...(accept&&tableStatements.length?[completionFence]:[]),...workflowSettlementStatements(db,binding.org_id,binding.run_id),checkpoint]);
 let result;
 try{result=await finish(!writeFailed)}catch(error){
  if(!tableStatements.length)throw error;
  // A failed guarded mutation rolls back every row and event statement. Settle
  // the terminal job as failed in a clean transaction instead of retrying it.
  const rejectedUpdate=update.bind(jobId,fingerprint,binding.definition,binding.org_id,binding.run_id,0,approvedWrite?1:0,declined?1:0,writeReceipts);
  result=await db.batch([rejectedUpdate,...workflowSettlementStatements(db,binding.org_id,binding.run_id),checkpoint]);
 }
 if(result[0]?.meta?.changes&&!writeFailed&&requestedMutations.length&&env)await drainWorkflowRowEvents(env,{limit:requestedMutations.length,now:Date.now()});
 return {settled:!!result[0]?.meta?.changes};
}

function workflowProgramTableWriteGuard(start,permission='write'){
 const n=offset=>`?${start+offset}`;
 const [org,run,app,entity,table,job,gateway,lease,at,user]=Array.from({length:10},(_,index)=>n(index));
 return `EXISTS(SELECT 1 FROM hx_workflow_runs r JOIN hx_workflow_run_definitions d ON d.org_id=r.org_id AND d.run_id=r.id
  JOIN hx_workflow_node_checkpoints c ON c.org_id=r.org_id AND c.run_id=r.id AND c.node_id='program'
  WHERE r.org_id=${org} AND r.id=${run} AND r.workflow_id=json_extract(d.definition,'$.id') AND r.status='running'
   AND c.status='running' AND c.lease_until>${at}
   AND EXISTS(SELECT 1 FROM hx_workflow_activations a JOIN hx_gateway_jobs j ON j.org_id=a.org_id AND j.id=a.job_id
    JOIN hx_gateways g ON g.org_id=j.org_id AND g.id=j.gateway_id
    WHERE a.job_id=${job} AND a.org_id=r.org_id AND a.run_id=r.id AND a.node_id=c.node_id AND a.node_owner=c.owner AND a.node_attempt=c.attempt
     AND j.gateway_id=${gateway} AND j.lease_hash=${lease} AND j.status='succeeded' AND j.finished_at=${at}
     AND j.finished_at<j.lease_until AND j.finished_at<j.deadline AND g.revoked_at IS NULL
     AND EXISTS(SELECT 1 FROM memberships gm WHERE gm.org_id=g.org_id AND gm.user_github_id=g.created_by AND LOWER(TRIM(gm.role)) IN ('owner','admin')))
   AND EXISTS(SELECT 1 FROM hx_workflows w JOIN memberships m ON m.org_id=w.org_id AND m.user_github_id=${user}
    WHERE w.org_id=${org} AND w.id=r.workflow_id AND w.created_by=${user} AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest')
   AND EXISTS(SELECT 1 FROM json_each(d.definition,'$.steps[0].sourceTables') source
    WHERE json_extract(source.value,'$.entityId')=${entity} AND json_extract(source.value,'$.tableId')=${table} AND json_extract(source.value,'$.${permission}')=1)
   AND EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=${org} AND a.id=${app} AND
    ((${entity}='primary' AND a.table_id=${table}) OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=a.org_id AND e.app_id=a.id AND e.entity_key=${entity} AND e.table_id=${table}))))
  AND EXISTS(SELECT 1 FROM memberships active WHERE active.org_id=${org} AND active.user_github_id=${user} AND LOWER(TRIM(COALESCE(active.role,'guest')))!='guest')
  AND NOT EXISTS(SELECT 1 FROM hx_apps linked LEFT JOIN hx_app_access policy ON policy.org_id=linked.org_id AND policy.app_id=linked.id
   LEFT JOIN hx_app_person_access personal ON personal.org_id=linked.org_id AND personal.app_id=linked.id AND personal.user_github_id=${user}
   LEFT JOIN memberships member ON member.org_id=linked.org_id AND member.user_github_id=${user}
   WHERE linked.org_id=${org} AND (linked.table_id=${table} OR EXISTS(SELECT 1 FROM hx_app_entities e WHERE e.org_id=linked.org_id AND e.app_id=linked.id AND e.table_id=${table}))
    AND NOT(linked.created_by=${user} OR personal.permission='edit' OR (personal.permission IS NULL AND policy.room_channel IS NULL AND COALESCE(policy.visibility,'workspace')='workspace' AND LOWER(TRIM(COALESCE(member.role,'guest'))) IN ('owner','admin'))))
  AND NOT EXISTS(SELECT 1 FROM hx_app_entities orphan WHERE orphan.org_id=${org} AND orphan.table_id=${table} AND NOT EXISTS(SELECT 1 FROM hx_apps a WHERE a.org_id=orphan.org_id AND a.id=orphan.app_id))
  AND NOT EXISTS(SELECT 1 FROM workspace_deletions deletion WHERE deletion.org_id=${org} AND deletion.purge_started_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM workspace_tombstones tombstone WHERE tombstone.org_id=${org})`;
}

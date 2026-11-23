import {WorkflowRunUsage} from './WorkflowRunUsage'
import {HeldWebhookEvents} from './HeldWebhookEvents'
import {WorkflowRunSummaryCard} from './WorkflowRunSummary'
import './AutomationRuns.css'
import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {HarnessApi,HeldWorkflowEvents,Run,WorkflowRunPage,WorkflowRunSummary as WorkflowRunSummaryData,WorkflowSafety} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import {groupRunsByStartDay,runDayLabel,runTimestampLabel} from '../utils/runHistory'
import {stepLabel} from '../utils/workflowLabels'
const labels:Record<string,string>={done:'Completed',running:'Running',waiting:'Waiting for approval',failed:'Failed',declined:'Declined',ok:'Succeeded',cancelled:'Cancelled'}
const stepDurationLabel=(durationMs:number)=>durationMs>=1000?`${(durationMs/1000).toLocaleString(getLocale(),{maximumFractionDigits:2})} s`:`${durationMs} ms`
export {runDuration} from '../utils/runDuration'
import {runDuration} from '../utils/runDuration'
import {hashForThread} from '../utils/route'
const authorizationResourceLabels:Record<NonNullable<Run['log'][number]['authorization']>[number]['resourceType'],string>={
 workflow:'Workflow resource',conversation:'Conversation resource',agent:'Agent resource',table:'Table resource',app:'App resource',connection:'Connection resource',member:'Member resource',
}
const effectLabels:Record<NonNullable<Run['log'][number]['effectReceipt']>['effect'],string>={none:'No external effect',local:'Workspace change',external:'External action',ai:'AI processing'}
const targetLabels:Record<NonNullable<Run['log'][number]['effectReceipt']>['target'],string>={workflow:'Workflow',conversation:'Conversation',agent:'Agent',connection:'Connection',table:'App table',approval:'Approval',followup:'Follow-up',program:'Workflow program'}
const outcomeLabels:Record<NonNullable<Run['log'][number]['effectReceipt']>['outcome'],string>={completed:'Completed',pending:'Pending',failed:'Failed',unknown:'Unknown',skipped:'Skipped'}
const externalWriteStatusLabels:Record<NonNullable<Run['log'][number]['externalWrites']>[number]['status'],string>={sent:'External write sent once',unknown:'External write outcome unknown',not_sent:'External write not sent'}

async function readRunPage(api:HarnessApi,workflowId:string,detailRuns:Run[],failedOnly:boolean,cursor?:string|null):Promise<WorkflowRunPage>{
 if(typeof api.workflowRunsPage==='function')return api.workflowRunsPage(workflowId,{limit:50,...(cursor?{cursor}:{}),...(failedOnly?{status:'failed'}:{})})
 const runs=failedOnly?detailRuns.filter(run=>run.status==='failed'):detailRuns
 return {runs,hasMore:false,nextCursor:null}
}

export function AutomationRuns({workflowId,api,orgId}:{workflowId:string;api:HarnessApi;orgId?:string}) {
 const t=useT(),[runs,setRuns]=useState<Run[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[isOpen,setIsOpen]=useState(false),[failedOnly,setFailedOnly]=useState(false)
 const [runCursor,setRunCursor]=useState<string|null>(null),[hasMoreRuns,setHasMoreRuns]=useState(false),[loadingMore,setLoadingMore]=useState(false),[pageError,setPageError]=useState('')
 const [summary,setSummary]=useState<WorkflowRunSummaryData|null>(null),[sourceThreadId,setSourceThreadId]=useState<string|null>(null)
 const [safety,setSafety]=useState<WorkflowSafety|null>(null),[canEdit,setCanEdit]=useState(false),[held,setHeld]=useState<HeldWorkflowEvents|null>(null),[isWebhook,setIsWebhook]=useState(false)
 const [externalWriteCheck,setExternalWriteCheck]=useState<{runId:string;operationId:string;outcome:'sent'|'not_sent'}|null>(null),[reconcilingWrite,setReconcilingWrite]=useState(false),[reconcileError,setReconcileError]=useState('')
 const request=useRef(0),pending=useRef<number|null>(null),opened=useRef(false)
 const readSourceThread=useCallback(async()=>{
  if(typeof api.workflowSource!=='function')return null
  try{return (await api.workflowSource(workflowId,undefined,false)).source?.threadId||null}catch{return null}
 },[workflowId,api])
 const load=useCallback(async(heldOffset=0,failedFilter=false)=>{
  if(pending.current!==null)return
  const current=++request.current;pending.current=current;setBusy(true);setError('')
  try{const result=heldOffset?await api.workflow(workflowId,heldOffset):await api.workflow(workflowId);const page=await readRunPage(api,workflowId,result.runs||[],failedFilter);const source=page.runs.some(run=>run.status==='failed')?await readSourceThread():null;if(current===request.current){setRuns(page.runs);setRunCursor(page.nextCursor);setHasMoreRuns(page.hasMore);setPageError('');setSummary(result.summary||null);setSafety(result.workflow?.safety||null);setCanEdit(result.canEdit===true);setHeld(result.held||null);setIsWebhook(result.workflow?.trigger?.type==='webhook');setSourceThreadId(source)}}
  catch(e){if(current===request.current){setRuns(null);setRunCursor(null);setHasMoreRuns(false);setPageError('');setSummary(null);setSafety(null);setCanEdit(false);setHeld(null);setIsWebhook(false);setSourceThreadId(null);setError(e instanceof Error?e.message:String(e))}}
  finally{if(pending.current===current)pending.current=null;if(current===request.current)setBusy(false)}
 },[workflowId,api,readSourceThread])
 useEffect(()=>{
  request.current++;pending.current=null;setRuns(null);setRunCursor(null);setHasMoreRuns(false);setLoadingMore(false);setPageError('');setSummary(null);setSourceThreadId(null);setSafety(null);setCanEdit(false);setHeld(null);setIsWebhook(false);setError('');setBusy(false);setFailedOnly(false)
  if(opened.current)void load(0,false)
  return ()=>{request.current++}
 },[load])
 const resume=async()=>{
  if(pending.current!==null||!canEdit||!safety?.paused_at)return
  const current=++request.current;pending.current=current;setBusy(true);setError('')
  try{
   await api.resumeWorkflow(workflowId,safety.generation)
   const result=await api.workflow(workflowId)
   const page=await readRunPage(api,workflowId,result.runs||[],failedOnly),source=page.runs.some(run=>run.status==='failed')?await readSourceThread():null
   if(current===request.current){setRuns(page.runs);setRunCursor(page.nextCursor);setHasMoreRuns(page.hasMore);setPageError('');setSummary(result.summary||null);setSourceThreadId(source);setSafety(result.workflow?.safety||null);setCanEdit(result.canEdit===true);setHeld(result.held||null);setIsWebhook(result.workflow?.trigger?.type==='webhook')}
  }catch(e){if(current===request.current)setError(e instanceof Error?e.message:String(e))}
  finally{if(pending.current===current)pending.current=null;if(current===request.current)setBusy(false)}
 }
 useEffect(()=>{
  if(!isOpen||busy||error||!runs?.some(run=>run.status==='running'||run.status==='waiting'))return
  const timer=setTimeout(()=>void load(0,failedOnly),10000)
  return ()=>clearTimeout(timer)
 },[isOpen,busy,error,runs,load,failedOnly])
 const loadMore=async()=>{
  if(!hasMoreRuns||!runCursor||loadingMore||busy)return
  const current=request.current;setLoadingMore(true);setPageError('')
  try{
   const page=await api.workflowRunsPage(workflowId,{limit:50,cursor:runCursor,...(failedOnly?{status:'failed'}:{})})
   const source=page.runs.some(run=>run.status==='failed')&&!sourceThreadId?await readSourceThread():sourceThreadId
   if(current===request.current){setRuns(previous=>{const existing=new Set((previous||[]).map(run=>run.id));return [...(previous||[]),...page.runs.filter(run=>!existing.has(run.id))]});setRunCursor(page.nextCursor);setHasMoreRuns(page.hasMore);if(source)setSourceThreadId(source)}
  }catch(e){if(current===request.current)setPageError(e instanceof Error?e.message:String(e))}
  finally{if(current===request.current)setLoadingMore(false)}
 }
 const reconcileExternalWrite=async(run:Run,operationId:string,outcome:'sent'|'not_sent')=>{
  if(!canEdit||typeof api.reconcileWorkflowExternalWrite!=='function'||reconcilingWrite)return
  setReconcilingWrite(true);setReconcileError('')
  try{
   await api.reconcileWorkflowExternalWrite(workflowId,run.id,run.startedAt,operationId,outcome)
   setExternalWriteCheck(null)
   await load(0,failedOnly)
  }catch(e){
   setReconcileError(e instanceof Error?e.message:String(e))
  }finally{setReconcilingWrite(false)}
 }
 const visibleRuns=runs||[]
 const orderedDays=groupRunsByStartDay(visibleRuns)
 return <details className="hx-run-history-panel" onToggle={e=>{opened.current=e.currentTarget.open;setIsOpen(opened.current);if(opened.current && runs===null && !busy)void load(0,failedOnly)}}><summary>{t('Run history')}</summary>
  {busy&&<p role="status">{t('Loading…')}</p>}{error&&<p role="alert">{error}</p>}
  {runs!==null&&!error&&<WorkflowRunSummaryCard summary={summary}/>}
  {safety?.paused_at&&<section className="form-note" role="status">
   <strong>{safety.pause_reason?.startsWith('budget_ai_')?t('Paused by estimated AI usage budget'):safety.pause_reason?.startsWith('budget_')?t('Paused by run budget'):t('Paused after three consecutive failures')}</strong>
   <p>{safety.pause_reason?.startsWith('budget_ai_unpriced')?t('Some AI usage could not be priced. Review the usage windows and budget settings. This workflow can run on its next trigger when all budget conditions are clear.'):safety.pause_reason?.startsWith('budget_ai_')?t('Review the usage windows and budget settings. This workflow can run on its next trigger when all budget conditions are clear.'):safety.pause_reason?.startsWith('budget_')?t('Review the usage windows and budget settings. This workflow can run on its next trigger when all budget conditions are clear.'):t('Review the failed runs below before resuming. Held events will not replay automatically.')}</p>
   {canEdit&&!safety.pause_reason?.startsWith('budget_')&&<button type="button" className="pill-btn" disabled={busy} onClick={()=>void resume()}>{t('Resume after review')}</button>}
  </section>}
  {isWebhook&&canEdit&&held&&<HeldWebhookEvents workflowId={workflowId} held={held} api={api} busy={busy} onRefresh={load}/>}
  {runs?.length===0&&!failedOnly&&<p>{t('No runs yet.')}</p>}
  {runs?.length===0&&failedOnly&&<p className="hx-run-empty">{t('No failed runs.')}</p>}
  {runs!==null&&<div className="hx-run-history">
   <div className="hx-run-history-tools"><button type="button" className="pill-btn quiet hx-run-filter" aria-pressed={failedOnly} disabled={busy||loadingMore} onClick={()=>{const next=!failedOnly;setFailedOnly(next);void load(0,next)}}>{t('Failed runs only')}</button></div>
   {visibleRuns.length===0&&failedOnly?<p className="hx-run-empty">{t('No failed runs.')}</p>:orderedDays.map(([key,group])=><section className="hx-run-day" key={key}><h4>{runDayLabel(group.date,getLocale(),t)}</h4>
    {group.runs.map(run=><details key={run.id}><summary>{runTimestampLabel(run.startedAt,getLocale(),t('Date unavailable'))} · {t(labels[run.status]||run.status)}{run.startedByName&&<> · {t('Run by')}: {run.startedByName}</>}{run.definitionRevision ? <span className="row-sub">{t('Version {version}',{version:run.definitionRevision})}</span> : run.definitionSnapshotAvailable===true ? <span className="row-sub">{t('Version not recorded')}</span> : run.definitionSnapshotAvailable===false ? <span className="row-sub">{t('Original definition snapshot unavailable')}</span> : null}{runDuration(run)!==null&&<> · <span title={t('Elapsed time, including approval waits')}>{runDuration(run)}</span></>}</summary>
     <WorkflowRunUsage usage={run.usage}/>
     {run.status==='failed'&&sourceThreadId&&orgId&&<a className="pill-btn quiet hx-run-ask" href={hashForThread(sourceThreadId,orgId)} title={t('Open the automation thread to ask how to recover without rerunning this workflow.')}>{t('Ask in chat')}</a>}
      <ol>{run.log.map((entry,index)=>{
       const stepUsage=run.usage?.steps.find(item=>item.stepNumber===entry.step)
       let stepUsageText:string|null=null
       if(stepUsage){
        const unpriced=stepUsage.unpricedCalls>0?' · '+t('{count} unpriced calls',{count:stepUsage.unpricedCalls.toLocaleString(getLocale())}):''
        stepUsageText=`${t('Input tokens')}: ${stepUsage.inputTokens.toLocaleString(getLocale())} · ${t('Output tokens')}: ${stepUsage.outputTokens.toLocaleString(getLocale())} · ${t('Estimated model cost')}: $${(stepUsage.estimatedMicros/1_000_000).toFixed(6)}${unpriced}`
       }
       return <li key={index}><strong>{entry.step}. {stepLabel(t,entry.type)} — {t(labels[entry.status]||entry.status)}</strong>{entry.inputPreview&&<details className="hx-run-input-preview"><summary>{t('Input template')}</summary>{entry.inputPreview.omitted?<p className="row-sub">{t('Preview omitted because the run trace size limit was reached.')}</p>:<><pre>{JSON.stringify(entry.inputPreview.input??{},null,2)}</pre><p className="row-sub">{t('Runtime record, message, and connection values are not retained.')}</p></>}</details>}{entry.effectReceipt&&<div className="hx-run-effect-receipt" aria-label={t('Effect receipt')}><span>{t('Operation')}: {t(entry.effectReceipt.operation)}</span><span>{t('Effect')}: {t(effectLabels[entry.effectReceipt.effect])}</span><span>{t('Target')}: {t(targetLabels[entry.effectReceipt.target])}</span><strong>{t(outcomeLabels[entry.effectReceipt.outcome])}</strong></div>}{!!entry.externalWrites?.length&&<section className="hx-run-external-writes"><strong>{t('External write receipts')}</strong><ol>{entry.externalWrites.map((receipt,receiptIndex)=>{
        const reconciliation=entry.externalWriteReconciliations?.find(item=>item.operationId===receipt.operationId)
        const selected=externalWriteCheck?.runId===run.id&&externalWriteCheck.operationId===receipt.operationId?externalWriteCheck:null
        return <li key={`${receipt.operationId}:${receiptIndex}`}><span>{receiptIndex+1}. {receipt.method} · {receipt.name}</span><code>{receipt.operationId}</code><strong className={receipt.status==='unknown'?'form-error':''}>{t(externalWriteStatusLabels[receipt.status])}</strong>
         {reconciliation&&<p className="row-sub">{t('Provider check recorded: {outcome} · {when}. The request was not resent.',{outcome:t(reconciliation.outcome==='sent'?'Confirmed sent':'Confirmed not sent'),when:new Date(reconciliation.checkedAt).toLocaleString(getLocale())})}</p>}
         {receipt.status==='unknown'&&!reconciliation&&canEdit&&typeof api.reconcileWorkflowExternalWrite==='function'&&<>
          <p className="row-sub">{t('This result is unknown. Check the provider directly before recording an outcome. Honmaru will not resend this request.')}</p>
          {!selected&&<div className="hx-actions"><button type="button" className="btn-text" disabled={busy||reconcilingWrite} onClick={()=>{setReconcileError('');setExternalWriteCheck({runId:run.id,operationId:receipt.operationId,outcome:'sent'})}}>{t('Provider confirms sent…')}</button><button type="button" className="btn-text" disabled={busy||reconcilingWrite} onClick={()=>{setReconcileError('');setExternalWriteCheck({runId:run.id,operationId:receipt.operationId,outcome:'not_sent'})}}>{t('Provider confirms not sent…')}</button></div>}
          {selected&&<section className="form-note"><p>{t('Record that the provider confirms {outcome}. This only annotates history; it will not resend the request.',{outcome:t(selected.outcome)})}</p><div className="hx-actions"><button type="button" className="pill-btn danger" disabled={busy||reconcilingWrite} onClick={()=>void reconcileExternalWrite(run,receipt.operationId,selected.outcome)}>{reconcilingWrite?t('Loading…'):t('Record provider check without resending')}</button><button type="button" className="btn-text" disabled={reconcilingWrite} onClick={()=>setExternalWriteCheck(null)}>{t('Cancel')}</button></div></section>}
         </>}
        </li>
       })}</ol><p className="row-sub">{t('Request bodies and credentials are not retained in these receipts.')}</p>{reconcileError&&<p role="alert" className="form-error">{reconcileError}</p>}</section>}{entry.error&&<p className="form-error">{entry.error}</p>}{entry.output&&<pre>{entry.output}</pre>}{!!entry.messages?.length&&<section className="hx-run-drafts"><strong>{t('Draft messages')}</strong>{entry.messages.map((draft,draftIndex)=><article key={draftIndex}><p>{draft.text}</p>{draft.mention!==undefined&&<small>{t('Mention')}: {Array.isArray(draft.mention)?draft.mention.join(', '):draft.mention}</small>}</article>)}</section>}
      {!!entry.authorization?.length&&<details className="hx-run-authorization"><summary>{t('Access checks')} · {entry.authorization.length}</summary><ul>{entry.authorization.map((event,eventIndex)=><li key={`${event.resourceType}:${event.resourceId}:${event.outcome}:${eventIndex}`}>{event.actorName&&<span>{t('Actor')}: {event.actorName}</span>}<span>{t('Resource')}: {t(authorizationResourceLabels[event.resourceType])} · <code>{event.resourceId}</code></span><strong className={event.outcome==='denied'?'form-error':''}>{t(event.outcome==='allowed'?'Allowed':'Denied')}</strong><time dateTime={event.checkedAt}>{new Date(event.checkedAt).toLocaleString(getLocale())}</time></li>)}</ul></details>}
      {stepUsageText&&<div className="hx-run-step-usage"><strong>{t('Step AI usage')}</strong><span>{stepUsageText}</span></div>}
      {entry.durationMs!==undefined&&Number.isFinite(entry.durationMs)&&<div className="hx-run-step-duration"><strong>{t('Step duration')}</strong><span>{stepDurationLabel(entry.durationMs)}</span></div>}
      {entry.operationId&&<div className="hx-run-operation-id"><strong>{t('Operation ID')}</strong><code>{entry.operationId}</code></div>}
     </li>})}</ol>
     <small>{t('Run ID: {id}',{id:run.id})}</small>
    </details>)}
   </section>)}
  </div>}
  {!!pageError&&<p role="alert">{pageError}</p>}
  {hasMoreRuns&&<button type="button" className="pill-btn quiet" disabled={busy||loadingMore} onClick={()=>void loadMore()}>{loadingMore?t('Loading older runs…'):pageError?t('Retry'):t('Load older runs')}</button>}
  <button type="button" className="pill-btn quiet" disabled={busy||loadingMore} onClick={()=>void load(0,failedOnly)}>{error||pageError?t('Retry'):t('Refresh history')}</button>
 </details>
}

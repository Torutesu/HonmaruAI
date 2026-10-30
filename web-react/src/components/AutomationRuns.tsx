import {WorkflowRunUsage} from './WorkflowRunUsage'
import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {HarnessApi,Run,WorkflowSafety} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import {groupRunsByStartDay,runDayLabel,runTimestampLabel} from '../utils/runHistory'
const labels:Record<string,string>={done:'Completed',running:'Running',waiting:'Waiting for approval',failed:'Failed',declined:'Declined',ok:'Succeeded',cancelled:'Cancelled'}
export {runDuration} from '../utils/runDuration'
import {runDuration} from '../utils/runDuration'

export function AutomationRuns({workflowId,api}:{workflowId:string;api:HarnessApi}) {
 const t=useT(),[runs,setRuns]=useState<Run[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[isOpen,setIsOpen]=useState(false),[failedOnly,setFailedOnly]=useState(false)
 const [safety,setSafety]=useState<WorkflowSafety|null>(null),[canEdit,setCanEdit]=useState(false)
 const request=useRef(0),pending=useRef<number|null>(null),opened=useRef(false)
 const load=useCallback(async()=>{
  if(pending.current!==null)return
  const current=++request.current;pending.current=current;setBusy(true);setError('')
  try{const result=await api.workflow(workflowId);if(current===request.current){setRuns(result.runs);setSafety(result.workflow?.safety||null);setCanEdit(result.canEdit===true)}}
  catch(e){if(current===request.current){setRuns(null);setSafety(null);setCanEdit(false);setError(e instanceof Error?e.message:String(e))}}
  finally{if(pending.current===current)pending.current=null;if(current===request.current)setBusy(false)}
 },[workflowId,api])
 useEffect(()=>{
  request.current++;pending.current=null;setRuns(null);setSafety(null);setCanEdit(false);setError('');setBusy(false);setFailedOnly(false)
  if(opened.current)void load()
  return ()=>{request.current++}
 },[load])
 const resume=async()=>{
  if(pending.current!==null||!canEdit||!safety?.paused_at)return
  const current=++request.current;pending.current=current;setBusy(true);setError('')
  try{
   await api.resumeWorkflow(workflowId,safety.generation)
   const result=await api.workflow(workflowId)
   if(current===request.current){setRuns(result.runs);setSafety(result.workflow?.safety||null);setCanEdit(result.canEdit===true)}
  }catch(e){if(current===request.current)setError(e instanceof Error?e.message:String(e))}
  finally{if(pending.current===current)pending.current=null;if(current===request.current)setBusy(false)}
 }
 useEffect(()=>{
  if(!isOpen||busy||error||!runs?.some(run=>run.status==='running'||run.status==='waiting'))return
  const timer=setTimeout(()=>void load(),10000)
  return ()=>clearTimeout(timer)
 },[isOpen,busy,error,runs,load])
 const visibleRuns=(runs||[]).filter(run=>!failedOnly||run.status==='failed')
 const orderedDays=groupRunsByStartDay(visibleRuns)
 return <details className="hx-run-history-panel" onToggle={e=>{opened.current=e.currentTarget.open;setIsOpen(opened.current);if(opened.current && runs===null && !busy)void load()}}><summary>{t('Run history')}</summary>
  {busy&&<p role="status">{t('Loading…')}</p>}{error&&<p role="alert">{error}</p>}
  {safety?.paused_at&&<section className="form-note" role="status"><strong>{safety.pause_reason?.startsWith('budget_ai_')?'AI使用量の概算上限に達したため停止しました':safety.pause_reason?.startsWith('budget_')?'実行上限に達したため自動停止しました':'3回連続の失敗により自動停止しました'}</strong><p>{safety.pause_reason?.startsWith('budget_ai_unpriced')?'単価不明の利用が直近期間から外れるか、上限設定を変更すると次のトリガーから再開します。':safety.pause_reason?.startsWith('budget_ai_')?'AI使用量の概算上限期間が切れると、次のトリガーから自動再開します。':safety.pause_reason?.startsWith('budget_')?'実行上限の期間が切れると自動再開します。':'下の履歴を確認してから再開してください。保留イベントは自動再生されません。'}</p>{canEdit&&!safety.pause_reason?.startsWith('budget_')&&<button type="button" className="pill-btn" disabled={busy} onClick={()=>void resume()}>確認して再開</button>}</section>}
  {runs?.length===0&&<p>{t('No runs yet.')}</p>}
  {!!runs?.length&&<div className="hx-run-history">
   <div className="hx-run-history-tools"><button type="button" className="pill-btn quiet hx-run-filter" aria-pressed={failedOnly} onClick={()=>setFailedOnly(value=>!value)}>{t('Failed runs only')}</button></div>
   {visibleRuns.length===0?<p className="hx-run-empty">{t('No failed runs.')}</p>:orderedDays.map(([key,group])=><section className="hx-run-day" key={key}><h4>{runDayLabel(group.date,getLocale(),t)}</h4>
    {group.runs.map(run=><details key={run.id}><summary>{runTimestampLabel(run.startedAt,getLocale(),t('Date unavailable'))} · {t(labels[run.status]||run.status)}{runDuration(run)!==null&&<> · <span title={t('Elapsed time, including approval waits')}>{runDuration(run)}</span></>}</summary>
     <WorkflowRunUsage usage={run.usage}/>
     <ol>{run.log.map((entry,index)=><li key={index}><strong>{entry.step}. {t(labels[entry.status]||entry.status)}</strong>{entry.error&&<p className="form-error">{entry.error}</p>}{entry.output&&<pre>{entry.output}</pre>}</li>)}</ol>
     <small>{t('Run ID: {id}',{id:run.id})}</small>
    </details>)}
   </section>)}
  </div>}
  <button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void load()}>{error?t('Retry'):t('Refresh history')}</button>
 </details>
}

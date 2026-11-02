import React,{useEffect,useRef,useState} from 'react'
import type {HarnessApi,WorkflowRevision,Table} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import {stepLabel,triggerLabel,type WorkflowAppOption} from '../utils/workflowLabels'
import {describeWorkflowCondition} from '../utils/workflowCondition'

export function WorkflowHistory({api,workflowId,tables=[],agents=[],apps=[],canRestore=false,currentUpdatedAt,safetyPaused=false,onRestore}:{api:HarnessApi;workflowId:string;tables?:Table[];agents?:Array<{id:string;name:string}>;apps?:WorkflowAppOption[];canRestore?:boolean;currentUpdatedAt?:string;safetyPaused?:boolean;onRestore?:(revision:number,confirmAutoPaused:boolean)=>Promise<void>|void}){
 const t=useT(),generation=useRef(0),pending=useRef(false)
 const [items,setItems]=useState<WorkflowRevision[]>([]),[cursor,setCursor]=useState<number|null>(null)
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [from,setFrom]=useState<number|null>(null),[to,setTo]=useState<number|null>(null)
 const [restoreRevision,setRestoreRevision]=useState<number|null>(null),[confirmRestore,setConfirmRestore]=useState(false),[restoring,setRestoring]=useState(false)
 useEffect(()=>()=>{generation.current++},[])
 const load=async(more=false)=>{
  if(pending.current)return
  pending.current=true;setBusy(true);setError('');const token=++generation.current
  try{
   const result=await api.workflowRevisions(workflowId,more?cursor??undefined:undefined)
   if(token!==generation.current)return
   const next=more?[...items,...result.items]:result.items
   setItems(next);setCursor(result.nextCursor);setLoaded(true)
   if(!more){setTo(next[0]?.revision??null);setFrom(next[1]?.revision??next[0]?.revision??null);setConfirmRestore(false)}
   else {setTo(value=>value??next[0]?.revision??null);setFrom(value=>value??next[1]?.revision??next[0]?.revision??null)}
   // Page contents are permission-filtered; the first page can contain no
   // older version even when a later page does. Keep a selection only while
   // that version is still available in the loaded results.
   setRestoreRevision(value=>next.slice(1).some(item=>item.revision===value)?value:next[1]?.revision??null)
  }catch(e){if(token===generation.current){setItems([]);setLoaded(false);setCursor(null);setError(e instanceof Error?e.message:String(e))}}
  finally{if(token===generation.current){pending.current=false;setBusy(false)}}
 }
 const before=items.find(item=>item.revision===from),after=items.find(item=>item.revision===to)
 const restoreTarget=items.find(item=>item.revision===restoreRevision)
 const restoreIsAutoPaused=Boolean(safetyPaused&&restoreTarget?.definition.enabled)
 const submitRestore=async()=>{
  if(!restoreTarget||!onRestore||!currentUpdatedAt||restoring)return
  setRestoring(true);setError('')
  try{await onRestore(restoreTarget.revision,restoreIsAutoPaused);setConfirmRestore(false)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setRestoring(false)}
 }
 const fields=[['name','Name'],['enabled','Automatic triggers'],['trigger','Trigger'],['steps','Steps']] as const
 const rowValue=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2)
 const display=(definition:WorkflowRevision['definition'],key:typeof fields[number][0])=>{
  if(key==='name')return <p>{definition.name}</p>
  if(key==='enabled')return <p>{t(definition.enabled?'On':'Off')}</p>
  if(key==='trigger')return <p>{triggerLabel(t,definition.trigger,tables,apps)}{definition.trigger.column&&<><br/>{tables.find(table=>table.id===definition.trigger.tableId)?.columns.find(column=>column.id===definition.trigger.column)?.name||definition.trigger.column}</>}</p>
  return <ol className="hx-revision-steps">{definition.steps.map((step,index)=><li key={index}>
   <strong>{stepLabel(t,step.type)}</strong>
   {step.type==='code'&&<><p>{t('Execution node')}: {step.gatewayId}</p><pre className="hx-program-source">{step.code}</pre></>}
   {step.channel&&<p>{step.channel.startsWith('ag:')||step.channel.startsWith('dm:')?t('Private chat'):step.channel.replace(/^b:/,'#')}</p>}
   {step.agentId&&<p>{t('Agent')}: {agents.find(agent=>agent.id===step.agentId)?.name||step.agentId}</p>}
   {step.tableId&&<p>{tables.find(table=>table.id===step.tableId)?.name||step.tableId}</p>}
   {step.rowId&&<p>ID: {step.rowId}</p>}
   {step.to&&<p>@{step.to}</p>}
   {[step.text,step.prompt,step.title,step.summary].filter(Boolean).map((text,index)=><p key={index}>{text}</p>)}
   {step.minutes!==undefined&&<p>{step.minutes} min</p>}
   {step.values&&<dl>{Object.entries(step.values).map(([column,value])=><React.Fragment key={column}><dt>{tables.find(table=>table.id===step.tableId)?.columns.find(item=>item.id===column)?.name||column}</dt><dd>{rowValue(value)}</dd></React.Fragment>)}</dl>}
   {step.when&&<div className="hx-flow-condition"><small>{t('Execution condition')}</small><p>{describeWorkflowCondition(step.when,tables.find(table=>table.id===definition.trigger.tableId)?.columns)}</p></div>}
  </li>)}</ol>
 }

 return <details className="hx-workflow-history" onToggle={event=>{if(event.currentTarget.open&&!loaded&&!error)void load()}}>
  <summary>{t('Definition history')}</summary>
  <p className="row-sub">{t('Only versions you can currently access are shown. Older history starts when tracking was enabled.')}</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {busy&&<p role="status">{t('Loading…')}</p>}
  {loaded&&!items.length&&<p>{t('No accessible versions on this page.')}</p>}
  {!!items.length&&<>
   {canRestore&&onRestore&&currentUpdatedAt&&items.some(item=>item.revision!==items[0]?.revision)&&<section className="hx-revision-restore" aria-label={t('Restore workflow version')}>
    <label>{t('Restore workflow version')} <select className="hx-cell-select" aria-label={t('Restore workflow version')} value={restoreRevision??''} disabled={restoring} onChange={e=>{setRestoreRevision(Number(e.target.value));setConfirmRestore(false)}}>
     {items.filter(item=>item.revision!==items[0]?.revision).map(item=><option key={item.revision} value={item.revision}>{t('Version {version}',{version:item.revision})} · {new Date(item.recordedAt).toLocaleString(getLocale())} · {item.definition.name}</option>)}
    </select></label>
    <p>{t('Restoring sets the name, automatic-trigger setting, trigger and steps from this version. It creates a new immutable version, does not start a run, and in-flight runs keep their saved definition. Safety pauses and budget limits stay as they are.')}</p>
    {restoreIsAutoPaused&&<p className="hx-revision-restore-warning">{t('This version enables automatic triggers. The workflow will remain safety-paused until you resume it separately.')}</p>}
    {!confirmRestore?<button className="pill-btn quiet" disabled={!restoreTarget||restoring} onClick={()=>setConfirmRestore(true)}>{t('Restore this version…')}</button>:<div className="hx-revision-restore-confirm" role="group" aria-label={t('Confirm restore')}>
     <p>{t('Restore version {version} as a new workflow definition?',{version:restoreTarget?.revision??''})}</p>
     <div className="hx-actions"><button className="pill-btn" disabled={restoring||!restoreTarget} onClick={()=>void submitRestore()}>{restoring?t('Restoring…'):t('Restore as new version')}</button><button className="btn-text" disabled={restoring} onClick={()=>setConfirmRestore(false)}>{t('Cancel')}</button></div>
    </div>}
   </section>}
   <div className="hx-inline">{([['Compare from',from,setFrom],['Compare to',to,setTo]] as const).map(([label,value,set])=><label key={label}>{t(label)} <select className="hx-cell-select" aria-label={t(label)} value={value??''} onChange={e=>set(Number(e.target.value))}>
    {items.map(item=><option key={item.revision} value={item.revision}>{t('Version {version}',{version:item.revision})} · {new Date(item.recordedAt).toLocaleString(getLocale())}</option>)}
   </select></label>)}</div>
   {before&&after&&<div className="hx-revision-changes">{fields.filter(([key])=>JSON.stringify(before.definition[key])!==JSON.stringify(after.definition[key])).map(([key,label])=><section key={key}>
    <h4>{t(label)}</h4><div className="hx-revision-pair"><div><small>{t('Before')}</small><div className="hx-revision-value">{display(before.definition,key)}</div></div><div><small>{t('After')}</small><div className="hx-revision-value">{display(after.definition,key)}</div></div></div>
   </section>)}{fields.every(([key])=>JSON.stringify(before.definition[key])===JSON.stringify(after.definition[key]))&&<p>{t('No definition changes between these versions.')}</p>}</div>}
  </>}
  <div className="hx-actions"><button className="btn-text" disabled={busy} onClick={()=>void load()}>{t('Refresh')}</button>{cursor!==null&&<button className="pill-btn quiet" disabled={busy} onClick={()=>void load(true)}>{t('Load older versions')}</button>}</div>
 </details>
}

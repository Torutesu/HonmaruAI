import React,{useEffect,useRef,useState} from 'react'
import type {HarnessApi,WorkflowRevision} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'

export function WorkflowHistory({api,workflowId}:{api:HarnessApi;workflowId:string}){
 const t=useT(),generation=useRef(0),pending=useRef(false)
 const [items,setItems]=useState<WorkflowRevision[]>([]),[cursor,setCursor]=useState<number|null>(null)
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [from,setFrom]=useState<number|null>(null),[to,setTo]=useState<number|null>(null)
 useEffect(()=>()=>{generation.current++},[])
 const load=async(more=false)=>{
  if(pending.current)return
  pending.current=true;setBusy(true);setError('');const token=++generation.current
  try{
   const result=await api.workflowRevisions(workflowId,more?cursor??undefined:undefined)
   if(token!==generation.current)return
   setItems(old=>more?[...old,...result.items]:result.items);setCursor(result.nextCursor);setLoaded(true)
   if(!more){setTo(result.items[0]?.revision??null);setFrom(result.items[1]?.revision??result.items[0]?.revision??null)}
  }catch(e){if(token===generation.current){setItems([]);setLoaded(false);setCursor(null);setError(e instanceof Error?e.message:String(e))}}
  finally{if(token===generation.current){pending.current=false;setBusy(false)}}
 }
 const before=items.find(item=>item.revision===from),after=items.find(item=>item.revision===to)
 const fields=[['name','Name'],['enabled','Automatic triggers'],['trigger','Trigger'],['steps','Steps']] as const
 const display=(value:unknown)=>typeof value==='boolean'?t(value?'On':'Off'):typeof value==='string'?value:JSON.stringify(value,null,2)
 return <details className="hx-workflow-history" onToggle={event=>{if(event.currentTarget.open&&!loaded&&!error)void load()}}>
  <summary>{t('Definition history')}</summary>
  <p className="row-sub">{t('Only versions you can currently access are shown. Older history starts when tracking was enabled.')}</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {busy&&<p role="status">{t('Loading…')}</p>}
  {loaded&&!items.length&&<p>{t('No accessible versions on this page.')}</p>}
  {!!items.length&&<>
   <div className="hx-inline">{([['Compare from',from,setFrom],['Compare to',to,setTo]] as const).map(([label,value,set])=><label key={label}>{t(label)} <select aria-label={t(label)} value={value??''} onChange={e=>set(Number(e.target.value))}>
    {items.map(item=><option key={item.revision} value={item.revision}>{t('Version {version}',{version:item.revision})} · {new Date(item.recordedAt).toLocaleString(getLocale())}</option>)}
   </select></label>)}</div>
   {before&&after&&<div className="hx-revision-changes">{fields.filter(([key])=>JSON.stringify(before.definition[key])!==JSON.stringify(after.definition[key])).map(([key,label])=><section key={key}>
    <h4>{t(label)}</h4><div className="hx-revision-pair"><div><small>{t('Before')}</small><pre>{display(before.definition[key])}</pre></div><div><small>{t('After')}</small><pre>{display(after.definition[key])}</pre></div></div>
   </section>)}{fields.every(([key])=>JSON.stringify(before.definition[key])===JSON.stringify(after.definition[key]))&&<p>{t('No definition changes between these versions.')}</p>}</div>}
  </>}
  <div className="hx-actions"><button className="btn-text" disabled={busy} onClick={()=>void load()}>{t('Refresh')}</button>{cursor!==null&&<button className="pill-btn quiet" disabled={busy} onClick={()=>void load(true)}>{t('Load older versions')}</button>}</div>
 </details>
}

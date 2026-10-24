import React,{useCallback,useEffect,useRef,useState} from 'react'
import type {HarnessApi,WorkflowNotice} from '../utils/harness'
import {getLocale} from '../utils/locale'
import {useT} from '../utils/i18n'
export function WorkflowNotices({api,onOpen}:{api:HarnessApi;onOpen:(id:string)=>void}){
 const t=useT(),version=useRef(0)
 const [items,setItems]=useState<WorkflowNotice[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const pending=useRef(false)
 const load=useCallback(async()=>{
  if(pending.current)return
  const current=++version.current;pending.current=true;setBusy(true);setError('')
  try{const result=await api.workflowNotices();if(current===version.current)setItems(result.items)}
  catch(e){if(current===version.current){setItems([]);setError(e instanceof Error?e.message:String(e))}}
  finally{if(current===version.current){pending.current=false;setBusy(false)}}
 },[api])
 useEffect(()=>{version.current++;pending.current=false;setItems([]);void load();return()=>{version.current++}},[load])
 const read=async(item:WorkflowNotice)=>{
  if(pending.current)return
  const current=++version.current;pending.current=true;setBusy(true);setError('')
  try{
   await api.readWorkflowNotice(item.workflowId,item.generation)
   const result=await api.workflowNotices()
   if(current===version.current)setItems(result.items)
  }catch(e){if(current===version.current){setItems([]);setError(e instanceof Error?e.message:String(e))}}
  finally{if(current===version.current){pending.current=false;setBusy(false)}}
 }
 return <section aria-label={t('Automation notifications')}>
  <details><summary>{t('Automation notifications')} · {busy||error?'—':items.filter(n=>!n.readAt).length} {t('unread')}</summary>
   {error&&<p role="alert" className="form-error">{error}</p>}
   {busy&&<p role="status">{t('Loading…')}</p>}
   {!busy&&!error&&!items.length&&<p>{t('No automation notifications.')}</p>}
   <div className="rows">{items.map(item=><div className="row static" key={item.workflowId+':'+item.generation}>
    <div className="row-main"><strong>{item.name}</strong><span className="row-sub">{item.paused?t('Paused after failures'):t('Previous failure pause')}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(getLocale())}</time>
     <div className="hx-actions"><button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>onOpen(item.workflowId)}>{t('Review workflow')}</button>{!item.readAt&&<button type="button" className="btn-text" disabled={busy} onClick={()=>void read(item)}>{t('Mark as read')}</button>}</div>
    </div>
   </div>)}</div>
   <button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void load()}>{t('Refresh notifications')}</button>
  </details>
 </section>
}

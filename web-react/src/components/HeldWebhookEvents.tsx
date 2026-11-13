import React,{useRef,useState} from 'react'
import type {HarnessApi,HeldWorkflowEvents} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'

type HeldEvent=HeldWorkflowEvents['events'][number]

export function HeldWebhookEvents({workflowId,held,api,busy,onRefresh}:{workflowId:string;held:HeldWorkflowEvents;api:HarnessApi;busy:boolean;onRefresh:(offset:number)=>Promise<void>}){
 const inspectGeneration=useRef(0)
 const t=useT(),[selected,setSelected]=useState<string[]>([]),[inspected,setInspected]=useState<string|null>(null),[payload,setPayload]=useState<unknown>(null),[payloadLoaded,setPayloadLoaded]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const format=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?t('Date unavailable'):date.toLocaleString(getLocale())}
 const toggle=(id:string)=>setSelected(ids=>ids.includes(id)?ids.filter(item=>item!==id):[...ids,id])
 const selectVisible=()=>setSelected(held.events.map(event=>event.id))
 const runAction=async(action:'replay'|'discard')=>{
  if(pending||busy||!selected.length)return
  const ids=[...selected]
  const confirmed=globalThis.confirm(action==='replay'?t('Replay {count} held webhook event(s)? This starts workflow runs and may perform their configured actions.',{count:ids.length}):t('Discard {count} held webhook event(s)? This cannot be undone.',{count:ids.length}))
  if(!confirmed)return
  setPending(true);setError('');setNotice('')
  try{
   if(action==='replay'){
    const result=await api.replayWorkflowEvents(workflowId,ids)
    setNotice(t('Started {count} held event(s); {skipped} were skipped.',{count:result.runs.length,skipped:result.skipped}))
   }else{
    const result=await api.discardWorkflowEvents(workflowId,ids)
    setNotice(t('Discarded {count} held event(s).',{count:result.discarded}))
   }
   setSelected([]);inspectGeneration.current++;setInspected(null);setPayload(null);setPayloadLoaded(false)
   await onRefresh(held.pageOffset||0)
  }catch(reason){setError(reason instanceof Error?reason.message:String(reason))}
  finally{setPending(false)}
 }
 const inspect=async(event:HeldEvent)=>{
  if(pending||busy)return
  if(inspected===event.id){inspectGeneration.current++;setInspected(null);setPayload(null);setPayloadLoaded(false);return}
  const generation=++inspectGeneration.current
  setInspected(event.id);setPayload(null);setPayloadLoaded(false);setError('')
  try{const result=await api.heldWorkflowEvent(workflowId,event.id);if(inspectGeneration.current===generation){setPayload(result.event.input);setPayloadLoaded(true)}}
  catch(reason){if(inspectGeneration.current===generation)setError(reason instanceof Error?reason.message:String(reason))}
 }
 const safePayload=payload===null?'null':JSON.stringify(payload,null,2)
 const clipped=typeof safePayload==='string'&&safePayload.length>12000?`${safePayload.slice(0,12000)}\n…`:safePayload
 return <section className="hx-held-webhook-events" aria-label={t('Held webhook events')}>
  <header><div><h4>{t('Held webhook events')}</h4><p>{t('{count} events · kept for up to 7 days',{count:held.count})}{held.oldestExpiry?` · ${t('Oldest expires {date}',{date:format(held.oldestExpiry)})}`:''}</p></div><button type="button" className="pill-btn quiet" disabled={busy||pending} onClick={()=>void onRefresh(held.pageOffset||0)}>{t('Refresh held events')}</button></header>
  {!!held.events.length&&<div className="hx-held-webhook-tools"><button type="button" className="pill-btn quiet" disabled={busy||pending} onClick={selectVisible}>{t('Select page')}</button><button type="button" className="pill-btn quiet" disabled={busy||pending||!selected.length} onClick={()=>void runAction('replay')}>{t('Replay selected')}</button><button type="button" className="pill-btn quiet danger" disabled={busy||pending||!selected.length} onClick={()=>void runAction('discard')}>{t('Discard selected')}</button><span>{t('{count} selected',{count:selected.length})}</span></div>}
  {held.events.length===0?<p>{t('No held webhook events.')}</p>:<ul>{held.events.map(event=><li key={event.id}>
   <label><input type="checkbox" checked={selected.includes(event.id)} disabled={busy||pending} onChange={()=>toggle(event.id)}/><span><strong>{t('Received {date}',{date:format(event.receivedAt)})}</strong><small>{t('Expires {date}',{date:format(event.expiresAt)})} · <code>{event.id}</code></small></span></label>
   <button type="button" className="pill-btn quiet" disabled={busy||pending} aria-expanded={inspected===event.id} onClick={()=>void inspect(event)}>{inspected===event.id?t('Hide payload'):t('Review payload')}</button>
   {inspected===event.id&&(payloadLoaded?<pre>{clipped}</pre>:<small role="status">{t('Loading…')}</small>)}
  </li>)}</ul>}
  {(held.previousOffset!==null&&held.previousOffset!==undefined||held.nextOffset!==null&&held.nextOffset!==undefined)&&<nav aria-label={t('Held event pages')}><button type="button" className="pill-btn quiet" disabled={busy||pending||held.previousOffset==null} onClick={()=>{setSelected([]);inspectGeneration.current++;setInspected(null);setPayload(null);setPayloadLoaded(false);void onRefresh(held.previousOffset!)}}>{t('Previous')}</button><span>{t('Page {page}',{page:Math.floor((held.pageOffset||0)/25)+1})}</span><button type="button" className="pill-btn quiet" disabled={busy||pending||held.nextOffset==null} onClick={()=>{setSelected([]);inspectGeneration.current++;setInspected(null);setPayload(null);setPayloadLoaded(false);void onRefresh(held.nextOffset!)}}>{t('Next')}</button></nav>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 </section>
}

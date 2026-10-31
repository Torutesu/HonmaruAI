import {Icon} from './Icon'
import {composing} from '../utils/keys'
import {hashForThread} from '../utils/route'
import {useT} from '../utils/i18n'
import React,{useEffect,useId,useRef,useState} from 'react'
type Api={httpBase:string;orgId:string;sessionToken:string}
type HookEvent={messageId:string;hookId:string;createdAt:string;status:string;version?:number;canRetry?:boolean}
const eventLabels:Record<string,string>={external_running:'External agent working',external_failed:'External agent failed or reached its limit',external_finished:'External processing ended',pending:'Waiting for dispatch',queued:'Queued',running:'Running',answered:'Reply saved',finished:'Processing ended',failed:'Failed',interrupted:'Interrupted',cancelled:'Cancelled',no_agents:'No responding agent',unknown:'Status unavailable'}
type Hook={id:string;name:string;version:number;revokedAt:string|null;provider?:'room'|'line'}
export function RoomWebhooks({api,channel,onOpenThread}:{api:Api;channel:string;onOpenThread?:()=>void}) {
 return <ScopedRoomWebhooks key={JSON.stringify([api.httpBase,api.orgId,api.sessionToken,channel])} api={api} channel={channel} onOpenThread={onOpenThread}/>
}
function ScopedRoomWebhooks({api,channel,onOpenThread}:{api:Api;channel:string;onOpenThread?:()=>void}) {
 const t=useT(),nameId=useId()
 const [hooks,setHooks]=useState<Hook[]>([]),[name,setName]=useState(''),[provider,setProvider]=useState<'room'|'line'>('room'),[channelSecret,setChannelSecret]=useState(''),[lineSecretDrafts,setLineSecretDrafts]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[loaded,setLoaded]=useState(false)
 const [credential,setCredential]=useState<{id:string;secret?:string;provider:'room'|'line'}|null>(null)
 const [copyNotice,setCopyNotice]=useState('')
 const copyGeneration=useRef(0)
 const [events,setEvents]=useState<HookEvent[]>([])
 const [retryConfirm,setRetryConfirm]=useState<string|null>(null)
 const generation=useRef(0),alive=useRef(true),pending=useRef(false),controller=useRef<AbortController|null>(null)
 useEffect(()=>{alive.current=true;pending.current=false;return()=>{generation.current++;alive.current=false;controller.current?.abort()}},[])
 const run=async(method:'GET'|'POST'|'PUT',input?:object)=>{
  if(pending.current)return
  const scope=generation.current
  pending.current=true;setBusy(true);setError('');setCredential(null);setCopyNotice('');copyGeneration.current++
  const abort=new AbortController();controller.current=abort
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
   const data=await Promise.race([(async()=>{
    const response=await fetch(`${api.httpBase}/hx/rooms/webhooks?${new URLSearchParams({orgId:api.orgId,channel})}`,{method,headers:{'content-type':'application/json','x-session-token':api.sessionToken},signal:abort.signal,...(method==='GET'?{}:{body:JSON.stringify({orgId:api.orgId,channel,...input})})})
    const body=await response.json();if(!response.ok)throw Error(body.message||t("The request failed."));return body
   })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error(t("The request timed out.")))},15000)})])
   if(!alive.current||scope!==generation.current)return
   if(method==='GET'){setHooks(data.hooks);setEvents(data.events||[]);setRetryConfirm(null);setUncertain(false);setLoaded(true)}
   else if(method==='POST'){setHooks(items=>[...items,{...data.hook,revokedAt:null}]);setName('');setChannelSecret('');setCredential({id:data.hook.id,secret:data.secret,provider:data.hook.provider||'room'})}
   else {
    const change=input as {id:string;action:string;messageId?:string}
    if(change.action==='retry'){setEvents(items=>items.map(item=>item.messageId===change.messageId?{...item,status:'queued',canRetry:false}:item));setRetryConfirm(null);return}
    setHooks(items=>items.map(item=>item.id===change.id?{...item,version:data.version,revokedAt:change.action==='revoke'?new Date().toISOString():item.revokedAt}:item))
    if(change.action==='replace-line-secret')setLineSecretDrafts(items=>({...items,[change.id]:''}))
    if(data.secret)setCredential({id:change.id,secret:data.secret,provider:'room'})
   }
  }catch(e){if(alive.current&&scope===generation.current){setError(e instanceof Error?e.message:String(e));if(method!=='GET')setUncertain(true)}}
  finally{clearTimeout(timer);if(alive.current&&scope===generation.current){pending.current=false;setBusy(false)}}
 }
 const copyCredential=async(value:string)=>{
  const generation=++copyGeneration.current
  setCopyNotice('')
  let message='Could not copy. Select and copy the value manually.'
  try {if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);message='Copied'}} catch {}
  if(alive.current&&copyGeneration.current===generation)setCopyNotice(message)
 }
 useEffect(()=>{void run('GET')},[])
 return <section aria-label={t("Manage webhooks")} className="room-webhooks">
  <label className="dlg-label" htmlFor={nameId}>{t("Name")}</label>
  <form className={`room-webhooks-create${provider==='line'?' line':''}`} onSubmit={e=>{e.preventDefault();if(loaded&&!busy&&!uncertain&&name.trim())void run('POST',{name:name.trim(),provider,...(provider==='line'?{channelSecret}:{})})}}><input id={nameId} className="dlg-input" value={name} maxLength={120} placeholder={t("e.g. Deployment notifications")} disabled={busy||uncertain} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&composing(e))e.preventDefault()}}/>
  <label className="dlg-label">{t("Integration type")}<select className="dlg-input" value={provider} disabled={busy||uncertain} onChange={e=>setProvider(e.target.value==='line'?'line':'room')}><option value="room">{t("Room webhook")}</option><option value="line">{t("LINE Official Account")}</option></select></label>
  {provider==='line'&&<label className="dlg-label">{t("LINE channel secret")}<input className="dlg-input" type="password" autoComplete="new-password" value={channelSecret} maxLength={256} disabled={busy||uncertain} onChange={e=>setChannelSecret(e.target.value)} /></label>}
  <button type="submit" className="dlg-btn primary" disabled={busy||uncertain||!loaded||!name.trim()||(provider==='line'&&channelSecret.trim().length<16)}>{provider==='line'?t("Connect LINE") : t("Create webhook")}</button></form>
  {busy&&<p role="status">{t("Working\u2026")}</p>}
  {error&&<p role="alert" className="dlg-error">{t(error)} {uncertain&&t("The save result is uncertain. Reload the list to check.")}</p>}
  {(error||hooks.length>0||events.length>0)&&<button type="button" className="dlg-btn" disabled={busy} onClick={()=>void run('GET')}>{t("Reload list")}</button>}
  {credential&&<div className="room-settings-response-card" role="status">
   {credential.provider==='room'&&<p>{t("This secret is shown only now. Save it somewhere safe.")}</p>}
   <label className="room-settings-field">{t("Webhook URL")}<input className="dlg-input" readOnly value={`${api.httpBase}/hooks/${credential.provider==='line'?'line':'rooms'}/${credential.id}`}/></label><button type="button" className="dlg-btn room-webhook-copy" onClick={()=>void copyCredential(`${api.httpBase}/hooks/${credential.provider==='line'?'line':'rooms'}/${credential.id}`)}><Icon name="copy" size={14}/>{t('Copy webhook URL')}</button>
   {credential.provider==='room'&&<><label className="room-settings-field">{t("Authorization header")}<input className="dlg-input" readOnly value={`Bearer ${credential.secret||''}`}/></label><button type="button" className="dlg-btn room-webhook-copy" onClick={()=>void copyCredential(`Bearer ${credential.secret||''}`)}><Icon name="copy" size={14}/>{t('Copy authorization header')}</button><p>{t("Send eventId and body in JSON. Retries with the same eventId use the same conversation.")}</p></>}
   {credential.provider==='line'&&<p>{t("Set this URL in the LINE Developers Messaging API webhook settings. LINE text messages are verified and posted to this room; automatic AI replies and media downloads stay off.")}</p>}
   {copyNotice&&<p role="status">{t(copyNotice)}</p>}
   <button type="button" className="dlg-btn" onClick={()=>{setCredential(null);setCopyNotice('');copyGeneration.current++}}>{t("Hide secret")}</button>
  </div>}
  {loaded&&!busy&&!error&&!hooks.length&&<p>{t("No webhooks yet.")}</p>}
  <ul>{hooks.map(hook=><li key={hook.id}><strong>{hook.name}</strong> <span>{hook.provider==='line'?t('LINE Official Account'):t('Room webhook')}</span> {hook.revokedAt?<span>{t("Revoked")}</span>:<>
   {hook.provider==='line'&&<button type="button" className="dlg-btn room-webhook-copy" onClick={()=>void copyCredential(`${api.httpBase}/hooks/line/${hook.id}`)}><Icon name="copy" size={14}/>{t('Copy webhook URL')}</button>}
   {hook.provider==='line'&&<details className="room-webhook-line-secret"><summary>{t('Replace channel secret')}</summary><form onSubmit={e=>{e.preventDefault();const draft=lineSecretDrafts[hook.id]||'';if(!busy&&!uncertain&&draft.trim().length>=16)void run('PUT',{id:hook.id,version:hook.version,action:'replace-line-secret',channelSecret:draft})}}><input className="dlg-input" type="password" autoComplete="new-password" maxLength={256} value={lineSecretDrafts[hook.id]||''} aria-label={t('LINE channel secret')} onChange={e=>setLineSecretDrafts(items=>({...items,[hook.id]:e.target.value}))}/><button type="submit" className="dlg-btn" disabled={busy||uncertain||(lineSecretDrafts[hook.id]||'').trim().length<16}>{t('Save channel secret')}</button></form></details>}
   {hook.provider!=='line'&&<button type="button" className="dlg-btn" disabled={busy||uncertain} onClick={()=>void run('PUT',{id:hook.id,version:hook.version,action:'rotate'})}>{t("Rotate key")}</button>}
   <button type="button" className="dlg-btn" disabled={busy||uncertain} onClick={()=>void run('PUT',{id:hook.id,version:hook.version,action:'revoke'})}>{t("Revoke")}</button>
  </>}</li>)}</ul>
  {events.length>0&&<section className="room-webhook-events" aria-label={t('Recent webhook events')}><h3>{t('Recent webhook events')}</h3><ul>{events.map(event=><li key={event.messageId}><div><strong>{hooks.find(h=>h.id===event.hookId)?.name||'Webhook'}</strong><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div><a className="room-webhook-thread-link" href={hashForThread(event.messageId,api.orgId)} aria-disabled={busy} onClick={e=>{if(busy)e.preventDefault();else onOpenThread?.()}}>{t('View conversation')}</a><span>{t(eventLabels[event.status]||'Status unavailable')}</span>{event.canRetry&&<button type="button" className="dlg-btn" disabled={busy||uncertain} onClick={()=>event.status==='interrupted'?setRetryConfirm(event.messageId):void run('PUT',{action:'retry',messageId:event.messageId,version:event.version})}>{t('Retry execution')}</button>}{retryConfirm===event.messageId&&<div className="room-webhook-retry-confirm"><p>{t('The previous execution may have reached the external service. Retrying may repeat its work. Check the existing result first.')}</p><button type="button" className="dlg-btn" disabled={busy||uncertain} onClick={()=>void run('PUT',{action:'retry',messageId:event.messageId,version:event.version,confirmInterrupted:true})}>{t('Retry this interrupted execution')}</button><button type="button" className="dlg-btn" disabled={busy} onClick={()=>setRetryConfirm(null)}>{t('Cancel')}</button></div>}</li>)}</ul></section>}
 </section>
}

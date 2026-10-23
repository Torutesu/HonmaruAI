import React,{useCallback,useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {RoomColorPicker} from './RoomColorPicker'
import {ROOM_COLORS} from '../utils/roomColors'
import {useT} from '../utils/i18n'
import './RoomSettings.css'
export interface RoomSettingsValue {name:string;color:keyof typeof ROOM_COLORS;mentionedOnly:boolean;version:number;responseVersion:number}
interface Loaded {settings:RoomSettingsValue;canEdit:boolean;canChangeResponses:boolean}
export function RoomSettings({api,view,onClose,onSaved}:{api:{httpBase:string;orgId:string;sessionToken:string};view:string;onClose:()=>void;onSaved:()=>void}){
 const t=useT(),[data,setData]=useState<Loaded|null>(null),[draft,setDraft]=useState<RoomSettingsValue|null>(null)
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false)
 const scope=useRef(0),reads=useRef(0),pending=useRef(false)
 const load=useCallback(async()=>{
  const generation=scope.current,read=++reads.current
  setLoading(true);setError('');setConflict(false)
  try{
   const response=await fetch(`${api.httpBase}/hx/rooms/settings?${new URLSearchParams({orgId:api.orgId,channel:view})}`,{headers:{'x-session-token':api.sessionToken}})
   const result=await response.json();if(!response.ok)throw Error(result.message||'Room settings could not be loaded.')
   if(generation!==scope.current||read!==reads.current)return
   setData(result);setDraft(result.settings)
  }catch(e){if(generation===scope.current&&read===reads.current){setData(null);setError(e instanceof Error?e.message:String(e))}}
  finally{if(generation===scope.current&&read===reads.current)setLoading(false)}
 },[api.httpBase,api.orgId,api.sessionToken,view])
 useEffect(()=>{scope.current++;setData(null);setDraft(null);void load();return()=>{scope.current++;reads.current++}},[load])
 const changed=!!data&&!!draft&&(draft.name.trim()!==data.settings.name||draft.color!==data.settings.color||draft.mentionedOnly!==data.settings.mentionedOnly)
 const save=async()=>{
  if(pending.current||!data?.canEdit||!draft||!draft.name.trim()||!changed||conflict||loading)return
  pending.current=true;setBusy(true);setError('');const generation=scope.current
  try{
   const response=await fetch(`${api.httpBase}/hx/rooms/settings`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel:view,...draft,name:draft.name.trim()})})
   const result=await response.json()
   if(generation!==scope.current)return
   if(!response.ok){if(response.status===409)setConflict(true);throw Error(result.message||'That did not save.')}
   onSaved();onClose()
  }catch(e){if(generation===scope.current)setError(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;if(generation===scope.current)setBusy(false)}
 }
 const disabled=busy||loading||!data?.canEdit||conflict
 return <Dialog className="room-settings" title={t('Room settings')} onClose={()=>{if(!pending.current)onClose()}}
  footer={<><button className="dlg-btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="dlg-btn primary" disabled={disabled||!draft?.name.trim()||!changed} onClick={()=>void save()}>{t(busy?'Saving…':'Save')}</button></>}>
  {loading&&<p role="status">{t('Loading…')}</p>}
  {draft&&<>
   <div className="room-settings-field"><span className="dlg-label">{t('Room icon')}</span><RoomColorPicker color={draft.color} disabled={disabled} onChange={color=>setDraft({...draft,color})}/></div>
   <label className="room-settings-field"><span className="dlg-label">{t('Room name')}</span><input className="dlg-input" aria-label={t('Room name')} value={draft.name} maxLength={120} disabled={disabled} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
   <section className="room-settings-response" aria-label={t('How agents respond')}><h3>{t('How agents respond')}</h3>
    <label><span>{t('Mentioned only')}</span><input type="checkbox" role="switch" checked={draft.mentionedOnly} disabled={disabled||!data?.canChangeResponses} onChange={e=>setDraft({...draft,mentionedOnly:e.target.checked})}/></label>
    <p>{t('Agents respond when mentioned. When off, clear requests can be assigned to an available agent.')}</p>
   </section>
   {data&&!data.canEdit&&<p className="room-settings-note">{t('Join this room to edit its settings.')}</p>}
  </>}
  {error&&<div role="alert" className="dlg-error">{t(error)} {(!data||conflict)&&<button type="button" disabled={busy||loading} onClick={()=>void load()}>{t('Reload latest settings')}</button>}</div>}
 </Dialog>
}

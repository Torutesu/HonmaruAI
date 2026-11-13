import React,{useCallback,useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {RoomVisualEditor} from './RoomVisualEditor'
import {RoomWebhooks} from './RoomWebhooks'
import {ROOM_COLORS} from '../utils/roomColors'
import {useT} from '../utils/i18n'
import './RoomSettings.css'
async function boundedRequest<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
 try{return await Promise.race([work(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('通信がタイムアウトしました。最新の設定を読み込んでください。'));controller.abort()},15000)})])}
 finally{clearTimeout(timer)}
}
export interface RoomSettingsValue {name:string;color:keyof typeof ROOM_COLORS;mentionedOnly:boolean;defaultAgentId:string|null;isDefault:boolean;fixedMembership:boolean;version:number;responseVersion:number}
interface Loaded {visualVersion?:number;scope:'public'|'private';canChangeVisibility:boolean;canChangeRoomPolicies:boolean;canChangeDefault:boolean;isPrivate:boolean;settings:RoomSettingsValue;availableAgents:{id:string;name:string;emoji?:string|null;specialty:string}[];canEdit:boolean;canChangeResponses:boolean}
export function RoomSettings({api,view,onClose,onSaved}:{api:{httpBase:string;orgId:string;sessionToken:string};view:string;onClose:()=>void;onSaved:()=>void}){
 const t=useT(),[data,setData]=useState<Loaded|null>(null),[draft,setDraft]=useState<RoomSettingsValue|null>(null)
 const [visibilityDraft,setVisibilityDraft]=useState<'public'|'private'|null>(null)
 const [visualBusy,setVisualBusy]=useState(false)
 const [hooksOpen,setHooksOpen]=useState(false)
 const visualScope=JSON.stringify([api.httpBase,api.orgId,api.sessionToken,view]),currentVisualScope=useRef(visualScope);currentVisualScope.current=visualScope
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false)
 const scope=useRef(0),reads=useRef(0),pending=useRef(false)
 const load=useCallback(async()=>{
  const generation=scope.current,read=++reads.current
  setLoading(true);setError('');setConflict(false)
  try{
   const result=await boundedRequest(async signal=>{
   const response=await fetch(`${api.httpBase}/hx/rooms/settings?${new URLSearchParams({orgId:api.orgId,channel:view})}`,{headers:{'x-session-token':api.sessionToken},signal})
   const result=await response.json();if(!response.ok)throw Error(result.message||'Room settings could not be loaded.')
   return result
   })
   if(generation!==scope.current||read!==reads.current)return
   setData(result);setDraft(result.settings);setVisibilityDraft(result.scope||'private')
  }catch(e){if(generation===scope.current&&read===reads.current){setData(null);setError(e instanceof Error?e.message:String(e))}}
  finally{if(generation===scope.current&&read===reads.current)setLoading(false)}
 },[api.httpBase,api.orgId,api.sessionToken,view])
 useEffect(()=>{scope.current++;pending.current=false;setBusy(false);setVisualBusy(false);setHooksOpen(false);setData(null);setDraft(null);void load();return()=>{scope.current++;reads.current++}},[load])
 const changed=!!data&&!!draft&&(draft.name.trim()!==data.settings.name||draft.color!==data.settings.color||draft.mentionedOnly!==data.settings.mentionedOnly||draft.defaultAgentId!==data.settings.defaultAgentId||draft.isDefault!==data.settings.isDefault||draft.fixedMembership!==data.settings.fixedMembership)
 const visibilityChanged=!!data&&!!visibilityDraft&&visibilityDraft!==data.scope
 const save=async()=>{
  if(visualBusy||pending.current||!data?.canEdit||!draft||!draft.name.trim()||!changed||visibilityChanged||conflict||loading)return
  pending.current=true;setBusy(true);setError('');const generation=scope.current;let confirmed=false
  try{
   const {response,result}=await boundedRequest(async signal=>{
   const response=await fetch(`${api.httpBase}/hx/rooms/settings`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel:view,...draft,name:draft.name.trim()}),signal})
   const result=await response.json();return {response,result}
   });confirmed=true
   if(generation!==scope.current)return
   if(!response.ok){if(response.status===409)setConflict(true);throw Error(result.message||'That did not save.')}
   onSaved();onClose()
  }catch(e){if(generation===scope.current){if(!confirmed){setConflict(true);setError('保存結果を確認できませんでした。入力内容は保持しています。最新の設定を読み込み、保存済みか確認してください。')}else setError(e instanceof Error?e.message:String(e))}}
  finally{if(generation===scope.current){pending.current=false;setBusy(false)}}
 }
 const saveVisibility=async()=>{
  if(visualBusy||pending.current||!data?.canChangeVisibility||!visibilityDraft||!visibilityChanged||changed||conflict||loading)return
  pending.current=true;setBusy(true);setError('');const generation=scope.current;let confirmed=false
  try{
   const {response,result}=await boundedRequest(async signal=>{
    const response=await fetch(`${api.httpBase}/hx/rooms/visibility`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel:view,scope:visibilityDraft,version:data.settings.version}),signal})
    const result=await response.json();return {response,result}
   });confirmed=true
   if(generation!==scope.current)return
   if(!response.ok){if(response.status===409)setConflict(true);throw Error(result.message||'That did not save.')}
   onSaved();await load()
  }catch(e){if(generation===scope.current){if(!confirmed){setConflict(true);setError('保存結果を確認できませんでした。入力内容は保持しています。最新の設定を読み込み、保存済みか確認してください。')}else setError(e instanceof Error?e.message:String(e))}}
  finally{if(generation===scope.current){pending.current=false;setBusy(false)}}
 }
 const disabled=visualBusy||busy||loading||!data?.canEdit||conflict
 return <><Dialog className="room-settings" title={t('Room settings')} onClose={()=>{if(!pending.current&&!visualBusy)onClose()}}
  footer={<><button className="dlg-btn" disabled={busy||visualBusy} onClick={onClose}>{t('Cancel')}</button><button className="dlg-btn primary" disabled={disabled||visibilityChanged||!draft?.name.trim()||!changed} onClick={()=>void save()}>{t(busy?'Saving…':'Save')}</button></>}>
  {loading&&<p role="status">{t('Loading…')}</p>}
  {draft&&<>
   <div className="room-settings-field"><span className="dlg-label">{t('Room icon')}</span><RoomVisualEditor key={`${api.httpBase}:${api.orgId}:${api.sessionToken}:${view}:${data?.settings.version}:${reads.current}`} api={api} channel={view} version={data?.settings.version||0} visualVersion={data?.visualVersion} color={draft.color} disabled={disabled} dirty={changed} onColor={color=>setDraft({...draft,color})} onBusy={value=>{if(currentVisualScope.current===visualScope)setVisualBusy(value)}} onChanged={()=>{if(currentVisualScope.current===visualScope){onSaved();void load()}}}/></div>
   <label className="room-settings-field"><span className="dlg-label">{t('Room name')}</span><input className="dlg-input" aria-label={t('Room name')} value={draft.name} maxLength={120} disabled={disabled} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
   {data?.canChangeVisibility&&<section className="room-settings-field" aria-label={t('Room visibility')}><label><span className="dlg-label">{t('Room visibility')}</span><select className="dlg-input" aria-label={t('Room visibility')} value={visibilityDraft||data.scope} disabled={disabled||changed} onChange={e=>setVisibilityDraft(e.target.value as 'public'|'private')}><option value="public">{t('Public')}</option><option value="private">{t('Private')}</option></select></label>{visibilityChanged&&<button type="button" className="dlg-btn" disabled={disabled||changed} onClick={()=>void saveVisibility()}>{t('Save visibility')}</button>}</section>}
   <section className="room-settings-response" aria-label={t('How agents respond')}><h3>{t('How agents respond')}</h3>
    <div className="room-settings-response-card"><label><span>{t('Mentioned only')}</span><input type="checkbox" role="switch" aria-label={t('Mentioned only')} checked={draft.mentionedOnly} disabled={disabled||!data?.canChangeResponses} onChange={e=>setDraft({...draft,mentionedOnly:e.target.checked})}/></label>
    <p>{t('Agents respond when mentioned. When off, clear requests can be assigned to an available agent.')}</p></div>
    <label className="room-settings-field"><span className="dlg-label">{t('Default agent')}</span><select className="dlg-input" aria-label={t('Default agent')} value={draft.defaultAgentId||''} disabled={disabled||!data?.canChangeResponses} onChange={e=>setDraft({...draft,defaultAgentId:e.target.value||null})}><option value="">{t('Automatic routing')}</option>{data?.availableAgents.map(agent=><option key={agent.id} value={agent.id}>{agent.emoji?`${agent.emoji} `:''}{agent.name}{agent.specialty?` · ${agent.specialty}`:''}</option>)}</select><small>{t('A specialist can still take a clear request when their expertise matches.')}</small></label>
   </section>
   <section className="room-settings-response room-settings-membership" aria-label={t('Room membership')}><h3>{t('Room membership')}</h3>
    <div className="room-settings-response-card"><label><span>{t('Default Room')}</span><input type="checkbox" role="switch" aria-label={t('Default Room')} checked={draft.isDefault} disabled={disabled||!data?.canChangeDefault||data.isPrivate||view==='b:general'} onChange={e=>setDraft({...draft,isDefault:e.target.checked})}/></label><p>{t('Default Rooms are always included for new members.')}</p></div>
    <div className="room-settings-response-card"><label><span>{t('Fixed membership')}</span><input type="checkbox" role="switch" aria-label={t('Fixed membership')} checked={draft.fixedMembership} disabled={disabled||!data?.canChangeRoomPolicies} onChange={e=>setDraft({...draft,fixedMembership:e.target.checked})}/></label><p>{t('Room admins cannot remove individual members while fixed membership is on.')}</p></div>
   </section>
   {data?.canEdit&&data.canChangeResponses&&<details className="room-settings-advanced"><summary>{t("Advanced settings")}</summary><div className="room-settings-integration-heading">Webhook</div><div className="room-settings-integration"><p>{t("Webhook events open threads for this room’s agents.")}</p><button type="button" className="dlg-btn" disabled={disabled||changed} onClick={()=>setHooksOpen(true)}>{t("Manage")}</button></div>{changed&&<p className="room-settings-note">{t("Save room settings first.")}</p>}</details>}
   {data&&!data.canEdit&&<p className="room-settings-note">{t('Join this room to edit its settings.')}</p>}
  </>}
  {error&&<div role="alert" className="dlg-error">{t(error)} {(!data||conflict)&&<button type="button" disabled={busy||loading} onClick={()=>void load()}>{t('Reload latest settings')}</button>}</div>}
 </Dialog>
 {hooksOpen&&<Dialog className="room-settings room-webhooks-dialog" title="Webhook" lede={t("Each webhook event opens a dedicated thread in this room for its agents to handle.")} onClose={()=>setHooksOpen(false)} footer={<button type="button" className="dlg-btn" onClick={()=>setHooksOpen(false)}>{t('Close')}</button>}><RoomWebhooks key={visualScope} api={api} channel={view} onOpenThread={onClose}/></Dialog>}
 </>
}

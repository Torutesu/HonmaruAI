import React,{useEffect,useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import './RoomJoinDialog.css'
interface PublicRoom {channel:string;name:string;joined:boolean;memberCount:number}
export function RoomJoinDialog({api,onClose,onJoined}:{api:{httpBase:string;orgId:string;sessionToken:string};onClose:()=>void;onJoined:(channel:string)=>void}) {
 const t=useT(),pending=useRef(false),generation=useRef(0)
 const [rooms,setRooms]=useState<PublicRoom[]|null>(null),[query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(''),[revision,setRevision]=useState(0)
 useEffect(()=>{
  const abort=new AbortController();generation.current++;setRooms(null);setError('')
  void fetch(`${api.httpBase}/channels/public-rooms?orgId=${encodeURIComponent(api.orgId)}`,{headers:{'x-session-token':api.sessionToken},signal:abort.signal})
   .then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.message||'Could not load rooms.');return data.rooms as PublicRoom[]})
   .then(data=>{if(!abort.signal.aborted)setRooms(data)})
   .catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:String(e))})
  return()=>{abort.abort();generation.current++}
 },[api.httpBase,api.orgId,api.sessionToken,revision])
 const join=async(room:PublicRoom)=>{
  if(pending.current)return
  if(room.joined){onJoined(room.channel);return}
  const current=generation.current
  pending.current=true;setBusy(room.channel);setError('')
  try{
   const response=await fetch(`${api.httpBase}/channels/join`,{method:'POST',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel:room.channel})})
   const data=await response.json();if(!response.ok)throw Error(data.message||'Could not join this room.')
   if(current!==generation.current)return
   setRooms(previous=>previous?.map(r=>r.channel===room.channel?{...r,joined:true}:r)||null)
   onJoined(room.channel)
  }catch(e){if(current===generation.current)setError(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy('')}
 }
 const filtered=rooms?.filter(r=>!r.joined&&r.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 return <Dialog title={t('Join public room')} className="room-join" onClose={()=>{if(!pending.current)onClose()}}
  footer={error?<button className="dlg-btn" disabled={!!busy} onClick={()=>setRevision(n=>n+1)}>{t('Reload')}</button>:undefined}>
  <label className="room-join-search"><Icon name="search" size={16}/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('Search public rooms')} aria-label={t('Search public rooms')}/></label>
  {!rooms&&!error&&<p role="status">{t('Loading…')}</p>}
  {filtered?.length===0&&<p className="dlg-hint room-join-empty">{t(query.trim()?'No matching rooms.':'No public rooms available to join.')}</p>}
  <ul className="room-join-list">{filtered?.map(room=><li key={room.channel}><span className="room-join-icon"><Icon name="room" size={18}/></span><span className="room-join-name">{room.name}<small>{t('{count} members',{count:room.memberCount})}</small></span><button className="dlg-btn" disabled={!!busy} onClick={()=>void join(room)}>{t(busy===room.channel?'Joining…':room.joined?'Open':'Join')}</button></li>)}</ul>
  {error&&<p className="dlg-error" role="alert">{t(error)}</p>}
 </Dialog>
}

import React,{useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Avatar} from './Avatar'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import './RoomMemberPicker.css'
export interface RoomCandidate {id:string;kind:'person'|'agent';name:string;avatarUrl?:string|null}
export function RoomMemberPicker({candidates,onAdd,onClose,onInvite,error,onReload}:{
 candidates:RoomCandidate[];onAdd:(selected:RoomCandidate[])=>Promise<void>;onClose:()=>void;onInvite:()=>void;error?:string;onReload:()=>void
}){
 const t=useT(),[query,setQuery]=useState(''),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[problem,setProblem]=useState(''),pending=useRef(false)
 const key=(row:RoomCandidate)=>`${row.kind}:${row.id}`
 const picked=candidates.filter(row=>selected.includes(key(row)))
 const shown=candidates.filter(row=>row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const submit=async()=>{
  if(pending.current||!picked.length||error)return
  pending.current=true;setBusy(true);setProblem('')
  try{await onAdd(picked)}catch(e){setProblem(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 return <Dialog className="room-member-picker" title={t('Add members')} onClose={()=>{if(!pending.current)onClose()}} footer={candidates.length>0?<button className="dlg-btn primary" disabled={busy||!picked.length||Boolean(error)} onClick={()=>void submit()}>{busy?t('Adding…'):t('Add ({n})',{n:picked.length})}</button>:undefined}>
  {error?<div className="room-member-picker-empty"><p role="alert" className="dlg-error">{t(error)}</p><button className="dlg-btn" disabled={busy} onClick={onReload}>{t('Try again')}</button></div>:candidates.length===0?<div className="room-member-picker-empty"><span className="room-member-picker-icon"><Icon name="invite" size={20}/></span><p>{t('All workspace members have already joined.')}</p><button className="dlg-btn primary" onClick={onInvite}>{t('Invite members to workspace')}</button></div>:<>
   <label className="room-member-picker-search"><Icon name="search" size={16}/><input className="dlg-input" autoFocus value={query} disabled={busy} onChange={event=>setQuery(event.target.value)} aria-label={t('Search members')} placeholder={t('Search members')}/></label>
   <div className="room-member-picker-list">{shown.length===0?<p>{t('Nobody by that name.')}</p>:shown.map(row=><label className="room-member-picker-row" key={key(row)}><input type="checkbox" disabled={busy} checked={selected.includes(key(row))} onChange={()=>setSelected(previous=>previous.includes(key(row))?previous.filter(id=>id!==key(row)):[...previous,key(row)])}/><Avatar name={row.name} url={row.avatarUrl||undefined} size={28} round/><span>{row.name}</span>{row.kind==='agent'&&<Icon name="bot" size={14}/>}</label>)}</div>
  </>}
  {problem&&<p role="alert" className="dlg-error">{t(problem)}</p>}
 </Dialog>
}

import React,{useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Avatar} from './Avatar'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import './RoomMemberPicker.css'
export interface RoomCandidate {id:string;kind:'person'|'agent';name:string;avatarUrl?:string|null;requestOnly?:boolean;accessRequestStatus?:'none'|'pending';missingAccessMembers?:Array<{id:string;name:string}>;canGrantAccess?:boolean;grantAccess?:boolean}
export function RoomMemberPicker({candidates,onAdd,onClose,onInvite,error,onReload,onRequestAccess}:{
 candidates:RoomCandidate[];onAdd:(selected:RoomCandidate[])=>Promise<void>;onClose:()=>void;onInvite:()=>void;error?:string;onReload:()=>void;onRequestAccess?:(agent:RoomCandidate)=>Promise<void>
}){
 const t=useT(),[query,setQuery]=useState(''),[selected,setSelected]=useState<string[]>([]),[grantAccess,setGrantAccess]=useState<string[]>([]),[busy,setBusy]=useState(false),[requesting,setRequesting]=useState<string|null>(null),[problem,setProblem]=useState(''),pending=useRef(false)
 const key=(row:RoomCandidate)=>`${row.kind}:${row.id}`
 const picked=candidates.filter(row=>!row.requestOnly&&selected.includes(key(row))).map(row=>({...row,grantAccess:grantAccess.includes(key(row))}))
 const shown=candidates.filter(row=>row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const requestAccess=async(agent:RoomCandidate)=>{
  if(!onRequestAccess||requesting)return
  setRequesting(agent.id);setProblem('')
  try{await onRequestAccess(agent)}catch(e){setProblem(e instanceof Error?e.message:String(e))}
  finally{setRequesting(null)}
 }
 const submit=async()=>{
  if(pending.current||!picked.length||error)return
  pending.current=true;setBusy(true);setProblem('')
  try{await onAdd(picked)}catch(e){setProblem(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 return <Dialog className="room-member-picker" title={t('Add members')} onClose={()=>{if(!pending.current)onClose()}} footer={candidates.some(row=>!row.requestOnly)?<button className="dlg-btn primary" disabled={busy||!picked.length||Boolean(error)} onClick={()=>void submit()}>{busy?t('Adding…'):t('Add ({n})',{n:picked.length})}</button>:undefined}>
  {error?<div className="room-member-picker-empty"><p role="alert" className="dlg-error">{t(error)}</p><button className="dlg-btn" disabled={busy||Boolean(requesting)} onClick={onReload}>{t('Try again')}</button></div>:candidates.length===0?<div className="room-member-picker-empty"><span className="room-member-picker-icon"><Icon name="invite" size={20}/></span><p>{t('There are no eligible people or agents to add. Invite workspace members or ask an agent owner to share access.')}</p><button className="dlg-btn primary" onClick={onInvite}>{t('Invite members to workspace')}</button></div>:<>
   <label className="room-member-picker-search"><Icon name="search" size={16}/><input className="dlg-input" autoFocus value={query} disabled={busy} onChange={event=>setQuery(event.target.value)} aria-label={t('Search members')} placeholder={t('Search members')}/></label>
   <div className="room-member-picker-list">{shown.length===0?<p>{t('Nobody by that name.')}</p>:shown.map(row=><div className="room-member-picker-item" key={key(row)}>
    <label className={`room-member-picker-row${row.requestOnly?' request-only':''}`}><input type="checkbox" disabled={busy||row.requestOnly||Boolean(requesting)} checked={selected.includes(key(row))} onChange={()=>{const id=key(row);if(selected.includes(id)){setSelected(previous=>previous.filter(value=>value!==id));setGrantAccess(previous=>previous.filter(value=>value!==id))}else setSelected(previous=>[...previous,id])}}/><Avatar name={row.name} url={row.avatarUrl||undefined} size={28} round/><span>{row.name}</span>{row.kind==='agent'&&<Icon name={row.requestOnly?'lock':'bot'} size={14}/>}</label>
    {row.requestOnly&&<button type="button" className="room-member-access-request" disabled={Boolean(requesting)||row.accessRequestStatus==='pending'} onClick={()=>void requestAccess(row)}>{requesting===row.id?t('Sending…'):row.accessRequestStatus==='pending'?t('Request sent'):t('Request access')}</button>}
    {!row.requestOnly&&row.kind==='agent'&&selected.includes(key(row))&&Boolean(row.missingAccessMembers?.length)&&<fieldset className="room-member-access-choice">
     <legend>{t('Some room members do not have access to this agent.')}</legend>
     {row.canGrantAccess?<>
      <label><input type="radio" name={`room-access-${row.id}`} checked={!grantAccess.includes(key(row))} onChange={()=>setGrantAccess(previous=>previous.filter(id=>id!==key(row)))}/>{t('Add without access')}</label>
      <label><input type="radio" name={`room-access-${row.id}`} checked={grantAccess.includes(key(row))} onChange={()=>setGrantAccess(previous=>previous.includes(key(row))?previous:[...previous,key(row)])}/>{t('Grant access and add ({n})',{n:row.missingAccessMembers?.length||0})}</label>
     </>:<p>{t('You need agent access permissions to grant access to these room members.')}</p>}
    </fieldset>}
   </div>)}</div>
  </>}
  {problem&&<p role="alert" className="dlg-error">{t(problem)}</p>}
 </Dialog>
}

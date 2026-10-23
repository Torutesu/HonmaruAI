import React,{useRef,useState} from 'react'
import {Dialog} from './Dialog'
import {Avatar} from './Avatar'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import './RoomMembersDialog.css'

export interface RoomMemberRow {
 id:string;kind:'person'|'agent';name:string;avatarUrl?:string|null;role:'admin'|'member'
 canChangeRole?:boolean;canRemove?:boolean
}
export function RoomMembersDialog({members,loading,error,onReload,onAdd,onProfile,onRole,onRemove,onClose}:{
 members:RoomMemberRow[];loading?:boolean;error?:string;onReload:()=>void;onAdd?:()=>void
 onProfile:(member:RoomMemberRow)=>void;onRole:(member:RoomMemberRow,role:'admin'|'member')=>Promise<void>
 onRemove:(member:RoomMemberRow)=>Promise<void>;onClose:()=>void
}) {
 const t=useT(),[menu,setMenu]=useState<string|null>(null),[busy,setBusy]=useState(false),[problem,setProblem]=useState(''),pending=useRef(false)
 const action=async(work:()=>Promise<void>)=>{
  if(pending.current)return
  pending.current=true;setBusy(true);setProblem('')
  try{await work();setMenu(null)}catch(e){setProblem(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 return <Dialog className="room-members" title={t('Room members')} onClose={()=>{if(pending.current)return;if(menu)setMenu(null);else onClose()}}>
  {loading?<p role="status" className="room-members-message">{t('Loading…')}</p>:<>
   {onAdd&&<button className="room-members-add" disabled={busy} onClick={onAdd}><Icon name="plus" size={16}/>{t('Add members')}</button>}
   <div className="room-members-list">{members.map(member=>{
    const key=`${member.kind}:${member.id}`,editable=member.canChangeRole||member.canRemove
    return <div className="room-members-row" key={key}>
     <button className="room-members-person" disabled={busy} onClick={()=>onProfile(member)}><Avatar name={member.name} url={member.avatarUrl||undefined} size={24} round/><span>{member.name}</span>{member.kind==='agent'&&<Icon name="bot" size={12}/>}</button>
     {editable?<div className="room-members-role-wrap"><button className="room-members-role" disabled={busy} aria-expanded={menu===key} aria-label={t('{name}: {role}',{name:member.name,role:t(member.role==='admin'?'Admin':'Member')})} onClick={()=>setMenu(menu===key?null:key)}>{t(member.role==='admin'?'Admin':'Member')}<Icon name="chevron-down" size={12}/></button>
      {menu===key&&<div className="room-members-menu" role="group" aria-label={t('Room member actions')}>
       {member.canChangeRole&&(['admin','member'] as const).map(role=><button key={role} disabled={busy||member.role===role} onClick={()=>void action(()=>onRole(member,role))}><span>{t(role==='admin'?'Admin':'Member')}</span>{member.role===role&&<Icon name="check" size={14}/>}</button>)}
       {member.canRemove&&<button className="room-members-remove" disabled={busy} onClick={()=>void action(()=>onRemove(member))}>{t('Remove from room')}</button>}
      </div>}
     </div>:<span className="room-members-role">{t(member.role==='admin'?'Admin':'Member')}</span>}
    </div>
   })}</div>
  </>}
  {(error||problem)&&<div className="room-members-message"><p role="alert" className="dlg-error">{t(problem||error||'')}</p>{error&&<button className="dlg-btn" disabled={busy} onClick={onReload}>{t('Try again')}</button>}</div>}
 </Dialog>
}

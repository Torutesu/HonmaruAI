import React,{useLayoutEffect,useRef,useState} from 'react'
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
 const trigger=useRef<HTMLButtonElement|null>(null),popup=useRef<HTMLDivElement|null>(null)
 const returnFocus=useRef(false)
 const closeMenu=()=>{returnFocus.current=true;setMenu(null)}
 useLayoutEffect(()=>{
  if(!menu&&!busy&&returnFocus.current){returnFocus.current=false;trigger.current?.focus()}
 },[menu,busy])
 useLayoutEffect(()=>{
  if(!menu||typeof document==='undefined')return
  const element=popup.current,anchor=trigger.current
  if(!element||!anchor)return
  const place=()=>{
   const rect=anchor.getBoundingClientRect(),width=element.offsetWidth,height=element.offsetHeight
   element.style.left=`${Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8))}px`
   element.style.top=`${Math.max(8,Math.min(rect.bottom+4+height>window.innerHeight-8?rect.top-height-4:rect.bottom+4,window.innerHeight-height-8))}px`
  }
  place();element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  const outside=(event:PointerEvent)=>{
   if(!pending.current&&!element.contains(event.target as Node)&&!anchor.contains(event.target as Node))setMenu(null)
  }
  const focus=(event:FocusEvent)=>{
   if(!pending.current&&!element.contains(event.target as Node)&&!anchor.contains(event.target as Node))setMenu(null)
  }
  document.addEventListener('pointerdown',outside,true)
  document.addEventListener('focusin',focus)
  window.addEventListener('resize',place);document.addEventListener('scroll',place,true)
  return ()=>{
   document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',focus)
   window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true)
  }
 },[menu,problem,error,loading])
 const action=async(work:()=>Promise<void>)=>{
  if(pending.current)return
  pending.current=true;setBusy(true);setProblem('')
  try{await work();closeMenu()}catch(e){setProblem(e instanceof Error?e.message:String(e))}
  finally{pending.current=false;setBusy(false)}
 }
 return <Dialog className="room-members" title={t('Room members')} onClose={()=>{if(pending.current)return;if(menu)closeMenu();else onClose()}}>
  {loading?<p role="status" className="room-members-message">{t('Loading…')}</p>:<>
   {onAdd&&<button className="room-members-add" disabled={busy} onClick={onAdd}><Icon name="plus" size={16}/>{t('Add members')}</button>}
   <div className="room-members-list">{members.map(member=>{
    const key=`${member.kind}:${member.id}`,editable=member.canChangeRole||member.canRemove
    return <div className="room-members-row" key={key}>
     <button className="room-members-person" disabled={busy} onClick={()=>onProfile(member)}><Avatar name={member.name} url={member.avatarUrl||undefined} size={24} round/><span>{member.name}</span>{member.kind==='agent'&&<Icon name="bot" size={12}/>}</button>
     {editable?<div className="room-members-role-wrap"><button className="room-members-role" disabled={busy} aria-expanded={menu===key} aria-label={t('{name}: {role}',{name:member.name,role:t(member.role==='admin'?'Admin':'Member')})} onClick={event=>{trigger.current=event.currentTarget;setMenu(menu===key?null:key)}}>{t(member.role==='admin'?'Admin':'Member')}<Icon name="chevron-down" size={12}/></button>
      {menu===key&&<div ref={popup} className="room-members-menu" onKeyDown={event=>{
       if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
       event.preventDefault()
       const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
       const index=buttons.indexOf(document.activeElement as HTMLButtonElement)
       const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length
       buttons[next]?.focus()
      }} role="group" aria-label={t('Room member actions')}>
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

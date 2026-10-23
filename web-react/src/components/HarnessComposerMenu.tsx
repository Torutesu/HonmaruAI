import React,{useEffect,useRef,useState} from 'react'
import {Icon,type IconName} from './Icon'
import {useT} from '../utils/i18n'
import {composing} from '../utils/keys'

type Props={onAttach:()=>void;onMention:()=>void;onConnections?:()=>void;onDecision:()=>void;onSchedule:()=>void;canDecide:boolean;canSchedule:boolean;children:React.ReactNode}
export function HarnessComposerMenu({onAttach,onMention,onConnections,onDecision,onSchedule,canDecide,canSchedule,children}:Props){
 const t=useT(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
 const [open,setOpen]=useState(false),[format,setFormat]=useState(false)
 const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus()}
 useEffect(()=>{
  if(!open&&!format)return
  if(open)root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)){close();setFormat(false)}}
  document.addEventListener('pointerdown',outside)
  return()=>document.removeEventListener('pointerdown',outside)
 },[open,format])
 const action=(label:string,icon:IconName,run:()=>void,disabled=false)=><button key={label} type="button" role="menuitem" disabled={disabled} onClick={()=>{close(true);run()}}><Icon name={icon} size={16}/>{t(label)}</button>
 return <div className="hx-composer-add" ref={root} onKeyDown={event=>{
  if(composing(event))return
  if(event.key==='Escape'&&(open||format)){event.preventDefault();event.stopPropagation();close(true);setFormat(false)}
  if(event.key==='Tab')close()
  if(open&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
   const items=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')||[])
   if(!items.length)return
   event.preventDefault();event.stopPropagation()
   const index=items.indexOf(document.activeElement as HTMLButtonElement)
   const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
   items[next]?.focus()
  }
 }}>
  <button ref={trigger} type="button" className="slk-attach-btn" aria-label={t('Add to message')} title={t('Add to message')} aria-haspopup="menu" aria-expanded={open} onClick={()=>{setFormat(false);setOpen(value=>!value)}}><Icon name="plus" size={18}/></button>
  {open&&<div className="hx-composer-add-menu" role="menu" aria-label={t('Add to message')}>
   {action('Attach files','paperclip',onAttach)}
   {action('Mention someone','at',onMention)}
   {onConnections&&action('Manage integrations','plug',onConnections)}
   <div role="separator"/>
   {action('Formatting','edit',()=>setFormat(value=>!value))}
   {action('Send as a decision','sparkle',onDecision,!canDecide)}
   {action('Schedule message','clock',onSchedule,!canSchedule)}
  </div>}
  {format&&<div className="hx-composer-format">{children}</div>}
 </div>
}

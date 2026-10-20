import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'

export function SkillActionsMenu({ name, disabled, onRemove }: {name:string;disabled:boolean;onRemove:()=>void}) {
  const t=useT(), details=useRef<HTMLDetailsElement>(null), summary=useRef<HTMLElement>(null)
  const [open,setOpen]=useState(false)
  const close=()=>{if(details.current)details.current.open=false;setOpen(false)}
  useEffect(()=>{
    if(!open)return
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!details.current?.contains(event.target))close()}
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();summary.current?.focus()}}
    document.addEventListener('pointerdown',outside)
    document.addEventListener('keydown',escape)
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)}
  },[open])
  return <details ref={details} className="hx-skill-menu" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary ref={summary} aria-label={t('Actions for {name}',{name})} aria-expanded={open}><Icon name="more" size={18}/></summary>
    <button disabled={disabled} onClick={()=>{close();summary.current?.focus();onRemove()}}><Icon name="trash" size={14}/>{t('Remove from agent')}</button>
  </details>
}

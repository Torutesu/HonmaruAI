import React, {useEffect, useRef, useState} from 'react'
import {Icon} from './Icon'
import {composing} from '../utils/keys'
import {useT} from '../utils/i18n'

export function AppDataMenu({wrapText, save}:{wrapText:boolean;save:(value:boolean)=>Promise<void>}) {
 const t=useT()
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),pending=useRef(false),opened=useRef(false)
 const ownsFocus=()=>Boolean(root.current?.contains(document.activeElement))
 useEffect(()=>{if(!open){opened.current=false;return}if(!busy&&(!opened.current||ownsFocus()))root.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus();opened.current=true;const outside=(e:PointerEvent)=>{if(!busy&&!root.current?.contains(e.target as Node))setOpen(false)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[open,busy])
 const toggle=async()=>{if(pending.current)return;pending.current=true;root.current?.focus();setBusy(true);setError('');try{await save(!wrapText);const restore=ownsFocus();setOpen(false);if(restore)trigger.current?.focus()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}}
 return <div className="hx-app-menu" ref={root} tabIndex={-1} onKeyDown={e=>{if(!open||composing(e))return;if(e.key==='Escape'){e.stopPropagation();if(!busy){setOpen(false);trigger.current?.focus()}}if(e.key==='Tab'&&!busy)setOpen(false)}}>
  <button className="hx-app-icon-button" ref={trigger} aria-label={t('More data viewer actions')} title={t('More data viewer actions')} aria-haspopup="menu" aria-expanded={open} aria-disabled={busy} onClick={()=>{if(!pending.current)setOpen(!open)}}><Icon name="more" size={18}/></button>
  {open&&<div className="hx-app-menu-popover" role="menu" aria-label={t('More data viewer actions')}><button role="menuitemcheckbox" aria-checked={wrapText} disabled={busy} onClick={()=>void toggle()}><Icon name="wrap-text" size={16}/>テキストを折り返す{wrapText&&<Icon name="check" size={14}/>}</button>{error&&<p role="alert">{error}</p>}</div>}
 </div>
}

import React, {useEffect, useRef, useState} from 'react'
import {Icon} from './Icon'

export function AppDataMenu({wrapText, save}:{wrapText:boolean;save:(value:boolean)=>Promise<void>}) {
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
 useEffect(()=>{if(!open)return;root.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus();const outside=(e:PointerEvent)=>{if(!busy&&!root.current?.contains(e.target as Node))setOpen(false)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[open,busy])
 const toggle=async()=>{setBusy(true);setError('');try{await save(!wrapText);setOpen(false);trigger.current?.focus()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 return <div className="hx-app-menu" ref={root} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(!busy){setOpen(false);trigger.current?.focus()}}if(e.key==='Tab'&&!busy)setOpen(false)}}>
  <button className="hx-app-icon-button" ref={trigger} aria-label="その他のデータビューアー操作" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(!open)}><Icon name="more" size={18}/></button>
  {open&&<div className="hx-app-menu-popover" role="menu" aria-label="その他のデータビューアー操作"><button role="menuitemcheckbox" aria-checked={wrapText} disabled={busy} onClick={()=>void toggle()}><Icon name="wrap-text" size={16}/>テキストを折り返す{wrapText&&<Icon name="check" size={14}/>}</button>{error&&<p role="alert">{error}</p>}</div>}
 </div>
}

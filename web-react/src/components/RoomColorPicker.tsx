import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {useT} from '../utils/i18n'
import {composing} from '../utils/keys'
import {ROOM_COLORS,ROOM_COLOR_OPTIONS} from '../utils/roomColors'
import './RoomCreateDialog.css'
export function RoomColorPicker({color,onChange,disabled=false}:{color:keyof typeof ROOM_COLORS;onChange:(color:keyof typeof ROOM_COLORS)=>void;disabled?:boolean}){
 const t=useT(),[open,setOpen]=useState(false),button=useRef<HTMLButtonElement>(null),wrap=useRef<HTMLDivElement>(null)
 useEffect(()=>{
  if(!open||typeof window==='undefined')return
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!composing(event)){event.preventDefault();event.stopImmediatePropagation();setOpen(false);button.current?.focus()}}
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!wrap.current?.contains(event.target))setOpen(false)}
  window.addEventListener('keydown',escape,true);document.addEventListener('pointerdown',outside,true)
  return()=>{window.removeEventListener('keydown',escape,true);document.removeEventListener('pointerdown',outside,true)}
 },[open])
 useEffect(()=>{if(disabled)setOpen(false)},[disabled])
 return <div ref={wrap} className="room-create-color-wrap"><button ref={button} type="button" className="room-create-color" disabled={disabled}
  aria-label={t('Room color: {color}',{color:t(ROOM_COLOR_OPTIONS.find(([id])=>id===color)?.[1]||color)})} aria-expanded={open}
  onClick={()=>setOpen(v=>!v)} style={{'--room-color':ROOM_COLORS[color]} as React.CSSProperties}><Icon name="room" size={18}/></button>
  {open&&!disabled&&<div className="room-create-colors" role="group" aria-label={t('Room color')}>{ROOM_COLOR_OPTIONS.map(([id,label])=><button key={id} type="button" aria-label={t(label)} title={t(label)} aria-pressed={id===color} style={{'--room-color':ROOM_COLORS[id]} as React.CSSProperties}
   onClick={()=>{onChange(id);setOpen(false);button.current?.focus()}}><Icon name="room" size={14}/></button>)}</div>}
 </div>
}

import React, {useEffect, useId, useRef, useState} from 'react'
import {Avatar} from './Avatar'
import {Icon} from './Icon'

export interface AppPerson { ref:string; name:string }

export function AppPersonPicker({label,value,members,ready=true,disabled=false,onChange}:{label:string;value:string;members:AppPerson[];ready?:boolean;disabled?:boolean;onChange:(value:string)=>void}) {
 const id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0),[position,setPosition]=useState<React.CSSProperties>({})
 const selected=members.find(member=>member.ref===value),legacy=Boolean(value&&!selected)
 const visible=members.filter(member=>member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const options=[{ref:'',name:'未割り当て'},...(legacy?[{ref:value,name:`現在の値: ${value}`}]:[]),...visible]
 const close=()=>setOpen(false)
 const show=()=>{
  if(disabled||!ready||!members.length)return
  const rect=trigger.current?.getBoundingClientRect()
  if(rect&&typeof window!=='undefined'){
   const width=Math.min(Math.max(220,rect.width),window.innerWidth-24),spaceBelow=window.innerHeight-rect.bottom-12,above=spaceBelow<220&&rect.top>220
   const available=above?rect.top-20:spaceBelow
   setPosition({position:'fixed',zIndex:260,width,left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:above?rect.top-4:rect.bottom+4,transform:above?'translateY(-100%)':undefined,maxHeight:Math.max(120,Math.min(280,available))})
  }
  setQuery('');setActive(Math.max(0,options.findIndex(option=>option.ref===value)));setOpen(true)
 }
 const choose=(ref:string)=>{if(disabled)return;onChange(ref);close();trigger.current?.focus()}
 const move=(key:string)=>{
  if(!options.length)return
  setActive(index=>key==='Home'?0:key==='End'?options.length-1:(index+(key==='ArrowDown'?1:options.length-1))%options.length)
 }
 useEffect(()=>{if(disabled||!ready||!members.length)close()},[disabled,ready,members.length])
 useEffect(()=>{
  if(!open)return
  const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))close()}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&root.current?.contains(event.target as Node)){event.preventDefault();event.stopImmediatePropagation();close();trigger.current?.focus()}}
  const reposition=(event:Event)=>{if(event.target===window||!root.current?.contains(event.target as Node))close()}
  document.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true)
  return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true)}
 },[open])
 const unavailable=!ready?'メンバーを読み込み中…':members.length?'': '選択できるメンバーがいません'
 return <div ref={root} className="hx-person-picker" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))close()}}>
  <button ref={trigger} type="button" className="hx-person-trigger" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id:undefined} aria-activedescendant={open?`${id}-${active}`:undefined} disabled={disabled||!ready||!members.length}
   onClick={()=>open?close():show()} onKeyDown={event=>{if(disabled||event.nativeEvent.isComposing)return;if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(!open)show();else move(event.key)}else if(open&&(event.key==='Enter'||event.key===' ')){event.preventDefault();if(options[active])choose(options[active].ref)}else if(event.key==='Tab')close()}}>
   <span className="hx-person-trigger-value">{selected?<><Avatar name={selected.name} size={20}/><span>{selected.name}</span></>:value?<span>{value}</span>:<span className="hx-person-placeholder">{unavailable||`${label}を選択`}</span>}</span>
   <Icon name="chevron-down" size={14}/>
  </button>
  {open&&<div id={id} className="hx-person-options" style={position}>
   {members.length>=8&&<div className="hx-person-search"><Icon name="search" size={14}/><input type="search" aria-label="メンバーを検索" placeholder="メンバーを検索" value={query} onChange={event=>{setQuery(event.target.value);setActive(0)}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();move(event.key)}else if(event.key==='Enter'){event.preventDefault();if(options[active])choose(options[active].ref)}}}/></div>}
   <div role="listbox" aria-label={`${label}を選択`} className="hx-person-list">
    {options.map((option,index)=><button key={option.ref||'__unassigned'} id={`${id}-${index}`} data-member-ref={option.ref} type="button" role="option" aria-selected={option.ref===value} className={index===active?'active':''} onMouseDown={event=>event.preventDefault()} onMouseMove={()=>setActive(index)} onClick={()=>choose(option.ref)}>
     {option.ref&&members.some(member=>member.ref===option.ref)?<Avatar name={members.find(member=>member.ref===option.ref)!.name} size={22}/>:option.ref?<span className="hx-person-legacy" aria-hidden="true">?</span>:<span className="hx-person-unassigned" aria-hidden="true"><Icon name="users" size={15}/></span>}
     <span>{option.name}</span>{option.ref===value&&<Icon name="check" size={14}/>}
    </button>)}
    {members.length>=8&&!visible.length&&<p>該当するメンバーがいません</p>}
   </div>
  </div>}
 </div>
}

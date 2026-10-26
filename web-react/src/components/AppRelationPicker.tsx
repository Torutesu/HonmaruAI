import React, {useEffect, useId, useMemo, useRef, useState} from 'react'
import {Icon} from './Icon'
import type {Column, Row} from '../utils/harness'

export type RelationOption = {id:string;label:string}

function RelationField({column,value,options=[],disabled=false,onChange}:{column:Column;value:unknown;options?:RelationOption[];disabled?:boolean;onChange:(value:unknown)=>void}) {
 const id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),search=useRef<HTMLInputElement>(null)
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0),[position,setPosition]=useState<React.CSSProperties>({})
 const multiple=Boolean(column.multiple),selectedIds=useMemo(()=>multiple?(Array.isArray(value)?Array.from(new Set(value.filter((item):item is string=>typeof item==='string'))):[]):typeof value==='string'&&value?[value]:[],[multiple,value])
 const byId=useMemo(()=>new Map(options.map(option=>[option.id,option])),[options])
 const matches=useMemo(()=>{
  const needle=query.trim().toLocaleLowerCase()
  return options.filter(option=>!needle||option.label.toLocaleLowerCase().includes(needle)||option.id.toLocaleLowerCase().includes(needle))
 },[options,query])
 const visible=matches.slice(0,100)
 const selected=selectedIds.map(recordId=>byId.get(recordId)||{id:recordId,label:`${recordId}（未取得）`})
 const close=()=>setOpen(false)
 const show=()=>{
  if(disabled)return
  const rect=trigger.current?.getBoundingClientRect()
  if(rect&&typeof window!=='undefined'){
   const width=Math.min(window.innerWidth-24,Math.max(220,Math.min(rect.width,360))),spaceBelow=window.innerHeight-rect.bottom-12,above=spaceBelow<220&&rect.top>220
   const available=above?rect.top-20:spaceBelow
   setPosition({position:'fixed',zIndex:260,width,left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:above?rect.top-4:rect.bottom+4,transform:above?'translateY(-100%)':undefined,maxHeight:Math.max(120,Math.min(320,available))})
  }
  setQuery('');setActive(Math.min(99,Math.max(0,options.findIndex(option=>selectedIds.includes(option.id)))));setOpen(true)
 }
 const choose=(recordId:string)=>{
  if(disabled)return
  if(multiple){onChange(selectedIds.includes(recordId)?selectedIds.filter(id=>id!==recordId):[...selectedIds,recordId]);return}
  onChange(recordId===selectedIds[0]?null:recordId);close();trigger.current?.focus()
 }
 const remove=(recordId:string)=>{if(disabled)return;onChange(selectedIds.filter(id=>id!==recordId))}
 const move=(key:string)=>{
  if(!visible.length)return
  setActive(index=>key==='Home'?0:key==='End'?visible.length-1:(index+(key==='ArrowDown'?1:visible.length-1))%visible.length)
 }
 useEffect(()=>{if(open)search.current?.focus()},[open])
 useEffect(()=>{
  if(!open)return
  const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))close()}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&root.current?.contains(event.target as Node)){event.preventDefault();event.stopImmediatePropagation();close();trigger.current?.focus()}}
  const reposition=(event:Event)=>{if(event.target===window||!root.current?.contains(event.target as Node))close()}
  document.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true)
  return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true)}
 },[open])
 useEffect(()=>{if(disabled)close()},[disabled])
 const label=multiple?selected.length?`${selected.length}件を選択`:`${column.name}を選択`:selected[0]?.label||`${column.name}を選択`
 return <div ref={root} className={`hx-relation-picker${multiple?' is-multiple':''}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))close()}}>
  {multiple&&selected.length>0&&<div className="hx-relation-chips" aria-label={`${column.name}の選択済みレコード`}>
   {selected.map(option=><span className="hx-relation-chip" key={option.id}><span title={option.label}>{option.label}</span><button type="button" aria-label={`${option.label}を解除`} disabled={disabled} onClick={()=>remove(option.id)}>×</button></span>)}
  </div>}
  <button ref={trigger} type="button" className="hx-relation-trigger" aria-label={column.name} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?`${id}-list`:undefined} disabled={disabled}
   onClick={()=>open?close():show()} onKeyDown={event=>{if(disabled||event.nativeEvent.isComposing)return;if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(!open)show();else move(event.key)}else if(open&&event.key==='Enter'){event.preventDefault();const option=visible[active];if(option)choose(option.id)}else if(event.key==='Escape'&&open){event.preventDefault();close()}}}>
   <span className={selected.length?'':'hx-relation-placeholder'}>{label}</span>
   <Icon name="chevron-down" size={14}/>
  </button>
  {open&&<div className="hx-relation-options" style={position}>
   <div className="hx-relation-search"><Icon name="search" size={14}/><input ref={search} type="search" aria-label={`${column.name}を検索`} placeholder="検索…" value={query} onChange={event=>{setQuery(event.target.value);setActive(0)}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();move(event.key)}else if(event.key==='Enter'){event.preventDefault();const option=visible[active];if(option)choose(option.id)}else if(event.key==='Tab')close()}}/></div>
   <div id={`${id}-list`} role="listbox" aria-label={`${column.name}の候補`} aria-multiselectable={multiple||undefined} className="hx-relation-list">
    {!multiple&&<button type="button" role="option" className="hx-relation-option" aria-selected={!selectedIds.length} onMouseDown={event=>event.preventDefault()} onClick={()=>{onChange(null);close();trigger.current?.focus()}}><span>{column.name}なし</span>{!selectedIds.length&&<Icon name="check" size={14}/>}</button>}
    {visible.map((option,index)=>{const checked=selectedIds.includes(option.id);return <button key={option.id} id={`${id}-${index}`} type="button" role="option" aria-selected={checked} className={`hx-relation-option${index===active?' active':''}`} onMouseDown={event=>event.preventDefault()} onMouseMove={()=>setActive(index)} onClick={()=>choose(option.id)}>
     <span className="hx-relation-option-label">{option.label}</span>{checked&&<Icon name="check" size={14}/>}
    </button>})}
    {!visible.length&&<p>該当するレコードがありません</p>}
    {matches.length>100&&<p>検索結果が多いため、先頭100件を表示しています</p>}
   </div>
  </div>}
 </div>
}

export function AppRelationPicker({column,value,rows=[],targetColumn,disabled=false,onChange}:{column:Column;value:unknown;rows?:Row[];targetColumn?:Column;disabled?:boolean;onChange:(value:unknown)=>void}) {
 const options=useMemo(()=>rows.map(row=>{const labelValue=targetColumn?row.values[targetColumn.id]:undefined;return {id:row.id,label:labelValue==null||labelValue===''?row.id:String(labelValue)}}),[rows,targetColumn])
 return <RelationField column={column} value={value} options={options} disabled={disabled} onChange={onChange}/>
}

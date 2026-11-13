import React, {useEffect, useRef, useState} from 'react'
import type {AppEntity,Column,Row} from '../utils/harness'
import {cellText} from '../utils/harness'
import {useT} from '../utils/i18n'
import {enterKey} from '../utils/keys'
import {numberPreservesDecimal} from '../utils/numericPrecision'
import {instantFromLocalDateTime,localDateTimeInZone} from '../utils/zonedDateTime'

export type RelationEntity=AppEntity&{rows:Row[]}
export function relationOptionLabel(entity:RelationEntity,row:Row) {
 const title=entity.table.columns[0]
 return title?cellText(title,row.values[title.id])||row.id:row.id
}

function NumericCellInput({column,value,draft,setDraft,onSave}:{column:Column;value:unknown;draft:string;setDraft:React.Dispatch<React.SetStateAction<string>>;onSave:(value:unknown)=>void}) {
 const t=useT(),numberErrorId=React.useId()
 const [numberError,setNumberError]=useState<'precision'|'incomplete'|null>(null)
 const incomplete=useRef(false)
 useEffect(()=>{incomplete.current=false;setNumberError(null)},[value])
 return <>
  <input className="hx-cell-input" type="number" value={draft}
   aria-invalid={numberError?true:undefined} aria-describedby={numberError?numberErrorId:undefined}
   onInput={e=>{incomplete.current=e.currentTarget.validity.badInput;if(!incomplete.current)setNumberError(null)}}
   onChange={e=>{setDraft(e.target.value);if(!e.target.validity?.badInput)setNumberError(null)}}
   onBlur={e=>{
    if(e.currentTarget.validity.badInput||incomplete.current){incomplete.current=true;setNumberError('incomplete');return}
    if(draft===(value==null?'':String(value)))return
    if(draft!==''&&!numberPreservesDecimal(draft)){setNumberError('precision');return}
    setNumberError(null);onSave(draft)
   }}
   onKeyDown={e=>{if(enterKey(e))(e.target as HTMLInputElement).blur()}} aria-label={column.name}/>
  {numberError&&<div id={numberErrorId} className="form-error" role="alert">{numberError==='incomplete'?t('Enter a complete number before leaving this field.'):t('The value for {field} cannot be saved without changing the number.',{field:column.name})}</div>}
 </>
}

function CellInput({column,value,onSave,wrap=false,width,members=[],relationEntities=[],cancelled}:{column:Column;value:unknown;onSave:(v:unknown)=>void;wrap?:boolean;width?:number;members?:Array<{ref:string;name:string}>;relationEntities?:RelationEntity[];cancelled:React.RefObject<boolean>}) {
 const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'
 const asText=(next:unknown)=>column.type==='datetime'&&typeof next==='string'?localDateTimeInZone(next,timeZone):next==null?'':String(next)
 const [draft,setDraft]=useState<string>(()=>asText(value))
 const [choiceDraft,setChoiceDraft]=useState<unknown>(value)
 useEffect(()=>{setDraft(asText(value));setChoiceDraft(value)},[value,column.type])
 const textArea=useRef<HTMLTextAreaElement>(null)
 useEffect(()=>{if(textArea.current){textArea.current.style.height='auto';textArea.current.style.height=`${textArea.current.scrollHeight}px`}},[draft,wrap,width])
 const commit=(next:unknown)=>{if(!cancelled.current)onSave(next)}
 const sameChoice=(a:unknown,b:unknown)=>Array.isArray(a)&&Array.isArray(b)?a.length===b.length&&a.every((value,index)=>value===b[index]):Object.is(a,b)
 const commitChoice=()=>{if(!sameChoice(choiceDraft,value))commit(choiceDraft)}
 const commitOnEnter=(event:React.KeyboardEvent<HTMLSelectElement|HTMLInputElement>)=>{if(enterKey(event)){event.preventDefault();event.currentTarget.blur()}}
 if(column.type==='number')return <NumericCellInput column={column} value={value} draft={draft} setDraft={setDraft} onSave={commit}/>
 if(column.type==='relation') {
  const entity=relationEntities.find(item=>item.key===column.targetEntity)
  const selectedIds=Array.isArray(choiceDraft)?choiceDraft.map(String):[]
  const selectedId=choiceDraft==null||Array.isArray(choiceDraft)?'':String(choiceDraft)
  const known=new Set(entity?.rows.map(row=>row.id)||[])
  const missing=column.multiple?selectedIds.filter(id=>!known.has(id)):selectedId&&!known.has(selectedId)?[selectedId]:[]
  return <select className="hx-cell-select" aria-label={column.name} multiple={column.multiple||undefined} value={column.multiple?selectedIds:selectedId} onChange={e=>setChoiceDraft(column.multiple?Array.from(e.currentTarget.selectedOptions,option=>option.value):e.target.value||null)} onBlur={commitChoice} onKeyDown={commitOnEnter}>
   {!column.multiple&&<option value="">—</option>}
   {missing.map(id=><option key={id} value={id}>{id}（未取得）</option>)}
   {(entity?.rows||[]).map(row=><option key={row.id} value={row.id}>{relationOptionLabel(entity!,row)}</option>)}
  </select>
 }
 if(column.type==='person'&&members.length)return <select className="hx-cell-select" aria-label={column.name} value={String(choiceDraft??'')} onChange={e=>setChoiceDraft(e.target.value||null)} onBlur={commitChoice} onKeyDown={commitOnEnter}><option value="">—</option>{value&&!members.some(m=>m.ref===String(value))?<option value={String(value)}>{String(value)}</option>:null}{members.map(m=><option key={m.ref} value={m.ref}>{m.name}</option>)}</select>
 if(wrap&&['text','person'].includes(column.type))return <textarea ref={textArea} className="hx-cell-input hx-wrapped-input" rows={1} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={()=>{if(draft!==(value==null?'':String(value)))commit(draft)}} aria-label={column.name}/>
 if(column.type==='checkbox')return <input type="checkbox" checked={Boolean(choiceDraft)} onChange={e=>setChoiceDraft(e.target.checked)} onBlur={commitChoice} onKeyDown={commitOnEnter} aria-label={column.name}/>
 if(column.type==='select')return <select className="hx-cell-select" value={choiceDraft==null?'':String(choiceDraft)} onChange={e=>setChoiceDraft(e.target.value||null)} onBlur={commitChoice} onKeyDown={commitOnEnter} aria-label={column.name}><option value="">—</option>{(column.options||[]).map(option=><option key={option} value={option}>{option}</option>)}</select>
 const type=column.type==='date'?'date':column.type==='datetime'?'datetime-local':column.type==='email'?'email':column.type==='url'?'url':'text'
 return <input className="hx-cell-input" type={type} value={draft} onChange={e=>setDraft(e.target.value)} step={column.type==='datetime'?1:undefined} onBlur={()=>{if(draft!==asText(value))commit(column.type==='datetime'?instantFromLocalDateTime(draft,timeZone):draft)}} onKeyDown={e=>{if(enterKey(e))(e.target as HTMLInputElement).blur()}} aria-label={column.name}/>
}

/** A read-first table cell that enters the existing type-specific editor on activation. */
export function AppDataCell({column,value,displayValue,editable=true,onSave,wrap=false,width,members=[],relationEntities=[],title}:{column:Column;value:unknown;displayValue:string;editable?:boolean;onSave:(value:unknown)=>void;wrap?:boolean;width?:number;members?:Array<{ref:string;name:string}>;relationEntities?:RelationEntity[];title?:string}) {
 const [editing,setEditing]=useState(false)
 const root=useRef<HTMLDivElement>(null)
 const cancelled=useRef(false)
 useEffect(()=>{
  if(!editing)return
  root.current?.querySelector<HTMLElement>('input,select,textarea')?.focus()
 },[editing])
 if(!editable)return <span className="hx-system-cell" title={title}>{displayValue}</span>
 if(!editing)return <button type="button" className="hx-cell-display" aria-label={`${column.name}: ${displayValue||'—'}. Edit`} title={`${column.name}: ${displayValue||'—'}`} onClick={()=>{cancelled.current=false;setEditing(true)}}>{displayValue||<span className="hx-cell-empty">—</span>}</button>
 const cancel=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  if(event.key!=='Escape')return
  event.preventDefault();event.stopPropagation();cancelled.current=true;setEditing(false)
 }
 const closeIfValid=(event:React.FocusEvent<HTMLDivElement>)=>{
  if(event.currentTarget.contains(event.relatedTarget as Node|null))return
  const current=event.currentTarget
  if(!current.querySelector('[aria-invalid="true"]'))setEditing(false)
 }
 return <div ref={root} className="hx-cell-editing" onKeyDownCapture={cancel} onBlur={closeIfValid} data-column={column.id}>
  <CellInput column={column} value={value} onSave={next=>{if(!cancelled.current){onSave(next);setEditing(false)}}} wrap={wrap} width={width} members={members} relationEntities={relationEntities} cancelled={cancelled}/>
 </div>
}

import {SYSTEM_COLUMNS, isSystemTimestamp, localDateTime, utcDateTime} from '../utils/systemColumns'
import React, { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon'
import {AppRelationPicker} from './AppRelationPicker'
import {composing} from '../utils/keys'
import {useT} from '../utils/i18n'
import {instantFromLocalDateTime,localDateTimeInZone} from '../utils/zonedDateTime'
import type { Column, Row, View } from '../utils/harness'
const operators = [['eq','equals'],['neq','does not equal'],['contains','contains'],['empty','is empty'],['not_empty','is not empty'],['gt','is greater than / after'],['lt','is less than / before']]
type RelationEntity={key:string;table:{columns:Column[]};rows:Row[]}
const timeZoneFallback=['UTC','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Paris','America/Los_Angeles','America/Chicago','America/New_York','Australia/Sydney']
function availableTimeZones(current:string) {
  const intlWithZones=Intl as typeof Intl & {supportedValuesOf?:(key:'timeZone')=>string[]}
  const supported=intlWithZones.supportedValuesOf?.('timeZone')||timeZoneFallback
  return [...new Set(['UTC',...supported,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',current||'UTC'])].sort((a,b)=>a.localeCompare(b))
}
function isValidTimeZone(value:string) {
  try { new Intl.DateTimeFormat('en',{timeZone:value}).format(0); return true } catch { return false }
}
export function AppViewControls({view,columns,save,canEdit,personal=false,onAdjust,relationEntities=[]}:{view:View;columns:Column[];save:(patch:Partial<View>)=>Promise<void>;canEdit:boolean;personal?:boolean;onAdjust?:(kind:'filter'|'group')=>void;relationEntities?:RelationEntity[]}) {
  const t=useT()
  const timeZoneListId=`hx-time-zones-${useId().replace(/:/g,'')}`
  const queryColumns=[...columns,...SYSTEM_COLUMNS]
  const [open,setOpen]=useState<'filter'|'group'|null>(null)
  const [editing,setEditing]=useState(false)
  const [filters,setFilters]=useState(view.filters || [])
  const [where,setWhere]=useState(view.where)
  const [group,setGroup]=useState(view.groupBy || '')
  const [busy,setBusy]=useState(false), [error,setError]=useState('')
  const [timeZoneBusy,setTimeZoneBusy]=useState(false),[timeZoneError,setTimeZoneError]=useState('')
  const [timeZoneDraft,setTimeZoneDraft]=useState(view.timeZone||'UTC')
  const timeZoneChoices=availableTimeZones(view.timeZone||'UTC')
  const root=useRef<HTMLDivElement>(null)
  const trigger=useRef<HTMLButtonElement|null>(null)
  const close=()=>{setOpen(null);trigger.current?.focus()}
  useEffect(()=>setTimeZoneDraft(view.timeZone||'UTC'),[view.timeZone])
  useEffect(()=>{
    if(!open)return
    root.current?.querySelector<HTMLElement>('[role="dialog"] button,[role="dialog"] select')?.focus()
    const outside=(e:PointerEvent)=>{if(!busy && !root.current?.contains(e.target as Node))setOpen(null)}
    document.addEventListener('pointerdown',outside)
    return()=>document.removeEventListener('pointerdown',outside)
  },[open,busy,editing])
  const count=filters.length+Object.keys(where || {}).length
  const invalid = open==='filter' && filters.some(f=>!['empty','not_empty'].includes(f.op) && (!f.value || (isSystemTimestamp(f.column)||columns.find(column=>column.id===f.column)?.type==='datetime')&&!Number.isFinite(Date.parse(f.value))))
  const activeCount=(view.filters?.length || 0)+Object.keys(view.where || {}).length
  const controlLabel=(kind:'filter'|'group')=>{
    const label=t(kind==='filter'?'Filter records':'Group records')
    return kind==='filter'&&activeCount?t('{label} ({n} active)',{label,n:activeCount}):label
  }
  const apply=async()=>{
    setBusy(true);setError('')
    try{await save(open==='filter'?{filters,where:where || {}}:{groupBy:group || undefined});close()}
    catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  const change=(i:number,patch:Partial<NonNullable<View['filters']>[number]>)=>setFilters(filters.map((f,n)=>n===i?{...f,...patch}:f))
  const filterLabel=(column:Column|undefined,value:string)=>{
    if(column?.type!=='relation')return value
    const entity=relationEntities.find(item=>item.key===column.targetEntity),target=entity?.table.columns[0]
    const row=entity?.rows.find(candidate=>candidate.id===value)
    if(!row)return value
    const label=target?row.values[target.id]:undefined
    return label==null||label===''?row.id:String(label)
  }
  const filterOperatorLabel=(column:Column|undefined,op:string)=>column?.type==='relation'&&column.multiple?(op==='eq'?t('contains'):op==='neq'?t('does not contain'):operators.find(o=>o[0]===op)?.[1]):operators.find(o=>o[0]===op)?.[1]
  return <div ref={root} className="hx-view-controls" onKeyDown={e=>{if(e.key==='Escape'&&!composing(e)&&!busy){e.stopPropagation();close()}}}>
    {view.type==='calendar'&&<label className="hx-calendar-timezone"><span>{t('Calendar time zone')}</span><input aria-label={t('Calendar time zone')} list={timeZoneListId} value={timeZoneDraft} disabled={!canEdit||timeZoneBusy} onChange={event=>{const timeZone=event.target.value;setTimeZoneDraft(timeZone);if(!isValidTimeZone(timeZone)){setTimeZoneError(t('Enter a valid IANA time zone.'));return}setTimeZoneBusy(true);setTimeZoneError('');void save({timeZone}).catch(reason=>setTimeZoneError(reason instanceof Error?reason.message:String(reason))).finally(()=>setTimeZoneBusy(false))}}/><datalist id={timeZoneListId}>{timeZoneChoices.map(zone=><option key={zone} value={zone}/>)}</datalist>{timeZoneError&&<small role="alert">{timeZoneError}</small>}</label>}
    {(['filter','group'] as const).filter(kind=>kind==='filter'||view.type==='table'||view.type==='board').map(kind=><button key={kind} className={`pill-btn quiet ${open===kind?'on':''}`} title={controlLabel(kind)} aria-label={controlLabel(kind)} aria-haspopup="dialog" aria-expanded={open===kind} onClick={e=>{trigger.current=e.currentTarget;setOpen(open===kind?null:kind);setEditing(false);setError('');setFilters((view.filters||[]).map(f=>columns.find(c=>c.id===f.column)?.type==='relation'&&f.op==='contains'?{...f,op:'eq'}:f));setWhere(view.where);setGroup(view.groupBy||'')}}><Icon name={kind==='filter'?'filter':'group'} size={14}/>{t(kind==='filter'?'Filter records':'Group records')}{kind==='filter'&&activeCount>0&&<span className="hx-count">{activeCount}</span>}</button>)}
    {open&&<div className={`hx-view-popover ${editing&&open==='filter'?'editing':''}`} role="dialog" aria-label={t(open==='filter'?'Edit filters':'Edit grouping')}>
      {open==='filter'?<>
        {!editing?<><div className="hx-view-summary">{count?t('{count} conditions (match all)',{count}):t('No filters')}</div>{filters.map((f,i)=>{const column=queryColumns.find(c=>c.id===f.column);return <p key={i}>{column?.name} {filterOperatorLabel(column,f.op)} {isSystemTimestamp(f.column)?localDateTime(f.value).replace('T',' '):filterLabel(column,f.value)}</p>})}{Object.entries(where||{}).map(([id,values])=><p key={id}>{queryColumns.find(c=>c.id===id)?.name}: {values.join(' / ')}</p>)}<button className="hx-view-adjust" disabled={!canEdit} onClick={()=>setEditing(true)}><Icon name="sliders" size={15}/>{t('Adjust filters')}</button>{onAdjust&&<button type="button" className="hx-view-more" disabled={!canEdit} onClick={()=>{close();onAdjust('filter')}}>{t('Ask AI to suggest changes')}</button>}</>:<>
          <strong>{t('Records matching all conditions')}</strong>
          {Object.keys(where||{}).length>0&&<div className="hx-view-summary">{t('Existing conditions')}: {Object.entries(where||{}).map(([id,v])=>`${queryColumns.find(c=>c.id===id)?.name}: ${v.join(' / ')}`).join(', ')}<button onClick={()=>setWhere(undefined)}>{t('Clear existing conditions')}</button></div>}
          {filters.map((f,i)=>{const column=queryColumns.find(c=>c.id===f.column);return <div className="hx-filter-row" key={i}>
            <select aria-label={t('Condition {n} field',{n:i+1})} value={f.column} onChange={e=>{const next=queryColumns.find(c=>c.id===e.target.value);const op=isSystemTimestamp(e.target.value)&&f.op==='contains'||next?.type==='relation'&&!['eq','neq','empty','not_empty'].includes(f.op)?'eq':f.op;change(i,{column:e.target.value,value:'',op})}}>{queryColumns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select aria-label={t('Condition {n} operator',{n:i+1})} value={f.op} onChange={e=>change(i,{op:e.target.value})}>{(column?.type==='relation'?[['eq',column.multiple?t('contains') :t('equals')],['neq',column.multiple?t('does not contain'):t('does not equal')],['empty',t('is empty')],['not_empty',t('is not empty')]]:operators.filter(([op])=>!isSystemTimestamp(f.column)||op!=='contains')).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
            {!['empty','not_empty'].includes(f.op)&&(column?.type==='relation'?<AppRelationPicker column={{...column,multiple:false}} value={f.value||null} rows={relationEntities.find(entity=>entity.key===column.targetEntity)?.rows} targetColumn={relationEntities.find(entity=>entity.key===column.targetEntity)?.table.columns[0]} disabled={busy} onChange={value=>change(i,{value:String(value??'')})}/>:column?.type==='select'||column?.type==='checkbox'?<select aria-label={t('Condition {n} value',{n:i+1})} value={f.value} onChange={e=>change(i,{value:e.target.value})}><option value="">{t('Choose a value')}</option>{(column.type==='checkbox'?['true','false']:column.options||[]).map(v=><option key={v} value={v}>{v==='true'?t('Checked'):v==='false'?t('Unchecked'):v}</option>)}</select>:<input aria-label={t('Condition {n} value',{n:i+1})} step={isSystemTimestamp(f.column)||column?.type==='datetime'?1:undefined} type={isSystemTimestamp(f.column)||column?.type==='datetime'?'datetime-local':column?.type==='number'?'number':column?.type==='date'?'date':'text'} maxLength={500} value={isSystemTimestamp(f.column)?localDateTime(f.value):column?.type==='datetime'?localDateTimeInZone(f.value,view.timeZone||'UTC'):f.value} onChange={e=>change(i,{value:isSystemTimestamp(f.column)?utcDateTime(e.target.value):column?.type==='datetime'?instantFromLocalDateTime(e.target.value,view.timeZone||'UTC')||'':e.target.value})}/>)}
            <button aria-label={t('Remove condition {n}',{n:i+1})} onClick={()=>setFilters(filters.filter((_,n)=>n!==i))}><Icon name="x" size={14}/></button>
          </div>})}
          {filters.some(f=>isSystemTimestamp(f.column))&&<p className="hx-view-hint">{t('Enter date and time in your device time zone (to the second).')}</p>}
          <button className="hx-view-adjust" disabled={filters.length>=20||!columns.length} onClick={()=>setFilters([...filters,{column:columns[0].id,op:'eq',value:''}])}><Icon name="plus" size={14}/>{t('Add condition')}</button>
        </>}
      </>:<>{!editing?<><div className="hx-view-summary">{group ? columns.find(c=>c.id===group)?.name : t('No grouping')}</div><button className="hx-view-adjust" disabled={!canEdit} onClick={()=>setEditing(true)}><Icon name="group" size={15}/>{t('Adjust grouping')}</button>{onAdjust&&<button type="button" className="hx-view-more" disabled={!canEdit} onClick={()=>{close();onAdjust('group')}}>{t('Ask AI to suggest changes')}</button>}</>:<><strong>{t('Grouping')}</strong><label>{t('Field')}<select aria-label={t('Group by field')} value={group} onChange={e=>setGroup(e.target.value)} disabled={!canEdit}>{view.type!=='board'&&<option value="">{t('No grouping')}</option>}{columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><p>{t('Group records with the same value.')}</p></>}</>}
      {editing&&<><p className="hx-view-save-hint">{personal?t('Only you can see this view. It syncs across your devices.'):t('Changes apply to everyone who uses this view.')}</p><div className="hx-view-footer"><button disabled={busy} onClick={close}>{t('Cancel')}</button><button className="pill-btn" disabled={busy||!canEdit||invalid} onClick={()=>void apply()}>{busy?t('Saving…'):t('Save')}</button></div></>}
      {editing&&invalid&&<p>{t('Enter a value, or choose is empty to find blank values.')}</p>}
      {error&&<p role="alert" className="form-error">{error}</p>}
    </div>}
  </div>
}

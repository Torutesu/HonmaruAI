import {SYSTEM_COLUMNS, isSystemTimestamp, localDateTime, utcDateTime} from '../utils/systemColumns'
import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { Column, View } from '../utils/harness'
const operators = [['eq','と等しい'],['neq','と等しくない'],['contains','を含む'],['empty','が空'],['not_empty','が空ではない'],['gt','より大きい / 後'],['lt','より小さい / 前']]
export function AppViewControls({view,columns,save,canEdit,personal=false,onAdjust}:{view:View;columns:Column[];save:(patch:Partial<View>)=>Promise<void>;canEdit:boolean;personal?:boolean;onAdjust?:(kind:'filter'|'group')=>void}) {
  const queryColumns=[...columns,...SYSTEM_COLUMNS]
  const [open,setOpen]=useState<'filter'|'group'|null>(null)
  const [editing,setEditing]=useState(false)
  const [filters,setFilters]=useState(view.filters || [])
  const [where,setWhere]=useState(view.where)
  const [group,setGroup]=useState(view.groupBy || '')
  const [busy,setBusy]=useState(false), [error,setError]=useState('')
  const root=useRef<HTMLDivElement>(null)
  const trigger=useRef<HTMLButtonElement|null>(null)
  const close=()=>{setOpen(null);trigger.current?.focus()}
  useEffect(()=>{
    if(!open)return
    root.current?.querySelector<HTMLElement>('[role="dialog"] button,[role="dialog"] select')?.focus()
    const outside=(e:PointerEvent)=>{if(!busy && !root.current?.contains(e.target as Node))setOpen(null)}
    document.addEventListener('pointerdown',outside)
    return()=>document.removeEventListener('pointerdown',outside)
  },[open,busy,editing])
  const count=filters.length+Object.keys(where || {}).length
  const invalid = open==='filter' && filters.some(f=>!['empty','not_empty'].includes(f.op) && (!f.value || isSystemTimestamp(f.column)&&!Number.isFinite(Date.parse(f.value))))
  const activeCount=(view.filters?.length || 0)+Object.keys(view.where || {}).length
  const apply=async()=>{
    setBusy(true);setError('')
    try{await save(open==='filter'?{filters,where:where || {}}:{groupBy:group || undefined});close()}
    catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setBusy(false)}
  }
  const change=(i:number,patch:Partial<NonNullable<View['filters']>[number]>)=>setFilters(filters.map((f,n)=>n===i?{...f,...patch}:f))
  return <div ref={root} className="hx-view-controls" onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();close()}}}>
    {(['filter','group'] as const).filter(kind=>kind==='filter'||view.type==='table'||view.type==='board').map(kind=><button key={kind} className={`pill-btn quiet ${open===kind?'on':''}`} aria-haspopup="dialog" aria-expanded={open===kind} onClick={e=>{trigger.current=e.currentTarget;setOpen(open===kind?null:kind);setEditing(false);setError('');setFilters(view.filters||[]);setWhere(view.where);setGroup(view.groupBy||'')}}><Icon name={kind==='filter'?'filter':'group'} size={14}/>{kind==='filter'?'フィルター':'グループ化'}{kind==='filter'&&activeCount>0&&<span className="hx-count">{activeCount}</span>}</button>)}
    {open&&<div className={`hx-view-popover ${editing&&open==='filter'?'editing':''}`} role="dialog" aria-label={open==='filter'?'フィルターを編集':'グループ化を編集'}>
      {open==='filter'?<>
        {!editing?<><div className="hx-view-summary">{count?`${count}件の条件（すべて一致）`:'フィルターなし'}</div>{filters.map((f,i)=><p key={i}>{queryColumns.find(c=>c.id===f.column)?.name} {operators.find(o=>o[0]===f.op)?.[1]} {isSystemTimestamp(f.column)?localDateTime(f.value).replace('T',' '):f.value}</p>)}{Object.entries(where||{}).map(([id,values])=><p key={id}>{queryColumns.find(c=>c.id===id)?.name}: {values.join(' / ')}</p>)}<button className="hx-view-adjust" disabled={!canEdit} onClick={()=>{if(onAdjust){close();onAdjust('filter')}else setEditing(true)}}><Icon name="sliders" size={15}/>フィルターを調整</button>{onAdjust&&<button className="hx-view-adjust" disabled={!canEdit} onClick={()=>setEditing(true)}>条件を直接編集</button>}</>:<>
          <strong>すべての条件に一致するレコード</strong>
          {Object.keys(where||{}).length>0&&<div className="hx-view-summary">既存の条件: {Object.entries(where||{}).map(([id,v])=>`${queryColumns.find(c=>c.id===id)?.name}: ${v.join(' / ')}`).join('、')}<button onClick={()=>setWhere(undefined)}>既存条件を解除</button></div>}
          {filters.map((f,i)=>{const column=queryColumns.find(c=>c.id===f.column);return <div className="hx-filter-row" key={i}>
            <select aria-label={`条件${i+1}のフィールド`} value={f.column} onChange={e=>change(i,{column:e.target.value,value:'',op:isSystemTimestamp(e.target.value)&&f.op==='contains'?'eq':f.op})}>{queryColumns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select aria-label={`条件${i+1}の演算子`} value={f.op} onChange={e=>change(i,{op:e.target.value})}>{operators.filter(([op])=>!isSystemTimestamp(f.column)||op!=='contains').map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
            {!['empty','not_empty'].includes(f.op)&&(column?.type==='select'||column?.type==='checkbox'?<select aria-label={`条件${i+1}の値`} value={f.value} onChange={e=>change(i,{value:e.target.value})}><option value="">値を選択</option>{(column.type==='checkbox'?['true','false']:column.options||[]).map(v=><option key={v} value={v}>{v==='true'?'チェックあり':v==='false'?'チェックなし':v}</option>)}</select>:<input aria-label={`条件${i+1}の値`} step={isSystemTimestamp(f.column)?1:undefined} type={isSystemTimestamp(f.column)?'datetime-local':column?.type==='number'?'number':column?.type==='date'?'date':'text'} maxLength={500} value={isSystemTimestamp(f.column)?localDateTime(f.value):f.value} onChange={e=>change(i,{value:isSystemTimestamp(f.column)?utcDateTime(e.target.value):e.target.value})}/>)}
            <button aria-label={`条件${i+1}を削除`} onClick={()=>setFilters(filters.filter((_,n)=>n!==i))}><Icon name="x" size={14}/></button>
          </div>})}
          {filters.some(f=>isSystemTimestamp(f.column))&&<p className="hx-view-hint">日時は端末のタイムゾーンで入力します（秒単位）。</p>}
          <button className="hx-view-adjust" disabled={filters.length>=20||!columns.length} onClick={()=>setFilters([...filters,{column:columns[0].id,op:'eq',value:''}])}><Icon name="plus" size={14}/>条件を追加</button>
        </>}
      </>:<>{!editing?<><div className="hx-view-summary">{group ? columns.find(c=>c.id===group)?.name : 'グループ化なし'}</div><button className="hx-view-adjust" disabled={!canEdit} onClick={()=>{if(onAdjust){close();onAdjust('group')}else setEditing(true)}}><Icon name="group" size={15}/>グループ化を調整</button>{onAdjust&&<button className="hx-view-adjust" disabled={!canEdit} onClick={()=>setEditing(true)}>グループを直接編集</button>}</>:<><strong>グループ化</strong><label>フィールド<select aria-label="グループ化するフィールド" value={group} onChange={e=>setGroup(e.target.value)} disabled={!canEdit}>{view.type!=='board'&&<option value="">グループ化なし</option>}{columns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><p>同じ値のレコードをまとめて表示します。</p></>}</>}
      {editing&&<><p className="hx-view-save-hint">{personal?'自分だけに適用・端末間で同期されます。':'このビューを使うメンバーに反映されます。'}</p><div className="hx-view-footer"><button disabled={busy} onClick={close}>キャンセル</button><button className="pill-btn" disabled={busy||!canEdit||invalid} onClick={()=>void apply()}>{busy?'保存中…':'保存'}</button></div></>}
      {editing&&invalid&&<p>条件の値を入力してください。空欄の検索には「が空」を選びます。</p>}
      {error&&<p role="alert" className="form-error">{error}</p>}
    </div>}
  </div>
}
